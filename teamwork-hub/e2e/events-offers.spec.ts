import { expect, test, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * Waitlist offers where families and the front desk already look: a callout on the family Home and
 * a card on the staff Today page (run against `pnpm build && pnpm start` seeded with `pnpm db:fresh`).
 *
 * The first test only reads the seeded offer (Maya on "Sample: Small Group Sprint Clinic") and never
 * answers it, so both projects and reruns see the same thing. The second creates its own one-spot
 * clinic 210 days ahead, so it sorts after every seeded event.
 */
test.describe.configure({ mode: "serial" });

const SEEDED = "Sample: Small Group Sprint Clinic";
const noSideScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth), `${page.url()} scrolls sideways`).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
const letters = () => Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const ymd = (daysAhead: number) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
/** Set SHOTS=1 to save screenshots under docs/screenshots/tighten/. */
const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `docs/screenshots/tighten/${test.info().project.name}-${name}.png`, fullPage: true });
};
async function switchTo(page: Page, who: string) {
  await page.context().clearCookies();
  await login(page, who);
}
/** The Home callout for one event. */
const homeOffer = (page: Page, eventName: string) => page.getByTestId("home-waitlist-offers").locator("> div").filter({ hasText: eventName });

test("the seeded offer shows on the family Home with its expiry, and on staff Today; who may answer follows the registration rule", async ({ page }) => {
  await login(page, USERS.alex);
  await page.goto("/today");
  const offer = homeOffer(page, SEEDED);
  await expect(offer.getByText("A spot has opened for Maya")).toBeVisible();
  // Event, athlete and the expiry as a facility-local day and time.
  await expect(offer.getByRole("link", { name: SEEDED })).toHaveAttribute("href", /\/shop\/camps\/[0-9a-f-]{36}$/);
  await expect(offer.getByTestId("home-waitlist-offer")).toContainText(/held for Maya until (Mon|Tue|Wed|Thu|Fri|Sat|Sun), [A-Z][a-z]{2} \d{1,2} at \d{1,2}:\d{2} (AM|PM)/);
  await expect(offer.getByTestId("home-waitlist-offer")).toContainText("Nothing has been charged");
  await expect(offer.getByRole("button", { name: /Take the spot for Maya/ })).toBeVisible();
  await expect(offer.getByRole("button", { name: "No thanks" })).toBeVisible();
  await noSideScroll(page);
  await shot(page, "home-offer");
  // It covers every linked athlete, so it is there whichever child is selected.
  await page.getByRole("navigation", { name: "Choose athlete" }).getByRole("link", { name: "Eli" }).click();
  await expect(homeOffer(page, SEEDED)).toBeVisible();

  // Jordan can see Maya but cannot pay: the offer is shown with no buttons.
  await switchTo(page, USERS.jordan);
  await page.goto("/today");
  await expect(homeOffer(page, SEEDED).getByText("A spot has opened for Maya")).toBeVisible();
  await expect(homeOffer(page, SEEDED).getByRole("button")).toHaveCount(0);
  await expect(homeOffer(page, SEEDED)).toContainText("The adult who pays on the billing account can take the spot");

  // Another family sees nothing about it.
  await switchTo(page, USERS.chris);
  await page.goto("/today");
  await expect(page.getByText("A spot has opened for Maya")).toHaveCount(0);

  // Front desk: who holds the offer, for which event, and when it runs out.
  await switchTo(page, USERS.erin);
  await page.goto("/today");
  const card = page.locator("#today-waitlist-offers");
  await expect(card.getByRole("heading", { name: "Waitlist offers waiting on a family" })).toBeVisible();
  const row = card.getByRole("listitem").filter({ hasText: SEEDED });
  await expect(row.getByRole("link", { name: "Maya Parker" })).toBeVisible();
  await expect(row).toContainText(/Offer runs out (Mon|Tue|Wed|Thu|Fri|Sat|Sun), [A-Z][a-z]{2} \d{1,2} at \d{1,2}:\d{2} (AM|PM)/);
  await expect(card).toContainText("does not message families");
  await noSideScroll(page);
  await shot(page, "today-offers");
  await row.getByRole("link", { name: SEEDED }).click();
  await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}#waitlist$/);
  await expect(page.getByTestId("waitlist-row").filter({ hasText: "Maya Parker" })).toContainText(/Offered until/);
  await expect(page.getByTestId("waitlist-row").filter({ hasText: "Ava Parker" })).toContainText("Place 1");

  // Coaches do not get the card.
  await switchTo(page, USERS.marcus);
  await page.goto("/today");
  await expect(page.locator("#today-waitlist-offers")).toHaveCount(0);
});

