import { eq } from "drizzle-orm";
import { users } from "../../src/db/schema";
import type { Viewer } from "../../src/lib/authz/policy";
import { recordManualPayment } from "../../src/lib/billing/invoices";
import { createEvent, setEventStatus } from "../../src/lib/events/events";
import { registerForEvent } from "../../src/lib/events/registration";
import { addDaysYmd, localToUtc } from "../../src/lib/time";
import type { SeedCtx } from "./context";

/**
 * Camps and clinics demo data. Everything is synthetic and flagged is_demo. Names, descriptions,
 * ages and PRICES are SAMPLES for the demo, not Teamwork's real events or prices.
 * Built through the real domain functions. Needs the scheduling and billing seeds.
 */
export async function seedEvents(ctx: SeedCtx) {
  const { tx, today: T } = ctx;
  if (!ctx.extra.billing || !ctx.extra.scheduling) return;
  const viewer = async (key: string): Promise<Viewer> => {
    const [u] = await tx.select().from(users).where(eq(users.id, ctx.users[key]));
    return { userId: u.id, orgId: u.orgId, role: u.role, personId: u.personId, displayName: u.displayName, mfaVerified: true };
  };
  const erin = await viewer("erin");
  const now = localToUtc(T, "12:00");
  const days = (start: number, n: number, startTime: string, endTime: string) => Array.from({ length: n }, (_, i) => ({ date: addDaysYmd(T, start + i), startTime, endTime }));
  const publish = (eventId: string) => setEventStatus(tx, erin, { eventId, status: "published", now });
  let n = 0;
  const key = () => `seed-events-${String(++n).padStart(4, "0")}`;

  // 1. A three-day camp with an early bird price and a sibling discount (all sample values).
  const camp = await createEvent(
    tx,
    erin,
    {
      name: "Sample: Holiday Speed Camp",
      kind: "camp",
      description: "Sample description. Three mornings of sprint mechanics, acceleration and change of direction, in small groups by age. Bring water and indoor shoes.",
      capacity: 16,
      priceMinor: 18000,
      earlyBirdPriceMinor: 16000,
      earlyBirdUntil: addDaysYmd(T, 10),
      siblingDiscountPercent: 10,
      minAge: 10,
      maxAge: 16,
      sessions: days(21, 3, "09:00", "11:30"),
    },
    { isDemo: true },
  );
  await publish(camp.event.id);

  // 2. A one-day clinic with a small capacity.
  const clinic = await createEvent(
    tx,
    erin,
    {
      name: "Sample: Change of Direction Clinic",
      kind: "clinic",
      description: "Sample description. One two-hour session on cutting, decelerating and re-accelerating. For athletes who already train with us or play a field or court sport.",
      capacity: 8,
      priceMinor: 4500,
      minAge: 12,
      registrationClosesOn: addDaysYmd(T, 11),
      sessions: days(12, 1, "10:00", "12:00"),
    },
    { isDemo: true },
  );
  await publish(clinic.event.id);

  // 3. A draft staff are still setting up.
  const draft = await createEvent(
    tx,
    erin,
    { name: "Sample: Spring Combine Prep Camp", kind: "camp", description: "Sample draft. Not visible to families until it is published.", capacity: 20, priceMinor: 22000, minAge: 13, sessions: days(60, 4, "16:00", "18:00") },
    { isDemo: true },
  );

  // Registrations entered at the front desk for roster-filler athletes: two paid and confirmed
  // (staff-recorded sample payments) and one still holding a spot unpaid.
  const reg = (eventId: string, athleteKey: string) => registerForEvent(tx, erin, { eventId, athleteIds: [ctx.athletes[athleteKey]], idempotencyKey: key(), now });
  const payInFull = (r: Awaited<ReturnType<typeof reg>>, reference: string) =>
    recordManualPayment(tx, erin, { invoiceId: r.invoices[0].id, amountMinor: r.invoices[0].totalMinor, method: "check", reference, isDemo: true });
  if (ctx.athletes.owen && ctx.athletes.aria && ctx.athletes.jackson) {
    await payInFull(await reg(camp.event.id, "owen"), "Sample check 2041 (demo)");
    await reg(camp.event.id, "aria");
    await payInFull(await reg(clinic.event.id, "jackson"), "Sample check 2042 (demo)");
  }
  ctx.extra.events = { camp: camp.event.id, clinic: clinic.event.id, draft: draft.event.id };
}
