import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { PASSWORD, USERS } from "./helpers";

/**
 * Accessibility audit: signs in as owner, coach, guardian, athlete and kiosk and runs axe
 * (WCAG 2.0/2.1 A + AA rules) on every main route for that role, at the project's viewport
 * (desktop 1366px and mobile 390px). One test per route so a slow page can't hide the rest.
 * Run against a production build seeded with `pnpm db:fresh`:
 *
 *   pnpm build && pnpm start -p 3104
 *   BASE_URL=http://localhost:3104 PW_CHROMIUM=/path/to/chrome pnpm test:e2e e2e/a11y.spec.ts
 *
 * Set A11Y_BEST_PRACTICE=1 to also run axe's best-practice rules (landmarks, heading order).
 * Set A11Y_REPORT=<dir> to also write one JSON result per page (used for before/after counts).
 * Rules intentionally not enforced are listed in docs/ACCESSIBILITY.md (DISABLED_RULES below).
 */
test.describe.configure({ mode: "parallel" });

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", ...(process.env.A11Y_BEST_PRACTICE ? ["best-practice"] : [])];
/** Keep in sync with docs/ACCESSIBILITY.md → "Deferred". */
const DISABLED_RULES: string[] = [];

/** Demo share token from scripts/seed/showcase.ts (synthetic data only). */
const SHOWCASE = "/s/TeamworkDemoShowcaseMayaP000000000000000000";
/** Demo display token from scripts/seed/community.ts (synthetic data only). The link connects this browser as a gym TV. */
const DISPLAY_LINK = "/display/link/TeamworkDemoDisplayBoardTV00000000000000000";
// Signed out, "/display" is the "not connected" screen; the link lands on the live board as a TV would.
const PUBLIC = ["/", "/classes", "/programs", "/inquire", "/login", "/r/parkerdemo26", SHOWCASE, "/s/not-a-real-showcase-link", "/display", DISPLAY_LINK];
/** The owner's board preview with each panel pinned in turn (every panel type gets audited). */
const BOARD_PANELS = Array.from({ length: 19 }, (_, i) => `/display?panel=${i + 1}`);
const STAFF = [
  "/today",
  "/people",
  "/people/new",
  "/people/tasks",
  "/people/leads",
  "/people/leads/new",
  "/schedule",
  "/schedule/book",
  "/schedule/settings",
  "/billing",
  "/billing/invoices",
  "/billing/memberships",
  "/billing/pos",
  "/billing/products",
  "/billing/providers",
  "/billing/reconciliation",
  "/training",
  "/training/today",
  "/training/athletes",
  "/training/exercises",
  "/training/programs",
  "/training/plan",
  "/training/review",
  "/training/reports",
  "/training/weight-room",
  "/training/anywhere",
  "/training/anywhere/new",
  "/training/settings",
  "/science",
  "/science/load",
  "/science/wellness",
  "/science/force-plate",
  "/science/kpis",
  "/science/volume",
  "/science/wearables",
  "/science/habits",
  "/science/body-map",
  "/science/reports",
  "/performance",
  "/messages",
  "/messages/new",
  "/messages/templates",
  "/messages/automations",
  "/messages/outbox",
  "/documents",
  "/documents/archive",
  "/reports",
  "/reports/attendance",
  "/reports/utilization",
  "/reports/collections",
  "/reports/receivables",
  "/reports/membership-audit",
  "/people/requests",
  "/people/retention",
  "/people/retention?level=all",
  "/people/retention/winback",
  "/reports/retention-saves",
  "/reports/session-feedback",
  "/people/referrals",
  "/billing/opportunities",
  "/settings/growth",
  "/events",
  "/events/new",
  "/reports/growth-referrals",
  "/scoreboard",
  "/scoreboard/monthly",
  "/scoreboard/efficiency",
  "/scoreboard/marketing",
  "/scoreboard/money",
  "/scoreboard/list/past_due",
  "/payroll",
  "/payroll/staff",
  "/payroll/import",
  "/payroll/settings",
  "/time",
  "/imports",
  "/imports/exports",
  "/imports/hawkin",
  "/settings",
  "/settings/users",
  "/settings/custom-fields",
  "/settings/engagement",
  "/settings/showcase",
  "/settings/community",
  "/leaderboards",
  "/leaderboards?band=U14",
  "/display",
  ...BOARD_PANELS,
  "/people/showcases",
  "/training/recaps",
  "/wins",
  "/wins/review",
  "/wins/calendar",
  "/wins/calendar?view=month",
  "/wins/teams",
  "/wins/leads",
  "/wins/marketing",
  "/wins/news",
  "/wins/watch",
  "/wins?show=news",
  "/settings/newswatch",
  "/settings/security",
  "/settings/integrations",
  "/settings/jobs",
  "/settings/journey",
  "/follow-ups",
  "/follow-ups/checklist",
  "/follow-ups/scorecard",
  "/follow-ups/report",
  "/check-ins",
  "/check-ins/athletes",
  "/settings/check-ins",
  "/reports/session-checkins",
  "/settings/audit",
];
const COACH = ["/today", "/check-ins", "/check-ins/athletes", "/reports/session-checkins", "/people", "/people/tasks", "/schedule", "/training", "/training/today", "/training/weight-room", "/training/review", "/science", "/science/load", "/performance", "/messages", "/documents", "/reports", "/reports/attendance", "/reports/utilization", "/people/retention", "/reports/session-feedback", "/settings/security", "/time", "/training/anywhere", "/training/recaps", "/people/showcases", "/leaderboards", "/wins", "/wins/review", "/wins/calendar", "/wins/teams", "/wins/leads", "/follow-ups", "/follow-ups/checklist", "/follow-ups/scorecard", "/wins/news", "/wins/watch"];
const FAMILY = ["/today", "/check-ins", "/schedule", "/schedule/book", "/schedule/reservations", "/schedule/attendance", "/billing", "/billing/invoices", "/billing/memberships", "/billing/payment-methods", "/billing/history", "/training", "/science", "/science/wellness", "/science/body-map", "/performance", "/messages", "/documents", "/goals", "/shop", "/shop/camps", "/refer", "/anywhere", "/anywhere/season", "/showcase", "/recap", "/leaderboards", "/wins", "/wins?show=news"];

