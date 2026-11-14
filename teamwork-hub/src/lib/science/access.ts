import { and, asc, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, coachAssignments, groupMembers, organizations, people } from "@/db/schema";
import { accessibleAthleteIds, athleteScopeFilter, type Capability, type Viewer } from "@/lib/authz/policy";
import type { AuditActor } from "@/lib/audit";

export const actorOf = (v: Viewer): AuditActor => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

export type ScopedAthlete = { id: string; personId: string; name: string; firstName: string; bodyMassKg: number | null; active: boolean };

/** Athletes in the viewer's org that the viewer holds `cap` on (policy.ts decides). */
export async function scopedAthletes(tx: Tx, v: Viewer, cap: Capability, opts: { includeInactive?: boolean; ids?: string[] } = {}): Promise<ScopedAthlete[]> {
  const ids = await accessibleAthleteIds(tx, v, cap);
  const rows = await tx
    .select({ id: athletes.id, personId: athletes.personId, first: people.firstName, last: people.lastName, preferred: people.preferredName, mass: athletes.bodyMassKg, active: athletes.active })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.orgId, v.orgId), athleteScopeFilter(ids, athletes.id), opts.ids ? inArray(athletes.id, opts.ids.length ? opts.ids : ["00000000-0000-0000-0000-000000000000"]) : undefined))
    .orderBy(asc(people.lastName), asc(people.firstName));
  return rows
    .filter((r) => opts.includeInactive || r.active)
    .map((r) => ({
      id: r.id,
      personId: r.personId,
      name: `${r.preferred ?? r.first} ${r.last}`,
      firstName: r.preferred ?? r.first,
      bodyMassKg: parseMass(r.mass),
      active: r.active,
    }));
}

export function parseMass(v: string | null): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Group ids per athlete (for questionnaire/habit targeting). */
export async function groupsByAthlete(tx: Tx, athleteIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!athleteIds.length) return out;
  const rows = await tx.select().from(groupMembers).where(inArray(groupMembers.athleteId, athleteIds));
  for (const r of rows) out.set(r.athleteId, [...(out.get(r.athleteId) ?? []), r.groupId]);
  return out;
}

/** A coach responsible for the athlete (direct assignment first, then group), for routing review tasks. */
export async function responsibleCoach(tx: Tx, orgId: string, athleteId: string): Promise<string | null> {
  const [direct] = await tx
    .select({ id: coachAssignments.coachUserId })
    .from(coachAssignments)
    .where(and(eq(coachAssignments.orgId, orgId), eq(coachAssignments.athleteId, athleteId)))
    .limit(1);
  if (direct) return direct.id;
  const [viaGroup] = await tx
    .select({ id: coachAssignments.coachUserId })
    .from(coachAssignments)
    .innerJoin(groupMembers, eq(groupMembers.groupId, coachAssignments.groupId))
    .where(and(eq(coachAssignments.orgId, orgId), eq(groupMembers.athleteId, athleteId)))
    .limit(1);
  return viaGroup?.id ?? null;
}

// ---------------------------------------------------------------------------
// Configurable thresholds (org.settings.science). Defaults are Teamwork starting points, not norms.
// ---------------------------------------------------------------------------

export type ScienceSettings = {
  /** Soreness reports at or above this severity create a coach review task (pain always does). */
  sorenessReviewThreshold: number;
  /** Minimum fraction of known days in each ACWR window before a ratio is shown. */
  acwrMinCoverage: number;
  /** ACWR outside [low, high] raises a load alert. */
  acwrAlertHigh: number;
  acwrAlertLow: number;
  /** tw_readiness_v1 below this is flagged. */
  readinessFlagBelow: number;
};

export const DEFAULT_SCIENCE_SETTINGS: ScienceSettings = {
  sorenessReviewThreshold: 7,
  acwrMinCoverage: 0.75,
  acwrAlertHigh: 1.5,
  acwrAlertLow: 0.8,
  readinessFlagBelow: 40,
};

export async function scienceSettings(tx: Tx, orgId: string): Promise<ScienceSettings> {
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  const s = (o?.settings?.science ?? {}) as Partial<ScienceSettings>;
  return { ...DEFAULT_SCIENCE_SETTINGS, ...s };
}
