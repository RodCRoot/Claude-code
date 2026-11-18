import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, discounts, householdMembers, households, membershipEvents, memberships, type MembershipStatus } from "@/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { FAMILY_RATE_MIN_MEMBERS, familyRatePercent, membershipPolicy, type MembershipPolicy } from "@/lib/membership-policy";
import { todayLocal } from "@/lib/time";
import { SINGLE_PAYMENT_FLAG } from "@/lib/zenplanner/renewal";
import { billingTask } from "./tasks";

/**
 * Family rate (owner's rule, decided 2026-11-16).
 *
 * - Household, not payer: head count is taken over `household_members` (person ↔ household). The payer
 *   account plays no part, so siblings billed to two accounts qualify and two households sharing one
 *   payer do not.
 * - Rate = step (5%) × active members in the household, 0 below 2, capped (default 25%). Every active
 *   member gets the same rate.
 * - "Active" = an athlete with at least one hub membership that is pending, trialing, active or past due.
 *   On hold, cancelled and expired do not count; a membership on hold also loses the rate while held.
 * - Zen Planner-billed (imported) memberships are never touched. A current one counts toward the head count
 *   (setting) unless it is a one-off purchase (Installment Plan "Single Payment").
 * - An athlete in no household is a household of one (no rate). An athlete in several households gets
 *   the rate of the one with the most active members; households are never merged.
 */
export const FAMILY_COUNTED_STATUSES: MembershipStatus[] = ["pending", "trialing", "active", "past_due"];
const SYNCED_STATUSES: MembershipStatus[] = ["pending", "trialing", "active", "past_due", "on_hold"];

const FAMILY_DISCOUNT_PREFIXES = ["Family discount", "Sibling discount"];
export const isFamilyDiscount = (d: { name: string } | null | undefined) => !!d && FAMILY_DISCOUNT_PREFIXES.some((p) => d.name.startsWith(p));

export type HouseholdRate = {
  /** null: the athlete is in no household (a household of one). */
  householdId: string | null;
  householdName: string | null;
  /** Active members counted in that household. */
  headCount: number;
  percent: number;
  uncappedPercent: number;
  capped: boolean;
};

const NO_RATE: HouseholdRate = { householdId: null, householdName: null, headCount: 0, percent: 0, uncappedPercent: 0, capped: false };

/**
 * Head count and rate per household for the whole organization (two queries; a facility has a few
 * hundred memberships). `assumeActiveAthleteId` counts one more athlete as active, for previews.
 */
export async function householdFamilyRates(tx: Tx, orgId: string, policy: MembershipPolicy, opts: { assumeActiveAthleteId?: string } = {}) {
  const counted = await tx
    .selectDistinct({ athleteId: memberships.athleteId })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, orgId),
        inArray(memberships.status, FAMILY_COUNTED_STATUSES),
        // A sibling still billed by Zen Planner counts toward the household (never repriced: see syncFamilyDiscount).
        policy.familyRateCountsZenPlannerMembers ? undefined : ne(memberships.billingProvider, "external_zenplanner"),
        // ...unless it is a one-off purchase in Zen Planner (a drop-in or single class); a setting, off by default.
        policy.familyRateCountsSinglePayments ? undefined : sql`not exists (select 1 from zp_membership_details d where d.membership_id = ${memberships.id} and d.flags @> ${JSON.stringify([SINGLE_PAYMENT_FLAG])}::jsonb)`,
      ),
    );
  const active = new Set(counted.map((r) => r.athleteId));
  if (opts.assumeActiveAthleteId) active.add(opts.assumeActiveAthleteId);
  const links = await tx
    .select({ householdId: households.id, householdName: households.name, athleteId: athletes.id })
    .from(householdMembers)
    .innerJoin(households, and(eq(households.id, householdMembers.householdId), eq(households.orgId, orgId)))
    .innerJoin(athletes, and(eq(athletes.personId, householdMembers.personId), eq(athletes.orgId, orgId)));
  const byHousehold = new Map<string, HouseholdRate>();
  const householdsOf = new Map<string, string[]>();
  for (const l of links) {
    householdsOf.set(l.athleteId, [...(householdsOf.get(l.athleteId) ?? []), l.householdId]);
    const h = byHousehold.get(l.householdId) ?? { ...NO_RATE, householdId: l.householdId, householdName: l.householdName };
    if (active.has(l.athleteId)) h.headCount++;
    byHousehold.set(l.householdId, h);
  }
  for (const h of byHousehold.values()) Object.assign(h, familyRatePercent(policy, h.headCount));
  const rateOf = (athleteId: string): HouseholdRate => {
    const own = (householdsOf.get(athleteId) ?? []).map((id) => byHousehold.get(id)!).sort((a, b) => b.headCount - a.headCount || a.householdId!.localeCompare(b.householdId!));
    if (!own.length) return { ...NO_RATE, headCount: active.has(athleteId) ? 1 : 0 };
    return active.has(athleteId) ? own[0] : { ...own[0], percent: 0, uncappedPercent: 0, capped: false };
  };
  return { rateOf, households: [...byHousehold.values()], isActive: (athleteId: string) => active.has(athleteId) };
}

