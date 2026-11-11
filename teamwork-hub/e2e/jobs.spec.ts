import { expect, test } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * Scheduled jobs status page and the referral wording after the owner's 2026-11-11 decision
 * (run against `pnpm build && pnpm start` seeded with `pnpm db:fresh`).
 */
test("owner sees the scheduled jobs, runs one now and gets its result; operations cannot open the page", async ({ page }) => {
  await login(page, USERS.rod);
  await page.goto("/settings/jobs");
  await expect(page.getByRole("heading", { level: 1, name: "Scheduled jobs" })).toBeVisible();
  for (const name of ["Referral progress", "Team challenge completions", "Goals, XP and badges", "Monthly recaps"]) await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Goals, XP and badges" });
  await row.getByRole("button", { name: /Run now/ }).click();
  await expect(row.getByText("Completed", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("athletes checked");
  await expect(row).not.toContainText("Never");

  await page.context().clearCookies();
  await login(page, USERS.erin);
  await page.goto("/settings/jobs");
  await expect(page.getByRole("heading", { level: 1, name: "Scheduled jobs" })).toHaveCount(0);
});

test("referral pages say what each family gets: $50 credit for the referrer, $50 off the first invoice for the new family", async ({ page }) => {
  await page.goto("/r/parkerdemo26");
  await expect(page.getByTestId("new-family-offer")).toContainText("$50.00 off their first invoice");
  // The same offer text is shown for a code that does not exist (the page never looks codes up).
  await page.goto("/r/zzzzzzzzzz");
  await expect(page.getByTestId("new-family-offer")).toContainText("$50.00 off their first invoice");

  await login(page, USERS.alex);
  await page.goto("/refer");
  await expect(page.getByText("a $50.00 account credit")).toBeVisible();
  await expect(page.getByTestId("friend-reward")).toContainText("$50.00 off their first invoice");

  await page.context().clearCookies();
  await login(page, USERS.rod);
  await page.goto("/settings/growth");
  await expect(page.getByLabel("Off the new family's first invoice ($)")).toHaveValue("50.00");
  await page.goto("/people/referrals");
  await expect(page.getByText("$50.00 off first invoice").first()).toBeVisible();
});
