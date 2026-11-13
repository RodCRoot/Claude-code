import "dotenv/config";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { login, USERS } from "./helpers";

/**
 * The guided sign-up in the browser, in NOT-CONFIGURED mode (no Stripe keys), at desktop and 390px:
 * a parent chooses a plan, the front desk witnesses the membership agreement in person, the payment step
 * shows the honest "not available yet" state, the parent chooses to pay each bill, and the confirmation
 * shows the first bill. Run against `pnpm build && pnpm start` seeded with `pnpm db:fresh`.
 *
 * There is no fake-provider mode in this app's browser test setup (provider flows are covered by signed
 * webhook fixtures in vitest), so no saved method is created here.
 *
 * Each project gets its own synthetic athlete on Chris Parker's account (inserted through DATABASE_URL).
 * The athlete's required waivers are marked complete in the database so the spec exercises the agreement.
 * Set SHOTS=1 to save screenshots under docs/screenshots/signup/.
 */
test.describe.configure({ mode: "serial" });

const noSideScroll = async (page: Page) => {
  // Compare with the configured viewport, not innerWidth: on a phone a too-wide page widens innerWidth with it.
  const vw = page.viewportSize()?.width ?? 0;
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${page.url()} scrolls sideways`).toBeLessThanOrEqual(vw + 1);
};
const shot = async (page: Page, project: string, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `docs/screenshots/signup/${project}-${name}.png`, fullPage: true });
};

const fx: Record<string, { athleteId: string; first: string; flowUrl?: string }> = {};
let pool: Pool;

test.beforeAll(async ({}, info) => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const one = async (q: string, p: unknown[] = []) => (await pool.query(q, p)).rows[0];
  const org = await one(`select id from organizations where slug = 'teamwork-demo'`);
  const chris = await one(`select person_id from users where email = $1`, [USERS.chris]);
  const payer = await one(`select pa.payer_account_id as id from payer_authorizations pa where pa.person_id = $1 and pa.can_pay limit 1`, [chris.person_id]);
  const first = `Signup${info.project.name === "desktop" ? "Desk" : "Phone"}${Date.now().toString(36).slice(-4)}`;
  const person = await one(`insert into people (org_id, first_name, last_name, date_of_birth, is_demo) values ($1, $2, 'Sample', current_date - interval '13 years', true) returning id`, [org.id, first]);
  const athlete = await one(`insert into athletes (org_id, person_id, is_demo) values ($1, $2, true) returning id`, [org.id, person.id]);
  await pool.query(`insert into guardianships (org_id, guardian_person_id, athlete_id, relationship) values ($1, $2, $3, 'parent')`, [org.id, chris.person_id, athlete.id]);
  await pool.query(`insert into payer_beneficiaries (payer_account_id, athlete_id) values ($1, $2)`, [payer.id, athlete.id]);
  fx[info.project.name] = { athleteId: athlete.id, first };
});

test.afterAll(async () => {
  await pool.end();
});

test("parent chooses a plan; the agreement is filled in from the plan", async ({ page }, info) => {
  const f = fx[info.project.name];
  await login(page, USERS.chris);
  await page.goto("/billing/signup");
  await expect(page.getByRole("heading", { name: "Sign up for a membership" })).toBeVisible();
  const card = page.locator("li", { hasText: `${f.first} Sample` });
  await card.getByRole("button", { name: "Choose a plan" }).click();
  await page.waitForURL(/\/billing\/signup\/[0-9a-f-]{36}/);
  f.flowUrl = new URL(page.url()).pathname;
  await expect(page.getByRole("heading", { name: "1. Choose a plan" })).toBeVisible();
  await noSideScroll(page);
  await shot(page, info.project.name, "1-plan");
  await page.locator('input[name="productVersionId"]').first().check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "2. Review and sign" })).toBeVisible();
  await expect(page.getByText("Membership agreement for this plan")).toBeVisible();
  // Nothing was billed by choosing a plan.
  const m = (await pool.query(`select m.id, m.status, m.agreement_state, (select count(*)::int from invoices i where i.membership_id = m.id) as invoices from memberships m where m.athlete_id = $1 and m.status <> 'cancelled'`, [f.athleteId])).rows[0];
  expect(m).toMatchObject({ status: "pending", agreement_state: "awaiting", invoices: 0 });
  // The seeded required waivers are not what this spec is about: mark them complete for this athlete.
  await pool.query(
    `update form_requests fr set status = 'completed', completed_at = now() from form_template_versions v join form_templates t on t.id = v.template_id
     where v.id = fr.template_version_id and fr.athlete_id = $1 and t.kind <> 'membership_agreement'`,
    [f.athleteId],
  );
  await page.reload();
  await noSideScroll(page);
  await shot(page, info.project.name, "2-documents");
  // The parent opens the agreement: real plan values, sample-text label, no merge braces.
  await page.getByRole("link", { name: "Review and sign" }).first().click();
  await page.waitForURL(/\/documents\/requests\//);
  const body = page.locator("main");
  await expect(body).toContainText("SAMPLE TEXT");
  await expect(body).toContainText(`${f.first} Sample`);
  await expect(body).toContainText("Cancellation requires");
  await expect(body).not.toContainText("{{");
  await expect(page.getByText("Part of a membership sign-up")).toBeVisible();
  await noSideScroll(page);
  await shot(page, info.project.name, "3-agreement");
});

test("front desk witnesses the signature in person", async ({ page }, info) => {
  const f = fx[info.project.name];
  await login(page, USERS.erin);
  await page.goto("/billing/signup");
  await expect(page.getByRole("heading", { name: "Sign up a member" })).toBeVisible();
  await page.getByRole("link", { name: `${f.first} Sample` }).click();
  await page.waitForURL(/\/billing\/signup\/[0-9a-f-]{36}/);
  await expect(page.getByRole("img", { name: "QR code that opens this sign-up" })).toBeVisible();
  await noSideScroll(page);
  await shot(page, info.project.name, "4-staff-handover");
  await page.getByRole("link", { name: "Review and sign" }).first().click();
  await page.waitForURL(/\/documents\/requests\//);
  const card = page.locator("#sign-in-person");
  await card.locator('select[name="inPersonPick"]').selectOption({ index: 0 });
  await card.locator('input[name="consent"]').check();
  await card.locator('input[name="typedName"]').fill("Chris Parker");
  await card.locator('input[name="identityAttested"]').check();
  await card.getByRole("button", { name: /sign/i }).click();
  await expect(page.locator("#top").getByText("completed")).toBeVisible();
  const row = (await pool.query(`select agreement_state from memberships where athlete_id = $1 and status <> 'cancelled'`, [f.athleteId])).rows[0];
  expect(row.agreement_state).toBe("signed");
});

test("payment step is honest about Stripe not being connected; parent finishes and sees the first bill", async ({ page }, info) => {
  const f = fx[info.project.name];
  await login(page, USERS.chris);
  await page.goto(f.flowUrl!);
  await expect(page.getByRole("heading", { name: "3. How you will pay" })).toBeVisible();
  await expect(page.getByText("Saving a card or bank account is not available yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a card" })).toHaveCount(0);
  await noSideScroll(page);
  await shot(page, info.project.name, "5-payment-not-configured");
  await page.getByRole("button", { name: "I will pay each bill myself" }).click();
  await expect(page.getByRole("heading", { name: "4. Confirm" })).toBeVisible();
  await expect(page.getByText(/Your first bill is/)).toBeVisible();
  await expect(page.getByText(/Nothing is charged automatically/)).toBeVisible();
  await page.getByRole("button", { name: "Finish sign-up" }).click();
  await expect(page.getByRole("heading", { name: `Welcome, ${f.first}!` })).toBeVisible();
  await expect(page.getByRole("link", { name: "Reserve a class" })).toBeVisible();
  await noSideScroll(page);
  await shot(page, info.project.name, "6-confirmation");
  // No charge, no attempt, no saved method: only an open bill (when one is due) on the family's account.
  const r = (
    await pool.query(
      `select (select count(*)::int from payment_attempts a join invoices i on i.id = a.invoice_id join memberships m on m.id = i.membership_id where m.athlete_id = $1) as attempts,
              (select count(*)::int from invoices i join memberships m on m.id = i.membership_id where m.athlete_id = $1 and i.status = 'paid' and i.total_minor > 0) as paid,
              (select status from signup_flows where athlete_id = $1) as flow`,
      [f.athleteId],
    )
  ).rows[0];
  expect(r).toMatchObject({ attempts: 0, paid: 0, flow: "completed" });
  // Payment Methods page: honest state, no add buttons.
  await page.goto("/billing/payment-methods");
  await expect(page.getByText("Saving a card or bank account is not available yet").first()).toBeVisible();
  await noSideScroll(page);
  await shot(page, info.project.name, "7-payment-methods");
});

test("a view-only guardian cannot start a sign-up", async ({ page }) => {
  await login(page, USERS.jordan);
  await page.goto("/billing/signup");
  await expect(page.getByText("Nothing to sign up here")).toBeVisible();
});