type Role = { name: string; email?: string; routes: string[]; dynamic?: [string, RegExp][] };
const ROLES: Role[] = [
  { name: "public", routes: PUBLIC },
  {
    name: "owner",
    email: USERS.rod,
    routes: STAFF,
    dynamic: [
      ["/people?kind=athletes", /^\/people\/[0-9a-f-]{36}$/],
      ["/billing/invoices", /^\/billing\/invoices\/[0-9a-f-]{36}$/],
      ["/billing/memberships", /^\/billing\/memberships\/[0-9a-f-]{36}$/],
      ["/payroll", /^\/payroll\/runs\/[0-9a-f-]{36}$/],
      ["/messages", /^\/messages\/[0-9a-f-]{36}$/],
      ["/performance", /^\/performance\/[0-9a-f-]{36}$/],
      ["/people/retention", /^\/people\/retention\/feedback\/[0-9a-f-]{36}$/],
      ["/check-ins", /^\/check-ins\/responses\/[0-9a-f-]{36}$/],
      ["/training/anywhere", /^\/training\/anywhere\/[0-9a-f-]{36}$/],
      ["/events", /^\/events\/[0-9a-f-]{36}$/],
    ],
  },
  { name: "coach", email: USERS.marcus, routes: COACH, dynamic: [["/people", /^\/people\/[0-9a-f-]{36}$/], ["/training/athletes", /^\/training\/athletes\/[0-9a-f-]{36}$/]] },
  {
    name: "guardian",
    email: USERS.alex,
    routes: FAMILY,
    dynamic: [
      ["/billing", /^\/billing\/invoices\/[0-9a-f-]{36}$/],
      ["/today", /^\/people\/[0-9a-f-]{36}$/],
      ["/performance", /^\/performance\/[0-9a-f-]{36}$/],
      ["/check-ins", /^\/check-ins\/[0-9a-f-]{36}\/after$/],
      ["/schedule/reservations", /^\/schedule\/classes\/[0-9a-f-]{36}$/],
      ["/billing/memberships", /^\/billing\/memberships\/[0-9a-f-]{36}$/],
      ["/shop/camps", /^\/shop\/camps\/[0-9a-f-]{36}$/],
      ["/recap", /^\/recap\/\d{4}-\d{2}\?athlete=[0-9a-f-]{36}$/],
    ],
  },
  { name: "athlete", email: USERS.maya, routes: FAMILY.filter((r) => r !== "/billing"), dynamic: [["/anywhere", /^\/anywhere\/sessions\/[0-9a-f-]{36}/]] },
  { name: "kiosk", email: USERS.kiosk, routes: ["/kiosk", "/kiosk/clock"] },
];