/** The rate this athlete would get with an active membership (sign-up and membership previews). */
export async function familyRateIfEnrolled(tx: Tx, orgId: string, athleteId: string, policy?: MembershipPolicy): Promise<HouseholdRate> {
  const p = policy ?? (await membershipPolicy(tx, orgId));
  return (await householdFamilyRates(tx, orgId, p, { assumeActiveAthleteId: athleteId })).rateOf(athleteId);
}

async function familyDiscountId(tx: Tx, orgId: string, percent: number) {
  const name = `Family discount ${percent}%`;
  const [d] = await tx.select().from(discounts).where(and(eq(discounts.orgId, orgId), eq(discounts.name, name), eq(discounts.kind, "percent"), eq(discounts.value, percent)));
  if (d) return d.id;
  const [nd] = await tx.insert(discounts).values({ orgId, name, kind: "percent", value: percent }).returning();
  return nd.id;
}

export type FamilyRateChange = { membershipId: string; action: "applied" | "changed" | "removed"; percent: number; previousPercent: number | null };

/**
 * Recalculate the family rate for every household in the organization and reprice every hub-billed
 * membership whose rate is out of date. Call it after any membership event (sign-up, cancel, hold start
 * or end, expiry, a person moving household); the renewal job also runs it every day.
 *
 * Idempotent: a second run with nothing changed writes nothing. It only ever sets `memberships.discount_id`
 * (what the NEXT invoice is priced with); it never creates, voids or re-prices an invoice.
 * - A membership carrying another (non-family) discount is left alone: discounts are not stacked.
 * - Zen Planner-billed memberships are never touched and do not count.
 * - Stripe/PayPal subscription memberships are not changed here (the provider amount is fixed); staff get a task.
 * - A household past the cap gets the cap, and staff get a task naming the household.
 */
