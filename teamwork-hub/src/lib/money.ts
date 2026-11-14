/** Money helpers. All amounts are integer minor units; never use floats for money. */

export function formatMoney(minor: number | null | undefined, currency = "USD"): string {
  if (minor == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
}

/** Parse a user-entered dollar string ("$1,234.50") into minor units, or null if invalid. */
export function parseMoneyToMinor(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.replace("-", "").split(".");
  const value = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return cleaned.startsWith("-") ? -value : value;
}

/** Percentage discount in minor units, rounded half-up to the cent. */
export function percentOf(minor: number, percent: number): number {
  return Math.round((minor * percent) / 100);
}

export function assertSameCurrency(a: string, b: string) {
  if (a.toUpperCase() !== b.toUpperCase()) throw new Error(`Currency mismatch: ${a} vs ${b}`);
}
