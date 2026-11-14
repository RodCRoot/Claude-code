import type { Page } from "@playwright/test";

export const PASSWORD = "teamwork-demo-1";

export async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

export const USERS = {
  rod: "rod.demo@teamwork-hub.test",
  erin: "erin.demo@teamwork-hub.test",
  marcus: "marcus.demo@teamwork-hub.test",
  alex: "alex.parker@example.test",
  jordan: "jordan.parker@example.test",
  chris: "chris.parker@example.test",
  maya: "maya.parker@example.test",
  kiosk: "kiosk.demo@teamwork-hub.test",
};
