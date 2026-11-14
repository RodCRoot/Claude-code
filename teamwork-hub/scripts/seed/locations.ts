import { and, eq, inArray } from "drizzle-orm";
import { classSeries, locations, products, resources, scheduleSessions, serviceTypes } from "../../src/db/schema";
import { seriesOccurrences } from "../../src/lib/scheduling/recurrence";
import { addDaysYmd } from "../../src/lib/time";
import type { SeedCtx } from "./context";

/**
 * Multi-location demo: the existing schedule becomes the primary location, and a second sample
 * location gets its own room and a weekly series (future sessions only, no bookings, so the
 * historical attendance data stays as it was). The sample unlimited/2x memberships are scoped to
 * the primary location, which demonstrates "a Bloomington membership can't book Linton sessions".
 * Addresses are left empty: they are Teamwork's to enter.
 */
export async function seedLocations(ctx: SeedCtx) {
  const { tx, orgId, today, tz } = ctx;
  const ex: Record<string, string> = {};
  ctx.extra.locations = ex;

  const [primary] = await tx.insert(locations).values({ orgId, name: "Bloomington", timezone: tz, sortOrder: 0, isDemo: true }).returning();
  const [second] = await tx.insert(locations).values({ orgId, name: "Linton", timezone: tz, sortOrder: 1, isDemo: true }).returning();
  Object.assign(ex, { bloomington: primary.id, linton: second.id });

  // Everything seeded so far happens at the primary location.
  await tx.update(resources).set({ locationId: primary.id }).where(eq(resources.orgId, orgId));
  await tx.update(classSeries).set({ locationId: primary.id }).where(eq(classSeries.orgId, orgId));
  await tx.update(scheduleSessions).set({ locationId: primary.id }).where(eq(scheduleSessions.orgId, orgId));

  // Membership scope: sample memberships cover the primary location only.
  await tx
    .update(products)
    .set({ locationIds: [primary.id] })
    .where(and(eq(products.orgId, orgId), inArray(products.name, ["Sample — Unlimited Monthly Membership", "Sample — 2x/Week Monthly Membership"])));

  const [gpt] = await tx.select().from(serviceTypes).where(and(eq(serviceTypes.orgId, orgId), eq(serviceTypes.name, "Group Performance Training")));
  if (!gpt) return; // scheduling module not seeded
  const [gym] = await tx.insert(resources).values({ orgId, name: "Linton Gym (sample)", kind: "area", capacity: 20, locationId: second.id }).returning();
  ex.lintonGym = gym.id;
  const startsOn = addDaysYmd(today, 1);
  const [series] = await tx
    .insert(classSeries)
    .values({
      orgId,
      serviceTypeId: gpt.id,
      title: "Linton Youth Development (sample)",
      weekdays: [1, 3],
      startTimeLocal: "18:00",
      durationMinutes: 60,
      timezone: tz,
      startsOn,
      endsOn: null,
      coachUserId: ctx.users.tess,
      resourceId: gym.id,
      locationId: second.id,
      capacity: 12,
      waitlistCapacity: 4,
      isDemo: true,
    })
    .returning();
  ex.lintonSeries = series.id;
  const occ = seriesOccurrences({ weekdays: [1, 3], startTimeLocal: "18:00", durationMinutes: 60, timezone: tz, startsOn, endsOn: null }, startsOn, addDaysYmd(today, 21));
  if (!occ.length) return;
  const rows = await tx
    .insert(scheduleSessions)
    .values(
      occ.map((o) => ({
        orgId,
        serviceTypeId: gpt.id,
        seriesId: series.id,
        title: series.title,
        startsAt: o.startsAt,
        endsAt: o.endsAt,
        timezone: tz,
        coachUserId: ctx.users.tess,
        resourceId: gym.id,
        locationId: second.id,
        capacity: 12,
        waitlistCapacity: 4,
        visibility: "members" as const,
        isDemo: true,
      })),
    )
    .returning({ id: scheduleSessions.id });
  ex.lintonFirstSession = rows[0].id;
}
