import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, people } from "@/db/schema";
import { AuthzError, athleteCapabilities, isStaff, type Capability, type Viewer } from "@/lib/authz/policy";
import { todayLocal } from "@/lib/time";

/** Athletes aged 13 or older may set their own goals; younger athletes go through a guardian or coach. */
export const GOAL_SELF_MIN_AGE = 13;

export function ageOn(dateOfBirth: string | null, today: string): number | null {
  if (!dateOfBirth) return null;
  let age = Number(today.slice(0, 4)) - Number(dateOfBirth.slice(0, 4));
  if (today.slice(5) < dateOfBirth.slice(5)) age--;
  return age;
}

/**
 * What a viewer may see and do in the engagement module for one athlete. Everything is derived
 * from `athleteCapabilities` in policy.ts (the single source of truth); nothing is granted here
 * that policy.ts does not already grant.
 *
 * - training.read → streak, XP/level, badges, PRs, measured goal progress (coaching data).
 * - profile.read  → the goal list (titles, dates, status). Guardians hold this through an active
 *                   guardianship; a payer-only adult does not.
 * - health.read   → whether today's wellness check-in is done. Values are never shown here at all.
 */
export type EngagementAccess = {
  caps: Set<Capability>;
  isSelf: boolean;
  canSeeGoals: boolean;
  canSeeTraining: boolean;
  canSeeHealth: boolean;
  canWriteGoals: boolean;
  /** Linking a goal to a measured value requires seeing that value. */
  canLinkMeasuredGoals: boolean;
  /** Why the viewer cannot write goals, when that deserves an explanation. */
  writeBlockedReason: string | null;
};

export async function engagementAccess(tx: Tx, v: Viewer, athleteId: string, today = todayLocal()): Promise<EngagementAccess> {
  const caps = await athleteCapabilities(tx, v, athleteId);
  const canSeeGoals = caps.has("profile.read");
  const canSeeTraining = caps.has("training.read");
  let isSelf = false;
  let canWriteGoals = false;
  let writeBlockedReason: string | null = null;
  if (isStaff(v)) {
    canWriteGoals = caps.has("training.write");
  } else if (v.role === "guardian") {
    canWriteGoals = canSeeGoals;
  } else if (v.role === "athlete" && caps.has("training.log")) {
    isSelf = true;
    const [p] = await tx
      .select({ dob: people.dateOfBirth })
      .from(athletes)
      .innerJoin(people, eq(people.id, athletes.personId))
      .where(and(eq(athletes.id, athleteId), eq(athletes.orgId, v.orgId)));
    const age = ageOn(p?.dob ?? null, today);
    canWriteGoals = age !== null && age >= GOAL_SELF_MIN_AGE;
    if (!canWriteGoals) writeBlockedReason = "Ask a parent or your coach to add goals with you.";
  }
  return { caps, isSelf, canSeeGoals, canSeeTraining, canSeeHealth: caps.has("health.read"), canWriteGoals, canLinkMeasuredGoals: canWriteGoals && canSeeTraining, writeBlockedReason };
}

export async function requireEngagement(tx: Tx, v: Viewer, athleteId: string, need: "goals" | "training" | "writeGoals"): Promise<EngagementAccess> {
  const a = await engagementAccess(tx, v, athleteId);
  const ok = need === "goals" ? a.canSeeGoals : need === "training" ? a.canSeeTraining : a.canWriteGoals;
  if (!ok) throw new AuthzError(need === "writeGoals" && a.writeBlockedReason ? a.writeBlockedReason : undefined);
  return a;
}
