// Interaction-level E2E in real Chrome: actually USES the app — logs sets,
// completes a session, checks in, creates a goal, posts/reacts/DMs, runs an
// eval session — then verifies cross-role data flow (athlete actions visible
// to the coach). Throws on any failed expectation; collects console errors.
// Requires: a seeded server running (FORCE_SEED=1 npm run seed && npm start in
// server/) and playwright (local devDep or global). BASE via E2E_BASE_URL.
import { execSync } from "child_process";
let chromium;
try { ({ chromium } = await import("playwright")); }
catch {
  const g = execSync("npm root -g").toString().trim();
  ({ chromium } = await import(`${g}/playwright/index.mjs`));
}

const BASE = process.env.E2E_BASE_URL || "http://localhost:4000";
const problems = [];
let step = "";
const ok = (name) => console.log(`  ✓ ${name}`);

const browser = await chromium.launch();
let lastPage = null;
async function dumpAndExit(err) {
  console.error("FAILED @", step, "-", String(err).slice(0, 300));
  console.error("problems so far:", JSON.stringify([...new Set(problems)], null, 1));
  try { if (lastPage) { await lastPage.screenshot({ path: "e2e-failure.png" }); console.error("screenshot: shots/failure.png"); } } catch {}
  process.exit(1);
}
process.on("unhandledRejection", dumpAndExit);
process.on("uncaughtException", dumpAndExit);

function wire(page) {
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console @ ${step}: ${m.text().slice(0, 150)}`); });
  page.on("pageerror", (e) => problems.push(`pageerror @ ${step}: ${String(e).slice(0, 150)}`));
  page.on("response", (r) => { if (r.status() >= 400 && r.url().includes("/api/")) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(BASE, "")} @ ${step}`); });
}

async function login(page, email) {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.locator("label:has-text('Email') input").fill(email);
  await page.locator("input[type=password]").fill("password123");
  await page.locator("button[type=submit]").click();
  await page.waitForSelector(".sidebar", { timeout: 10000 }); // fails loudly if login rejected
  await page.waitForLoadState("networkidle");
}

// ============ ATHLETE FLOW (phone) ============
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  lastPage = page;
  wire(page);
  step = "athlete login";
  await login(page, "athlete@vantage.dev");
  ok(step);

  step = "athlete opens today's session and logs 2 sets";
  await page.goto(BASE + "/training", { waitUntil: "networkidle" });
  await page.locator(".athlete-card.as-button").first().click();
  await page.waitForLoadState("networkidle");
  const tiny = page.locator("input.tiny");
  // first set row: reps, load, velocity (skip rpe)
  await tiny.nth(0).fill("2");
  await tiny.nth(1).fill("60");
  await tiny.nth(2).fill("1.02");
  // second set row
  await tiny.nth(4).fill("2");
  await tiny.nth(5).fill("60");
  await tiny.nth(6).fill("0.97");
  await page.locator("button:has-text('Save progress')").click();
  await page.waitForLoadState("networkidle");
  ok(step);

  step = "athlete marks session complete";
  await page.locator("button:has-text('Mark complete')").click();
  await page.waitForSelector("text=Workout completed ✓");
  await page.waitForTimeout(900); // logger navigates back after 600ms
  await page.waitForSelector("text=COMPLETED");
  ok(step);

  step = "athlete submits wellness check-in";
  await page.goto(BASE + "/wellness", { waitUntil: "networkidle" });
  await page.locator("label:has-text('Notes') input").fill("hamstring a bit tight");
  await page.locator("button:text-matches('check-in', 'i')").first().click();
  await page.waitForSelector("text=saved ✓");
  ok(step);

  step = "athlete creates own goal via UI";
  await page.goto(BASE + "/goals", { waitUntil: "networkidle" });
  await page.locator("button:has-text('New goal')").click();
  await page.locator("label:has-text('Target') input").fill("99");
  await page.locator("button:has-text('Set goal')").click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
  if (!(await page.locator(".goal-card").count())) throw new Error("goal card did not appear");
  ok(step);
  await ctx.close();
}

// ============ COACH FLOW (desktop) ============
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  wire(page);
  step = "coach login";
  await login(page, "coach@vantage.dev");
  ok(step);

  step = "coach sees athlete's session on adherence board (today)";
  await page.locator("button:has-text('Show all athletes')").click();
  await page.waitForTimeout(200);
  const row = page.locator("tr", { hasText: "Jordan Smith" }).first();
  if (!(await row.locator("text=today").count())) throw new Error("Jordan Smith's completion not shown as 'today'");
  ok(step);

  step = "coach sees athlete's check-in on Readiness (with note)";
  await page.goto(BASE + "/wellness", { waitUntil: "networkidle" });
  if (!(await page.locator("text=hamstring a bit tight").count())) throw new Error("check-in note not on readiness board");
  ok(step);

  step = "coach posts announcement + fist-bumps a post";
  await page.goto(BASE + "/feed", { waitUntil: "networkidle" });
  await page.locator("input[placeholder='Post an announcement…']").fill("Facility closed Monday for floor refinish");
  await page.locator("button:has-text('Post')").click();
  await page.waitForSelector("text=Facility closed Monday");
  await page.locator(".fist").first().click();
  await page.waitForTimeout(300);
  ok(step);

  step = "coach DMs the athlete";
  await page.goto(BASE + "/messages", { waitUntil: "networkidle" });
  await page.waitForSelector("#recip option:nth-child(2)", { state: "attached" }); // recipients load async
  await page.locator("#recip").selectOption({ index: 1 }); // 0 is the disabled placeholder
  await page.locator("button:has-text('Message')").first().click();
  await page.locator("input[placeholder='Type a message…']").fill("Great velocity numbers today 👊");
  await page.locator("button:has-text('Send')").click();
  await page.waitForSelector("text=Great velocity numbers today");
  ok(step);

  step = "coach runs a new eval session and enters a result";
  await page.goto(BASE + "/evals", { waitUntil: "networkidle" });
  await page.locator("button:has-text('Run testing session')").first().click();
  await page.waitForLoadState("networkidle");
  await page.locator("input.eval-cell").first().fill("1.69");
  await page.locator("button:has-text('Save results')").click();
  await page.waitForSelector("text=Saved 1");
  ok(step);

  step = "gym mode: pick athlete, open session, finish";
  await page.goto(BASE + "/gym", { waitUntil: "networkidle" });
  await page.locator(".kiosk-search").fill("Taylor");
  await page.locator(".kiosk-tile", { hasText: "Taylor Johnson" }).click();
  await page.waitForSelector(".kiosk-tile"); // session list loads async
  await page.locator(".kiosk-tile").first().click();
  await page.waitForSelector(".kiosk-input");
  await page.locator(".kiosk-input").first().fill("3");
  await page.locator("button:has-text('Finish session')").click();
  await page.waitForSelector(".kiosk-search"); // back at athlete picker
  ok(step);
  await ctx.close();
}

await browser.close();
console.log(`\n=== PROBLEMS (${problems.length}) ===`);
for (const p of [...new Set(problems)]) console.log(" -", p);
if (problems.length) process.exit(1);
console.log("ALL INTERACTION FLOWS PASSED");
