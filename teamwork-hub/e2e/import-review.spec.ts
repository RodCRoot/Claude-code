import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * The identity review step with a long list: one decision per person (not per row), paged, searchable,
 * filterable, with bulk confirmation. Run against `pnpm build && pnpm start` seeded with `pnpm db:fresh`.
 *
 * Every person here is fictional. Each run uses its own made-up surname suffix, so the desktop and mobile
 * projects (and reruns) never collide.
 */
test.describe.configure({ mode: "serial" });

/** Compared with the layout width, not innerWidth. On failure the message names the elements that stick out. */
const noSideScroll = async (page: Page) => {
  const over = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth - w <= 1) return null;
    const clipped = (el: Element) => {
      for (let a = el.parentElement; a; a = a.parentElement) if (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(a).overflowX)) return true;
      return false;
    };
    return Array.from(document.querySelectorAll("body *"))
      .filter((el) => el.getBoundingClientRect().right > w + 1 && !clipped(el) && !el.closest("header"))
      .slice(0, 6)
      .map((el) => `${el.tagName.toLowerCase()}.${(el.getAttribute("class") ?? "").slice(0, 50)} "${(el.textContent ?? "").slice(0, 40)}"`)
      .concat(`scrollWidth ${document.documentElement.scrollWidth} > ${w}`);
  });
  expect(over, `${page.url()} scrolls sideways`).toBeNull();
};
/** Set SHOTS=1 to refresh docs/screenshots/ready/ (fictional people only). */
const shot = async (page: Page, name: string, project: string) => {
  if (process.env.SHOTS) await page.locator("#review").screenshot({ path: `docs/screenshots/ready/${name}-${project === "mobile" ? "390" : "desktop"}.png` });
};
const letters = () => Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

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

const FIRST = ["Niko", "Opal", "Pax", "Quill", "Rowan", "Sable", "Tarn", "Umber", "Vesper", "Wren"];
const PEOPLE = 60;

