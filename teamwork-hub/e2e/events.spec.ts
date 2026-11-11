import { expect, test, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * Camps and clinics, family side (run against `pnpm build && pnpm start` seeded with
 * `pnpm db:fresh`). The desktop project registers Maya for the sample camp and the mobile project
 * (390px) registers her for the sample clinic, so the two runs do not depend on each other.
 * A second run on the same database finds the spot already held and checks that state instead.
 */
const noSideScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

test("a parent finds a camp, registers an athlete, and lands on an unpaid invoice with the spot held", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const eventName = mobile ? "Sample: Change of Direction Clinic" : "Sample: Holiday Speed Camp";
  await login(page, USERS.alex);

  // Reachable from the shop.
  await page.goto("/shop");
  await expect(page.getByRole("heading", { name: "Camps and clinics" })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(eventName) })).toBeVisible();
  await page.getByRole("link", { name: "See all" }).click();
  await expect(page).toHaveURL(/\/shop\/camps$/);
  await expect(page.getByRole("heading", { level: 1, name: "Camps and clinics" })).toBeVisible();

  // The list shows published events with dates, ages, price and spots left; the draft is not there.
  const item = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: eventName }) });
  await expect(item).toBeVisible();
  await expect(item.getByText(/spots? left/)).toBeVisible();
  await expect(item.getByText(/\$\d+\.\d{2}/).first()).toBeVisible();
  await expect(page.getByText("Sample: Spring Combine Prep Camp")).toHaveCount(0);
  await noSideScroll(page);

  await item.getByRole("link", { name: /Details and registration|View registration/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: eventName })).toBeVisible();
  await expect(page.getByText(/of \d+ left/)).toBeVisible();
  await noSideScroll(page);

  const maya = page.getByRole("checkbox", { name: /Maya Parker/ });
  if (await maya.count()) {
    // Nothing chosen yet: the total is zero and the server refuses an empty registration.
    await expect(page.getByTestId("event-total")).toHaveText("$0.00");
    await maya.check();
    await expect(page.getByTestId("event-total")).toHaveText(mobile ? "$45.00" : "$160.00");
    await page.getByRole("button", { name: /^Register/ }).click();
    await expect(page).toHaveURL(/registered=1/);
    await expect(page.getByText("Spot held for Maya")).toBeVisible();
  }

  // Held, not confirmed: a redirect back to this page never confirms anything.
  await expect(page.getByText(/Nothing has been charged/).first()).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Maya Parker" }).getByText("Awaiting payment")).toBeVisible();
  await expect(page.getByText(/is registered|are registered/)).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /Maya Parker/ })).toHaveCount(0);
  await noSideScroll(page);

  // The invoice is a normal open invoice in the existing billing flow.
  await page.getByRole("link", { name: /Continue to payment|View bill/ }).first().click();
  await expect(page).toHaveURL(/\/billing\/invoices\/[0-9a-f-]{36}/);
  await expect(page.getByText(new RegExp(`${eventName}: Maya Parker`)).first()).toBeVisible();
  await expect(page.getByText(/open/i).first()).toBeVisible();
  await noSideScroll(page);

  // Reloading the event page with the "registered" flag still shows an unpaid hold.
  await page.goBack();
  await page.reload();
  await expect(page.getByRole("listitem").filter({ hasText: "Maya Parker" }).getByText("Awaiting payment")).toBeVisible();
});

test("a guardian who cannot pay sees the camp and a plain reason, with no way to register", async ({ page }) => {
  await login(page, USERS.jordan);
  await page.goto("/shop/camps");
  await page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Sample: Holiday Speed Camp" }) }).getByRole("link").last().click();
  await expect(page.getByRole("heading", { level: 1, name: "Sample: Holiday Speed Camp" })).toBeVisible();
  await expect(page.getByText(/cannot pay on it/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Register/ })).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await noSideScroll(page);
});

test("staff see the events list with paid and unpaid counts and can export the roster", async ({ page }) => {
  await login(page, USERS.erin);
  await page.goto("/events");
  await expect(page.getByRole("heading", { level: 1, name: "Camps & clinics" })).toBeVisible();
  await page.getByRole("link", { name: "Sample: Holiday Speed Camp" }).click();
  await expect(page.getByRole("heading", { name: "Registrations" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Owen Fitzgerald" })).toBeVisible();
  const href = await page.getByRole("link", { name: "Export roster (CSV)" }).getAttribute("href");
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/csv");
  const csv = await res.text();
  expect(csv).toContain("Athlete,Age at start,Registration,Payment");
  expect(csv).toMatch(/Owen Fitzgerald,14,Confirmed,Paid,160\.00/);
  expect(csv).toMatch(/Aria Castellanos,13,Spot held,Unpaid/);
  // Families cannot reach the export.
  await page.context().clearCookies();
  await login(page, USERS.alex);
  expect((await page.request.get(href!)).status()).toBe(403);
});
