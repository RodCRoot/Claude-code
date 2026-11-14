import "dotenv/config";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { login, USERS } from "./helpers";

/**
 * Coach-entered check-ins in the browser (run against `pnpm build && pnpm start` seeded with
 * `pnpm db:fresh`, at desktop and 390px).
 *
 * The windows depend on the clock, not the weekday, so each project adds its own synthetic
 * sessions for Leo Rivera straight into the database (DATABASE_URL): one that started ten minutes
 * ago (ready check: closed for the family, still open for the coach at the gym) and one that ended
 * an hour ago (after check). Leo is used so the sessions other specs add for Maya are untouched.
 * Set SHOTS=1 to save screenshots under docs/screenshots/golive/.
 */
test.describe.configure({ mode: "serial" });

const SAM = "sam.rivera@example.test"; // Leo's parent (demo login, health access)
// Compared with the viewport, not innerWidth: a too-wide page widens innerWidth with it on a phone.
const noSideScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth), `${page.url()} scrolls sideways`).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
const shot = async (page: Page, project: string, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `docs/screenshots/golive/${project}-coach-entry-${name}.png`, fullPage: true });
};
/**
 * The coach-entry page is only reachable from a roster, two hops from any static page, so the route
 * sweep in a11y.spec.ts cannot find it. Same rule set as that sweep (WCAG 2.0/2.1 A and AA).
 */
const axeClean = async (page: Page) => {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `axe violations on ${page.url()}`).toEqual([]);
};
const pick = (page: Page, name: string, value: string | number) => page.locator(`input[name="${name}"][value="${value}"]`).check({ force: true });

const fx: Record<string, { runningSession: string; runningBooking: string; doneSession: string; doneBooking: string }> = {};

test.beforeAll(async ({}, info) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const one = async (q: string, p: unknown[] = []) => (await pool.query(q, p)).rows[0];
    const org = await one(`select id, timezone from organizations where slug = 'teamwork-demo'`);
    const leo = await one(`select a.id from athletes a join people p on p.id = a.person_id where a.org_id = $1 and p.first_name = 'Leo' and p.last_name = 'Rivera'`, [org.id]);
    const coach = await one(`select id from users where email = $1`, [USERS.marcus]);
    const svc = await one(`select id from service_types where org_id = $1 and name = 'Group Performance Training' limit 1`, [org.id]);
    const session = async (title: string, startMin: number, endMin: number, status: string) => {
      const s = await one(
        `insert into schedule_sessions (org_id, service_type_id, title, starts_at, ends_at, timezone, coach_user_id, capacity, is_demo)
         values ($1, $2, $3, now() + $4 * interval '1 minute', now() + $5 * interval '1 minute', $6, $7, 12, true) returning id`,
        [org.id, svc.id, title, startMin, endMin, org.timezone, coach.id],
      );
      const b = await one(
        `insert into bookings (org_id, session_id, athlete_id, status, entitlement_source, checked_in_at, check_in_method, is_demo)
         values ($1, $2, $3, $4, 'comp', case when $4 = 'attended' then now() - interval '2 hours' end, case when $4 = 'attended' then 'staff' end, true) returning id`,
        [org.id, s.id, leo.id, status],
      );
      return { sessionId: s.id as string, bookingId: b.id as string };
    };
    const running = await session(`Coach entry demo (${info.project.name})`, -10, 50, "booked");
    const done = await session(`Coach entry demo, finished (${info.project.name})`, -120, -60, "attended");
    fx[info.project.name] = { runningSession: running.sessionId, runningBooking: running.bookingId, doneSession: done.sessionId, doneBooking: done.bookingId };
  } finally {
    await pool.end();
  }
});

