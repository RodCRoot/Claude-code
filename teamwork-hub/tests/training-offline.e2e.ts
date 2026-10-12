import "dotenv/config";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { Pool } from "pg";

/**
 * Offline recovery for athlete set logging (run against a production build; the training
 * service worker is only registered in production — see tests/training.playwright.config.ts).
 */
test.describe.configure({ mode: "serial" });

const MAYA = "maya.parker@example.test";
const MARCUS = "marcus.demo@teamwork-hub.test";

async function signIn(page: Page, email: string) {
  // Through the real login form (the demo role switcher is disabled in production builds).
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", "teamwork-demo-1");
  await page.click("button[type=submit]");
  await page.waitForURL(/\/today/);
}

/** Training caches (name → stored paths), training SW registrations (scope paths), and control. */
function swState(page: Page) {
  return page.evaluate(async () => {
    const out: Record<string, string[]> = {};
    for (const k of await caches.keys()) {
      if (!k.startsWith("tw-training-")) continue;
      out[k] = (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname).sort();
    }
    const regs = (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname);
    return { caches: out, regs, controlled: !!navigator.serviceWorker.controller };
  });
}

/**
 * Fully offline: pages AND the service worker's own fetches (see the config's SW network flag).
 * The route stays installed and is gated by a flag (unroute doesn't reliably detach from workers).
 */
const network = new WeakMap<BrowserContext, { down: boolean }>();
async function goOffline(context: BrowserContext) {
  let state = network.get(context);
  if (!state) {
    state = { down: false };
    network.set(context, state);
    const s = state;
    await context.route("**/*", (r) => (s.down ? r.abort("internetdisconnected") : r.fallback()));
  }
  state.down = true;
  await context.setOffline(true);
}
async function goOnline(context: BrowserContext) {
  const state = network.get(context);
  if (state) state.down = false;
  await context.setOffline(false);
}

const MAYA_WORKOUTS = `
  from workouts w join athletes a on a.id = w.athlete_id join people p on p.id = a.person_id
  where p.first_name = 'Maya' and p.last_name = 'Parker'`;

