import { expect, test, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * Bar-speed (VBT) surfaces in the browser. Run against `pnpm build && pnpm start` seeded with
 * `pnpm db:fresh` (the seed adds synthetic bar speeds for Maya's Back Squat and Bench Press).
 * The confirm flow changes data once, so it runs in the desktop project only and tolerates a rerun.
 */
test.describe.configure({ mode: "serial" });

async function openMaya(page: Page) {
  await page.goto("/training/athletes");
  await page.getByRole("link", { name: "Maya Parker" }).first().click();
  await expect(page).toHaveURL(/\/training\/athletes\/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { level: 1, name: "Maya Parker" })).toBeVisible();
  return page.url();
}

/** Next Monday in the facility timezone: the seeded "Lower" day, which has Back Squat. */
function nextMonday(): string {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Indiana/Indianapolis" }).format(new Date());
  const d = new Date(`${ymd}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== 1);
  return d.toISOString().slice(0, 10);
}

test("coach reviews bar-speed max suggestions: dismiss one, confirm one, and it is saved as an estimate", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "changes data once; desktop only");
  await login(page, USERS.marcus);
  await openMaya(page);
  const card = page.locator("#vbt-max-card");
  await expect(card.getByRole("heading", { name: "Estimated max from bar speed" })).toBeVisible();
  await expect(card).toContainText("lv_profile_v1");
  await expect(card).toContainText("never a tested max");

  const bench = card.getByTestId("vbt-suggestion-Bench Press");
  if (await bench.isVisible()) {
    await bench.getByRole("button", { name: /Dismiss/ }).click();
    await expect(bench).toHaveCount(0);
    await expect(card.getByTestId("vbt-decisions")).toContainText(/Dismissed: Bench Press, [\d.]+ kg estimate, nothing stored/);
  }
  const squat = card.getByTestId("vbt-suggestion-Back Squat");
  if (await squat.isVisible()) {
    await expect(squat).toContainText("estimate");
    await expect(squat).toContainText(/Current max: \d+ lb \(tested/);
    await squat.getByRole("button", { name: /Confirm as estimated max/ }).click();
    await expect(squat).toHaveCount(0);
  }
  await expect(card.getByTestId("vbt-decisions")).toContainText(/Confirmed: Back Squat, [\d.]+ lb saved as an estimate from bar speed/);
  // Max history: the new row is an estimate from bar speed, and the tested rows are still there.
  const history = page.getByRole("table", { name: "Max history" });
  const row = history.getByRole("row").filter({ hasText: "Estimated from bar speed" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Back Squat");
  await expect(row).toContainText("estimated");
  await expect(row).not.toContainText("Tested 1RM");
  // No bench max was stored by dismissing.
  await expect(history.getByRole("row").filter({ hasText: "Bench Press" }).filter({ hasText: "bar speed" })).toHaveCount(0);

  // Relative strength is on the same page for the coach, and labels the estimate.
  const rel = page.locator("#rel-strength-card");
  await expect(rel).toContainText("rel_strength_v1");
  await expect(rel).toContainText("Body weight used");
  await expect(rel.getByRole("listitem").filter({ hasText: "Back Squat" })).toContainText("estimated from bar speed");
  await expect(rel.getByRole("listitem").filter({ hasText: "Power Clean" })).toContainText(/\d\.\d\d× body weight/);
});

test("families see neither the suggestion card nor relative strength or body weight", async ({ page }, info) => {
  await login(page, USERS.marcus);
  const url = await openMaya(page);
  await expect(page.locator("#vbt-max-card")).toBeVisible();
  await expect(page.locator("#rel-strength-card")).toBeVisible();
  await page.context().clearCookies();

  for (const who of [USERS.jordan, USERS.alex] as const) {
    await login(page, who);
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1, name: "Maya Parker" })).toBeVisible();
    await expect(page.locator("#vbt-max-card")).toHaveCount(0);
    await expect(page.locator("#rel-strength-card")).toHaveCount(0);
    const body = await page.locator("main").innerText();
    expect(body).not.toMatch(/body weight|61\.2|× body/i);
    // A confirmed estimate (after the desktop run) is labelled as one, never as tested.
    const est = page.getByRole("table", { name: "Max history" }).getByRole("row").filter({ hasText: "bar speed" });
    if (info.project.name === "desktop") await expect(est).toContainText("estimated");
    await page.goto("/leaderboards");
    expect(await page.locator("main").innerText()).not.toMatch(/bar speed|61\.2/i);
    await page.context().clearCookies();
  }
});

test("weight room shows a live %1RM next to bar speed only where the athlete has enough data", async ({ page }) => {
  await login(page, USERS.marcus);
  await page.goto(`/training/weight-room?date=${nextMonday()}`);
  await page.getByRole("button", { name: /^Maya Parker:/ }).click();
  await page.getByRole("button", { name: /Back Squat/ }).click();
  const speed = page.getByLabel("Speed (m/s)").first();
  await expect(speed).toBeVisible();
  await expect(page.getByTestId("vbt-pct")).toHaveCount(0); // nothing until a speed is typed
  await speed.fill("0.75");
  const pct = page.getByTestId("vbt-pct").first();
  await expect(pct).toContainText("About 67.3% of 1RM");
  await expect(pct).toContainText("mpv_squat_v1");
  await expect(pct).toContainText("not a tested max");
  await speed.fill("");
  await expect(page.getByTestId("vbt-pct")).toHaveCount(0);

  // Leo has no bar-speed data: the field is there, but no estimate is guessed.
  await page.getByRole("button", { name: "← All athletes" }).click();
  await page.getByRole("button", { name: /^Leo Rivera:/ }).click();
  await page.getByRole("button", { name: /Back Squat/ }).click();
  await page.getByLabel("Speed (m/s)").first().fill("0.75");
  await expect(page.getByTestId("vbt-pct")).toHaveCount(0);
});
