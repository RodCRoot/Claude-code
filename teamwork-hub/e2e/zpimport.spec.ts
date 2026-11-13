import { expect, test, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * Zen Planner exact presets in the browser, at desktop and 390px. Run against
 * `pnpm build && pnpm start` seeded with `pnpm db:fresh`.
 *
 * Every person here is fictional. Each run uses its own made-up surname and Family ID, so the
 * desktop and mobile projects (and reruns) never collide.
 */
test.describe.configure({ mode: "serial" });

// Compared with the layout width, not innerWidth: a too-wide page widens innerWidth with it on a phone.
const noSideScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBeLessThanOrEqual(1);
const letters = () => Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

/** The wizard is a long page and the app scrolls smoothly: jump to the control first so the click lands on it at 390px too. */
async function press(page: Page, name: string | RegExp) {
  const b = page.getByRole("button", { name });
  await b.evaluate((el) => el.scrollIntoView({ behavior: "instant", block: "center" }));
  await b.click();
}

async function upload(page: Page, name: string, csv: string, schemaId: string) {
  await page.goto("/imports");
  await page.setInputFiles("#file", { name, mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.selectOption("#schemaId", schemaId);
  await page.getByRole("button", { name: /Upload/ }).click();
  await expect(page).toHaveURL(/\/imports\/[0-9a-f-]{36}/);
  await page.waitForLoadState("networkidle");
}

async function coverageAndCommit(page: Page) {
  // A file with no dates in it (no Signup Date column) has no detected coverage: staff type it in.
  if (!(await page.inputValue("#coverageStart"))) await page.fill("#coverageStart", "2026-01-01");
  if (!(await page.inputValue("#coverageEnd"))) await page.fill("#coverageEnd", "2026-11-13");
  await press(page, "Confirm coverage");
  await expect(page.getByRole("button", { name: "Update coverage" })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await press(page, "Commit import");
  await expect(page.getByText(/Committed .*"create":\s*\d+/).or(page.getByRole("heading", { name: "Reconciliation" })).first()).toBeVisible();
}

test("owner imports a fictional Person and Membership export with the exact presets, reviews matches, and reads the discount review", async ({ page }) => {
  const sfx = letters();
  const last = `Fictional${sfx}`;
  const family = `E2E-${sfx}`;
  const person = [
    "First Name,Last Name,Birth Date,Status,Family ID,Parent First,Parent Last,Parent Email,Allergies,Groups,Bar Code",
    `Nova,${last},04/02/2011,Member,${family},Quill,${last},quill.${sfx}@example.test,Peanuts (fictional),Soccer,X1`,
    `Orbit,${last},09/10/2013,Member,${family},Quill,${last},quill.${sfx}@example.test,,Basketball,X2`,
  ].join("\n");
  const membership = [
    "First Name,Last Name,Birth Date,Membership,Status,Mbr. Begin Date,Mbr. End Date,Months,Payment Amount,Att. Limit,Att. Limit Type,Autopay?,Family ID",
    `Nova,${last},04/02/2011,Sports Performance 2x per Week 12 Month,Active,01/05/2026,01/04/2027,12,$161.09,2,Weekly,Yes,${family}`,
    `Orbit,${last},09/10/2013,Sports Performance 2x per Week 12 Month,Active,01/05/2026,01/04/2027,12,$178.99,2,Weekly,Yes,${family}`,
  ].join("\n");

  await login(page, USERS.rod);

  // The guide explains the export steps and says plainly that the presets are untested against a real file.
  await page.goto("/imports/zenplanner");
  await expect(page.getByRole("heading", { level: 1, name: "Zen Planner" })).toBeVisible();
  await expect(page.getByText("not yet tested against a real export file").first()).toBeVisible();
  await expect(page.getByText(/person\/index\.cfm\?export=CSV&_c=/).first()).toBeVisible();
  await noSideScroll(page);

  // Person grid: no manual mapping, the unknown column is reported, not fatal.
  await upload(page, `person-${sfx}.csv`, person, "zenplanner.person_grid");
  const preset = page.getByTestId("preset-status");
  await expect(preset).toContainText("10 of 11 columns in this file were recognized without manual mapping");
  await expect(preset).toContainText("Not recognized (will not be imported): Bar Code");
  await expect(page.getByText("required fields mapped")).toBeVisible();
  await noSideScroll(page);
  await press(page, "Validate rows");
  await expect(page.getByRole("heading", { name: /Identity review/ })).toBeVisible();
  await expect(page.getByText("nothing to review")).toBeVisible();
  await expect(page.getByText(/A new parent\/guardian record will be created for Quill/).first()).toBeVisible();
  await noSideScroll(page);
  await coverageAndCommit(page);

  // Membership grid: name + birth date matches wait on the review screen for staff confirmation.
  await upload(page, `membership-${sfx}.csv`, membership, "zenplanner.membership_grid");
  await expect(page.getByTestId("preset-status")).toContainText("Every column in the file was recognized");
  await press(page, "Validate rows");
  await expect(page.getByRole("heading", { name: /Identity review — 2 people/ })).toBeVisible();
  await expect(page.getByText("2 rows waiting")).toBeVisible();
  await expect(page.locator("#review")).toContainText(`Nova ${last}`);
  await noSideScroll(page);
  await press(page, /Confirm all strong matches \(2\)/);
  await expect(page.getByText("nothing to review")).toBeVisible();
  await coverageAndCommit(page);

  // Discount review for this import.
  await page.getByRole("link", { name: "Open the discount review for this import" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Discount review" })).toBeVisible();
  const family10 = page.getByRole("region", { name: "Matches the family discount" });
  await expect(family10).toContainText(`Nova ${last}`);
  await expect(family10).toContainText("$178.99");
  await expect(family10).toContainText("$161.09");
  await expect(family10).toContainText("$17.90");
  const siblings = page.getByRole("region", { name: "Siblings without the family discount" });
  await expect(siblings).toContainText(`Orbit ${last}`);
  await expect(siblings).toContainText(family);
  await expect(page.getByText(/still needs confirmation/)).toBeVisible();
  await noSideScroll(page);
  const dl = page.getByRole("link", { name: "Download CSV" });
  await expect(dl).toHaveAttribute("download", "");
  const csv = await page.request.get((await dl.getAttribute("href"))!);
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(await csv.text()).toContain(`Siblings without the family discount,List price,Orbit ${last},${family}`);

  // Reconciliation page loads with the hub's figures and the entry form.
  await page.goto("/imports/zenplanner/reconcile");
  await expect(page.getByRole("heading", { level: 1, name: "Reconciliation" })).toBeVisible();
  await page.fill("#activeMembers", "9999");
  await page.getByRole("button", { name: "Compare and save" }).click();
  await expect(page.getByText("Saved. The comparison is at the top of the history below.")).toBeVisible();
  await expect(page.getByRole("region", { name: /Comparison as of/ }).first()).toContainText("9999");
  await noSideScroll(page);
});

test("operations and coaches cannot open the Zen Planner import pages or the discount CSV", async ({ page }) => {
  await login(page, USERS.erin);
  for (const path of ["/imports/zenplanner", "/imports/zenplanner/discounts", "/imports/zenplanner/reconcile"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/denied/);
    await expect(page.getByRole("heading", { level: 1, name: /Zen Planner|Discount review|Reconciliation/ })).toHaveCount(0);
  }
  const res = await page.request.get("/imports/zenplanner/discounts/export");
  expect(res.status()).toBe(403);
});

test("the webhook receiver is off by default", async ({ request }) => {
  const res = await request.post("/api/webhooks/zenplanner/people", { data: [{ firstName: "Nobody", lastName: "Fictional" }], headers: { "x-zp-shared-secret": "anything" } });
  expect(res.status()).toBe(404);
});
