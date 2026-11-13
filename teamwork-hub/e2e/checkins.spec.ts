import "dotenv/config";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { login, USERS } from "./helpers";

/**
 * Session check-ins in the browser: an athlete does the ready check and the after check, and the
 * coach sees the readiness strip on the session roster (run against `pnpm build && pnpm start`
 * seeded with `pnpm db:fresh`, at desktop and 390px).
 *
 * The check-in windows depend on the clock, so each project adds its own two synthetic sessions
 * for Maya straight into the database (DATABASE_URL): one that starts in 90 minutes and one that
 * ended an hour ago. Set SHOTS=1 to save screenshots under docs/screenshots/checkins/.
 */
test.describe.configure({ mode: "serial" });

const noSideScroll = async (page: Page) => {
  // Compare with the configured viewport, not innerWidth: on a phone a too-wide page widens innerWidth with it.
  const vw = page.viewportSize()?.width ?? 0;
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${page.url()} scrolls sideways`).toBeLessThanOrEqual(vw + 1);
};
const shot = async (page: Page, project: string, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `docs/screenshots/checkins/${project}-${name}.png`, fullPage: true });
};
const pick = (page: Page, name: string, value: string | number) => page.locator(`input[name="${name}"][value="${value}"]`).check({ force: true });

const fx: Record<string, { upcomingSession: string; upcomingBooking: string; doneBooking: string }> = {};

test.beforeAll(async ({}, info) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const one = async (q: string, p: unknown[] = []) => (await pool.query(q, p)).rows[0];
    const org = await one(`select id, timezone from organizations where slug = 'teamwork-demo'`);
    const maya = await one(`select a.id from athletes a join people p on p.id = a.person_id where a.org_id = $1 and p.first_name = 'Maya' and p.last_name = 'Parker'`, [org.id]);
    const coach = await one(`select id from users where email = $1`, [USERS.marcus]);
    const svc = await one(`select id from service_types where org_id = $1 and name = 'Group Performance Training' limit 1`, [org.id]);
    const session = async (title: string, startMin: number, endMin: number, status: string, athleteId: string = maya.id) => {
      const s = await one(
        `insert into schedule_sessions (org_id, service_type_id, title, starts_at, ends_at, timezone, coach_user_id, capacity, is_demo)
         values ($1, $2, $3, now() + $4 * interval '1 minute', now() + $5 * interval '1 minute', $6, $7, 12, true) returning id`,
        [org.id, svc.id, title, startMin, endMin, org.timezone, coach.id],
      );
      const b = await one(
        `insert into bookings (org_id, session_id, athlete_id, status, entitlement_source, checked_in_at, check_in_method, is_demo)
         values ($1, $2, $3, $4, 'comp', case when $4 = 'attended' then now() - interval '2 hours' end, case when $4 = 'attended' then 'staff' end, true) returning id`,
        [org.id, s.id, athleteId, status],
      );
      return { sessionId: s.id as string, bookingId: b.id as string };
    };
    const up = await session(`Check-in demo (${info.project.name})`, 90, 150, "booked");
    const done = await session(`Check-in demo, finished (${info.project.name})`, -120, -60, "attended");
    // Eli (demo kiosk PIN 2580) is booked on a class that started two minutes ago.
    const eli = await one(`select a.id from athletes a join people p on p.id = a.person_id where a.org_id = $1 and p.first_name = 'Eli' and p.last_name = 'Parker'`, [org.id]);
    await session(`Kiosk demo (${info.project.name})`, -2, 58, "booked", eli.id);
    fx[info.project.name] = { upcomingSession: up.sessionId, upcomingBooking: up.bookingId, doneBooking: done.bookingId };
  } finally {
    await pool.end();
  }
});

test("athlete does the ready check and the after check; the old feedback link lands on the after check", async ({ page }, info) => {
  const f = fx[info.project.name];
  await login(page, USERS.maya);

  // Offered on Athlete Home.
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Session check-ins" })).toBeVisible();
  await expect(page.locator(`a[href="/check-ins/${f.upcomingBooking}/ready"]`).first()).toBeVisible();

  // Ready check: one screen.
  await page.goto(`/check-ins/${f.upcomingBooking}/ready`);
  await expect(page.getByRole("heading", { level: 1, name: "Before your session" })).toBeVisible();
  await noSideScroll(page);
  await pick(page, "readiness", 4);
  // Sleep is skipped when today's wellness check-in already has it.
  if (await page.locator('input[name="sleepQuality"]').count()) await pick(page, "sleepQuality", 3);
  await page.locator("#soreness").fill("7");
  await expect(page.getByText("Very sore", { exact: true })).toBeVisible();
  await expect(page.getByText("That is pretty sore.")).toBeVisible();
  await pick(page, "hurt", "yes");
  await page.locator('select[name="spotRegion"]').selectOption("knee");
  await page.locator('select[name="spotSide"]').selectOption("left");
  await pick(page, "spotType", "sharp");
  await expect(page.getByRole("alert").filter({ hasText: "Please tell your coach and a parent now" })).toBeVisible();
  await page.getByLabel(/Anything your coach should know today/).fill(`Tweaked it at practice (sample, ${info.project.name})`);
  await noSideScroll(page);
  await shot(page, info.project.name, "ready-check");
  await page.getByRole("button", { name: "I am ready" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  // Reload: it is now a correctable answer, not a second check-in.
  await page.reload();
  await expect(page.getByRole("button", { name: "Update ready check" })).toBeVisible();
  await expect(page.locator('input[name="readiness"][value="4"]')).toBeChecked();

  // After check for the session that just ended.
  await page.goto(`/check-ins/${f.doneBooking}/after`);
  await expect(page.getByRole("heading", { level: 1, name: "How was your session?" })).toBeVisible();
  await pick(page, "rpe", 7);
  await pick(page, "liked", "lifting");
  await pick(page, "liked", "my_coach");
  await page.locator("#dislikedText").fill(`More time on sprints please (sample, ${info.project.name})`);
  await pick(page, "hurt", "no");
  await page.locator("#soreness").fill("4");
  await pick(page, "rating", 4);
  await noSideScroll(page);
  await shot(page, info.project.name, "after-check");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Thank you. Your answers were saved." })).toBeVisible();

  // The old ten-second feedback link still works and lands on the same check-in.
  await page.goto(`/feedback/${f.doneBooking}`);
  await expect(page).toHaveURL(new RegExp(`/check-ins/${f.doneBooking}/after$`));
  await expect(page.locator('input[name="rating"][value="4"]')).toBeChecked();
  await expect(page.locator('input[name="rpe"][value="7"]')).toBeChecked();

  // History and trends.
  await page.goto("/check-ins");
  await expect(page.getByRole("heading", { level: 1, name: "My check-ins" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How I have been feeling" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent sessions" })).toBeVisible();
  await noSideScroll(page);
  await shot(page, info.project.name, "athlete-trends");
});

test("coach sees the readiness strip with the pain flag; the front desk sees only that there is a note", async ({ page }, info) => {
  const f = fx[info.project.name];
  await login(page, USERS.marcus);
  await page.goto(`/schedule/sessions/${f.upcomingSession}`);
  const strip = page.locator("#readiness");
  await expect(strip.getByText("Ready checks: 1 of 1")).toBeVisible();
  const row = strip.getByTestId("readiness-row").filter({ hasText: "Maya Parker" });
  await expect(row.getByText("Ready 4/5")).toBeVisible();
  await expect(row.getByText(/Sore 7\/10/)).toBeVisible();
  await expect(row.getByText("Sharp pain: Left knee")).toBeVisible();
  await expect(row.getByText(/Tweaked it at practice/)).toBeVisible();
  await noSideScroll(page);
  await strip.getByLabel(/Planned intensity/).fill("6");
  await strip.getByRole("button", { name: "Save" }).click();
  await expect(strip.getByText("Planned intensity saved: 6 of 10.")).toBeVisible();
  await shot(page, info.project.name, "coach-strip");

  // Details page, and the same alert list on the follow-ups queue.
  await row.getByRole("link", { name: /Details/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Maya Parker" })).toBeVisible();
  await expect(page.getByText("Left knee: sharp pain, 3 of 10")).toBeVisible();
  await page.goto("/follow-ups");
  await expect(page.getByRole("heading", { name: "Session check-ins to look at" })).toBeVisible();
  await page.goto("/check-ins");
  await expect(page.getByRole("heading", { name: "My classes" })).toBeVisible();
  await noSideScroll(page);
  await shot(page, info.project.name, "coach-classes");

  // Front desk (no health access): completion and "has a note", nothing else.
  await page.context().clearCookies();
  await login(page, USERS.erin);
  await page.goto(`/schedule/sessions/${f.upcomingSession}`);
  const ops = page.locator("#readiness").getByTestId("readiness-row").filter({ hasText: "Maya Parker" });
  await expect(ops.getByText("Ready check done")).toBeVisible();
  await expect(ops.getByText("Has a note for the coach")).toBeVisible();
  await expect(page.locator("#readiness")).not.toContainText("knee");
  await expect(page.locator("#readiness")).not.toContainText("Tweaked");
  await expect(page.locator("#readiness")).not.toContainText("7/10");
});

test("kiosk: after a PIN check-in the ready check takes a few taps, then the pad is back with nothing left on screen", async ({ page }, info) => {
  await login(page, USERS.kiosk);
  await page.goto("/kiosk");
  await page.locator("#kiosk-pin").fill("2580");
  await page.locator("#kiosk-pin").press("Enter");
  const panel = page.getByRole("region", { name: "Quick ready check" });
  await expect(panel.getByRole("heading", { name: `Quick ready check for Kiosk demo (${info.project.name})? Four taps.` })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Skip" })).toBeVisible();
  await noSideScroll(page);
  await panel.getByRole("group", { name: "How ready do you feel today?" }).getByRole("button", { name: /Good/ }).click();
  await panel.getByRole("group", { name: "How did you sleep last night?" }).getByRole("button", { name: /OK/ }).click();
  await panel.getByRole("button", { name: "2 of 10" }).click();
  await panel.getByRole("button", { name: "No, all good" }).click();
  await shot(page, info.project.name, "kiosk-ready-check");
  await panel.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText("Thanks! Have a great session.")).toBeVisible();
  // It closes by itself; the next athlete sees an empty PIN pad and no name.
  await expect(page.locator("#kiosk-pin")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#kiosk-pin")).toHaveValue("");
  await expect(page.getByText("Thanks! Have a great session.")).toHaveCount(0);
  await expect(page.getByText(/checked in, Eli/)).toHaveCount(0);
  // A second PIN entry for the same class offers no second ready check.
  await page.locator("#kiosk-pin").fill("2580");
  await page.locator("#kiosk-pin").press("Enter");
  await expect(page.getByText(/Hi Eli/).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Quick ready check" })).toHaveCount(0);
});