test("service worker: offline full reload shows today's saved workout; log; reconnect → synced, no duplicates", async ({ page, context }) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const today = (await pool.query(`select (now() at time zone 'America/Indiana/Indianapolis')::date::text as d`)).rows[0].d as string;
  // Demo data schedules Mon/Wed/Fri; on other days move Maya's next untouched workout to today.
  if (!(await pool.query(`select w.id ${MAYA_WORKOUTS} and w.scheduled_date = $1`, [today])).rowCount) {
    await pool.query(
      `update workouts set scheduled_date = $1 where id = (select w.id ${MAYA_WORKOUTS} and w.status = 'scheduled' and w.scheduled_date > $1
         and not exists (select 1 from workout_items x join set_logs s on s.workout_item_id = x.id where x.workout_id = w.id) order by w.scheduled_date limit 1)`,
      [today],
    );
  }
  const { rows } = await pool.query(
    `select wi.id as item_id, w.id as workout_id ${MAYA_WORKOUTS.replace("from workouts w", "from workouts w join workout_items wi on wi.workout_id = w.id join exercises e on e.id = coalesce(wi.substituted_exercise_id, wi.exercise_id)")}
       and w.scheduled_date = $1 and w.status <> 'skipped' and e.tracking_type = 'weight_reps' and not e.is_unilateral
       and not exists (select 1 from set_logs s where s.workout_item_id = wi.id)
     order by wi.sort_order limit 1`,
    [today],
  );
  expect(rows.length, "an unlogged weight × reps item in Maya's workout today").toBe(1);
  const { item_id: itemId } = rows[0] as { item_id: string; workout_id: string };
  const mayaToday = (await pool.query(`select w.id ${MAYA_WORKOUTS} and w.scheduled_date = $1`, [today])).rows.map((r) => r.id as string);

  await signIn(page, MAYA);
  await page.goto("/training/today");
  await expect(page.getByTestId("offline-ready")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });

  // What is stored: the scoped worker, the shell + build assets, and Maya's own minimized data.
  const st = await swState(page);
  expect(st.regs).toEqual(["/training/today"]);
  expect(Object.keys(st.caches).sort()).toEqual(["tw-training-data-v1", "tw-training-shell-v1"]);
  expect(st.caches["tw-training-data-v1"]).toEqual(["/__tw-training/owner", "/api/training/today"]);
  expect(st.caches["tw-training-shell-v1"]).toContain("/training/today/offline");
  expect(st.caches["tw-training-shell-v1"].every((p) => p === "/training/today/offline" || p.startsWith("/_next/static/"))).toBe(true);
  const saved = await page.evaluate(async () => (await caches.match("/api/training/today", { cacheName: "tw-training-data-v1" }))!.text());
  expect(saved).toContain(itemId);
  expect(saved).not.toMatch(/Maya|Parker|athleteName|coachFeedback/);
  expect((JSON.parse(saved) as { workouts: { id: string }[] }).workouts.map((w) => w.id).sort()).toEqual([...mayaToday].sort());
  // The shell HTML itself carries no workout data.
  const shell = await page.evaluate(async () => (await caches.match("/training/today/offline", { cacheName: "tw-training-shell-v1" }))!.text());
  expect(shell).not.toContain(itemId);

  // 1) Offline + full reload: the service worker serves the shell + saved workout.
  await goOffline(context);
  await page.reload();
  await expect(page.getByTestId("offline-copy")).toBeVisible();
  const item = page.locator(`section:has(#item-${itemId})`);
  await expect(item).toBeVisible();

  // 2) Log two sets offline (edit reps on the second) → queued in localStorage.
  await item.getByRole("button", { name: /^Log .* Set 1$/ }).click();
  await item.locator(`[id="${itemId}-1-both-reps"]`).fill("2");
  await item.getByRole("button", { name: /^Log .* Set 2$/ }).click();
  await expect(page.getByTestId("unsynced-count")).toHaveText("2");
  await expect(page.getByTestId("sync-status")).toContainText("offline");
  const stored = await page.evaluate(() => localStorage.getItem("tw.training.queue.v1") ?? "");
  expect(stored).toContain(itemId);
  expect(stored).not.toMatch(/Maya|Parker/);

  // Another full reload while still offline: the queue survives.
  await page.reload();
  await expect(page.getByTestId("offline-copy")).toBeVisible();
  await expect(page.getByTestId("unsynced-count")).toHaveText("2");
  await expect(page.locator(`section:has(#item-${itemId}) [data-testid="set-0-both"]`)).toContainText("unsynced");

  // 3) Reconnect: the queue flushes on the online event.
  await goOnline(context);
  await expect(page.getByTestId("sync-status")).toContainText("All entries synced", { timeout: 30_000 });
  await expect(page.locator(`section:has(#item-${itemId}) [data-testid="set-1-both"]`)).toContainText("saved");
  expect(await page.evaluate(() => localStorage.getItem("tw.training.queue.v1"))).toBeNull();

  // 4) Database: exactly one row per slot with the edited values.
  const logs = await pool.query("select set_index, reps, side from set_logs where workout_item_id = $1 order by set_index", [itemId]);
  expect(logs.rows.map((r) => [r.set_index, r.side])).toEqual([
    [0, "both"],
    [1, "both"],
  ]);
  expect(logs.rows[1].reps).toBe(2);

  // 5) The saved copy is refreshed with the synced sets.
  await expect
    .poll(async () => {
      const t = await page.evaluate(async () => (await caches.match("/api/training/today", { cacheName: "tw-training-data-v1" }))!.text());
      return (JSON.parse(t) as { workouts: { items: { id: string; logs: unknown[] }[] }[] }).workouts.flatMap((w) => w.items).find((i) => i.id === itemId)?.logs.length;
    })
    .toBe(2);
  await pool.end();
});

