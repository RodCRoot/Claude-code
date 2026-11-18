import { percentOf } from "@/lib/money";

export type EventPricing = {
  priceMinor: number;
  earlyBirdPriceMinor: number | null;
  earlyBirdUntil: string | null;
  siblingDiscountPercent: number | null;
};

/** Default time an unpaid registration holds its spot. Staff set it per event. */
export const DEFAULT_HOLD_HOURS = 48;

/** The price in effect on a facility local date: early bird through the end of its last day, else the regular price. */
export function eventPriceOn(e: EventPricing, todayYmd: string): { baseMinor: number; earlyBird: boolean } {
  const early = e.earlyBirdPriceMinor != null && e.earlyBirdUntil != null && todayYmd <= e.earlyBirdUntil && e.earlyBirdPriceMinor < e.priceMinor;
  return early ? { baseMinor: e.earlyBirdPriceMinor!, earlyBird: true } : { baseMinor: e.priceMinor, earlyBird: false };
}

export type PricedSeat = { baseMinor: number; earlyBird: boolean; siblingDiscountMinor: number; amountMinor: number };

/**
 * Prices `count` new seats for one billing account. The sibling discount applies to every athlete
 * after the family's first on this event, counting registrations the family already holds
 * (`alreadyRegistered`). It is taken off the price in effect (early bird included), rounded to the cent.
 */
export function priceSeats(e: EventPricing, todayYmd: string, count: number, alreadyRegistered: number): PricedSeat[] {
  const { baseMinor, earlyBird } = eventPriceOn(e, todayYmd);
  const out: PricedSeat[] = [];
  for (let i = 0; i < count; i++) {
    const sibling = alreadyRegistered + i >= 1 && e.siblingDiscountPercent ? Math.min(baseMinor, percentOf(baseMinor, e.siblingDiscountPercent)) : 0;
    out.push({ baseMinor, earlyBird, siblingDiscountMinor: sibling, amountMinor: baseMinor - sibling });
  }
  return out;
}
