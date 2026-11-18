import "dotenv/config";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { login, USERS } from "./helpers";

/**
 * A coach replacing an answer the family already gave (run against `pnpm build && pnpm start`
 * seeded with `pnpm db:fresh`, at desktop and 390px).
 *
 * Each project adds its own synthetic finished session for Ava Parker (under 13, so her parent
 * Chris may answer how hard it was) straight into the database (DATABASE_URL), coached by Tess Morales.
 * Ava is used so the sessions other specs add for Maya, Eli and Leo are untouched.
 * Set SHOTS=1 to save screenshots under docs/screenshots/tighten/.
 */
test.describe.configure({ mode: "serial" });

const TESS = "tess.demo@teamwork-hub.test"; // coaches the youth group Ava is in (Marcus does not, and is refused)

const noSideScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth), `${page.url()} scrolls sideways`).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `docs/screenshots/tighten/${test.info().project.name}-coach-replace-${name}.png`, fullPage: true });
};
const pick = (page: Page, name: string, value: string | number) => page.locator(`input[name="${name}"][value="${value}"]`).check({ force: true });
const query = async <T>(q: string, p: unknown[] = []): Promise<T> => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    return (await pool.query(q, p)).rows[0] as T;
  } finally {
    await pool.end();
  }
};

const fx: Record<string, { sessionId: string; bookingId: string }> = {};

test.beforeAll(async ({}, info) => {
  const org = await query<{ id: string; timezone: string }>(`select id, timezone from organizations where slug = 'teamwork-demo'`);
  const ava = await query<{ id: string }>(`select a.id from athletes a join people p on p.id = a.person_id where a.org_id = $1 and p.first_name = 'Ava' and p.last_name = 'Parker'`, [org.id]);
  const coach = await query<{ id: string }>(`select id from users where email = $1`, [TESS]);
  const svc = await query<{ id: string }>(`select id from service_types where org_id = $1 and name = 'Group Performance Training' limit 1`, [org.id]);
  const s = await query<{ id: string }>(
    `insert into schedule_sessions (org_id, service_type_id, title, starts_at, ends_at, timezone, coach_user_id, capacity, is_demo)
     values ($1, $2, $3, now() - interval '150 minutes', now() - interval '90 minutes', $4, $5, 12, true) returning id`,
    [org.id, svc.id, `Coach replace demo (${info.project.name})`, org.timezone, coach.id],
  );
  const b = await query<{ id: string }>(
    `insert into bookings (org_id, session_id, athlete_id, status, entitlement_source, checked_in_at, check_in_method, is_demo)
     values ($1, $2, $3, 'attended', 'comp', now() - interval '150 minutes', 'staff', true) returning id`,
    [org.id, s.id, ava.id],
  );
  fx[info.project.name] = { sessionId: s.id, bookingId: b.id };
});

