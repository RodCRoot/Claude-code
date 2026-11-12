import { expect, test, type BrowserContext } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * Community module in the browser (run against `pnpm build && pnpm start` seeded with
 * `pnpm db:fresh`): what a gym TV can and cannot reach, revoking a screen, the board keeping its
 * last data when the network drops, and what families see on the leaderboards.
 */
/** Demo display token from scripts/seed/community.ts (synthetic data only). */
const DISPLAY_LINK = "/display/link/TeamworkDemoDisplayBoardTV00000000000000000";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const APP_ROUTES = ["/today", "/people", "/schedule", "/billing", "/training", "/science", "/performance", "/messages", "/documents", "/reports", "/settings", "/settings/community", "/settings/audit", "/leaderboards", "/kiosk", "/payroll", "/imports", "/showcase", "/recap", "/wins", "/wins/marketing"];

async function connect(context: BrowserContext) {
  const page = await context.newPage();
  await page.goto(DISPLAY_LINK);
  await expect(page).toHaveURL(/\/display$/);
  await expect(page.getByRole("heading", { level: 1, name: /community board/i })).toBeAttached();
  return page;
}

test("a display device reads the board and nothing else", async ({ context }) => {
  const page = await connect(context);
  // The token left the URL and lives in an httpOnly cookie the page cannot read.
  expect(await page.evaluate(() => document.cookie)).not.toContain("tw_display");
  const cookie = (await context.cookies()).find((c) => c.name === "tw_display");
  expect(cookie?.httpOnly).toBe(true);
  expect((await context.cookies()).some((c) => c.name === "tw_session")).toBe(false);

  const res = await page.request.get("/api/display/board");
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(JSON.parse(body).panels.length).toBeGreaterThan(3);
  // Display names only: no ids, no full last names, and the hidden demo athlete (Eli) is absent.
  expect(body).not.toMatch(UUID);
  expect(body).not.toContain("Parker");
  expect(body).not.toMatch(/\bEli\b/);
  expect(body).toContain("Maya P.");
  // Wins panel: approved wins under display names. The hidden athlete's approved win, a win still
  // waiting for review and a staff draft awaiting the family are all absent, as are source links.
  const winsPanel = JSON.parse(body).panels.find((p: { key: string }) => p.key === "wins");
  expect(JSON.stringify(winsPanel)).toContain("all-conference second team");
  expect(body).not.toContain("Sampleton Storm semifinal");
  expect(body).not.toContain("Career high 14 kills");
  expect(body).not.toContain("Sectional opener");
  expect(body).not.toContain("https://");

  // Every app route treats the TV as signed out.
  for (const route of APP_ROUTES) {
    await page.goto(route);
    expect(new URL(page.url()).pathname, `${route} must bounce to /login`).toBe("/login");
  }
  // So does every other API it might try, and the board endpoint is read-only.
  for (const [method, url] of [
    ["POST", "/api/anywhere/complete"],
    ["GET", "/api/exports/people"],
    ["GET", "/api/reports/attendance"],
    ["GET", "/api/training/today"],
  ] as const) {
    const r = await page.request.fetch(url, { method, data: method === "POST" ? { items: [{}] } : undefined, maxRedirects: 0 });
    expect([401, 403, 404, 405, 307, 308], `${method} ${url} -> ${r.status()}`).toContain(r.status());
    expect(await r.text()).not.toContain("Maya");
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const r = await page.request.fetch("/api/display/board", { method, data: {} });
    expect(r.status(), `${method} /api/display/board`).toBe(405);
  }
  // The board itself has no link out to the app.
  await page.goto("/display");
  expect(await page.locator('a[href]:not([href^="#"])').count()).toBe(0);
});

test("without a token, or with a made-up one, there is no board", async ({ page }) => {
  expect((await page.request.get("/api/display/board")).status()).toBe(401);
  await page.goto("/display");
  await expect(page.getByRole("heading", { name: "This screen is not connected" })).toBeVisible();
  await page.goto("/display/link/not-a-real-display-token-0000000000000000000");
  await expect(page.getByRole("heading", { name: "This screen is not connected" })).toBeVisible();
  expect((await page.request.get("/api/display/board")).status()).toBe(401);
});

