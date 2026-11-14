import { expect, test, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * Camp and clinic waitlist, end to end (run against `pnpm build && pnpm start` seeded with
 * `pnpm db:fresh`). Each run creates its own one-spot sample clinic with a made-up name, so the
 * desktop and mobile projects and reruns never depend on each other or on seeded events.
 * The clinic is 200 days ahead (a fixed offset, never a weekday), so it sorts after every seeded
 * event and never pushes one off the "next three" cards other specs look at.
 */
test.describe.configure({ mode: "serial" });

// Compared with the viewport, not innerWidth: a too-wide page widens innerWidth with it on a phone.
const noSideScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth), `${page.url()} scrolls sideways`).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
const letters = () => Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const ymd = (daysAhead: number) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);

async function switchTo(page: Page, who: string) {
  await page.context().clearCookies();
  await login(page, who);
}

test("full clinic: a parent joins the waitlist, a spot is released, the parent is offered it and accepts into a normal unpaid bill", async ({ page }) => {
  test.setTimeout(120_000);
  const name = `Sample: Waitlist Clinic ${letters()}`;

  // --- Staff create a one-spot sample clinic and fill it ------------------------------------
  await login(page, USERS.erin);
  await page.goto("/events/new");
  await page.locator("#ev-name").fill(name);
  await page.locator("#ev-kind").selectOption("clinic");
  await page.locator('input[name="sessionDate"]').first().fill(ymd(200));
  await page.locator('input[name="sessionStart"]').first().fill("09:00");
  await page.locator('input[name="sessionEnd"]').first().fill("10:30");
  await page.locator("#ev-cap").fill("1");
  await page.locator("#ev-price").fill("45");
  await expect(page.locator("#ev-wl")).toHaveValue("24");
  await page.locator("#ev-wl").fill("12");
  await page.getByRole("button", { name: "Create draft" }).click();
  await page.waitForURL(/\/events\/[0-9a-f-]{36}\?created=1/);
  const eventUrl = page.url().split("?")[0];
  const eventId = eventUrl.split("/").pop()!;
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(/Published: families can see it/)).toBeVisible();

  await page.locator("#reg-athlete").selectOption({ label: "Brooks, Dana" });
  await page.getByRole("button", { name: "Hold spot and create invoice" }).click();
  await expect(page.getByText(/Spot held\. Invoice/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Waitlist", exact: true })).toBeVisible();
  await expect(page.getByText("Nobody is waiting.")).toBeVisible();
  await noSideScroll(page);

  // --- The parent sees Full and joins the waitlist ---------------------------------------------
  await switchTo(page, USERS.alex);
  await page.goto(`/shop/camps/${eventId}`);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByText("This is full")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Register/ })).toHaveCount(0);
  await page.getByRole("checkbox", { name: /Maya Parker/ }).check();
  await expect(page.getByText(/Joining is free and nothing is charged/)).toBeVisible();
  await noSideScroll(page);
  await page.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(page.getByTestId("waitlist-place")).toContainText("Maya Parker");
  await expect(page.getByTestId("waitlist-place")).toContainText("On the waitlist, place 1");
  await expect(page.getByTestId("waitlist-offer")).toHaveCount(0);
  await noSideScroll(page);
  await page.goto("/shop/camps");
  await expect(page.getByRole("listitem").filter({ has: page.getByRole("heading", { name }) }).getByText("Maya: on the waitlist")).toBeVisible();

  // A guardian who cannot pay sees the place but gets no buttons.
  await switchTo(page, USERS.jordan);
  await page.goto(`/shop/camps/${eventId}`);
  await expect(page.getByTestId("waitlist-place")).toContainText("place 1");
  await expect(page.getByRole("button", { name: /Leave the waitlist|Join the waitlist/ })).toHaveCount(0);

  // --- Staff see the line and release the spot ---------------------------------------------------
  await switchTo(page, USERS.erin);
  await page.goto(eventUrl);
  const row = page.getByTestId("waitlist-row").filter({ hasText: "Maya Parker" });
  await expect(row).toContainText("Place 1");
  await expect(row.getByRole("button", { name: /Move up/ })).toBeVisible();
  await noSideScroll(page);
  const reg = page.getByRole("row").filter({ hasText: "Dana Brooks" });
  await reg.locator("summary").click();
  await reg.getByLabel("Reason").fill("e2e: family cancelled");
  await reg.getByRole("button", { name: "Cancel registration" }).click();
  // Offered, not registered: no registration row for Maya, and the spot is not shown as free.
  await expect(row).toContainText(/Offered until/);
  await expect(page.getByText("0 of 1", { exact: true })).toBeVisible();
  await noSideScroll(page);

  // --- The parent sees the offer in the app and accepts ---------------------------------------
  await switchTo(page, USERS.alex);
  await page.goto("/shop/camps");
  await expect(page.getByRole("listitem").filter({ has: page.getByRole("heading", { name }) }).getByText("Maya: spot offered")).toBeVisible();
  await page.goto(`/shop/camps/${eventId}`);
  await expect(page.getByText("A spot has opened for Maya")).toBeVisible();
  await expect(page.getByTestId("waitlist-offer")).toContainText("Nothing has been charged");
  await noSideScroll(page);
  await page.getByRole("button", { name: /Take the spot for Maya/ }).click();
  await page.waitForURL(/registered=1/);
  await expect(page.getByText("Spot held for Maya")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Maya Parker" }).getByText("Awaiting payment")).toBeVisible();
  await expect(page.getByTestId("waitlist-offer")).toHaveCount(0);
  await page.getByRole("link", { name: /Continue to payment|View bill/ }).first().click();
  await expect(page).toHaveURL(/\/billing\/invoices\/[0-9a-f-]{36}/);
  await expect(page.getByText(new RegExp(`${name}: Maya Parker`)).first()).toBeVisible();
  await expect(page.getByText(/open/i).first()).toBeVisible();
  await noSideScroll(page);

  // --- Staff: the line is empty again and the registration is an ordinary unpaid hold ----------
  await switchTo(page, USERS.erin);
  await page.goto(eventUrl);
  await expect(page.getByText("Nobody is waiting.")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Maya Parker" })).toContainText(/Unpaid/);
});

test("coaches cannot open the event page that holds the waitlist", async ({ page }) => {
  await login(page, USERS.marcus);
  await page.goto("/events");
  await expect(page.getByRole("heading", { level: 1, name: "Camps & clinics" })).toHaveCount(0);
});
