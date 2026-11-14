import { expect, test, type Browser, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * Wins and Competitions in the browser (run against `pnpm build && pnpm start` seeded with
 * `pnpm db:fresh`). Runs at desktop and 390px. Every run uses its own headline so it can be
 * repeated against the same database.
 */
const SHOTS = process.env.WINS_SHOTS === "1";
const SAM = "sam.rivera@example.test";

async function as(browser: Browser, email: string, viewport?: { width: number; height: number } | null): Promise<Page> {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  const page = await ctx.newPage();
  await login(page, email);
  return page;
}
/** Buttons carry the headline in a screen-reader-only span, which reads as "Approve : headline". */
const btn = (label: string, headline: string) => new RegExp(`${label}\\s*: ${headline.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const noSideScroll = async (page: Page) => {
  // Compare with the configured viewport, not innerWidth: on a phone a too-wide page widens innerWidth with it.
  const vw = page.viewportSize()?.width ?? 0;
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${page.url()} scrolls sideways`).toBeLessThanOrEqual(vw + 1);
};
const shot = async (page: Page, name: string, project: string) => {
  if (SHOTS) await page.screenshot({ path: `docs/screenshots/wins/${name}-${project === "mobile" ? "390" : "desktop"}.png`, fullPage: true });
};

test("a parent submits a win; staff approve; other families see a display name; marketing needs the parent's own yes and can be withdrawn", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const vp = info.project.use.viewport;
  const headline = `E2E tournament win ${info.project.name} ${Date.now().toString().slice(-7)}`;

  // 1. Alex (parent of Maya) submits.
  const alex = await as(browser, USERS.alex, vp);
  await alex.goto("/wins");
  await alex.waitForLoadState("networkidle");
  await alex.getByLabel("Athlete").selectOption({ label: "Maya" });
  await alex.getByLabel("Sport").fill("Volleyball");
  await alex.getByLabel("Headline").fill(headline);
  await alex.getByRole("button", { name: "Send to staff" }).click();
  await expect(alex.getByText("A staff member reviews every win before anyone else sees it.").first()).toBeVisible();
  const mine = alex.locator("li", { hasText: headline }).first();
  await expect(mine).toContainText("Waiting for staff review");
  await expect(mine).toContainText("Social posts and the gym website: Not given");
  await noSideScroll(alex);

  // 2. Another family does not see it while it is pending.
  const chris = await as(browser, USERS.chris, vp);
  await chris.goto("/wins");
  await expect(chris.getByRole("heading", { name: "Gym wins" })).toBeVisible();
  await expect(chris.getByText(headline)).toHaveCount(0);

  // 3. Coach Marcus approves it.
  const marcus = await as(browser, USERS.marcus, vp);
  await marcus.goto("/wins/review");
  await marcus.waitForLoadState("networkidle");
  await expect(marcus.locator("#wins-pending")).toContainText(headline.slice(0, 20));
  await marcus.getByRole("button", { name: btn("Approve", headline) }).click();
  await expect(marcus.locator("#wins-approved")).toContainText(headline);
  await shot(marcus, "review", info.project.name);
  // A coach cannot open the marketing queue.
  await marcus.goto("/wins/marketing");
  await expect(marcus).toHaveURL(/\/denied/);

  // 4. Now the other family sees it, under the display name only.
  await chris.reload();
  const feedItem = chris.locator("#wins-feed li", { hasText: headline });
  await expect(feedItem).toContainText("Maya P.");
  const feedText = await chris.locator("#wins-feed").innerText();
  expect(feedText).not.toContain("Parker");
  // The hidden demo athlete's approved win, a pending win and a staff draft never reach the feed.
  expect(feedText).not.toContain("Sampleton Storm semifinal");
  expect(feedText).not.toContain("Career high 14 kills");
  expect(feedText).not.toContain("Sectional opener");
  await shot(chris, "feed", info.project.name);

  // 5. Operations: not in "Ready to post" without consent. Ask the family.
  const erin = await as(browser, USERS.erin, vp);
  await erin.goto("/wins/marketing");
  await erin.waitForLoadState("networkidle");
  await expect(erin.locator("#marketing-ready")).not.toContainText(headline);
  await expect(erin.locator("#marketing-ask")).toContainText(headline);
  await erin.getByRole("button", { name: btn("Ask the family", headline) }).click();
  await expect(erin.locator("#marketing-ask li", { hasText: headline })).toContainText("Asked, no answer yet");

  // 6. Alex sees the request on Home and gives consent on the Wins page.
  const mayaId = ((await alex.locator("section[id^='wins-']", { hasText: "Maya's wins" }).first().getAttribute("id")) ?? "").slice(5);
  expect(mayaId).toMatch(/^[0-9a-f-]{36}$/);
  await alex.goto(`/today?athlete=${mayaId}`);
  await expect(alex.locator("#wins-home")).toContainText("The gym would like to share a win publicly");
  await alex.goto("/wins");
  await alex.waitForLoadState("networkidle");
  const row = alex.locator("li", { hasText: headline }).first();
  await expect(row).toContainText("The gym would like to share this win publicly");
  await row.getByText("Choose", { exact: false }).first().click();
  await expect(row).toContainText("SAMPLE WORDING");
  await row.getByRole("button", { name: btn("I agree, allow it", headline) }).click();
  await expect(alex.locator("li", { hasText: headline }).first()).toContainText("Social posts and the gym website: Given (Alex Parker");
  await shot(alex, "family-wins", info.project.name);

  // 7. Ready to post, with caption drafts that use the display name only. Mark as posted.
  await erin.reload();
  await erin.waitForLoadState("networkidle");
  const ready = erin.locator("#marketing-ready li", { hasText: headline });
  await expect(ready).toContainText("Consent given");
  const captions = await ready.locator("textarea").evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value));
  expect(captions).toHaveLength(3);
  for (const c of captions) {
    expect(c).toContain("Maya P.");
    expect(c).toContain(headline);
    expect(c).not.toMatch(/Parker|—/);
  }
  await ready.getByRole("button", { name: btn("Mark as posted", headline) }).click();
  await expect(erin.locator("#marketing-ready li", { hasText: headline })).toContainText("Posted: Instagram");
  await noSideScroll(erin);
  await shot(erin, "marketing", info.project.name);

  // 8. Alex withdraws. The win leaves the queue and lands on the take-down list.
  alex.once("dialog", (d) => d.accept());
  await alex.locator("li", { hasText: headline }).first().getByRole("button", { name: btn("Withdraw permission", headline) }).click();
  await expect(alex.locator("li", { hasText: headline }).first()).toContainText("Social posts and the gym website: Withdrawn");
  await erin.reload();
  await erin.waitForLoadState("networkidle");
  await expect(erin.locator("#marketing-ready")).not.toContainText(headline);
  await expect(erin.getByText("Take these down")).toBeVisible();
  const down = erin.locator("li", { hasText: headline }).first();
  await expect(down).toContainText("The family withdrew marketing consent");
  erin.once("dialog", (d) => d.accept());
  await down.getByRole("button", { name: btn("Posts taken down", headline) }).click();
  await expect(erin.getByRole("button", { name: btn("Posts taken down", headline) })).toHaveCount(0);

  // 9. Clean up so the seeded TV panel keeps its content on repeat runs: Alex removes the win.
  alex.once("dialog", (d) => d.accept());
  const again = alex.locator("li", { hasText: headline }).first();
  await again.getByText("Photo and removal").click();
  await again.getByRole("button", { name: btn("Remove this win", headline) }).click();
  await expect(alex.getByText(headline)).toHaveCount(0);
  for (const p of [alex, chris, marcus, erin]) await p.context().close();
});