test("coach enters the ready check from the roster; it is labelled as entered by the coach for staff and for the family", async ({ page }, info) => {
  const f = fx[info.project.name];
  await login(page, USERS.marcus);
  await page.goto(`/schedule/sessions/${f.runningSession}`);
  const row = page.locator("#readiness").getByTestId("readiness-row").filter({ hasText: "Leo Rivera" });
  await expect(row.getByText("No ready check yet")).toBeVisible();
  await row.getByRole("link", { name: /Enter for Leo Rivera/ }).click();
  await page.waitForURL(new RegExp(`/check-ins/${f.runningBooking}/coach`));
  await expect(page.getByRole("heading", { level: 1, name: "Check-in for Leo Rivera" })).toBeVisible();
  await expect(page.getByText("You are entering this for the athlete")).toBeVisible();
  // The after check is not open yet for a session that is still running.
  await expect(page.getByTestId("coach-after-closed")).toContainText("checked in");
  await noSideScroll(page);
  await axeClean(page);

  const ready = page.locator("#ready");
  await pick(page, "readiness", 4);
  await pick(page, "sleepQuality", 3);
  await ready.locator("#soreness").fill("2");
  await pick(page, "hurt", "no");
  await ready.locator("#note").fill("Told me he feels good (sample)");
  await shot(page, info.project.name, "form");
  await ready.getByRole("button", { name: "Save the ready check for Leo" }).click();
  await expect(ready.getByText(/Saved as entered by you/)).toBeVisible();
  await expect(ready.getByText(/Answered by coach Marcus Hale/)).toBeVisible();
  await noSideScroll(page);

  // Roster strip: the answers, and who entered them.
  await page.goto(`/schedule/sessions/${f.runningSession}`);
  const after = page.locator("#readiness").getByTestId("readiness-row").filter({ hasText: "Leo Rivera" });
  await expect(after.getByText("Ready 4/5")).toBeVisible();
  await expect(after.getByTestId("entered-by-coach")).toHaveText(/Entered by coach Marcus Hale/);
  await expect(after.getByRole("link", { name: /Enter or correct for Leo Rivera/ })).toBeVisible();
  await noSideScroll(page);
  await shot(page, info.project.name, "strip");
  // Response page.
  await after.getByRole("link", { name: /Details/ }).click();
  await expect(page.getByTestId("entered-by-coach")).toContainText("the ready check (Marcus Hale");
  await noSideScroll(page);

  // The front desk has no health access: no answers, no entry link, but it still says who entered it.
  await page.context().clearCookies();
  await login(page, USERS.erin);
  await page.goto(`/schedule/sessions/${f.runningSession}`);
  const ops = page.locator("#readiness").getByTestId("readiness-row").filter({ hasText: "Leo Rivera" });
  await expect(ops.getByText("Ready check done")).toBeVisible();
  await expect(ops.getByTestId("entered-by-coach")).toContainText("Entered by coach Marcus Hale");
  await expect(ops.getByRole("link", { name: /Enter/ })).toHaveCount(0);
  await expect(page.locator("#readiness")).not.toContainText("4/5");
  await page.goto(`/check-ins/${f.runningBooking}/coach`);
  await expect(page.getByRole("heading", { level: 1, name: "Check-in for Leo Rivera" })).toHaveCount(0);

  // The parent sees that the coach entered it.
  await page.context().clearCookies();
  await login(page, SAM);
  await page.goto(`/check-ins/${f.runningBooking}/ready`);
  // Leo is over 13, so his parent cannot answer the ready check; the page still says who entered it.
  await expect(page.getByTestId("entered-by-coach")).toContainText("Entered by coach Marcus Hale");
  await noSideScroll(page);
});

test("after check: the coach enters effort with no rating and no show-my-coach tick; the parent sees who entered it", async ({ page }, info) => {
  const f = fx[info.project.name];
  await login(page, USERS.marcus);
  await page.goto(`/check-ins/${f.doneBooking}/coach`);
  const card = page.locator("#after");
  await expect(card.getByText(/How hard it was:\s*not answered yet/)).toBeVisible();
  await expect(card.getByText(/The 1 to 5 rating is left to Leo or a parent/)).toBeVisible();
  await expect(card.locator('input[name="tellCoach"]')).toHaveCount(0);
  await expect(card.locator('input[name="rating"]')).toHaveCount(0);
  await axeClean(page);
  await pick(page, "rpe", 7);
  await card.getByRole("button", { name: "Save the after check for Leo" }).click();
  await expect(card.getByText(/Saved as entered by you/)).toBeVisible();
  await expect(card.getByText(/How hard it was:\s*answered by coach Marcus Hale/)).toBeVisible();
  await noSideScroll(page);
  await shot(page, info.project.name, "after");

  // The session page reports the effort, and the athlete's trends say who entered it.
  await page.goto(`/schedule/sessions/${f.doneSession}`);
  await expect(page.locator("#readiness")).toContainText("Reported: 7 of 10 (1 athlete)");
  await page.goto(`/check-ins/${f.doneBooking}/coach`);
  // A coach correcting a coach entry needs no replacement tick.
  await expect(page.locator("#after").locator('input[name="replace"]')).toHaveCount(0);

  // The parent's page says part of it was entered by the coach, and still offers the parent their own part.
  await page.context().clearCookies();
  await login(page, SAM);
  await page.goto(`/check-ins/${f.doneBooking}/after`);
  await expect(page.getByTestId("entered-by-coach")).toContainText("entered by coach Marcus Hale");
  await expect(page.locator('input[name="rpe"]')).toHaveCount(0);
  await noSideScroll(page);
});
