import { expect, test } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * On Your Own in the browser (run against `pnpm build && pnpm start` seeded with `pnpm db:fresh`):
 * the save-and-retry path when the connection drops at Finish, what a guardian sees, and the
 * under-13 rule in the library.
 */
const SAFETY = "Stop if anything hurts and tell your coach or a parent.";

test("athlete finishes a session with no connection; it is kept on the device and sent once when back online", async ({ page, context }) => {
  await login(page, USERS.maya);
  await page.goto("/anywhere");
  await expect(page.getByRole("heading", { name: "From your coach" })).toBeVisible();
  await page.getByRole("link", { name: /Start\s*: Hotel Room 15/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Hotel Room 15" })).toBeVisible();
  await page.waitForURL(/\/anywhere\/sessions\//);
  await expect(page.getByRole("note").filter({ hasText: SAFETY })).toBeVisible();
  const finish = page.getByRole("button", { name: "Finish session" });
  await expect(finish).toBeDisabled();
  await page.locator("ol input[type=checkbox]").first().check();
  await page.locator("ol input[type=checkbox]").nth(1).check();
  // Ticks survive a reload (kept on the device).
  await page.reload();
  await expect(page.getByText("2 of 6 done")).toBeVisible();

  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/anywhere/complete")) posts.push(r.postData() ?? "");
  });
  await context.setOffline(true);
  await finish.click();
  await expect(page.getByText("It is saved on this device and will send when you are back online.")).toBeVisible();
  await context.setOffline(false);
  // The queue retries by itself when the browser reports it is back online.
  await expect(page.getByText("Saved. It counts toward your weekly streak")).toBeVisible({ timeout: 15_000 });
  // One completion key was used for every attempt.
  const keys = new Set(posts.map((p) => (JSON.parse(p) as { items: { clientKey: string }[] }).items[0].clientKey));
  expect(keys.size).toBe(1);
  await page.getByRole("link", { name: "Back to On Your Own" }).click();
  await expect(page.getByRole("heading", { name: "Done recently" })).toBeVisible();
  await expect(page.getByText("2 of 6 steps").first()).toBeVisible();
});

test("guardian can read a session but not finish it; an under-13 athlete only gets suitable sessions", async ({ page }) => {
  await login(page, USERS.alex);
  await page.goto("/anywhere");
  await page.getByRole("navigation", { name: "Choose athlete" }).getByRole("link", { name: "Maya" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Field Speed Starts" })).toBeVisible();
  await page.getByRole("link", { name: /View\s*: Core Four/ }).first().click();
  await page.waitForURL(/\/anywhere\/sessions\//);
  await expect(page.getByRole("note").filter({ hasText: SAFETY })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish session" })).toHaveCount(0);
  await expect(page.getByText("Athletes tick steps and finish sessions from their own login.")).toBeVisible();

  await page.goto("/anywhere");
  await page.getByRole("navigation", { name: "Choose athlete" }).getByRole("link", { name: "Eli" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Youth Agility Play" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Field Speed Starts" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 3, name: "Bodyweight Strength Circuit" })).toHaveCount(0);
});

test("a parent logs an at-home session and its effort rating for a child under 13; the coach sees it was logged by a parent", async ({ page }) => {
  await login(page, USERS.alex);
  await page.goto("/anywhere");
  // Maya is 15: view only. Eli is 12 and Alex has training and booking access: Start.
  await page.getByRole("navigation", { name: "Choose athlete" }).getByRole("link", { name: "Eli" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Youth Agility Play" })).toBeVisible();
  await page.getByRole("link", { name: /Start\s*: Youth Agility Play/ }).first().click();
  await page.waitForURL(/\/anywhere\/sessions\//);
  await expect(page.getByRole("note").filter({ hasText: SAFETY })).toBeVisible();
  await expect(page.getByTestId("parent-logging-note")).toContainText("You are logging this for Eli");
  const finish = page.getByRole("button", { name: "Finish session" });
  await expect(finish).toBeDisabled();
  await page.locator("ol input[type=checkbox]").first().check();
  await page.getByLabel("How many minutes did it take Eli?").fill("14");
  await page.getByRole("group", { name: /How hard did it feel for Eli/ }).locator('label:has(input[value="4"])').click();
  await finish.click();
  await expect(page.getByText("Saved for Eli. It counts toward Eli's weekly streak, and the coach can see that a parent logged it.")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("link", { name: "Back to On Your Own" }).click();
  await expect(page.getByRole("heading", { name: "Done recently" })).toBeVisible();
  await expect(page.getByText(/14 min · effort 4 · logged by a parent/).first()).toBeVisible();

  // Staff review queue shows who logged it.
  await page.context().clearCookies();
  await login(page, USERS.rod);
  await page.goto("/training/anywhere");
  const row = page.getByRole("row").filter({ hasText: "Youth Agility Play" }).filter({ hasText: "Logged by parent" }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText("Eli");
});

test("staff are sent to the coach library; signed-out visitors cannot post completions", async ({ page, request }) => {
  const res = await request.post("/api/anywhere/complete", { data: { items: [] } });
  expect(res.status()).toBe(401);
  await login(page, USERS.marcus);
  await page.goto("/anywhere");
  await expect(page).toHaveURL(/\/training\/anywhere$/);
  await expect(page.getByRole("heading", { name: "Who has a game in the next 48 hours" })).toHaveCount(0);
  await page.goto("/training");
  await expect(page.getByRole("heading", { name: "Who has a game in the next 48 hours" })).toBeVisible();
});