test("a parent declines one offer and accepts the next from Home, through the same actions as the camp page", async ({ page }) => {
  test.setTimeout(120_000);
  const name = `Sample: Home Offer Clinic ${letters()}`;

  // Staff: a one-spot sample clinic, filled.
  await login(page, USERS.erin);
  await page.goto("/events/new");
  await page.locator("#ev-name").fill(name);
  await page.locator("#ev-kind").selectOption("clinic");
  await page.locator('input[name="sessionDate"]').first().fill(ymd(210));
  await page.locator('input[name="sessionStart"]').first().fill("09:00");
  await page.locator('input[name="sessionEnd"]').first().fill("10:30");
  await page.locator("#ev-cap").fill("1");
  await page.locator("#ev-price").fill("45");
  await page.getByRole("button", { name: "Create draft" }).click();
  await page.waitForURL(/\/events\/[0-9a-f-]{36}\?created=1/);
  const eventUrl = page.url().split("?")[0];
  const eventId = eventUrl.split("/").pop()!;
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(/Published: families can see it/)).toBeVisible();
  await page.locator("#reg-athlete").selectOption({ label: "Brooks, Dana" });
  await page.getByRole("button", { name: "Hold spot and create invoice" }).click();
  await expect(page.getByText(/Spot held\. Invoice/)).toBeVisible();

  // The parent puts both children in line. Nothing about this event is on Home yet.
  await switchTo(page, USERS.alex);
  await page.goto(`/shop/camps/${eventId}`);
  await page.getByRole("checkbox", { name: /Maya Parker/ }).check();
  await page.getByRole("checkbox", { name: /Eli Parker/ }).check();
  await page.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(page.getByTestId("waitlist-place")).toHaveCount(2);
  await page.goto("/today");
  await expect(homeOffer(page, name)).toHaveCount(0);

  // Staff release the spot: the first in line is offered it.
  await switchTo(page, USERS.erin);
  await page.goto(eventUrl);
  const reg = page.getByRole("row").filter({ hasText: "Dana Brooks" });
  await reg.locator("summary").click();
  await reg.getByLabel("Reason").fill("e2e: family cancelled");
  await reg.getByRole("button", { name: "Cancel registration" }).click();
  await expect(page.getByTestId("waitlist-row").filter({ hasText: /Offered until/ })).toHaveCount(1);
  await page.goto("/today");
  await expect(page.locator("#today-waitlist-offers").getByRole("listitem").filter({ hasText: name })).toHaveCount(1);

  // Home: exactly one offer for this event. Decline it; the spot passes to the sibling.
  await switchTo(page, USERS.alex);
  await page.goto("/today");
  await expect(homeOffer(page, name)).toHaveCount(1);
  const firstTitle = (await homeOffer(page, name).getByText(/A spot has opened for (Maya|Eli)/).textContent())!;
  const first = firstTitle.includes("Maya") ? "Maya" : "Eli";
  const second = first === "Maya" ? "Eli" : "Maya";
  page.once("dialog", (d) => d.accept());
  await homeOffer(page, name).getByRole("button", { name: "No thanks" }).click();
  await expect(homeOffer(page, name).getByText(`A spot has opened for ${second}`)).toBeVisible();
  await expect(homeOffer(page, name).getByText(`A spot has opened for ${first}`)).toHaveCount(0);
  await noSideScroll(page);

  // Accept for the sibling: the normal held registration and unpaid bill, nothing charged.
  await homeOffer(page, name).getByRole("button", { name: new RegExp(`Take the spot for ${second}`) }).click();
  await page.waitForURL(new RegExp(`/shop/camps/${eventId}\\?registered=1`));
  await expect(page.getByText(`Spot held for ${second}`)).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: `${second} Parker` }).getByText("Awaiting payment")).toBeVisible();
  await page.goto("/today");
  await expect(homeOffer(page, name)).toHaveCount(0);

  // Staff Today no longer lists it; the registration is an ordinary unpaid hold.
  await switchTo(page, USERS.erin);
  await page.goto("/today");
  await expect(page.getByRole("listitem").filter({ hasText: name })).toHaveCount(0);
  await page.goto(eventUrl);
  await expect(page.getByText("Nobody is waiting.")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: `${second} Parker` })).toContainText(/Unpaid/);
});
