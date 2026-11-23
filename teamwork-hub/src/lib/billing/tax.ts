/**
 * Sales tax arithmetic. Pure integer math on minor units, no I/O, safe to import in client code
 * (the front-desk sale screen previews with the same function the server bills with).
 *
 * The rule:
 *  - Only lines flagged taxable carry tax. The flag is copied from the product when the bill is made.
 *  - A price discount on the bill is spread across ALL its lines in proportion to their amounts, so a
 *    taxable line is taxed on what was actually charged for it.
 *  - Credits (family rate credit, account credit) are not price discounts: they lower the amount due
 *    and never lower the tax.
 *  - Tax is rounded ONCE per bill: (sum of taxable amounts after discount) x rate, half up to the cent.
 *    The per-line tax figures are that bill total split back across the taxable lines, so they always
 *    add up to it.
 */

/** Rate in basis points: 700 = 7.00%. */
export const DEFAULT_SALES_TAX_BPS = 700;
export const DEFAULT_SALES_TAX_LABEL = "Indiana state sales tax";

/** round(numerator / denominator), halves up. Non-negative integers only. */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

/** Tax on a taxable amount at a rate in basis points, half up to the minor unit. */
export function taxOn(taxableMinor: number, rateBps: number): number {
  if (taxableMinor <= 0 || rateBps <= 0) return 0;
  return divRoundHalfUp(taxableMinor * rateBps, 10_000);
}

/**
 * Split `total` across `weights` in proportion, in whole minor units that add up to exactly `total`
 * (largest remainder; ties go to the earlier line).
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const base = weights.map((w) => Math.floor((total * w) / sum));
  let left = total - base.reduce((s, x) => s + x, 0);
  const order = weights
    .map((w, i) => ({ i, rem: (total * w) % sum }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    if (weights[o.i] <= 0) continue;
    base[o.i] += 1;
    left -= 1;
  }
  return base;
}

export type TaxLineInput = { amountMinor: number; taxable: boolean };
export type TaxResult = {
  /** Per line, same order as the input. */
  lines: { discountMinor: number; taxMinor: number }[];
  /** Taxable lines after their share of the price discount: what the rate is applied to. */
  taxableMinor: number;
  taxMinor: number;
};

/**
 * @param priceDiscountMinor the bill's price discount (NOT credits)
 * @param rateBps 0 = no tax
 */
export function computeTax(lines: TaxLineInput[], priceDiscountMinor: number, rateBps: number): TaxResult {
  const discounts = allocate(Math.max(0, priceDiscountMinor), lines.map((l) => l.amountMinor));
  const bases = lines.map((l, i) => (l.taxable ? Math.max(0, l.amountMinor - discounts[i]) : 0));
  const taxableMinor = bases.reduce((s, x) => s + x, 0);
  const taxMinor = taxOn(taxableMinor, rateBps);
  const taxes = allocate(taxMinor, bases);
  return { lines: lines.map((_, i) => ({ discountMinor: discounts[i], taxMinor: taxes[i] })), taxableMinor, taxMinor };
}

/** "7.00%" from 700; trailing zeros beyond two decimals are never needed (basis points). */
export function formatRate(rateBps: number): string {
  return `${(rateBps / 100).toFixed(2)}%`;
}

/** Parse "7", "7.0", "7.25%" into basis points. Blank = 0 (no tax). Null = not a valid rate. */
export function parseRateToBps(raw: string): number | null {
  const s = raw.trim().replace(/%$/, "").trim();
  if (s === "") return 0;
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
