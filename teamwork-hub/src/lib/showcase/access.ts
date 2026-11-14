import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, organizations, people } from "@/db/schema";
import { athleteCapabilities, isAdmin, isStaff, type Capability, type Viewer } from "@/lib/authz/policy";
import { ageOn } from "@/lib/engagement/access";
import { DEFAULT_TZ, todayLocal } from "@/lib/time";
import { ADULT_AGE, showcaseSettingsOf, type ShowcaseSettings } from "./settings";

/**
 * What a viewer may do with one athlete's Showcase. Everything is derived from
 * `athleteCapabilities` in policy.ts; nothing is granted here that policy.ts does not grant.
 *
 * - A guardian's `profile.read` only ever comes from an active guardianship, so a payer-only
 *   adult (billing.read alone) has no Showcase access at all.
 * - Minors (under 18, or no birthday on file): the athlete may draft from the organization's
 *   minimum age; only a guardian may publish.
 * - Adults publish for themselves. A guardian linked to an adult may not publish for them.
 * - Staff never draft or publish. Owner and admin may revoke; staff with profile access may see
 *   that a Showcase is published.
 */
export type ShowcaseAccess = {
  settings: ShowcaseSettings;
  tz: string;
  caps: Set<Capability>;
  relationship: "self" | "guardian" | "staff" | "none";
  /** Null when no birthday is on file (treated as a minor). */
  age: number | null;
  isMinor: boolean;
  canView: boolean;
  canDraft: boolean;
  canPublish: boolean;
  /** Take the link down. Never needs the same bar as publishing. */
  canRevoke: boolean;
  canSeeTraining: boolean;
  /** Plain words for the builder when drafting or publishing is not available. */
  draftBlockedReason: string | null;
  publishBlockedReason: string | null;
};

export async function showcaseAccess(tx: Tx, v: Viewer, athleteId: string, today?: string): Promise<ShowcaseAccess> {
  const caps = await athleteCapabilities(tx, v, athleteId);
  const [row] = await tx
    .select({ dob: people.dateOfBirth, settings: organizations.settings, tz: organizations.timezone })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .innerJoin(organizations, eq(organizations.id, athletes.orgId))
    .where(and(eq(athletes.id, athleteId), eq(athletes.orgId, v.orgId)));
  const settings = showcaseSettingsOf(row?.settings);
  const tz = row?.tz ?? DEFAULT_TZ;
  const age = ageOn(row?.dob ?? null, today ?? todayLocal(tz));
  const isMinor = age === null || age < ADULT_AGE;
  const base: ShowcaseAccess = {
    settings, tz, caps, relationship: "none", age, isMinor,
    canView: false, canDraft: false, canPublish: false, canRevoke: false, canSeeTraining: caps.has("training.read"),
    draftBlockedReason: null, publishBlockedReason: null,
  };
  if (!row || !caps.has("profile.read")) return base;

  if (isStaff(v)) {
    return { ...base, relationship: "staff", canView: true, canRevoke: isAdmin(v), draftBlockedReason: "Families build and publish their own Showcase.", publishBlockedReason: "Only a parent or guardian, or an adult athlete, can publish a Showcase." };
  }
  if (!settings.enabled) return { ...base, canView: v.role === "athlete" || v.role === "guardian", relationship: v.role === "athlete" ? "self" : "guardian", draftBlockedReason: "Showcase is turned off for this gym.", publishBlockedReason: "Showcase is turned off for this gym." };

  if (v.role === "athlete") {
    const oldEnough = age !== null && age >= settings.minAge;
    return {
      ...base,
      relationship: "self",
      canView: true,
      canDraft: oldEnough,
      canPublish: !isMinor,
      canRevoke: true,
      draftBlockedReason: oldEnough ? null : "Ask a parent or guardian to build your Showcase with you.",
      publishBlockedReason: isMinor ? "A parent or guardian publishes your Showcase. Save your draft and ask them to take a look." : null,
    };
  }
  if (v.role === "guardian") {
    return {
      ...base,
      relationship: "guardian",
      canView: true,
      canDraft: true,
      canPublish: isMinor,
      canRevoke: true,
      publishBlockedReason: isMinor ? null : "This athlete is an adult and publishes their own Showcase.",
    };
  }
  return base;
}
