import { expect, test } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * Family scheduling and billing in the shape and words families already know:
 * a day calendar with Reserve / Cancel reservation, My Reservations, and a profile area with Bills and Pay Now.
 * Runs against the seeded demo org and leaves it as it found it (the reservation it makes is cancelled again).
 */

const CASEY = "casey.nguyen@example.test";
const FAMILY_ROUTES = ["/schedule", "/schedule/reservations", "/schedule/attendance", "/schedule/book", "/billing", "/billing/memberships", "/billing/invoices", "/billing/payment-methods", "/billing/history"];

test("guardian reserves from the day list with the family-member checklist, then cancels", async ({ page }) => {
  await login(page, USERS.alex);
  await page.goto("/schedule");
  await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Days this week" }).getByRole("link")).toHaveCount(7);
  await expect(page.getByRole("navigation", { name: "Schedule sections" }).getByRole("link")).toHaveText(["Calendar", "My Reservations", "Appointments", "My Attendance"]);

  // Two or more days ahead (outside any late-cancel window), find a class nobody in the family is in yet.
  const picker = page.locator("main details.group > summary");
  await expect(page.getByRole("link", { name: "Next day" })).toBeVisible();
  for (let i = 2; i < 10; i++) {
    const ymd = new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10);
    await page.goto(`/schedule?date=${ymd}`);
    await page.waitForLoadState("networkidle");
    if (await picker.count()) break;
  }
  await expect(picker.first(), "a class with Reserve for several family members").toBeVisible();
  const row = page.locator("main li:has(details.group)").first();
  const href = await row.locator('a[href^="/schedule/classes/"]').first().getAttribute("href");
  const sameRow = page.locator(`main li:has(a[href="${href}"])`);

  await row.locator("details.group > summary").click();
  await sameRow.getByRole("checkbox", { name: "Eli Parker" }).check();
  await sameRow.getByRole("button", { name: "Reserve", exact: true }).click();
  await expect(sameRow.getByText("Reserved · Eli")).toBeVisible();

  // The same state shows on the class detail and under My Reservations.
  await page.goto(href!);
  await expect(page.getByRole("heading", { name: "Attending from your family" })).toBeVisible();
  await expect(page.getByText("Cancellation policy.")).toBeVisible();
  await page.goto("/schedule/reservations");
  await expect(page.getByRole("heading", { level: 1, name: "My Reservations" })).toBeVisible();
  await expect(page.locator(`main a[href="${href}"]`).first()).toBeVisible();

  // Cancel from the class detail; the confirm states the reservation is being cancelled.
  await page.goto(href!);
  let asked = "";
  page.once("dialog", (d) => {
    asked = d.message();
    void d.accept();
  });
  await page.getByRole("button", { name: /Cancel reservation for Eli/ }).click();
  await expect(page.getByText("No one from your family is reserved in this class.")).toBeVisible();
  expect(asked).toMatch(/^Cancel this reservation\?/);
});

test("a guardian who cannot book sees the schedule with the honest explanation and no Reserve", async ({ page }) => {
  await login(page, CASEY);
  await page.goto("/schedule");
  await expect(page.getByText(/reservations are managed by another guardian or the front desk/)).toBeVisible();
  await expect(page.locator("main").getByRole("button", { name: /^(Reserve|Join waitlist)/ })).toHaveCount(0);
  await expect(page.locator("main details.group")).toHaveCount(0);
});

test("profile tabs are in the order families know, and Pay Now follows who may pay", async ({ page, browser }) => {
  await login(page, USERS.alex);
  await page.goto("/billing/invoices");
  await expect(page.getByRole("navigation", { name: "Section" }).getByRole("link")).toHaveText(["Family", "Memberships", "Bills", "Payment Methods", "Payment History", "Documents", "Attendance"]);
  await expect(page.getByRole("heading", { level: 1, name: "Bills" })).toBeVisible();
  for (const h of ["Unpaid bills", "Upcoming bills", "Bill history"]) await expect(page.getByRole("heading", { name: new RegExp(`^${h}`) })).toBeVisible();
  const unpaid = page.locator("section", { has: page.getByRole("heading", { name: /^Unpaid bills/ }) });
  await expect(unpaid.getByRole("link", { name: /^Pay Now/ }).first()).toBeVisible();

  // Jordan can view the same account but not pay: no Pay Now anywhere, and the reason is stated.
  const ctx = await browser.newContext();
  const jp = await ctx.newPage();
  await login(jp, USERS.jordan);
  await jp.goto("/billing/invoices");
  await expect(jp.getByText(/Payments are made by another authorized person/)).toBeVisible();
  await expect(jp.getByRole("link", { name: /^Pay Now/ })).toHaveCount(0);
  await jp.goto("/billing");
  await expect(jp.getByText("View only")).toBeVisible();
  await expect(jp.getByRole("link", { name: /^Pay Now/ })).toHaveCount(0);
  await ctx.close();
});

test("family screens use the family words and never name the previous vendor", async ({ page }) => {
  await login(page, USERS.alex);
  for (const route of FAMILY_ROUTES) {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    const text = await page.locator("main").innerText();
    expect(text, `${route} names the previous vendor`).not.toMatch(/zen\s?planner/i);
    expect(text, `${route} still says invoice`).not.toMatch(/\binvoices?\b/i);
    expect(text, `${route} still says book/booking`).not.toMatch(/\b(book|booked|booking|bookings)\b/i);
  }
});
