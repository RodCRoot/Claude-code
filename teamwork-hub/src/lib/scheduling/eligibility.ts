import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import {
  athletes,
  creditBuckets,
  formRequests,
  formTemplates,
  formTemplateVersions,
  membershipHolds,
  memberships,
  people,
  products,
  productVersions,
} from "@/db/schema";
import { joinNames, locationNames, scopeCovers } from "@/lib/locations";
import type { ServiceType } from "./common";
import { DEFAULT_TZ, localYmd } from "@/lib/time";
import { activeMembershipOnDay } from "@/lib/credits";

export type EligibilityResult = { ok: boolean; reasons: string[] };

/** Whole years between a YYYY-MM-DD birth date and a YYYY-MM-DD date. */
export function ageOn(dob: string, onYmd: string): number {
  const [by, bm, bd] = dob.split("-").map(Number);
  const [y, m, d] = onYmd.split("-").map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

/**
 * Can this athlete attend a session of this service type at `at`?
 * - every required form template has a completed, unexpired form_request for the athlete
 * - age limits (needs a date of birth on file when limits are set)
 * Pure read — callers decide whether staff may override.
 */
export async function checkEligibility(
  tx: Tx,
  input: { orgId: string; athleteId: string; serviceType: Pick<ServiceType, "eligibility" | "name">; at: Date; tz?: string },
): Promise<EligibilityResult> {
  const reasons: string[] = [];
  const [a] = await tx
    .select({ personId: athletes.personId, active: athletes.active, dob: people.dateOfBirth, orgId: athletes.orgId })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(eq(athletes.id, input.athleteId));
  if (!a || a.orgId !== input.orgId) return { ok: false, reasons: ["Athlete not found."] };
  if (!a.active) reasons.push("This athlete is marked inactive.");

  const el = input.serviceType.eligibility ?? {};
  const required = (el.requiredFormTemplateIds ?? []).filter(Boolean);
  if (required.length) {
    const done = await tx
      .select({ templateId: formTemplateVersions.templateId })
      .from(formRequests)
      .innerJoin(formTemplateVersions, eq(formTemplateVersions.id, formRequests.templateVersionId))
      .where(
        and(
          eq(formRequests.orgId, input.orgId),
          or(eq(formRequests.athleteId, input.athleteId), and(isNull(formRequests.athleteId), eq(formRequests.subjectPersonId, a.personId))),
          eq(formRequests.status, "completed"),
          or(isNull(formRequests.expiresAt), gt(formRequests.expiresAt, input.at)),
          inArray(formTemplateVersions.templateId, required),
        ),
      );
    const have = new Set(done.map((d) => d.templateId));
    const missing = required.filter((t) => !have.has(t));
    if (missing.length) {
      const names = await tx.select({ id: formTemplates.id, name: formTemplates.name }).from(formTemplates).where(inArray(formTemplates.id, missing));
      const label = names.map((n) => n.name).join(", ") || `${missing.length} required form(s)`;
      reasons.push(`Required form not completed (or expired): ${label}.`);
    }
  }

  if (el.minAge != null || el.maxAge != null) {
    if (!a.dob) reasons.push("A date of birth is needed to check the age limit for this service.");
    else {
      const age = ageOn(a.dob, localYmd(input.at, input.tz ?? DEFAULT_TZ));
      if (el.minAge != null && age < el.minAge) reasons.push(`${input.serviceType.name} is for ages ${el.minAge}+.`);
      if (el.maxAge != null && age > el.maxAge) reasons.push(`${input.serviceType.name} is for ages ${el.maxAge} and under.`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export type Entitlement =
  | { kind: "not_required" }
  | { kind: "unlimited"; membershipId: string }
  /** A membership with a weekly class cap; the booking flow counts the ISO week under a row lock. `credits` = fallback credits available. */
  | { kind: "weekly"; membershipId: string; classesPerWeek: number; credits: number }
  | { kind: "credits"; available: number }
  | { kind: "none"; locationBlocked?: LocationBlock };

/** A membership/credit would have paid, but it is scoped to other locations. */
export type LocationBlock = { productName: string; coveredLocations: string[]; sessionLocation: string };

/** Family-facing explanation (no dashes). */
export function locationBlockMessage(athleteLabel: string, b: LocationBlock): string {
  const covers = joinNames(b.coveredLocations);
  // Family-facing text never carries em dashes, even when a product name does.
  const product = b.productName.replace(/\s*[\u2014\u2015]\s*/g, ": ");
  return `${athleteLabel}'s ${product} covers ${covers} sessions only. This session is at ${b.sessionLocation}. Please ask the front desk about a ${b.sessionLocation} option.`;
}

/** Does booking this service type need a membership/credit at all? */
export function requiresEntitlement(st: Pick<ServiceType, "eligibility" | "creditCost">): boolean {
  return st.eligibility?.requiresEntitlement !== false && st.creditCost > 0;
}

/**
 * What would pay for this athlete's booking (does not reserve anything):
 * 1. a live membership covering the service type on the session date (active/trialing, or on_hold with
 *    no hold covering that date, so a booking after a restart date works while the hold still runs):
 *    - no weekly cap and `unlimited` → "unlimited"
 *    - a weekly cap (`classes_per_week`) → "weekly" (the booking flow enforces the cap under a row lock)
 * 2. otherwise eligible credits (unexpired, matching service type, available ≥ cost) → "credits".
 *    Punch-card (hold_makeup) credits count only while the athlete has an active membership that day
 *    (policy `makeupRequiresActiveMembership`; a 1x/week membership counts).
 * 3. otherwise "none" (families are told they need a membership or credits; staff may comp).
 * Location scope: memberships (membership override, else product) and credit buckets only count
 * when they cover the session's location (empty scope = every location; a session without a
 * location is covered by anything). When a scoped membership/credit is the only thing that would
 * have paid, "none" carries `locationBlocked` so the caller can say why.
 */
export async function resolveEntitlement(
  tx: Tx,
  input: {
    orgId: string;
    athleteId: string;
    serviceType: Pick<ServiceType, "id" | "eligibility" | "creditCost">;
    at: Date;
    tz?: string;
    locationId?: string | null;
    makeupRequiresActiveMembership?: boolean;
  },
): Promise<Entitlement> {
  if (!requiresEntitlement(input.serviceType)) return { kind: "not_required" };
  const day = localYmd(input.at, input.tz ?? DEFAULT_TZ);
  const loc = input.locationId ?? null;
  const ms = await tx
    .select({
      id: memberships.id,
      serviceTypeIds: productVersions.serviceTypeIds,
      unlimited: productVersions.unlimited,
      classesPerWeek: productVersions.classesPerWeek,
      scope: sql<string[]>`coalesce(${memberships.locationIds}, ${products.locationIds})`,
      productName: products.name,
    })
    .from(memberships)
    .innerJoin(productVersions, eq(productVersions.id, memberships.productVersionId))
    .innerJoin(products, eq(products.id, productVersions.productId))
    .where(
      and(
        eq(memberships.orgId, input.orgId),
        eq(memberships.athleteId, input.athleteId),
        inArray(memberships.status, ["active", "trialing", "on_hold"]),
        or(eq(productVersions.unlimited, true), sql`${productVersions.classesPerWeek} is not null`),
        lte(memberships.startDate, day),
        or(isNull(memberships.endDate), sql`${memberships.endDate} >= ${day}`),
        sql`not exists (select 1 from ${membershipHolds} h where h.membership_id = ${memberships.id} and h.start_date <= ${day} and h.end_date >= ${day})`,
      ),
    );
  const forService = ms.filter((m) => !m.serviceTypeIds?.length || m.serviceTypeIds.includes(input.serviceType.id));
  const inScope = forService.filter((m) => scopeCovers(m.scope, loc));
  const unlimited = inScope.find((m) => m.classesPerWeek == null && m.unlimited);
  if (unlimited) return { kind: "unlimited", membershipId: unlimited.id };
  const blockedBy = forService.find((m) => !scopeCovers(m.scope, loc));

  const makeupOk = input.makeupRequiresActiveMembership === false ? sql`true` : activeMembershipOnDay(input.orgId, input.athleteId, day);
  const [row] = await tx
    .select({ available: sql<number>`coalesce(sum(${creditBuckets.available}),0)::int` })
    .from(creditBuckets)
    .where(
      and(
        eq(creditBuckets.orgId, input.orgId),
        eq(creditBuckets.athleteId, input.athleteId),
        eq(creditBuckets.status, "active"),
        sql`${creditBuckets.available} >= ${input.serviceType.creditCost}`,
        or(isNull(creditBuckets.expiresAt), gt(creditBuckets.expiresAt, input.at)),
        or(sql`${creditBuckets.periodStart} is null`, lte(creditBuckets.periodStart, day)),
        sql`(jsonb_array_length(${creditBuckets.serviceTypeIds}) = 0 or ${creditBuckets.serviceTypeIds} ? ${input.serviceType.id})`,
        loc ? sql`(jsonb_array_length(${creditBuckets.locationIds}) = 0 or ${creditBuckets.locationIds} ? ${loc})` : undefined,
        sql`(${creditBuckets.sourceKind} <> 'hold_makeup' or ${makeupOk})`,
      ),
    );
  const credits = row?.available ?? 0;
  const weekly = inScope.filter((m) => m.classesPerWeek != null).sort((a, b) => b.classesPerWeek! - a.classesPerWeek!)[0];
  if (weekly) return { kind: "weekly", membershipId: weekly.id, classesPerWeek: weekly.classesPerWeek!, credits };
  if (credits > 0) return { kind: "credits", available: credits };
  if (blockedBy && loc) {
    const names = await locationNames(tx, input.orgId, [...blockedBy.scope, loc]);
    return {
      kind: "none",
      locationBlocked: {
        productName: blockedBy.productName,
        coveredLocations: blockedBy.scope.map((id) => names.get(id) ?? "another location"),
        sessionLocation: names.get(loc) ?? "another location",
      },
    };
  }
  return { kind: "none" };
}
