import { expect, test, type Browser, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * News watch in the browser (run against `pnpm build && pnpm start` seeded with `pnpm db:fresh`).
 * Runs at desktop and 390px. No feed is read here: the clip is added by hand by a staff member,
 * with an invented headline and a link on the reserved example.com domain, so every run makes
 * its own clip and can be repeated against the same database.
 */
const SHOTS = process.env.NEWSWATCH_SHOTS === "1";

async function as(browser: Browser, email: string, viewport?: { width: number; height: number } | null): Promise<Page> {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  const page = await ctx.newPage();
  await login(page, email);
  return page;
}
const btn = (label: string, headline: string) => new RegExp(`${label}\\s*: ${headline.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const noSideScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${page.url()} scrolls sideways`).toBeLessThanOrEqual(1);
const shot = async (page: Page, name: string, project: string) => {
  if (SHOTS) await page.screenshot({ path: `docs/screenshots/newswatch/${name}-${project === "mobile" ? "390" : "desktop"}.png`, fullPage: true });
};

test("a coach checks a news clip, the owner approves it, and only then do other families see it", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const vp = info.project.use.viewport;
  const tag = `${info.project.name} ${Date.now().toString().slice(-7)}`;
  const article = `Maya Parker leads the Fictional Falls comeback, sample ${tag}`;
  const shown = `Maya leads the Fictional Falls comeback, sample ${tag}`;

  // 1. Coach Marcus adds a clip by hand for Maya (her parent switched news watch on) and marks it as our athlete.
  const marcus = await as(browser, USERS.marcus, vp);
  await marcus.goto("/wins/leads");
  await marcus.waitForLoadState("networkidle");
  await marcus.getByLabel("Who is it about?").selectOption({ label: "Maya Parker" });
  await marcus.getByLabel("Article headline").fill(article);
  await marcus.getByLabel("Publication").fill("Sampleton Gazette (sample)");
  await marcus.getByLabel("Link to the article").fill(`https://example.com/sample-news/e2e-${Date.now()}`);
  await marcus.getByRole("button", { name: "Add news clip" }).click();
  await expect(marcus.getByText("It is shown to nobody until it is approved.").first()).toBeVisible();
  const clip = marcus.locator("#news-clips li", { hasText: article }).first();
  await expect(clip).toContainText("Sampleton Gazette (sample)");
  await clip.getByRole("button", { name: btn("Our athlete", article) }).click();
  await expect(marcus.locator("#news-clips li", { hasText: article }).first()).toContainText("Our athlete, waiting for approval");
  await noSideScroll(marcus);
  await shot(marcus, "leads-triage", info.project.name);

  // 2. Triage shows nothing to anyone: another family does not see it, in either filter.
  const chris = await as(browser, USERS.chris, vp);
  await chris.goto("/wins?show=news");
  await expect(chris.getByRole("heading", { name: "Gym wins" })).toBeVisible();
  await expect(chris.getByText(tag)).toHaveCount(0);

  // 3. The coach cannot approve: the queue is read only for him.
  await marcus.goto("/wins/news");
  await expect(marcus.locator("#news-pending")).toContainText(article);
  await expect(marcus.getByRole("button", { name: btn("Approve", article) })).toHaveCount(0);
  await expect(marcus.getByRole("button", { name: "Approve selected clips" })).toHaveCount(0);

  // 4. The owner sees the count on Today, opens the queue and approves it.
  const rod = await as(browser, USERS.rod, vp);
  await rod.goto("/today");
  await expect(rod.locator("#news-clips-pending")).toContainText("waiting for your approval");
  await rod.locator("#news-clips-pending").getByRole("link", { name: "Review news clips" }).click();
  await expect(rod).toHaveURL(/\/wins\/news/);
  await rod.waitForLoadState("networkidle");
  await expect(rod.getByText("Nothing is shared without approval")).toBeVisible();
  await noSideScroll(rod);
  await shot(rod, "approval-queue", info.project.name);
  await rod.getByRole("button", { name: btn("Approve", article) }).click();
  await expect(rod.locator("#news-approved")).toContainText(article);

  // 5. Now the other family sees it: display name, headline with the first name only, publication, link out.
  await chris.goto("/wins?show=news");
  const item = chris.locator("#wins-feed li", { hasText: shown }).first();
  await expect(item).toBeVisible();
  await expect(item).toContainText("Maya P.");
  await expect(item).toContainText("In the news");
  await expect(item).toContainText("Sampleton Gazette (sample)");
  await expect(item).not.toContainText("Parker");
  await expect(item.getByRole("link", { name: /Read it at Sampleton Gazette/ })).toHaveAttribute("href", /^https:\/\/example\.com\/sample-news\/e2e-/);
  await expect(chris.locator("#alumni-news")).toContainText("Quinn M.");
  await noSideScroll(chris);
  await shot(chris, "family-feed", info.project.name);

  // 6. The owner takes it down in one step and it is gone again.
  await rod.getByRole("button", { name: btn("Take down", article) }).click();
  await expect(rod.locator("#news-approved")).not.toContainText(article);
  await chris.reload();
  await expect(chris.getByText(tag)).toHaveCount(0);
});

test("owner settings, the watch list and the family opt-in card show the limits plainly", async ({ browser }, info) => {
  test.setTimeout(120_000);
  const vp = info.project.use.viewport;
  const rod = await as(browser, USERS.rod, vp);
  await rod.goto("/settings/newswatch");
  await expect(rod.getByRole("heading", { name: "News watch", level: 1 })).toBeVisible();
  await expect(rod.getByText("It reads headlines and short summaries from feeds.")).toBeVisible();
  await expect(rod.getByText("The Hub does not get around paywalls or blocks.", { exact: false })).toBeVisible();
  await expect(rod.locator("#news-sources")).toContainText("The Herald-Times, Bloomington (news search)");
  await expect(rod.locator("#news-sources")).toContainText("The Times-Mail, Bedford (news search)");
  await expect(rod.locator("#news-sources")).toContainText("Greene County Daily World (publisher feed)");
  await expect(rod.getByLabel("Also let operations staff approve")).not.toBeChecked();
  await expect(rod.getByText("auto-approve", { exact: false })).toHaveCount(0);
  await noSideScroll(rod);
  await shot(rod, "settings", info.project.name);

  await rod.goto("/wins/watch");
  await expect(rod.locator("#watch-athletes")).toContainText("Maya Parker");
  await expect(rod.locator("#watch-alumni")).toContainText("Quinn Madeupson");
  await expect(rod.locator("#watch-alumni")).toContainText("Basis: Gave permission at alumni day (sample)");
  await noSideScroll(rod);
  await shot(rod, "watch-list", info.project.name);

  // A parent sees the switch with the wording; a minor athlete sees that a guardian decides.
  const alex = await as(browser, USERS.alex, vp);
  await alex.goto("/wins");
  await expect(alex.getByRole("heading", { name: "News watch for Maya" })).toBeVisible();
  await expect(alex.getByRole("button", { name: /Switch news watch off/ })).toBeVisible();
  await noSideScroll(alex);
  await shot(alex, "family-optin", info.project.name);
  const maya = await as(browser, USERS.maya, vp);
  await maya.goto("/wins");
  await expect(maya.getByRole("heading", { name: "News watch", exact: true })).toBeVisible();
  await expect(maya.getByRole("button", { name: /I agree, switch news watch on/ })).toHaveCount(0);
});
