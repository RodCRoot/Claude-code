import { bookings, formRequests, formTemplates, formTemplateVersions, memberships, products, productVersions, scheduleSessions, serviceTypes, type BookingStatus } from "@/db/schema";
import { addDaysYmd, localToUtc } from "@/lib/time";
import type { seedOrg } from "./helpers/db";
import { testDb } from "./helpers/db";

type Ctx = Awaited<ReturnType<typeof seedOrg>>;

/**
 * Minimal synthetic world for retention tests on a core-only org (`seedOrg(today, { modules: [] })`):
 * one plan, one service type, and at most one 5 PM session per local day created on demand.
 */
export async function retentionWorld(ctx: Ctx, today: string) {
  const db = testDb();
  const [product] = await db.insert(products).values({ orgId: ctx.orgId, name: "Test Unlimited", kind: "recurring_membership" }).returning();
  const [version] = await db.insert(productVersions).values({ productId: product.id, version: 1, priceMinor: 19900, interval: "month", unlimited: true, effectiveFrom: "2020-01-01" }).returning();
  const [product2] = await db.insert(products).values({ orgId: ctx.orgId, name: "Test 2x Week", kind: "recurring_membership" }).returning();
  const [version2] = await db.insert(productVersions).values({ productId: product2.id, version: 1, priceMinor: 14900, interval: "month", classesPerWeek: 2, effectiveFrom: "2020-01-01" }).returning();
  const [svc] = await db.insert(serviceTypes).values({ orgId: ctx.orgId, name: "Test Class", kind: "class" }).returning();
  const sessions = new Map<string, typeof scheduleSessions.$inferSelect>();

  /** The session `offset` days from today (negative = past) at `time` local, coached by `coach`. */
  async function session(offset: number, opts: { time?: string; coach?: string; title?: string } = {}) {
    const key = `${offset}|${opts.time ?? "17:00"}|${opts.coach ?? "marcus"}|${opts.title ?? "Test Class"}`;
    const hit = sessions.get(key);
    if (hit) return hit;
    const startsAt = localToUtc(addDaysYmd(today, offset), opts.time ?? "17:00", ctx.tz);
    const [s] = await db
      .insert(scheduleSessions)
      .values({ orgId: ctx.orgId, serviceTypeId: svc.id, title: opts.title ?? "Test Class", startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), timezone: ctx.tz, coachUserId: ctx.users[opts.coach ?? "marcus"], capacity: 100 })
      .returning();
    sessions.set(key, s);
    return s;
  }

  async function booking(athleteId: string, offset: number, status: BookingStatus, opts: Parameters<typeof session>[1] = {}) {
    const s = await session(offset, opts);
    const [b] = await db.insert(bookings).values({ orgId: ctx.orgId, sessionId: s.id, athleteId, status, entitlementSource: "membership" }).returning();
    return { booking: b, session: s };
  }

  async function membership(athleteId: string, payerKey: string | null, startDaysAgo: number, extra: Partial<typeof memberships.$inferInsert> = {}) {
    const [m] = await db
      .insert(memberships)
      .values({ orgId: ctx.orgId, athleteId, payerAccountId: payerKey ? ctx.payers[payerKey] : null, productVersionId: version.id, status: "active", startDate: addDaysYmd(today, -startDaysAgo), billingProvider: "manual", ...extra })
      .returning();
    return m;
  }

  /** Steady twice-a-week history: attended every 3–4 days from `from` to `to` days ago. */
  function steadyDays(from = 118, to = 2): number[] {
    const out: number[] = [];
    for (let d = 2, i = 0; d <= from; d += i++ % 2 ? 4 : 3) if (d >= to) out.push(d);
    return out;
  }
  async function attend(athleteId: string, daysAgo: number[]) {
    for (const d of daysAgo) await booking(athleteId, -d, "attended");
  }

  /** A form required for booking; `complete(athlete)` marks it done for one athlete. */
  async function requiredForm() {
    const [t] = await db.insert(formTemplates).values({ orgId: ctx.orgId, name: "Test Waiver", kind: "waiver", requiredForBooking: true }).returning();
    const [v] = await db
      .insert(formTemplateVersions)
      .values({ templateId: t.id, version: 1, title: "Test Waiver", bodyMarkdown: "Sample", signers: [{ role: "guardian", required: true }], contentHash: "x", status: "published" })
      .returning();
    return {
      complete: (athleteId: string, personId: string) =>
        db.insert(formRequests).values({ orgId: ctx.orgId, templateVersionId: v.id, subjectPersonId: personId, athleteId, status: "completed", completedAt: new Date() }),
    };
  }

  return { product, version, version2, svc, session, booking, membership, steadyDays, attend, requiredForm };
}