test.describe("queue protocol without the service worker", () => {
  // page.route can't see requests a service worker handles, so this protocol test blocks it.
  test.use({ serviceWorkers: "block" });

  /**
   * go offline → log sets (queued in localStorage) → reload while the API is unreachable
   * (entries survive) → server processes a retry but the response is lost (500) → client
   * retries the same clientMutationIds → synced, and the database holds no duplicates.
   */
  test("athlete logs sets offline, reloads, reconnects: synced with no duplicates", async ({ page, context }) => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    // A scheduled, untouched workout for Maya (demo seed).
    const { rows } = await pool.query(`
      select w.id, w.scheduled_date::text as date, wi.id as item_id
      from workouts w
      join athletes a on a.id = w.athlete_id join people p on p.id = a.person_id
      join workout_items wi on wi.workout_id = w.id and wi.sort_order = 0
      where p.first_name = 'Maya' and p.last_name = 'Parker' and w.status = 'scheduled'
        and not exists (select 1 from workout_items x join set_logs s on s.workout_item_id = x.id where x.workout_id = w.id)
      order by w.scheduled_date limit 1`);
    expect(rows.length, "seeded scheduled workout for Maya").toBe(1);
    const { date, item_id: itemId } = rows[0] as { date: string; item_id: string };

    await signIn(page, MAYA);
    await page.goto(`/training/today?date=${date}`);
    const item = page.locator(`section:has(#item-${itemId})`);
    await expect(item).toBeVisible();

    // 1) Offline: log two sets (edit reps on the second).
    await context.setOffline(true);
    await item.getByRole("button", { name: /^Log .* Set 1$/ }).click();
    await item.locator(`[id="${itemId}-1-both-reps"]`).fill("2");
    await item.getByRole("button", { name: /^Log .* Set 2$/ }).click();
    await expect(page.getByTestId("unsynced-count")).toHaveText("2");
    await expect(page.getByTestId("sync-status")).toContainText("offline");

    // localStorage holds ids + numbers only (no names / notes).
    const stored = await page.evaluate(() => localStorage.getItem("tw.training.queue.v1") ?? "");
    expect(stored).toContain(itemId);
    expect(stored).not.toMatch(/Maya|Parker|Power Clean/);

    // 2) Reload while the API is still unreachable: entries survive.
    await page.route("**/api/training/sets", (r) => r.abort("internetdisconnected"));
    await context.setOffline(false);
    await page.reload();
    await expect(page.getByTestId("unsynced-count")).toHaveText("2");
    await expect(page.locator(`[data-testid="set-0-both"]`).first()).toContainText("unsynced");

    // 3) Back online, but the first sync's response is lost after the server applied it.
    await page.unroute("**/api/training/sets");
    let lost = 0;
    await page.route("**/api/training/sets", async (r) => {
      const resp = await r.fetch();
      if (lost++ === 0) return r.fulfill({ status: 500, body: "{}" });
      return r.fulfill({ response: resp });
    });
    await page.getByRole("button", { name: "Retry now" }).click();
    await expect(page.getByTestId("sync-status")).toContainText("All entries synced", { timeout: 20_000 });
    expect(lost).toBeGreaterThanOrEqual(2);
    await expect(page.locator(`[data-testid="set-1-both"]`).first()).toContainText("saved");

    // 4) Database: exactly one row per slot, with the edited values.
    const logs = await pool.query("select set_index, reps, side, client_mutation_id from set_logs where workout_item_id = $1 order by set_index", [itemId]);
    expect(logs.rows.map((r) => [r.set_index, r.side])).toEqual([
      [0, "both"],
      [1, "both"],
    ]);
    expect(logs.rows[1].reps).toBe(2);
    expect(await page.evaluate(() => localStorage.getItem("tw.training.queue.v1"))).toBeNull();
    await pool.end();
  });
});

test("sign-out purges the offline copy; the shared weight-room tablet keeps no workout data in SW caches", async ({ page }) => {
  await signIn(page, MAYA);
  await page.goto("/training/today");
  await expect(page.getByTestId("offline-ready")).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  expect(Object.keys((await swState(page)).caches).length).toBeGreaterThan(0);

  // Sign out from the (mobile) menu: caches and the worker are gone.
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
  await expect.poll(async () => { const s = await swState(page); return { caches: s.caches, regs: s.regs }; }).toEqual({ caches: {}, regs: [] });
  // Sign-out is a soft navigation, so this document stays attached to the (now unregistered)
  // worker until it unloads; a fresh load is not controlled by anything.
  await page.reload();
  expect(await swState(page)).toEqual({ caches: {}, regs: [], controlled: false });

  // Coach on the shared tablet. Simulate data an athlete left behind on this device.
  await signIn(page, MARCUS);
  await page.evaluate(async () => {
    const c = await caches.open("tw-training-data-v1");
    await c.put("/api/training/today", new Response(JSON.stringify({ owner: "0".repeat(32), workouts: [] })));
  });
  await page.goto("/training/weight-room");
  await expect.poll(() => swState(page)).toEqual({ caches: {}, regs: [], controlled: false });

  // Log a set for an athlete; still nothing is written to service-worker caches.
  const athlete = page.locator('section[aria-label$="athletes"] button:not([disabled])').filter({ hasNotText: "Maya" }).first();
  if (await athlete.count()) {
    await athlete.click();
    const log = page.getByRole("button", { name: /^Log .* Set \d+( [LR])?$/ }).first();
    await expect(log).toBeVisible();
    await log.click();
    await expect(page.getByTestId("sync-status")).toContainText("All entries synced", { timeout: 20_000 });
  } else {
    test.info().annotations.push({ type: "note", description: "No workouts in the weight room today; logging step skipped." });
  }
  expect(await swState(page)).toEqual({ caches: {}, regs: [], controlled: false });
});
