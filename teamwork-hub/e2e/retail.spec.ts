import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { login, USERS } from "./helpers";

/**
 * Sales tax and size variants (owner's decision 2026-11-23). Run against `pnpm build && pnpm start`
 * seeded with `pnpm db:fresh`. Fictional sample products only; nothing is charged or sent.
 *
 * The spec turns the sample T-shirt's "Taxable" switch and shop listing ON (a fresh organization
 * starts with every product untaxed), sells one at the front desk and orders one in the Family Shop.
 * It runs serially and each project (desktop, mobile) sells a different size, so it can be run once
 * per project against the same database. Set SHOTS=1 to save screenshots under docs/screenshots/retail/.
 */
test.describe.configure({ mode: "serial" });

const SHIRT = "Sample — Team T-Shirt";
const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `docs/screenshots/retail/${test.info().project.name}-${name}.png`, fullPage: true });
};
const noSideScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth), `${page.url()} scrolls sideways`).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
const axe = async (page: Page) => {
  const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.length}`), `axe on ${page.url()}`).toEqual([]);
};

test("Settings shows the Indiana 7.00% rate with the accountant hint; the shirt is made taxable and sellable online", async ({ page }) => {
  await login(page, USERS.rod);
  await page.goto("/settings/payments");
  const card = page.locator("#sales-tax");
  await expect(card.locator("#salesTaxRate")).toHaveValue("7.00");
  await expect(card.locator("#salesTaxLabel")).toHaveValue("Indiana state sales tax");
  await expect(card).toContainText("no local sales taxes");
  await expect(card).toContainText("Confirm the rate with your accountant");
  await card.scrollIntoViewIfNeeded();
  await shot(page, "settings-rate");
  await noSideScroll(page);
  await axe(page);

  await page.goto("/billing/products");
  const row = page.locator("tr", { hasText: SHIRT }).first();
  // Memberships have no tax switch at all.
  await expect(page.locator("tr", { hasText: "Unlimited" }).first().locator('input[name="taxable"]')).toHaveCount(0);
  await row.locator("summary", { hasText: "Sales tax and sizes" }).click();
  const box = row.locator('input[name="taxable"]');
  if (!(await box.isChecked())) {
    await box.check();
    await row.getByRole("button", { name: "Save tax setting" }).click();
    await expect(page.locator("tr", { hasText: SHIRT }).first()).toContainText("Taxable");
  }
  const again = page.locator("tr", { hasText: SHIRT }).first();
  if (!(await again.locator("summary", { hasText: "Sales tax and sizes" }).locator("..").getAttribute("open"))) await again.locator("summary", { hasText: "Sales tax and sizes" }).click();
  await expect(again.locator("table")).toContainText("YS");
  await expect(again.locator("table")).toContainText("Total");
  await shot(page, "product-sizes");
  await axe(page);
  await again.locator("summary", { hasText: "Family Shop" }).click();
  const online = again.locator('input[name="sellableOnline"]');
  if (!(await online.isChecked())) {
    await online.check();
    await online.locator("xpath=ancestor::form").getByRole("button", { name: "Save" }).click();
    await expect(page.locator("tr", { hasText: SHIRT }).first()).toContainText("Sellable online");
  }
});

test("front desk: a taxable shirt in a chosen size shows the tax before the sale and the size on the receipt", async ({ page }) => {
  const size = test.info().project.name === "mobile" ? "YM" : "S";
  await login(page, USERS.erin);
  await page.goto("/billing/pos");
  // XL is out of stock in the seed and cannot be added.
  await expect(page.getByRole("button", { name: `Add ${SHIRT}, Size XL` })).toBeDisabled();
  const totals = page.getByTestId("pos-totals");
  await page.locator("#qty0").fill("0");
  await page.getByRole("button", { name: `Add ${SHIRT}, Size ${size}`, exact: false }).first().click();
  await expect(page.locator("#item0 option:checked")).toContainText(`${SHIRT}, Size ${size}`);
  await expect(page.getByTestId("pos-subtotal")).toHaveText("$25.00");
  await expect(totals).toContainText("Indiana state sales tax (7.00%)");
  await expect(page.getByTestId("pos-tax")).toHaveText("$1.75");
  await expect(page.getByTestId("pos-total")).toHaveText("$26.75");
  // An untaxed item adds to the subtotal but not to the tax.
  await page.locator("#item1").selectOption({ label: await page.locator("#item1 option", { hasText: "Sample — Shaker Bottle" }).first().innerText() });
  await page.locator("#qty1").fill("1");
  await expect(page.getByTestId("pos-subtotal")).toHaveText("$37.00");
  await expect(page.getByTestId("pos-tax")).toHaveText("$1.75");
  await expect(page.getByTestId("pos-total")).toHaveText("$38.75");
  await totals.scrollIntoViewIfNeeded();
  await shot(page, "pos-before-sale");
  await noSideScroll(page);
  await axe(page);

  await page.locator("#paymentKind").selectOption("invoice");
  await page.getByRole("button", { name: "Complete sale" }).click();
  await page.waitForURL(/\/billing\/invoices\/[0-9a-f-]{36}$/);
  await expect(page.locator("table").first()).toContainText(`${SHIRT}, Size ${size}`);
  await expect(page.getByTestId("tax-label")).toContainText("Indiana state sales tax (7.00%) on $25.00");
  await expect(page.getByTestId("tax-amount")).toHaveText("$1.75");
  await expect(page.locator("dl", { hasText: "Balance due" })).toContainText("$38.75");
  await shot(page, "invoice");
  await noSideScroll(page);

  await page.goto(`${page.url()}/receipt`);
  const receipt = page.locator("article");
  await expect(receipt).toContainText(`${SHIRT}, Size ${size} (T)`);
  await expect(page.getByTestId("receipt-tax-label")).toHaveText("Indiana state sales tax (7.00%)");
  await expect(page.getByTestId("receipt-tax")).toHaveText("$1.75");
  await expect(receipt).toContainText("$38.75");
  await shot(page, "receipt");
  await noSideScroll(page);
  await axe(page);
});

test("Family Shop: a size must be chosen, tax is shown before ordering, and the order shows the tax", async ({ page }) => {
  const size = test.info().project.name === "mobile" ? "YL" : "YS";
  await login(page, USERS.alex);
  await page.goto("/shop");
  const card = page.locator("li", { hasText: "Sample: Team T-Shirt" }).first();
  await expect(card.getByTestId("shop-tax")).toContainText("Plus $1.75 sales tax (7.00%). Total $26.75");
  const pick = card.locator('select[name="variantId"]');
  await expect(pick).toHaveAttribute("required", "");
  await expect(pick.locator("option", { hasText: "XL (out of stock)" })).toBeDisabled();
  await card.scrollIntoViewIfNeeded();
  await shot(page, "shop");
  await noSideScroll(page);
  await axe(page);
  await pick.selectOption({ label: size });
  const who = card.locator('select[name="athleteId"]');
  if (await who.count()) await who.selectOption({ index: 1 });
  await card.getByRole("button", { name: /Place order|Order and pay/ }).click();
  await page.waitForURL(/\/shop\/order\/[0-9a-f-]{36}$/);
  await expect(page.locator("main")).toContainText(`Sample: Team T-Shirt, Size ${size}`);
  await expect(page.locator("main")).toContainText("Indiana state sales tax (7.00%)");
  await expect(page.locator("main")).toContainText("$1.75");
  await expect(page.locator("main")).toContainText("$26.75");
  await shot(page, "shop-order");
  await noSideScroll(page);
  await axe(page);
});

test("Sales tax collected report states its basis, defines its columns and exports CSV", async ({ page }) => {
  await login(page, USERS.rod);
  await page.goto("/reports/sales-tax");
  await expect(page.locator("main")).toContainText("ACCRUAL");
  await expect(page.locator("main")).toContainText("What each column means");
  await expect(page.locator("table")).toContainText("7.00%");
  await expect(page.locator("table")).toContainText("Net tax");
  await shot(page, "report");
  await axe(page);
  const res = await page.request.get("/api/reports/sales-tax");
  expect(res.status()).toBe(200);
  expect((await res.text()).split("\n")[0]).toContain("Taxable sales (USD),Tax collected (USD)");
});