test("owner works through a review of 62 people: grouped by person, paged, searched, filtered, confirmed in bulk", async ({ page }, info) => {
  test.setTimeout(180_000);
  const sfx = letters();
  // 60 people with their own surname, plus two different people who share one name.
  const names = Array.from({ length: PEOPLE }, (_, i) => ({ first: FIRST[i % FIRST.length], last: `Madeup${sfx}${String(i).padStart(2, "0")}` }));
  const twin = { first: "Twin", last: `Pretend${sfx}` };
  const person = [
    "First Name,Last Name,Birth Date,Status",
    ...names.map((n, i) => `${n.first},${n.last},"Mar ${1 + (i % 28)}, 2011",Member`),
    `${twin.first},${twin.last},"Jan 5, 2010",Member`,
    `${twin.first},${twin.last},"Feb 6, 2012",Member`,
  ].join("\n");
  // Attendance as the real grid may arrive: names only, a date-time in one column, ON / OFF. Three rows per person.
  const visits = ["Nov 2, 2026 4:30 PM", "Nov 4, 2026 4:30 PM", "Nov 6, 2026 4:30 PM"];
  const attendance = [
    "First Name,Last Name,Date,Att.,Rsvp,Program",
    ...[...names, twin].flatMap((n) => visits.map((v, k) => `${n.first},${n.last},"${v}",${k === 2 ? "OFF" : "ON"},ON,Sports Performance`)),
  ].join("\n");

  await login(page, USERS.rod);
  await upload(page, `person-${sfx}.csv`, person, "zenplanner.person_grid");
  await press(page, "Validate rows");
  await expect(page.getByText("nothing to review")).toBeVisible();
  if (!(await page.inputValue("#coverageStart"))) await page.fill("#coverageStart", "2026-01-01");
  if (!(await page.inputValue("#coverageEnd"))) await page.fill("#coverageEnd", "2026-11-13");
  await press(page, "Confirm coverage");
  await expect(page.getByRole("button", { name: "Update coverage" })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await press(page, "Commit import");
  await expect(page.getByRole("heading", { name: "Reconciliation" })).toBeVisible();

  await upload(page, `attendance-${sfx}.csv`, attendance, "zenplanner.attendance_grid");
  await expect(page.getByText("required fields mapped")).toBeVisible();
  await press(page, "Validate rows");

  // 61 names (the shared name is one entry), 122 attended rows waiting: decisions are per person, not per row.
  const review = page.locator("#review");
  await expect(page.getByRole("heading", { name: "Identity review — 61 people" })).toBeVisible();
  await expect(review.getByText("122 rows waiting")).toBeVisible();
  await expect(review.getByTestId("review-count")).toHaveText("Showing 1 to 25 of 61 people.");
  await expect(review.getByRole("button", { name: "Save decision" })).toHaveCount(25);
  await expect(review.getByText("2 row(s)").first()).toBeVisible();
  // The people list for "link to someone else" is on the page once, not once per person.
  expect(await page.locator("datalist#review-people").count()).toBe(1);
  expect(await review.locator("select").count()).toBe(0);
  await noSideScroll(page);
  // The import page is reached by id, so it is not in the a11y route list: audit the review step here (WCAG A + AA).
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`)).toEqual([]);

  await shot(page, "review-page-1", info.project.name);

  // Paging.
  const pages = page.getByRole("navigation", { name: "Pages of people to review" });
  await expect(pages).toContainText("Page 1 of 3");
  await pages.getByRole("link", { name: "Next" }).click();
  await expect(page).toHaveURL(/rp=2/);
  await expect(review.getByTestId("review-count")).toHaveText("Showing 26 to 50 of 61 people.");
  await pages.getByRole("link", { name: "Next" }).click();
  await expect(review.getByTestId("review-count")).toHaveText("Showing 51 to 61 of 61 people.");
  await expect(pages.getByRole("link", { name: "Next" })).toHaveCount(0);

  // Filter by how the person matched: the shared name is the only one with several candidates.
  const filters = page.getByRole("navigation", { name: "Filter people to review" });
  await expect(filters.getByRole("link", { name: "Name only (60)" })).toBeVisible();
  await filters.getByRole("link", { name: "Several candidates (1)" }).click();
  await expect(review.getByTestId("review-count")).toHaveText("Showing 1 to 1 of 1 person (filtered from 61).");
  await expect(review).toContainText(`${twin.first} ${twin.last}`);
  await expect(review.getByRole("radio", { name: /Link to Twin/ })).toHaveCount(2);
  await shot(page, "review-several-candidates", info.project.name);
  // Decide it: the 2012 twin. The filter is kept and the list is now empty.
  await review.getByRole("radio", { name: /2012-02-06/ }).check();
  await press(page, "Save decision");
  await expect(page.getByText("Resolved 2 row(s).")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Identity review — 60 people" })).toBeVisible();

  // Search by name, then link that one person through the type-ahead instead of the suggestion.
  await page.goto(page.url().replace(/\?.*$/, ""));
  const target = names[37];
  const other = names[38];
  await page.getByLabel("Find a person in this list").fill(target.last.toUpperCase());
  await page.getByRole("search", { name: "Find a person to review" }).getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/rq=/);
  await expect(review.getByTestId("review-count")).toHaveText("Showing 1 to 1 of 1 person (filtered from 60).");
  await expect(review).toContainText(`${target.first} ${target.last}`);
  await expect(review.getByText("name only", { exact: true })).toBeVisible();
  // Free text that is not a pick from the suggestions is refused.
  const manual = review.getByLabel(/link .* to someone else/);
  await manual.fill("somebody else");
  await press(page, "Save decision");
  await expect(page.getByText("Pick the person from the suggestions that appear as you type their name.")).toBeVisible();
  const pick = await page.locator("datalist#review-people option").evaluateAll((opts, last) => (opts as HTMLOptionElement[]).map((o) => o.value).find((v) => v.startsWith(`${last},`)) ?? "", other.last);
  expect(pick).toContain(other.last);
  await manual.fill(pick);
  await press(page, "Save decision");
  await expect(page.getByText("Resolved 2 row(s).")).toBeVisible();
  // The search is kept after the decision; nobody is left under it.
  await expect(page).toHaveURL(/rq=/);
  await expect(review.getByTestId("review-count")).toHaveText("Nobody in this list matches.");
  await page.getByRole("link", { name: "Clear search" }).click();
  await expect(page.getByRole("heading", { name: "Identity review — 59 people" })).toBeVisible();
  await noSideScroll(page);

  // Everyone else in one deliberate step.
  page.once("dialog", (d) => {
    expect(d.message()).toContain("Link 59 people by name alone?");
    void d.accept();
  });
  await press(page, "Confirm all name-only matches (59)");
  await expect(page.getByText("Confirmed the name-only match for 59 people.")).toBeVisible();
  await expect(page.getByText("nothing to review")).toBeVisible();

  // Commit: two visits per person; the OFF rows are skipped, and so are the two visits of the person whose
  // rows were linked to someone who has their own rows for the same sessions (never double-booked).
  await press(page, "Confirm coverage");
  await expect(page.getByRole("button", { name: "Update coverage" })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await press(page, "Commit import");
  await expect(page.getByText("Committed: 120 created, 0 linked, 0 updated, 63 skipped, 0 rejected.")).toBeVisible();
  await noSideScroll(page);
});
