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
  productVersions,
} from "@/db/schema";
import type { ServiceType } from "./common";
import { DEFAULT_TZ, localYmd } from "@/lib/time";

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
  | { kind: "credits"; available: number }
  | { kind: "none" };

/** Does booking this service type need a membership/credit at all? */
export function requiresEntitlement(st: Pick<ServiceType, "eligibility" | "creditCost">): boolean {
  return st.eligibility?.requiresEntitlement !== false && st.creditCost > 0;
}

/**
 * What would pay for this athlete's booking (does not reserve anything):
 * 1. an active (or trialing) membership on an `unlimited` product version covering the service type
 *    on the session date, not on hold → "unlimited"
 * 2. otherwise eligible credits (unexpired, matching service type, available ≥ cost) → "credits"
 * 3. otherwise "none" (families are told they need a membership or credits; staff may comp).
 */
export async function resolveEntitlement(
  tx: Tx,
  input: { orgId: string; athleteId: string; serviceType: Pick<ServiceType, "id" | "eligibility" | "creditCost">; at: Date; tz?: string },
): Promise<Entitlement> {
  if (!requiresEntitlement(input.serviceType)) return { kind: "not_required" };
  const day = localYmd(input.at, input.tz ?? DEFAULT_TZ);
  const ms = await tx
    .select({ id: memberships.id, serviceTypeIds: productVersions.serviceTypeIds })
    .from(memberships)
    .innerJoin(productVersions, eq(productVersions.id, memberships.productVersionId))
    .where(
      and(
        eq(memberships.orgId, input.orgId),
        eq(memberships.athleteId, input.athleteId),
        inArray(memberships.status, ["active", "trialing"]),
        eq(productVersions.unlimited, true),
        lte(memberships.startDate, day),
        or(isNull(memberships.endDate), sql`${memberships.endDate} >= ${day}`),
        sql`not exists (select 1 from ${membershipHolds} h where h.membership_id = ${memberships.id} and h.start_date <= ${day} and h.end_date >= ${day})`,
      ),
    );
  const unlimited = ms.find((m) => !m.serviceTypeIds?.length || m.serviceTypeIds.includes(input.serviceType.id));
  if (unlimited) return { kind: "unlimited", membershipId: unlimited.id };

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
      ),
    );
  if (row && row.available > 0) return { kind: "credits", available: row.available };
  return { kind: "none" };
}