test("staff see who competes this week and tomorrow, with a link to the existing load view", async ({ page }, info) => {
  await login(page, USERS.marcus);
  await page.goto("/today");
  const card = page.locator("#competing-this-week");
  await expect(card.getByRole("heading", { name: "Competing this week" })).toBeVisible();
  await expect(card).toContainText("Game tomorrow");
  await expect(card).toContainText(/compete(s)? tomorrow/);
  // Coach Marcus sees his own athletes with full names; the youth coach's athletes are not his.
  await expect(card).toContainText("Maya Parker");
  await expect(card).not.toContainText("Eli Parker");
  const load = card.getByRole("link", { name: /Load for Maya Parker/ }).first();
  await expect(load).toHaveAttribute("href", /\/science\/load\?athlete=[0-9a-f-]{36}$/);
  await noSideScroll(page);
  await shot(page, "today-competing", info.project.name);

  await page.goto("/wins/calendar");
  await expect(page.getByRole("heading", { level: 1, name: "Competition calendar" })).toBeVisible();
  await expect(page.locator("ol[aria-label^='Competitions']")).toContainText("Fictional Falls High School Volleyball (sample)");
  await noSideScroll(page);
  await shot(page, "calendar-week", info.project.name);
  await page.getByRole("link", { name: "Month" }).click();
  await expect(page).toHaveURL(/view=month/);
  await page.getByLabel("Sport").selectOption("Football");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/sport=Football/);
  const cal = page.locator("ol[aria-label^='Competitions']");
  await expect(cal).toContainText("Imaginary Ironmen Football (sample)");
  await expect(cal).not.toContainText("Volleyball");
  await noSideScroll(page);
  await shot(page, "calendar-month", info.project.name);

  await page.goto("/wins/teams");
  await expect(page.getByRole("heading", { name: "Fictional Falls High School Volleyball (sample)" })).toBeVisible();
  await noSideScroll(page);
  await page.goto("/wins/leads");
  await expect(page.locator("#leads-open")).toContainText("Heard Sofia made the all-conference team");
  await noSideScroll(page);
  await page.goto("/people/retention");
  await expect(page.locator("#retention-wins")).toContainText("a reason to say congratulations");
});

