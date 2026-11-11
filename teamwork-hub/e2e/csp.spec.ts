import { expect, test, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * CSP sweep: signs in as each role, crawls every same-origin page link reachable from that
 * role's start pages (dynamic [id] pages included), and fails on any Content-Security-Policy
 * violation, uncaught page error, or 5xx. Run against `pnpm build && pnpm start` (CSP is
 * strictest in production) seeded with `pnpm db:fresh`:
 *
 *   BASE_URL=http://localhost:3105 pnpm test:e2e e2e/csp.spec.ts --project=desktop
 */
test.describe.configure({ mode: "serial" });

const MAX_PAGES = Number(process.env.CSP_MAX_PAGES ?? 400);
// Never follow links that change state or end the session.
const SKIP = [/^\/logout/, /^\/kiosk\/exit/, /^\/api\//, /\/rejected$/, /^\/dev\/switch\?/, /\.(csv|zip|pdf|json)$/];

type Finding = { url: string; kind: string; detail: string };

const routePattern = (pathname: string) => pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id").replace(/\/\d+(?=\/|$)/g, "/:n");

async function instrument(page: Page, findings: Finding[]) {
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || "inline"} (${e.sourceFile || ""}:${e.lineNumber})`);
    });
  });
  page.on("console", (msg) => {
    if (/Content Security Policy|Content-Security-Policy/i.test(msg.text())) findings.push({ url: page.url(), kind: "console-csp", detail: msg.text() });
  });
  page.on("pageerror", (err) => findings.push({ url: page.url(), kind: "pageerror", detail: err.message }));
}

/** Pages per browser tab. One tab crawling a few hundred pages can exhaust renderer memory and crash. */
const PAGES_PER_TAB = 40;

async function crawl(first: Page, starts: string[], findings: Finding[]) {
  let page = first;
  const origin = new URL(page.url()).origin;
  const seen = new Set<string>();
  const queue = [...starts];
  let visited = 0;
  // A fresh tab in the same context keeps the session cookie and the instrumentation.
  const freshTab = async () => {
    const next = await page.context().newPage();
    await instrument(next, findings);
    await page.close().catch(() => undefined);
    page = next;
  };
  while (queue.length && visited < MAX_PAGES) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    if (visited > 0 && visited % PAGES_PER_TAB === 0) await freshTab();
    let res = await page.goto(path, { waitUntil: "load" }).catch((e: Error) => e);
    if (res instanceof Error && /crash/i.test(res.message)) {
      // A renderer crash is not a CSP result: retry the same path once in a new tab.
      await freshTab();
      res = await page.goto(path, { waitUntil: "load" }).catch((e: Error) => e);
    }
    if (res instanceof Error) {
      findings.push({ url: path, kind: "navigation", detail: res.message });
      res = null;
    }
    // Let hydration, client components, and charts run (violations fire during this window).
    await page.waitForTimeout(400).catch(() => undefined);
    visited++;
    if (res && res.status() >= 500) findings.push({ url: path, kind: "http", detail: String(res.status()) });
    const violations = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []).catch(() => []);
    for (const v of violations) findings.push({ url: path, kind: "violation", detail: v });
    const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href)).catch(() => [] as string[]);
    for (const href of hrefs) {
      const u = new URL(href);
      if (u.origin !== origin) continue;
      const p = u.pathname + u.search;
      if (SKIP.some((r) => r.test(p)) || seen.has(p) || queue.includes(p)) continue;
      // Every route, not every record: at most 2 instances per route pattern ([id] segments
      // collapsed) and 2 query-string variants (tabs/filters) per path.
      const pattern = routePattern(u.pathname);
      const known = [...seen, ...queue];
      if (known.filter((s) => routePattern(s.split("?")[0]) === pattern && s.split("?")[0] !== u.pathname).length >= 2 && !known.some((s) => s.split("?")[0] === u.pathname)) continue;
      if (u.search && known.filter((s) => s.split("?")[0] === u.pathname).length > 2) continue;
      queue.push(p);
    }
  }
  return visited;
}

const ROLES: { name: string; email?: string; starts: string[] }[] = [
  { name: "public (signed out)", starts: ["/", "/programs", "/classes", "/inquire", "/login", "/denied", "/dev/switch", "/does-not-exist", "/r/parkerdemo26", "/s/TeamworkDemoShowcaseMayaP000000000000000000", "/s/not-a-real-showcase-link", "/display", "/display/link/TeamworkDemoDisplayBoardTV00000000000000000", "/display?panel=1", "/display?panel=2", "/display?panel=3", "/display?panel=4", "/display?panel=5", "/display?panel=6"] },
  {
    name: "owner",
    email: USERS.rod,
    starts: [
      "/today", "/people", "/people/leads", "/people/tasks", "/people/new", "/people/leads/new", "/schedule", "/schedule/book", "/schedule/settings",
      "/billing", "/billing/invoices", "/billing/memberships", "/billing/pos", "/billing/products", "/billing/providers", "/billing/reconciliation",
      "/training", "/training/athletes", "/training/exercises", "/training/plan", "/training/programs", "/training/reports", "/training/review",
      "/training/settings", "/training/today", "/training/weight-room", "/science", "/science/body-map", "/science/force-plate", "/science/habits",
      "/science/kpis", "/science/load", "/science/reports", "/science/volume", "/science/wearables", "/science/wellness", "/science/wellness/builder",
      "/performance", "/messages", "/messages/new", "/messages/outbox", "/messages/templates", "/messages/automations", "/documents", "/documents/archive",
      "/reports", "/settings", "/settings/audit", "/settings/integrations", "/settings/security", "/settings/users", "/imports", "/imports/exports", "/imports/hawkin", "/settings/engagement", "/settings/showcase", "/settings/community", "/leaderboards", "/display", "/people/showcases", "/training/recaps",
      "/people/requests", "/people/retention", "/people/retention/winback", "/reports/retention-saves", "/reports/session-feedback", "/reports/membership-audit", "/payroll", "/payroll/staff", "/payroll/import", "/payroll/settings", "/time",
      "/people/referrals", "/billing/opportunities", "/settings/growth", "/reports/growth-referrals", "/reports/growth-shop-sales", "/reports/growth-offers", "/reports/growth-trial-passes",
    ],
  },
  { name: "coach", email: USERS.marcus, starts: ["/today", "/training/today", "/training/weight-room", "/science", "/schedule", "/people/retention", "/reports/session-feedback", "/time", "/training/recaps", "/people/showcases", "/leaderboards"] },
  { name: "guardian", email: USERS.alex, starts: ["/today", "/schedule", "/schedule/book", "/billing/invoices", "/documents", "/messages", "/performance", "/goals", "/shop", "/refer", "/anywhere", "/anywhere/season", "/showcase", "/recap", "/leaderboards"] },
  { name: "athlete", email: USERS.maya, starts: ["/today", "/training/today", "/science/body-map", "/goals", "/anywhere", "/anywhere/season", "/showcase", "/recap", "/leaderboards"] },
  { name: "kiosk", email: USERS.kiosk, starts: ["/kiosk", "/kiosk/clock"] },
];

for (const role of ROLES) {
  test(`no CSP violations: ${role.name}`, async ({ page }) => {
    test.setTimeout(15 * 60_000);
    const findings: Finding[] = [];
    await instrument(page, findings);
    if (role.email) await login(page, role.email);
    else await page.goto("/");
    const visited = await crawl(page, role.starts, findings);
    console.log(`[csp] ${role.name}: ${visited} pages, ${findings.length} findings`);
    for (const f of findings) console.log(`[csp]   ${f.kind} ${f.url}: ${f.detail}`);
    expect(visited).toBeGreaterThanOrEqual(role.starts.length);
    expect(findings).toEqual([]);
  });
}

test("control: the sweep detects a real violation (injected markup with an inline handler is blocked)", async ({ page }) => {
  const findings: Finding[] = [];
  await instrument(page, findings);
  const res = await page.goto("/login");
  expect(res?.headers()["content-security-policy"]).toMatch(/'nonce-[^']+' 'strict-dynamic'/);
  // The classic stored-XSS shape: HTML injected into the page carrying an event-handler payload.
  await page.evaluate(() => {
    const div = document.createElement("div");
    div.innerHTML = `<img src="data:," onload="window.__injected = true"><img src="/nope.png" onerror="window.__injected = true">`;
    document.body.appendChild(div);
  });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as unknown as { __injected?: boolean }).__injected)).toBeUndefined();
  const violations = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
  expect(violations.some((v) => v.startsWith("script-src"))).toBe(true);
});
