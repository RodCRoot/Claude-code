import {
  athletes,
  bookings,
  discounts,
  invoices,
  leads,
  locations,
  membershipHolds,
  memberships,
  payerAccounts,
  people,
  products,
  productVersions,
  scheduleSessions,
  serviceTypes,
  transactions,
  type BookingStatus,
} from "@/db/schema";
import { ensureStages } from "@/lib/crm/stages";
import { addDaysYmd, localToUtc } from "@/lib/time";
import type { seedOrg } from "./helpers/db";
import { testDb } from "./helpers/db";

type Ctx = Awaited<ReturnType<typeof seedOrg>>;

/**
 * Hand-built synthetic world for scoreboard tests on a core-only org
 * (`seedOrg(today, { modules: [] })`): two locations, one plan per location plus one valid
 * everywhere and a trial product, and helpers that insert exactly one row each so every expected
 * number in a test can be counted by hand.
 */
export async function scoreboardWorld(ctx: Ctx, today: string) {
  const db = testDb();
  const orgId = ctx.orgId;
  const day = (n: number) => addDaysYmd(today, n);
  const at = (ymd: string, time = "12:00") => localToUtc(ymd, time, ctx.tz);
  const [locA] = await db.insert(locations).values({ orgId, name: "North (test)" }).returning();
  const [locB] = await db.insert(locations).values({ orgId, name: "South (test)", sortOrder: 1 }).returning();
  const [locEmpty] = await db.insert(locations).values({ orgId, name: "Empty (test)", sortOrder: 2 }).returning();

  async function plan(name: string, priceMinor: number, opts: { locationIds?: string[]; kind?: "recurring_membership" | "trial"; classesPerWeek?: number | null; unlimited?: boolean; trialDays?: number } = {}) {
    const [product] = await db.insert(products).values({ orgId, name, kind: opts.kind ?? "recurring_membership", locationIds: opts.locationIds ?? [] }).returning();
    const [version] = await db
      .insert(productVersions)
      .values({ productId: product.id, version: 1, priceMinor, interval: opts.kind === "trial" ? "none" : "month", classesPerWeek: opts.classesPerWeek ?? null, unlimited: opts.unlimited ?? false, trialDays: opts.trialDays ?? 0, effectiveFrom: "2020-01-01" })
      .returning();
    return { product, version };
  }
  const planA = await plan("Test North 2x", 10000, { locationIds: [locA.id], classesPerWeek: 2 });
  const planB = await plan("Test South 2x", 20000, { locationIds: [locB.id], classesPerWeek: 2 });
  const planAll = await plan("Test Everywhere Unlimited", 15000, { unlimited: true });
  const planNobody = await plan("Test Nobody Plan", 9900, { locationIds: [locEmpty.id] });
  const trial = await plan("Test Trial Week", 0, { kind: "trial" });

  let n = 0;
  /** A new synthetic athlete with their own payer account. */
  async function athlete(name?: string) {
    n++;
    const [p] = await db.insert(people).values({ orgId, firstName: name ?? `Fixture${n}`, lastName: "Scoreboard" }).returning();
    const [a] = await db.insert(athletes).values({ orgId, personId: p.id }).returning();
    const [pa] = await db.insert(payerAccounts).values({ orgId, name: `${name ?? `Fixture${n}`} payer` }).returning();
    return { athleteId: a.id, personId: p.id, payerId: pa.id };
  }

  type MOpts = Partial<typeof memberships.$inferInsert> & { start: number; end?: number | null };
  async function membership(who: { athleteId: string; payerId: string }, p: { version: { id: string } }, o: MOpts) {
    const { start, end, ...rest } = o;
    const ended = end != null;
    const [m] = await db
      .insert(memberships)
      .values({
        orgId,
        athleteId: who.athleteId,
        payerAccountId: who.payerId,
        productVersionId: p.version.id,
        status: ended && end! <= 0 ? "cancelled" : "active",
        startDate: day(start),
        endDate: ended ? day(end!) : null,
        cancelAt: ended ? day(end!) : null,
        billingProvider: "manual",
        createdAt: at(day(start)),
        ...rest,
      })
      .returning();
    return m;
  }

  const hold = (membershipId: string, start: number, end: number, createdDaysAgo = 30, kind: "hold" | "in_season" = "hold") =>
    db.insert(membershipHolds).values({ membershipId, startDate: day(start), endDate: day(end), kind, createdAt: at(day(-createdDaysAgo)) });

  let inv = 0;
  /** An issued invoice. `paid` adds a settled payment of that amount (default: nothing paid). */
  async function invoice(payerId: string, o: { total: number; due: number; issued?: number; membershipId?: string | null; paid?: number; paidDaysAgo?: number; status?: "open" | "paid" | "void" | "draft"; pending?: number }) {
    const issued = at(day(o.issued ?? o.due));
    const [i] = await db
      .insert(invoices)
      .values({ orgId, payerAccountId: payerId, number: `T-${++inv}-${orgId.slice(0, 6)}`, status: o.status ?? "open", subtotalMinor: o.total, totalMinor: o.total, issuedAt: issued, dueDate: day(o.due), membershipId: o.membershipId ?? null, periodStart: o.membershipId ? day(o.issued ?? o.due) : null, createdAt: issued })
      .returning();
    if (o.paid) await payment(payerId, i.id, o.paid, o.paidDaysAgo ?? 0);
    if (o.pending) await db.insert(transactions).values({ orgId, payerAccountId: payerId, invoiceId: i.id, kind: "charge", status: "pending", amountMinor: o.pending, currency: "USD", provider: "manual", verification: "staff_attested", occurredAt: at(day(0), "08:00") });
    return i;
  }
  const payment = (payerId: string, invoiceId: string | null, amountMinor: number, daysAgo: number, kind: "manual_payment" | "refund" = "manual_payment") =>
    db.insert(transactions).values({ orgId, payerAccountId: payerId, invoiceId, kind, status: "settled", amountMinor: kind === "refund" ? -Math.abs(amountMinor) : amountMinor, currency: "USD", provider: "manual", verification: "staff_attested", occurredAt: at(day(-daysAgo), "09:00"), settledAt: at(day(-daysAgo), "09:00") });

  const [svc] = await db.insert(serviceTypes).values({ orgId, name: "Test Class", kind: "class" }).returning();
  const [assess] = await db.insert(serviceTypes).values({ orgId, name: "Test Assessment", kind: "assessment" }).returning();
  async function session(offset: number, o: { time?: string; title?: string; locationId?: string | null; capacity?: number; assessment?: boolean; status?: "scheduled" | "cancelled" | "completed" } = {}) {
    const startsAt = at(day(offset), o.time ?? "17:00");
    const [s] = await db
      .insert(scheduleSessions)
      .values({ orgId, serviceTypeId: o.assessment ? assess.id : svc.id, title: o.title ?? "Test Class", startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), timezone: ctx.tz, locationId: o.locationId === undefined ? locA.id : o.locationId, capacity: o.capacity ?? 10, status: o.status ?? "scheduled" })
      .returning();
    return s;
  }
  const book = (sessionId: string, athleteId: string, status: BookingStatus = "attended") => db.insert(bookings).values({ orgId, sessionId, athleteId, status, entitlementSource: "membership" });

  await ensureStages(db, orgId);
  async function lead(o: { createdDaysAgo?: number; createdAt?: Date; stage?: string; source?: string | null; contacted?: boolean; sessionId?: string | null; convertedAthlete?: { athleteId: string; personId: string } | null }) {
    const person = o.convertedAthlete ? { id: o.convertedAthlete.personId } : (await db.insert(people).values({ orgId, firstName: `Lead${++n}`, lastName: "Scoreboard", status: "lead" }).returning())[0];
    const createdAt = o.createdAt ?? at(day(-(o.createdDaysAgo ?? 0)), "10:00");
    const [l] = await db
      .insert(leads)
      .values({ orgId, personId: person.id, stage: o.stage ?? "new", source: o.source === undefined ? "web_inquiry" : o.source, lastContactedAt: o.contacted ? createdAt : null, assessmentSessionId: o.sessionId ?? null, convertedAthleteId: o.convertedAthlete?.athleteId ?? null, convertedAt: o.convertedAthlete ? createdAt : null, createdAt })
      .returning();
    return l;
  }
  const discount = async (percent: number) => (await db.insert(discounts).values({ orgId, name: `${percent}% test`, kind: "percent", value: percent }).returning())[0];

  return { db, day, at, locA, locB, locEmpty, planA, planB, planAll, planNobody, trial, athlete, membership, hold, invoice, payment, session, book, lead, discount, svc, assess };
}