async function signIn(browser: Browser, opts: BrowserContextOptions, email: string) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

/** Follow the first link matching `re` on `from` so dynamic [id] pages are covered too. */
async function firstLink(page: Page, from: string, re: RegExp): Promise<string | null> {
  await page.goto(from);
  const hrefs = await page.locator("main a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
  return hrefs.find((h) => re.test(h)) ?? null;
}

async function check(page: Page, route: string, role: string, project: string) {
  const res = await page.goto(route);
  expect(res?.status(), `${route} responded`).toBeLessThan(500);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  const axe = await new AxeBuilder({ page }).withTags(TAGS).disableRules(DISABLED_RULES).analyze();
  const violations = axe.violations.map((v) => ({ id: v.id, impact: v.impact ?? null, nodes: v.nodes.length, help: v.help, targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")) }));
  const dir = process.env.A11Y_REPORT;
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    const file = `${role}-${project}-${route.replace(/[^a-z0-9]+/gi, "_")}.json`;
    fs.writeFileSync(path.join(dir, file), JSON.stringify([{ route, violations }], null, 1));
  }
  expect(
    violations.map((v) => `${v.id} (${v.impact}, ${v.nodes} nodes): ${v.help} → ${v.targets.join(" | ")}`),
    `axe violations on ${route} for ${role}`,
  ).toEqual([]);
}

for (const role of ROLES) {
  test.describe(`axe: ${role.name}`, () => {
    let state: Awaited<ReturnType<typeof signIn>> | undefined;
    test.beforeAll(async ({ browser }, info) => {
      if (role.email) state = await signIn(browser, { ...info.project.use, baseURL: info.project.use.baseURL }, role.email);
    });
    const page = async (browser: Browser, info: { project: { use: BrowserContextOptions } }) => (await browser.newContext({ ...info.project.use, storageState: state })).newPage();

    for (const route of role.routes) {
      test(route, async ({ browser }, info) => {
        test.setTimeout(120_000);
        const p = await page(browser, info);
        // Close the context: one per test otherwise piles up and the browser slows until it stalls.
        try { await check(p, route, role.name, info.project.name); } finally { await p.context().close(); }
      });
    }
    if (role.dynamic?.length) {
      test("detail pages", async ({ browser }, info) => {
        test.setTimeout(300_000);
        const p = await page(browser, info);
        const routes: string[] = [];
        for (const [from, re] of role.dynamic!) {
          const href = await firstLink(p, from, re);
          if (href) routes.push(href);
        }
        const failures: string[] = [];
        for (const r of routes) {
          try {
            await check(p, r, role.name, info.project.name);
          } catch (e) {
            failures.push(String((e as Error).message).split("\n").slice(0, 12).join("\n"));
          }
        }
        await p.context().close();
        expect(failures).toEqual([]);
      });
    }
  });
}
