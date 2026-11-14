import { expect, test, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * Lead Source, Interest and Priority as lists, and UTM capture on the public form
 * (run against `pnpm build && pnpm start` seeded with `pnpm db:fresh`).
 * Every person is fictional and each run uses its own made-up surname, so the desktop and mobile
 * projects and reruns never collide. Two public inquiries per run stay far below the hourly limit.
 */
test.describe.configure({ mode: "serial" });

// Compared with the viewport, not innerWidth: a too-wide page widens innerWidth with it on a phone.
const noSideScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth), `${page.url()} scrolls sideways`).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
const letters = () => Array.from({ length: 7 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

async function openLead(page: Page, surname: string) {
  await page.goto(`/people/leads?q=${surname}&view=list`);
  await page.getByRole("link", { name: new RegExp(surname) }).first().click();
  await page.waitForURL(/\/people\/leads\/[0-9a-f-]{36}$/);
}

test("public form: source and interest come from the lists, and tracking values in the link are kept on the lead", async ({ page }) => {
  const surname = `Zz${letters()}`;
  await page.goto("/inquire?utm_source=newsletter&utm_campaign=spring-speed&utm_medium=email&utm_term=speed%20training");
  await noSideScroll(page);
  await page.locator("#contactFirstName").fill("Pat");
  await page.locator("#contactLastName").fill(surname);
  await page.locator("#email").fill(`pat.${surname.toLowerCase()}@example.test`);
  await page.locator("#athleteFirstName").fill("Kit");
  await page.locator("#athleteLastName").fill(surname);
  await page.locator("#athleteAge").fill("14");
  await page.locator("#sport").fill("Volleyball");
  const source = page.getByLabel("How did you hear about us?");
  await expect(source.locator("option")).toContainText(["Choose one", "Flyer", "Newspaper Advertisement", "Facebook", "Referral", "Walk-in", "Drive By", "Website", "Other"]);
  // The free text box only appears with Other.
  await expect(page.getByLabel("Where did you hear about us?")).toHaveCount(0);
  await source.selectOption("Other");
  await page.getByLabel("Where did you hear about us?").fill("County fair booth");
  await page.getByLabel("What are you most interested in?").selectOption("Performance Training");
  await expect(page.getByLabel("Priority")).toHaveCount(0); // staff only
  await noSideScroll(page);
  await page.getByRole("button", { name: "Send inquiry" }).click();
  await page.waitForURL(/\/inquire\/thanks/);

  await login(page, USERS.erin);
  await openLead(page, surname);
  const inquiry = page.locator("dl").first();
  await expect(inquiry).toContainText("Other: County fair booth");
  await expect(inquiry).toContainText("Performance Training");
  await expect(inquiry).toContainText("Volleyball");
  await expect(page.getByTestId("lead-utm")).toHaveText("Source: newsletter · Name: spring-speed · Medium: email · Keywords: speed training");
  await noSideScroll(page);
});

test("staff: add a lead from the lists, then edit source, interest and priority", async ({ page }) => {
  const surname = `Zy${letters()}`;
  await login(page, USERS.erin);
  await page.goto("/people/leads/new");
  await page.locator("#contactFirstName").fill("Sam");
  await page.locator("#contactLastName").fill(surname);
  await page.locator("#email").fill(`sam.${surname.toLowerCase()}@example.test`);
  await page.locator("#athleteFirstName").fill("Rae");
  await page.locator("#athleteLastName").fill(surname);
  await page.locator("#athleteAge").fill("12");
  await page.locator("#leadSource").selectOption("Walk-in");
  await page.locator("#leadInterest").selectOption("General Fitness");
  await page.locator("#priority").selectOption("High");
  await noSideScroll(page);
  await page.getByRole("button", { name: "Create lead" }).click();
  await page.waitForURL(/\/people\/leads\/[0-9a-f-]{36}$/);
  const inquiry = page.locator("dl").first();
  await expect(inquiry).toContainText("Walk-in");
  await expect(inquiry).toContainText("General Fitness");
  await expect(inquiry).toContainText("High");

  await page.getByText("Edit source, interest and priority").click();
  await page.locator("#edit-leadSource").selectOption("Flyer");
  await page.locator("#edit-priority").selectOption("Low");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(inquiry).toContainText("Flyer");
  await expect(inquiry).toContainText("Low");
  await noSideScroll(page);

  // The list filter offers the normalised source and finds the lead under it.
  await page.goto(`/people/leads?source=Flyer&q=${surname}&view=list`);
  await expect(page.getByRole("link", { name: new RegExp(surname) }).first()).toBeVisible();
  await noSideScroll(page);
});

test("owner: the report and the scoreboard group leads by the normalised source", async ({ page }) => {
  await login(page, USERS.rod);
  await page.goto("/reports/leads-by-source");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Leads by source and interest");
  const table = page.getByRole("table").first();
  await expect(table).toContainText("Source");
  await expect(table).not.toContainText("web_inquiry");
  await expect(table).not.toContainText("walk_in");
  await noSideScroll(page);
  await page.goto("/scoreboard/marketing");
  await expect(page.getByText("By channel / lead source")).toBeVisible();
  await expect(page.locator("main")).not.toContainText("web_inquiry");
  await noSideScroll(page);
});
