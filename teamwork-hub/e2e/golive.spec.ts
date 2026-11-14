import { expect, test, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * Go-live readiness page (run against `pnpm build && pnpm start` seeded with `pnpm db:fresh`).
 * The page is computed from real state, so the spec asserts shapes and the items a demo server can
 * never have (demo mode, sample wording) rather than exact counts. The one thing it writes (an
 * attestation) is withdrawn again, and an earlier leftover is tolerated.
 */
test.describe.configure({ mode: "serial" });

// Compared with the viewport, not innerWidth: a too-wide page widens innerWidth with it on a phone.
const noSideScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth), `${page.url()} scrolls sideways`).toBeLessThanOrEqual(page.viewportSize()!.width + 1);

test("owner sees what is left, grouped, with honest statuses; the Today card links to it", async ({ page }) => {
  await login(page, USERS.rod);
  await page.goto("/today");
  const card = page.getByTestId("golive-today-card");
  await expect(card).toContainText(/Go-live: \d+ blocking items?/);
  await noSideScroll(page);
  await card.click();
  await page.waitForURL(/\/settings\/go-live/);

  await expect(page.getByRole("heading", { level: 1, name: "Go-live readiness" })).toBeVisible();
  await expect(page.getByTestId("golive-summary")).toHaveText(/^\d+ of \d+ done; \d+ blocks? going live$/);
  for (const name of ["Hosting and safety", "Payments", "Messages", "Legal text", "Catalog and policy", "Data migration", "People", "Open decisions"]) {
    await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  }
  // A demo server is in demo mode: that item can never be green here, and it blocks.
  const mode = page.locator('[data-item="hosting.app_mode"]');
  await expect(mode).toHaveAttribute("data-status", "attention");
  await expect(mode).toContainText("Blocks going live");
  await expect(mode).toContainText("Needs attention");
  // Sample wording is listed item by item.
  await expect(page.locator('[data-item="legal.wording.ach_mandate"]')).toHaveAttribute("data-status", "attention");
  await expect(page.locator('[data-item^="legal.form."]').first()).toBeVisible();
  // System-checked items offer no tick.
  await expect(mode.getByText("Record this yourself")).toHaveCount(0);
  await expect(page.locator('[data-item="payments.stripe_keys"]').locator("details")).toHaveCount(0);
  await noSideScroll(page);
});

test("a tick is recorded as attested by a named person and can be withdrawn", async ({ page }) => {
  await login(page, USERS.rod);
  await page.goto("/settings/go-live");
  const row = page.locator('[data-item="messages.rules_reviewed"]');
  if (await row.getByRole("button", { name: "Withdraw" }).count()) {
    await row.getByRole("button", { name: "Withdraw" }).click();
    await expect(row).toHaveAttribute("data-status", "not_started");
  }
  await row.locator("summary").click();
  // Submitting without ticking the statement is refused.
  await row.getByRole("button", { name: "Record" }).click();
  await expect(row.getByRole("alert")).toContainText("Tick the box");
  await row.getByRole("checkbox").check();
  await row.getByLabel(/Note/).fill("Checked with the front desk (e2e)");
  await row.getByRole("button", { name: "Record" }).click();
  await expect(row).toHaveAttribute("data-status", "done");
  await expect(row).toContainText("Attested by a person");
  await expect(row).toContainText("Rod");
  await noSideScroll(page);
  await row.getByRole("button", { name: "Withdraw" }).click();
  await expect(row).toHaveAttribute("data-status", "not_started");
});

test("operations and families cannot open the page and get no Today card", async ({ page }) => {
  for (const who of [USERS.erin, USERS.alex]) {
    await page.context().clearCookies();
    await login(page, who);
    await page.goto("/today");
    await expect(page.getByTestId("golive-today-card")).toHaveCount(0);
    await page.goto("/settings/go-live");
    await expect(page.getByRole("heading", { level: 1, name: "Go-live readiness" })).toHaveCount(0);
  }
});
