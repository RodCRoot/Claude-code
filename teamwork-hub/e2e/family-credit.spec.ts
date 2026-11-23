import { expect, test, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * Family rate sibling credit (owner's decision 2026-11-23). Run against `pnpm build && pnpm start`
 * seeded with `pnpm db:fresh`. Read-only: nothing is saved.
 * Set SHOTS=1 to save screenshots under docs/screenshots/credit/.
 */
const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `docs/screenshots/credit/${test.info().project.name}-${name}.png` });
};
const noSideScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth), `${page.url()} scrolls sideways`).toBeLessThanOrEqual(page.viewportSize()!.width + 1);

test("Membership policy has the sibling credit setting, on by default and not waiting for confirmation", async ({ page }) => {
  await login(page, USERS.rod);
  await page.goto("/settings");
  const box = page.locator('input[type=checkbox][name="familyRateSiblingCredit"]');
  await expect(box).toBeChecked();
  const label = page.locator("label", { has: box });
  await expect(label).toContainText("Family rate: credit existing members when the rate goes up mid-period");
  await expect(label).toContainText("Nothing is charged back when the rate goes down");
  await expect(label).not.toContainText("Needs confirmation");
  await label.scrollIntoViewIfNeeded();
  await shot(page, "setting");
  await noSideScroll(page);
});

test("the membership history says what a sibling credit was for", async ({ page }) => {
  await login(page, USERS.rod);
  await page.goto("/billing/memberships");
  // In the demo seed Eli is enrolled after Maya's current period was billed, so Maya has a credit.
  // (The seed is relative to today; on a day when Maya's period is not billed yet there is none.)
  await page.locator('a[href^="/billing/memberships/"]', { hasText: "Maya" }).first().click();
  await page.waitForURL(/\/billing\/memberships\/[0-9a-f-]{36}/);
  const events = page.getByTestId("family-credit-event");
  test.skip((await events.count()) === 0, "the seed granted no sibling credit today");
  await expect(events.first()).toContainText(/Sibling credit \$\d+\.\d{2} for the next bill: family rate 0% to 10%, \d+ of \d+ days left in the period already billed/);
  await events.first().scrollIntoViewIfNeeded();
  await shot(page, "history");
  await noSideScroll(page);
});