test("families: Your wins and the competing card on Home; a minor cannot give marketing consent; hidden athletes are never listed", async ({ page, browser }, info) => {
  // Maya (athlete, a minor): her wins, the staff draft to confirm, and no consent button.
  await login(page, USERS.maya);
  await page.goto("/today");
  await expect(page.locator("#wins-home")).toContainText("Your wins");
  await expect(page.locator("#wins-home")).toContainText("The gym heard about a win");
  const competing = page.locator("#wins-competing");
  await expect(competing).toContainText("athletes competing this week");
  await expect(competing).toContainText("Maya P.");
  const text = await competing.innerText();
  expect(text).not.toMatch(/\bEli\b/);
  expect(text).not.toMatch(/Parker|Fictional Falls|Makebelieve|Sampleton|6:30|18:30/);
  await noSideScroll(page);
  await shot(page, "athlete-home", info.project.name);
  await page.goto("/wins");
  await expect(page.getByText("A parent or guardian decides about public marketing for athletes under 18.").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /I agree, allow it/ })).toHaveCount(0);
  await noSideScroll(page);

  // Sam sees the pending marketing request for Leo's commitment.
  const sam = await as(browser, SAM, info.project.use.viewport);
  await sam.goto("/wins");
  await expect(sam.getByText("The gym would like to share this win publicly").first()).toBeVisible();
  await noSideScroll(sam);
  // Alex sees hidden Eli's own win on his family page, marked as not shown to others.
  const alex = await as(browser, USERS.alex, info.project.use.viewport);
  await alex.goto("/wins");
  await expect(alex.getByText("Name hidden from other families")).toBeVisible();
  await expect(alex.getByText("Scored the winner in the Sampleton Storm semifinal (sample)").first()).toBeVisible();
  await expect(alex.locator("#wins-feed")).not.toContainText("Sampleton Storm semifinal");
  await sam.context().close();
  await alex.context().close();
});
