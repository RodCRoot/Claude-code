/*
 * Teamwork Hub — athlete training logger service worker.
 *
 * Registered ONLY with scope "/training/today" (src/components/training-offline.tsx), and only for
 * an athlete signed in as themself. It handles exactly:
 *   - navigations to /training/today and /training/today/offline: network first; when the network
 *     is unreachable it serves the cached offline shell (a page with no workout data in its HTML);
 *   - GET /api/training/today: network first, cached copy when offline. This JSON is the athlete's
 *     own workouts for today, minimized for logging (no names, no coach notes, no other athletes);
 *   - GET /_next/static/*: immutable build assets, cache first.
 * Everything else — other pages, RSC/prefetch requests, POST /api/training/sets (the localStorage
 * queue syncs straight to the network), server actions — passes through untouched and is never cached.
 *
 * Caches are purged on sign-out (login page / sign-out button), when another user's data arrives
 * (owner key mismatch), when the server says the viewer may not use offline logging (401/403), and
 * by any non-athlete page (e.g. the shared-tablet weight room).
 */
const PREFIX = "tw-training-";
const SHELL_CACHE = PREFIX + "shell-v1";
const DATA_CACHE = PREFIX + "data-v1";
const SCOPE_PATH = "/training/today";
const SHELL_PATH = "/training/today/offline";
const DATA_PATH = "/api/training/today";
const OWNER_KEY = "/__tw-training/owner";
const OWNER_RE = /^[a-f0-9]{32}$/;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== SHELL_CACHE && k !== DATA_CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

async function purge() {
  for (const k of await caches.keys()) if (k.startsWith(PREFIX)) await caches.delete(k);
}

async function storedOwner() {
  if (!(await caches.has(DATA_CACHE))) return null;
  const r = await caches.match(OWNER_KEY, { cacheName: DATA_CACHE });
  return r ? r.text() : null;
}

async function setOwner(key) {
  if ((await storedOwner()) === key) return;
  await purge(); // a different user (or first use): nothing from before may remain
  const c = await caches.open(DATA_CACHE);
  await c.put(OWNER_KEY, new Response(key, { headers: { "Content-Type": "text/plain" } }));
}

/** Store a /api/training/today response if it belongs to the current owner. */
async function storeData(res) {
  if (res.status === 401 || res.status === 403) {
    await purge();
    return false;
  }
  if (!res.ok || res.redirected) return false;
  let body;
  try {
    body = await res.json();
  } catch {
    return false;
  }
  if (!body || typeof body.owner !== "string" || !OWNER_RE.test(body.owner) || !Array.isArray(body.workouts)) return false;
  await setOwner(body.owner); // purges first if the data belongs to a different user
  const c = await caches.open(DATA_CACHE);
  await c.put(DATA_PATH, new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "X-Training-Offline-Saved": new Date().toISOString() } }));
  return true;
}

async function refreshData() {
  const res = await fetch(DATA_PATH, { credentials: "same-origin", cache: "no-store" });
  return storeData(res);
}

/** Cache the offline shell page and the build assets it references (scripts, CSS, fonts). */
async function refreshShell() {
  const res = await fetch(SHELL_PATH, { credentials: "same-origin", cache: "no-store" });
  if (!res.ok || res.redirected) return false;
  const html = await res.text();
  const assets = new Set();
  for (const m of html.matchAll(/\/_next\/static\/[^"'\s\\<>]+/g)) assets.add(m[0]);
  for (const a of [...assets]) {
    if (!/\.css(\?|$)/.test(a)) continue;
    try {
      const css = await (await fetch(a)).text();
      for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
        if (m[1].startsWith("data:")) continue;
        const u = new URL(m[1], new URL(a, self.location.origin));
        if (u.origin === self.location.origin && u.pathname.startsWith("/_next/static/")) assets.add(u.pathname + u.search);
      }
    } catch {
      /* best effort */
    }
  }
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(
    [...assets].map(async (a) => {
      if (await cache.match(a)) return;
      try {
        const r = await fetch(a);
        if (r.ok) await cache.put(a, r);
      } catch {
        /* best effort */
      }
    }),
  );
  // Drop assets of older builds.
  for (const req of await cache.keys()) {
    const u = new URL(req.url);
    if (u.pathname !== SHELL_PATH && !assets.has(u.pathname + u.search)) await cache.delete(req);
  }
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("X-Training-Offline-Shell", "1");
  await cache.put(SHELL_PATH, new Response(html, { status: 200, headers }));
  return true;
}

self.addEventListener("message", (event) => {
  const msg = event.data || {};
  const port = event.ports && event.ports[0];
  let work;
  if (msg.type === "owner" && typeof msg.key === "string" && OWNER_RE.test(msg.key)) {
    work = setOwner(msg.key).then(async () => ({ data: await refreshData(), shell: await refreshShell() }));
  } else if (msg.type === "refresh") {
    work = refreshData().then((data) => ({ data }));
  } else if (msg.type === "purge") {
    work = purge().then(() => ({ purged: true }));
  } else {
    return;
  }
  event.waitUntil(
    work.then(
      (r) => port && port.postMessage({ ok: true, ...r }),
      (e) => port && port.postMessage({ ok: false, error: String(e) }),
    ),
  );
});

function offlinePage() {
  const body =
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline · Teamwork Hub</title>' +
    "<h1>You're offline</h1><p>Today's workout hasn't been saved on this device yet. Reconnect and open Training → Today once; after that it opens offline too.</p>" +
    "<p>Sets you already logged on this device are kept and sync when you're back online.</p></html>";
  return new Response(body, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'", "Cache-Control": "no-store" } });
}

async function navigation(request) {
  try {
    return await fetch(request);
  } catch {
    const shell = await caches.match(SHELL_PATH, { cacheName: SHELL_CACHE });
    const data = await caches.match(DATA_PATH, { cacheName: DATA_CACHE });
    return shell && data ? shell : offlinePage();
  }
}

async function todayData(request) {
  try {
    const res = await fetch(request);
    await storeData(res.clone());
    return res;
  } catch {
    const cached = await caches.match(DATA_PATH, { cacheName: DATA_CACHE });
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set("X-Training-Offline", "cache");
      return new Response(cached.body, { status: 200, headers });
    }
    return new Response(JSON.stringify({ error: "You're offline and today's workout isn't saved on this device." }), {
      status: 503,
      headers: { "Content-Type": "application/json", "X-Training-Offline": "none" },
    });
  }
}

async function staticAsset(request) {
  const cached = await caches.match(request, { cacheName: SHELL_CACHE });
  if (cached) return cached;
  const res = await fetch(request);
  // Only while an owner's offline copy exists: after a purge (sign-out, user change) a worker that
  // still controls an open page must not recreate caches.
  if (res.ok && res.type === "basic" && (await caches.has(DATA_CACHE))) {
    const c = await caches.open(SHELL_CACHE);
    await c.put(request, res.clone());
  }
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    if (url.pathname === SCOPE_PATH || url.pathname === SHELL_PATH) event.respondWith(navigation(req));
    return;
  }
  if (url.pathname === DATA_PATH) {
    event.respondWith(todayData(req));
    return;
  }
  if (url.pathname.startsWith("/_next/static/")) event.respondWith(staticAsset(req));
});
