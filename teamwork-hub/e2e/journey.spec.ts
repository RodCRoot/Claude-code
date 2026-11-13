import { expect, test, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * Member journey: follow-ups queue, profile panel, operations checklist, coach scorecard, report
 * and settings (run against `pnpm build && pnpm start` seeded with `pnpm db:fresh`, at desktop
 * and 390px). The seeded members are synthetic: Nora Quill (new), Theo Marsh (nearly through
 * onboarding, no-show yesterday), June Abara (on hold), Dex Moreno (cancelling).
 */
const noSideScroll = async (page: Page) => {
  // Compare with the configured viewport, not innerWidth: on a phone a too-wide page widens innerWidth with it.
  const vw = page.viewportSize()?.width ?? 0;
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${page.url()} scrolls sideways`).toBeLessThanOrEqual(vw + 1);
};

test("owner works the follow-ups queue and a member's journey panel", async ({ page }, info) => {
  await login(page, USERS.rod);
  await page.goto("/follow-ups");
  await expect(page.getByRole("heading", { level: 1, name: "Today's follow-ups" })).toBeVisible();
  await noSideScroll(page);
  // Grouped by type, with billing steps visible to the owner.
  await expect(page.getByRole("list", { name: "Onboarding steps" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Hold steps" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Offboarding steps" })).toBeVisible();
  const queue = page.locator("main");
  await expect(queue.getByText("Final bill settled").first()).toBeHidden(); // not due yet (7 days after the cancellation)
  await expect(queue.getByRole("link", { name: "Nora Quill", exact: true }).first()).toBeVisible();

  // Filter by owner role and by type.
  await page.getByLabel("Type").selectOption("hold");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/kind=hold/);
  await expect(page.getByRole("list", { name: "Onboarding steps" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Hold steps" }).getByRole("link", { name: "June Abara", exact: true })).toBeVisible();
  await page.goto("/follow-ups");

  // Yesterday's no-show, with log-a-reach-out.
  const noShows = page.locator("#no-shows");
  await expect(noShows.getByRole("link", { name: "Theo Marsh", exact: true })).toBeVisible();
  await noShows.getByText("Log a reach-out").first().click();
  await noShows.getByLabel(/What you did and what they said/).first().fill(`Called home, back on Thursday (sample, ${info.project.name}).`);
  await noShows.getByRole("button", { name: "Save reach-out" }).first().click();
  await expect(noShows.getByText("Reach-out logged.")).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Last reach-out logged .* by /).first()).toBeVisible();

  // Open Nora's profile: the journey panel shows onboarding with auto-ticked and open steps.
  await page.getByRole("list", { name: "Onboarding steps" }).getByRole("link", { name: "Nora Quill", exact: true }).first().click();
  await expect(page).toHaveURL(/\/people\/[0-9a-f-]{36}$/);
  const panel = page.locator("#journey");
  await expect(panel.getByRole("heading", { name: /Onboarding/ })).toBeVisible();
  await expect(panel.getByText("Ticked automatically").first()).toBeVisible(); // payment method, first session booked, coach assigned
  await expect(panel.getByText("Visit milestones")).toBeVisible();
  await noSideScroll(page);

  // One-tap complete on a step nobody else in this run touches (one per viewport so both runs act).
  const key = info.project.name === "mobile" ? "bring_a_friend" : "thank_you_card";
  const row = panel.locator(`li[data-step="${key}"]`);
  if (await row.getByRole("button", { name: /^Done/ }).count()) {
    await row.getByRole("button", { name: /^Done/ }).click();
    await expect(row.getByText("Done", { exact: true })).toBeVisible();
  } else {
    await expect(row.getByText(/Done|Skipped/).first()).toBeVisible(); // already resolved by an earlier run
  }
  // Snooze another step, with the reason and assign controls present.
  const welcome = panel.locator('li[data-step="welcome_message"]');
  if (await welcome.getByText("Skip, snooze or assign").count()) {
    await welcome.getByText("Skip, snooze or assign").click();
    await expect(welcome.getByLabel("Skip: reason")).toBeVisible();
    await expect(welcome.getByLabel("Assign to")).toBeVisible();
    await welcome.getByLabel("Snooze for").selectOption("1");
    await welcome.getByRole("button", { name: "Snooze", exact: true }).click();
    await expect(welcome.getByText(/Snoozed/).first()).toBeVisible();
  }
  // A message step links to the normal compose page; nothing is sent from the journey.
  await expect(panel.getByRole("link", { name: /Write a message/ }).first()).toHaveAttribute("href", /\/messages\/new\?athlete=/);
});

test("coach sees only their athletes, never billing steps, and keeps a weekly scorecard", async ({ page }, info) => {
  await login(page, USERS.marcus);
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Today's follow-ups" })).toBeVisible();
  await page.goto("/follow-ups");
  await expect(page.getByText("Billing steps are handled by the front desk")).toBeVisible();
  const main = page.locator("main");
  await expect(main.getByRole("link", { name: "Theo Marsh", exact: true }).first()).toBeVisible(); // assigned to marcus
  await expect(main.getByRole("link", { name: "Nora Quill", exact: true })).toHaveCount(0); // tess's athlete
  await expect(main.getByText("Payment method on file")).toHaveCount(0);
  await expect(main.getByText("Final bill settled")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Journey report" })).toHaveCount(0);
  await noSideScroll(page);

  await page.goto("/follow-ups/report");
  await expect(page.getByRole("heading", { level: 1, name: "Journey report" })).toHaveCount(0);
  await page.goto("/settings/journey");
  await expect(page.getByRole("heading", { level: 1, name: "Member journey" })).toHaveCount(0);

  await page.goto("/follow-ups/scorecard");
  await expect(page.getByRole("heading", { level: 1, name: "Coach weekly scorecard" })).toBeVisible();
  await expect(page.getByText("Session utilisation", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Client reach-outs logged")).toBeVisible();
  await page.getByLabel("What went well").fill(`Groups were full (sample, ${info.project.name}).`);
  await page.getByLabel("What help is needed").fill("Time blocked for check-in calls (sample).");
  await page.getByRole("button", { name: "Save reflection" }).click();
  await expect(page.getByText("Reflection saved.")).toBeVisible();
  await noSideScroll(page);

  // The operations checklist is open to whoever is on shift.
  await page.goto("/follow-ups/checklist");
  await expect(page.getByRole("heading", { level: 1, name: "Operations checklist" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit the list" })).toHaveCount(0);
});

test("owner: operations checklist, every coach's scorecard, report, settings and the nightly job", async ({ page }) => {
  await login(page, USERS.rod);
  await page.goto("/follow-ups/checklist");
  await expect(page.getByRole("heading", { level: 2, name: "Closing" })).toBeVisible();
  await expect(page.getByRole("list", { name: /^Completion for / })).toBeVisible();
  await noSideScroll(page);
  // Tick a closing item, then put it back so the next run starts the same.
  const btn = (verb: "Done" | "Undo") => page.getByRole("button", { name: new RegExp(`^${verb}\\s*: Lost property collected$`) });
  if (await btn("Undo").count()) await btn("Undo").click();
  await btn("Done").click();
  await expect(btn("Undo")).toBeVisible();
  await expect(page.getByText(/Done by .* at /).first()).toBeVisible();
  await btn("Undo").click();
  await expect(btn("Done")).toBeVisible();

  await page.goto("/follow-ups/scorecard");
  await expect(page.getByRole("heading", { level: 2, name: /Marcus/ })).toBeVisible();
  await page.getByRole("link", { name: "Previous week" }).click();
  await expect(page.getByText("Evening groups were full", { exact: false })).toBeVisible(); // seeded reflection the owner can read

  await page.goto("/follow-ups/report");
  for (const caption of ["Onboarding completion rate and time by month", "Touchpoints on time and late by month", "Milestones recognised and missed by month"]) await expect(page.getByRole("table", { name: caption })).toBeVisible();
  await noSideScroll(page);

  await page.goto("/settings/journey");
  await expect(page.getByRole("heading", { level: 1, name: "Member journey" })).toBeVisible();
  for (const name of ["Onboarding", "Touchpoints", "Visit milestones", "Review and referral asks", "Hold", "Offboarding"]) await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
  await expect(page.locator("#template-onboarding").getByText("Default", { exact: true }).first()).toBeVisible();
  await expect(page.locator("#template-touchpoints").getByLabel("Due after").first()).toHaveValue("6");
  await expect(page.locator("#template-visit_milestones").getByLabel("Visits").nth(7)).toHaveValue("1000");
  await noSideScroll(page);

  await page.goto("/settings/jobs");
  await expect(page.getByRole("row").filter({ hasText: "Member journey" })).toBeVisible();
});