test("a coach replaces a parent's effort answer: tick and reason are required, the earlier answer shows as Replaced, and the family page says entered by coach", async ({ page }, info) => {
  const f = fx[info.project.name];

  // The parent answers how hard it was for Ava (5 of 10).
  await login(page, USERS.chris);
  await page.goto(`/check-ins/${f.bookingId}/after`);
  await expect(page.getByRole("heading", { level: 1, name: "How was Ava's session?" })).toBeVisible();
  await expect(page.getByText("You are answering for Ava")).toBeVisible();
  await pick(page, "rpe", 5);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator('input[name="rpe"][value="5"]')).toBeChecked();
  await expect(page.getByRole("button", { name: "Update my answers" })).toBeVisible();
  await expect(page.getByTestId("entered-by-coach")).toHaveCount(0);
  const stored = await query<{ rpe: number; role: string }>(`select rpe, answered_by->>'role' as role from session_checkins where booking_id = $1 and phase = 'post'`, [f.bookingId]);
  expect(stored.rpe).toBe(5);
  expect(stored.role).not.toBe("coach");

  // The coach opens the entry page: the effort is already answered by a parent, and replacing it has a tick and a reason.
  await page.context().clearCookies();
  await login(page, TESS);
  await page.goto(`/check-ins/${f.bookingId}/coach`);
  const card = page.locator("#after");
  await expect(card.getByText(/How hard it was:\s*answered by/)).toBeVisible();
  const tick = card.locator('input[name="replace"]');
  await expect(tick).toHaveCount(1);
  await expect(tick).not.toBeChecked();
  await expect(card.getByText(/Their answer is kept on the record and shown as replaced/)).toBeVisible();
  await noSideScroll(page);

  // 1. No tick: refused, nothing changes.
  await pick(page, "rpe", 8);
  await card.getByRole("button", { name: "Save the after check for Ava" }).click();
  await expect(card.getByText(/Tick the box to replace their answer and say why/)).toBeVisible();
  expect((await query<{ rpe: number }>(`select rpe from session_checkins where booking_id = $1 and phase = 'post'`, [f.bookingId])).rpe).toBe(5);

  // 2. Tick but no reason: refused, nothing changes.
  await tick.check();
  await card.getByRole("button", { name: "Save the after check for Ava" }).click();
  await expect(card.getByText(/Say why you are replacing the athlete's own answer/)).toBeVisible();
  expect((await query<{ rpe: number }>(`select rpe from session_checkins where booking_id = $1 and phase = 'post'`, [f.bookingId])).rpe).toBe(5);
  await shot(page, "needs-reason");

  // 3. Tick and reason: saved as entered by the coach.
  await expect(tick).toBeChecked();
  await expect(page.locator('input[name="rpe"][value="8"]')).toBeChecked();
  await card.locator("#replaceReason").fill("Ava told me it felt much harder (sample)");
  await card.getByRole("button", { name: "Save the after check for Ava" }).click();
  await expect(card.getByText(/Saved as entered by you/)).toBeVisible();
  await expect(card.getByText(/How hard it was:\s*answered by coach Tess Morales/)).toBeVisible();
  // A coach correcting their own entry needs no tick any more.
  await expect(card.locator('input[name="replace"]')).toHaveCount(0);
  await noSideScroll(page);

  // The response page shows the earlier answer as "Replaced": who, why, and the earlier value.
  const row = await query<{ id: string; rpe: number; n: number }>(`select id, rpe, jsonb_array_length(replacements)::int as n from session_checkins where booking_id = $1 and phase = 'post'`, [f.bookingId]);
  expect(row.rpe).toBe(8);
  expect(row.n).toBe(1);
  await page.goto(`/check-ins/responses/${row.id}`);
  const replaced = page.getByTestId("checkin-replaced");
  await expect(replaced).toHaveCount(1);
  await expect(replaced).toContainText("coach Tess Morales replaced the answer");
  await expect(replaced).toContainText("for how hard it was");
  await expect(replaced).toContainText("Reason: Ava told me it felt much harder (sample)");
  await expect(page.getByText("Replaced", { exact: true })).toBeVisible();
  await expect(page.getByText(/Earlier answer:.*rpe 5/)).toBeVisible();
  await expect(page.getByTestId("entered-by-coach")).toContainText("how hard it was (Tess Morales");
  await noSideScroll(page);
  await shot(page, "response");

  // The family page says a coach entered it and that it replaced an earlier answer; the parent is not asked the effort again.
  await page.context().clearCookies();
  await login(page, USERS.chris);
  await page.goto(`/check-ins/${f.bookingId}/after`);
  await expect(page.getByText("Entered by coach Tess Morales", { exact: true })).toBeVisible();
  const note = page.getByTestId("entered-by-coach");
  await expect(note).toContainText("entered by coach Tess Morales from what Ava told them at the gym");
  await expect(note).toContainText("It replaced an earlier answer, which is kept on the record.");
  await expect(page.locator('input[name="rpe"]')).toHaveCount(0);
  await noSideScroll(page);
  await shot(page, "family");
});