export async function syncFamilyDiscount(tx: Tx, actor: AuditActor, orgId: string, opts: { policy?: MembershipPolicy } = {}) {
  // One recalculation per organization at a time, so two sign-ups in one household cannot miss each other.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`family-rate:${orgId}`}))`);
  const policy = opts.policy ?? (await membershipPolicy(tx, orgId));
  const rates = await householdFamilyRates(tx, orgId, policy);
  // Rows another transaction is changing are skipped: that transaction recalculates when it finishes.
  const live = await tx
    .select({ m: memberships, d: discounts })
    .from(memberships)
    .leftJoin(discounts, eq(discounts.id, memberships.discountId))
    .where(and(eq(memberships.orgId, orgId), inArray(memberships.status, SYNCED_STATUSES), ne(memberships.billingProvider, "external_zenplanner")))
    .orderBy(asc(memberships.createdAt), asc(memberships.id))
    .for("update", { of: memberships, skipLocked: true });
  const ids = new Map<number, string>();
  const changes: FamilyRateChange[] = [];
  for (const { m, d } of live) {
    if (d && !isFamilyDiscount(d)) continue; // another discount is in place: don't stack or replace
    const held = !FAMILY_COUNTED_STATUSES.includes(m.status);
    const rate = held ? { ...rates.rateOf(m.athleteId), percent: 0 } : rates.rateOf(m.athleteId);
    let want: string | null = null;
    if (rate.percent > 0) {
      want = ids.get(rate.percent) ?? (await familyDiscountId(tx, orgId, rate.percent));
      ids.set(rate.percent, want);
    }
    if ((m.discountId ?? null) === want) continue;
    if (m.billingProvider === "stripe" || m.billingProvider === "paypal") {
      await billingTask(tx, orgId, {
        title: `Family rate change needs the ${m.billingProvider === "stripe" ? "Stripe" : "PayPal"} subscription updated`,
        description: `${rate.headCount} active member(s) in ${rate.householdName ?? "this athlete's household"}; the family rate on this membership should be ${rate.percent > 0 ? `${rate.percent}%` : held ? "removed while it is on hold" : "removed"}. The hub cannot change what the provider charges.`,
        relatedType: "membership",
        relatedId: m.id,
        dedupeKey: `family-discount:${m.id}:${want ?? "none"}`,
      });
      continue;
    }
    await tx.update(memberships).set({ discountId: want, updatedAt: new Date() }).where(eq(memberships.id, m.id));
    const action = !want ? "removed" : d ? "changed" : "applied";
    const previousPercent = d ? d.value : null;
    changes.push({ membershipId: m.id, action, percent: rate.percent, previousPercent });
    const why = held ? "membership on hold" : `${rate.headCount} active member${rate.headCount === 1 ? "" : "s"} in ${rate.householdName ?? "no household"}`;
    await tx.insert(membershipEvents).values({
      membershipId: m.id,
      type: `family_discount_${action}`,
      effectiveOn: todayLocal(),
      actorUserId: actor.actorUserId,
      details: {
        percent: want ? rate.percent : null,
        previous: d ? { name: d.name, value: d.value } : null,
        householdId: rate.householdId,
        activeMembers: rate.headCount,
        onHold: held,
        capped: want ? rate.capped : false,
        uncappedPercent: want && rate.capped ? rate.uncappedPercent : null,
      },
    });
    await audit(tx, { ...actor, orgId }, `billing.membership.family_discount_${action}`, "membership", m.id, {
      summary: want
        ? `Family rate ${rate.percent}% ${action === "changed" ? `(was ${previousPercent}%)` : "applied"}: ${why}${rate.capped ? `; capped, the rule gives ${rate.uncappedPercent}%` : ""}`
        : `Family rate removed (was ${previousPercent}%): ${why}`,
      before: { discountId: m.discountId },
      after: { discountId: want },
    });
  }
  // Never cap silently: one task per household and head count, so a further change raises it again.
  const capped = rates.households.filter((h) => h.capped);
  for (const h of capped) {
    await billingTask(tx, orgId, {
      title: `Family rate capped at ${h.percent}% for ${h.householdName}`,
      description: `${h.headCount} active members in this household. The rule (${policy.familyDiscountStepPercent}% per active member) gives ${h.uncappedPercent}%, which is above the ${policy.familyDiscountCapPercent}% cap in Settings, Membership policy, so each member is getting ${h.percent}%. The owner has not set a ceiling: confirm the cap, raise it, or set this family's rate by hand.`,
      relatedType: "household",
      relatedId: h.householdId,
      priority: "high",
      dedupeKey: `family-cap:${h.householdId}:${h.headCount}:${policy.familyDiscountCapPercent}`,
    });
  }
  return { changes, capped, minMembers: FAMILY_RATE_MIN_MEMBERS };
}