test("an admin adds a screen, the TV connects, and revoking it kills the token", async ({ page, browser }) => {
  await login(page, USERS.rod);
  await page.goto("/settings/community");
  // Let the form hydrate: the one-time link is shown by client state, not by a page reload.
  await page.waitForLoadState("networkidle");
  const label = `E2E TV ${Date.now().toString().slice(-6)}`;
  await page.getByLabel("Screen name").fill(label);
  await page.getByRole("button", { name: "Create screen link" }).click();
  const link = await page.locator("#one-time-link").inputValue();
  expect(link).toMatch(/\/display\/link\/[A-Za-z0-9_-]{43}$/);

  const tv = await browser.newContext();
  const tvPage = await tv.newPage();
  await tvPage.goto(new URL(link).pathname);
  await expect(tvPage).toHaveURL(/\/display$/);
  expect((await tvPage.request.get("/api/display/board")).status()).toBe(200);

  await page.reload();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: new RegExp(`Revoke\\s*: ${label}`) }).click();
  // The row swaps its Revoke button for a "Revoked" badge.
  await expect(page.locator("#displays li", { hasText: label })).toContainText(/Revoked [A-Z]/);

  expect((await tvPage.request.get("/api/display/board")).status()).toBe(401);
  await tvPage.goto("/display");
  await expect(tvPage.getByRole("heading", { name: "This screen is not connected" })).toBeVisible();
  // The old link is dead too.
  await tvPage.goto(new URL(link).pathname);
  await expect(tvPage.getByRole("heading", { name: "This screen is not connected" })).toBeVisible();
  await tv.close();
});

test("the board cuts between panels, refreshes in place, and keeps its last data when the network drops", async ({ context }) => {
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(DISPLAY_LINK);
  await expect(page).toHaveURL(/\/display$/);
  const first = await page.locator("main section").first().getAttribute("aria-label");
  // No CSS transition or animation anywhere on the board: panels cut.
  const animated = await page.evaluate(() => [...document.querySelectorAll("*")].filter((el) => {
    const s = getComputedStyle(el);
    return s.animationName !== "none" || (s.transitionDuration !== "0s" && s.transitionProperty !== "none" && el.tagName !== "BUTTON");
  }).length);
  expect(animated).toBe(0);
  await page.clock.fastForward(16_000);
  await expect.poll(async () => page.locator("main section").first().getAttribute("aria-label")).not.toBe(first);

  // Drop the network for the data endpoint: the panel stays up and the footer says so.
  let refreshes = 0;
  await page.route("**/api/display/board", (route) => {
    refreshes++;
    return route.abort();
  });
  await page.clock.fastForward(61_000);
  await expect(page.getByText("Offline, showing the last update.")).toBeVisible();
  expect(refreshes).toBeGreaterThan(0);
  await expect(page.locator("main section").first()).toBeVisible();
  await expect(page.getByText(/Last updated/)).toBeVisible();

  // Back online: the note goes away without a page reload.
  await page.unroute("**/api/display/board");
  await page.clock.fastForward(61_000);
  await expect(page.getByText("Offline, showing the last update.")).toHaveCount(0);
});

test("families: own rank even when hidden, no trace of the hidden athlete for anyone else, shoutouts on Athlete Home", async ({ page, browser }) => {
  await login(page, USERS.alex);
  await page.goto("/leaderboards?band=U14");
  await expect(page.getByRole("heading", { level: 1, name: "Leaderboards" })).toBeVisible();
  await expect(page.getByText(/Eli: \d+(st|nd|rd|th).*hidden from the board/).first()).toBeVisible();
  await expect(page.getByText("not shown at all")).toBeVisible();
  await page.goto("/today");
  await page.getByRole("navigation", { name: "Choose athlete" }).getByRole("link", { name: "Maya" }).click();
  await expect(page.getByRole("heading", { name: "Shoutouts" })).toBeVisible();
  await expect(page.locator("#community-shoutouts")).toContainText("Coach Marcus Hale");

  // Chris's athlete (Ava) is in the same age group as Eli.
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await login(p2, USERS.chris);
  await p2.goto("/leaderboards?band=U14");
  await expect(p2.getByRole("heading", { level: 1, name: "Leaderboards" })).toBeVisible();
  await expect(p2.locator("main")).not.toContainText("Eli");
  // A band none of Chris's athletes are in falls back to their own.
  await p2.goto("/leaderboards?band=Adult");
  await expect(p2.getByRole("heading", { name: "U14 boards" })).toBeVisible();
  await other.close();
});

test("a minor cannot change their own display name; a coach posts shoutouts only for their own athletes", async ({ page, browser }) => {
  await login(page, USERS.maya);
  await page.goto("/leaderboards");
  await expect(page.getByText("A parent or guardian chooses this for athletes under 18.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save name setting" })).toHaveCount(0);

  const coach = await browser.newContext();
  const p2 = await coach.newPage();
  await login(p2, USERS.marcus);
  await p2.goto("/leaderboards");
  await expect(p2.getByRole("heading", { name: "Challenges", exact: true })).toBeVisible();
  // Coaches cannot reach community settings or the TV preview.
  await p2.goto("/settings/community");
  await expect(p2).toHaveURL(/\/denied/);
  await p2.goto("/display");
  await expect(p2.getByRole("heading", { name: "This screen is not connected" })).toBeVisible();
  await coach.close();
});
