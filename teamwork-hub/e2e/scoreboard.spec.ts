import { expect, test, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * Owner scoreboard (run against `pnpm build && pnpm start` seeded with `pnpm db:fresh`, which
 * includes the synthetic history seed). Runs at desktop and 390px. Read-only except for saving
 * the same "ideal" back, so it can be re-run on the same database.
 * Set SHOTS=1 to refresh docs/screenshots/scoreboard/.
 */
const noSideScroll = async (page: Page) => {
  // Compare with the configured viewport, not innerWidth: on a phone a too-wide page widens innerWidth with it.
  const vw = page.viewportSize()?.width ?? 0;
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${page.url()} scrolls sideways`).toBeLessThanOrEqual(vw + 1);
};
const dollars = (s: string) => Math.round(Number(s.replace(/[^0-9.]/g, "")) * 100);
const shot = async (page: Page, name: string, project: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `docs/screenshots/scoreboard/${name}-${project}.png`, fullPage: false });
};

test("owner: daily numbers open the rows behind them and reconcile", async ({ page }, info) => {
  await login(page, USERS.rod);
  await page.goto("/scoreboard");
  await expect(page.getByRole("heading", { level: 1, name: "Owner scoreboard" })).toBeVisible();
  await noSideScroll(page);
  await shot(page, "daily", info.project.name);

  // Every export link is a download.
  await expect(page.getByRole("link", { name: "Export CSV" }).first()).toHaveAttribute("download", "");

  // Past due: the four aging buckets add up to the headline total.
  const pastDue = page.locator('[data-metric="past_due"]');
  const total = dollars(await pastDue.getByRole("link").innerText());
  const buckets = await pastDue.locator("li span.tabular").allInnerTexts();
  expect(buckets).toHaveLength(4);
  expect(buckets.map(dollars).reduce((a, b) => a + b, 0)).toBe(total);
  expect(total).toBeGreaterThan(0);

  // Active members: the tile's people / memberships match the list behind it.
  const active = page.locator('[data-metric="active_members"]');
  const people = Number((await active.getByRole("link").innerText()).replace(/\D/g, ""));
  const memberships = Number(/(\d+) memberships/.exec(await active.innerText())![1]);
  await active.getByRole("link").click();
  await expect(page).toHaveURL(/\/scoreboard\/list\/active_members/);
  await expect(page.getByRole("heading", { level: 1, name: "Active members" })).toBeVisible();
  await expect(page.getByText(new RegExp(`^${memberships} rows as of now`))).toBeVisible();
  await expect(page.getByText("Definition (v1)")).toBeVisible();
  expect(people).toBeLessThanOrEqual(memberships);
  await noSideScroll(page);

  // The definitions drawer states how a number is computed, with its version.
  await page.goto("/scoreboard");
  await page.getByText(/^Definitions: how each number is computed/).click();
  await expect(page.locator("#def-projected_next_month")).toContainText("not on hold");
  await expect(page.locator("#def-at_risk")).toContainText("not a second definition");
  await expect(page.locator("#def-past_due")).toContainText("v1");

  // The filter narrows every tile the same way; lead numbers are withheld, not shown unfiltered.
  await page.locator("#sb-location").selectOption({ label: "Linton" });
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/location=[0-9a-f-]{36}/);
  await expect(page.getByText(/^Filter on:/)).toBeVisible();
  const filtered = Number((await page.locator('[data-metric="active_members"]').getByRole("link").innerText()).replace(/\D/g, ""));
  expect(filtered).toBeLessThan(people);
  await expect(page.locator('[data-metric="new_leads_24h"]')).toContainText("n/a");
  await expect(page.locator('[data-metric="open_pipeline"]')).toContainText("Not available with a location filter");
  await noSideScroll(page);
});

test("owner: monthly funnel, bottleneck rule and editable ideals", async ({ page }, info) => {
  await login(page, USERS.rod);
  await page.goto("/scoreboard/monthly");
  await expect(page.getByRole("heading", { level: 1, name: "Monthly funnel" })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "Net growth (sold minus lost)" })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "Plan changes / rebuilds (not losses)" })).toBeVisible();
  await expect(page.getByTestId("bottleneck-headline")).not.toBeEmpty();
  await expect(page.getByTestId("bottleneck-rule")).toContainText(/^Rule: |^No rule could run/);
  await expect(page.getByText("Only a rule of thumb")).toBeVisible();
  await noSideScroll(page);
  await shot(page, "monthly", info.project.name);

  const ideal = page.getByLabel("Ideal for Leads");
  const before = await ideal.inputValue();
  await ideal.fill(before || "14");
  await page.getByRole("button", { name: "Save ideals" }).click();
  await expect(page.getByText("Ideal targets saved.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Export CSV" }).first()).toHaveAttribute("download", "");
});

test("owner: schedule flags, payroll, marketing and money views", async ({ page }, info) => {
  await login(page, USERS.rod);
  await page.goto("/scoreboard/efficiency");
  await expect(page.getByRole("heading", { level: 1, name: "Schedule and payroll" })).toBeVisible();
  await expect(page.locator('tr[data-flag="full"]').first()).toContainText("Consider adding capacity");
  await expect(page.locator('tr[data-flag="under"]').first()).toContainText("Consider combining");
  // A month with no time-clock data is "not available", never $0.
  await expect(page.getByText("not available: no time-clock entries").first()).toBeVisible();
  await noSideScroll(page);
  await shot(page, "efficiency", info.project.name);

  await page.goto("/scoreboard/marketing");
  await expect(page.getByRole("heading", { level: 1, name: "Marketing economics" })).toBeVisible();
  await expect(page.getByText("Gross revenue, not profit").first()).toBeVisible();
  await expect(page.getByText("Lifetime revenue : acquisition cost")).toBeVisible();
  await noSideScroll(page);
  await shot(page, "marketing", info.project.name);

  await page.goto("/scoreboard/money");
  await expect(page.getByRole("heading", { level: 1, name: "Money view" })).toBeVisible();
  await expect(page.getByText("A management estimate, not accounting").first()).toBeVisible();
  await expect(page.getByText("entered by hand").first()).toBeVisible();
  for (const link of await page.getByRole("link", { name: "Export CSV" }).all()) await expect(link).toHaveAttribute("download", "");
  await noSideScroll(page);
  await shot(page, "money", info.project.name);
});

test("Today links to the scoreboard for owner and operations, not for a coach; expiring cards open their list", async ({ page }, info) => {
  await login(page, USERS.rod);
  await page.goto("/today");
  await page.getByRole("main").getByRole("link", { name: "Owner scoreboard" }).click();
  await expect(page).toHaveURL(/\/scoreboard$/);
  await expect(page.getByRole("heading", { level: 1, name: "Owner scoreboard" })).toBeVisible();

  // Saved cards expiring: the tile's number is the length of the list behind it, and each row opens the payer's methods.
  const tile = page.locator('[data-metric="cards_expiring"]');
  await expect(tile).toContainText("Saved cards expiring within 60 days");
  const n = Number((await tile.getByRole("link").innerText()).replace(/\D/g, ""));
  expect(n).toBeGreaterThan(0); // the demo seed has a card that expires this month
  await tile.getByRole("link").click();
  await expect(page).toHaveURL(/\/scoreboard\/list\/cards_expiring/);
  await expect(page.locator("main tbody tr")).toHaveCount(n);
  await expect(page.locator("main tbody tr").first().getByRole("link").first()).toHaveAttribute("href", /^\/billing\/payment-methods\?payer=/);
  await noSideScroll(page);
  await shot(page, "cards-expiring-list", info.project.name);

  // The same cards are on the front desk's follow-ups queue, as a card that is not a journey step.
  await page.goto("/follow-ups");
  const card = page.locator("#expiring-cards");
  await expect(card.getByRole("heading", { name: "Saved cards about to expire" })).toBeVisible();
  await expect(card.locator("li")).toHaveCount(n);
  await noSideScroll(page);
  await shot(page, "follow-ups-expiring-cards", info.project.name);
  await page.context().clearCookies();

  await login(page, USERS.erin);
  await page.goto("/today");
  await expect(page.getByRole("main").getByRole("link", { name: "Owner scoreboard" })).toBeVisible();
  await page.context().clearCookies();

  await login(page, USERS.marcus);
  await page.goto("/today");
  await expect(page.getByRole("main").getByRole("link", { name: "Owner scoreboard" })).toHaveCount(0);
  await page.goto("/follow-ups");
  await expect(page.locator("#expiring-cards")).toHaveCount(0);
});

test("operations sees the scoreboard without payroll; coaches are refused", async ({ page }) => {
  await login(page, USERS.erin);
  await page.goto("/scoreboard/efficiency");
  await expect(page.getByText("Payroll figures are restricted")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save thresholds" })).toHaveCount(0);
  await page.goto("/scoreboard/money");
  await expect(page.locator("#margin")).toContainText("Restricted");
  await page.context().clearCookies();

  await login(page, USERS.marcus);
  await page.goto("/scoreboard");
  await expect(page).toHaveURL(/\/denied/);
  await page.goto("/scoreboard/list/past_due");
  await expect(page).toHaveURL(/\/denied/);
  const res = await page.request.get("/api/scoreboard/daily");
  expect(res.status()).toBe(403);
});
