import { expect, test } from "@playwright/test";
import { login, USERS } from "./helpers";

test("signed-out users are redirected to login", async ({ page }) => {
  await page.goto("/people");
  await expect(page).toHaveURL(/\/login/);
});

test("wrong password shows a generic error", async ({ page }) => {
  await page.goto("/login");
  await page.fill("#email", "nobody@example.test");
  await page.fill("#password", "nope");
  await page.click("button[type=submit]");
  await expect(page.locator("form [role=alert]")).toContainText("incorrect");
});

test("guardian cannot open the staff directory or an unrelated child's page", async ({ page }) => {
  await login(page, USERS.chris);
  await page.goto("/people");
  await expect(page).toHaveURL(/\/denied/);
  await page.goto("/today");
  await expect(page.getByText("Ava Parker").first()).toBeVisible();
  await expect(page.getByText("Maya Parker")).toHaveCount(0);
});

test("coach is denied financial reports and settings", async ({ page }) => {
  await login(page, USERS.marcus);
  await page.goto("/reports/collections");
  await expect(page).toHaveURL(/\/denied/);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/denied/);
});

test("staff registers an athlete; duplicate email is flagged, not merged; record persists after reload", async ({ page }) => {
  await login(page, USERS.erin);
  await page.goto("/people/new");
  const stamp = Date.now().toString().slice(-6);
  await page.fill("#firstName", "Quinn");
  await page.fill("#lastName", `Test${stamp}`);
  await page.fill("#gFirstName", "Chris");
  await page.fill("#gLastName", "Parker");
  await page.fill("#gEmail", "chris.parker@example.test");
  await page.click("text=Register athlete >> nth=-1");
  await expect(page.locator("form [role=alert]")).toContainText("Possible existing record");
  await page.check("input[name=confirmDuplicates]");
  await page.click("text=Register athlete >> nth=-1");
  await page.waitForURL(/\/people\/[0-9a-f-]{36}/);
  await page.reload();
  await expect(page.locator("h1")).toContainText(`Quinn Test${stamp}`);
});
