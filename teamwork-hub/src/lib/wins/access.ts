import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, communityDisplayPrefs, people, type DisplayNameMode } from "@/db/schema";
import { athleteCapabilities, can, isStaff, type Capability, type Viewer } from "@/lib/authz/policy";
import type { AuditActor } from "@/lib/audit";
import { isMinor, publicName } from "@/lib/community/display-name";
import { communityOrg, type CommunityOrg } from "@/lib/community/settings";
import { todayLocal } from "@/lib/time";

export const actorOf = (v: Viewer): AuditActor => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

/**
 * What a viewer may do with one athlete's wins. Everything is derived from `athleteCapabilities`
 * and `can` in policy.ts; nothing is granted here that policy.ts does not grant.
 *
 * Guardian flags (see docs/modules/wins.md):
 *  - see the athlete's wins: an active guardianship (`profile.read`);
 *  - submit a win, confirm or decline a staff draft, choose the in-app and TV levels:
 *    `profile.read` AND `booking.create` (the guardianship's "can book" flag, the same flag that
 *    lets a guardian edit My Season: it is the flag for acting on the child's activities);
 *  - give or decline marketing consent: `profile.read` AND `forms.sign` (the "can sign forms"
 *    flag: a marketing release is a signed permission), and only for a minor;
 *  - withdraw marketing consent, or withdraw a win: any active guardianship. Taking something
 *    down never needs the same bar as putting it up.
 * Health access and training access are irrelevant: a win holds neither.
 * Adults (18 or older by the birthday on file) decide for themselves; a guardian linked to an
 * adult cannot consent or change sharing. No birthday on file is treated as a minor.
 * Staff submit, edit, approve and remove (wins.review + profile.read, so coaches only for
 * assigned athletes) and never consent on a family's behalf.
 */
export type WinsAccess = {
  athleteId: string;
  personId: string;
  caps: Set<Capability>;
  relationship: "self" | "guardian" | "staff" | "none";
  isMinor: boolean;
  firstName: string;
  lastName: string;
  mode: DisplayNameMode;
  /** What other families see; null when the athlete is hidden. */
  displayName: string | null;
  isDemo: boolean;
  org: CommunityOrg;
  today: string;
  canSee: boolean;
  canSubmit: boolean;
  /** Staff: edit, approve, remove. */
  canReview: boolean;
  /** Choose levels (a) in-app and (b) TV after submission. */
  canSetSharing: boolean;
  /** Give or decline level (c), public marketing. */
  canConsent: boolean;
  /** Withdraw level (c), or withdraw the whole win. */
  canWithdraw: boolean;
  consentBlockedReason: string | null;
};

export async function winsAccess(tx: Tx, v: Viewer, athleteId: string, opts: { today?: string } = {}): Promise<WinsAccess | null> {
  const [who] = await tx
    .select({ personId: people.id, first: people.firstName, preferred: people.preferredName, last: people.lastName, dob: people.dateOfBirth, isDemo: athletes.isDemo, mode: communityDisplayPrefs.mode })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .leftJoin(communityDisplayPrefs, and(eq(communityDisplayPrefs.athleteId, athletes.id), eq(communityDisplayPrefs.orgId, v.orgId)))
    .where(and(eq(athletes.id, athleteId), eq(athletes.orgId, v.orgId)));
  if (!who) return null;
  const org = await communityOrg(tx, v.orgId);
  const today = opts.today ?? todayLocal(org.tz);
  const caps = await athleteCapabilities(tx, v, athleteId, { today });
  const minor = isMinor(who.dob, today);
  const mode = who.mode ?? org.settings.defaultDisplayMode;
  const parts = { firstName: who.first, preferredName: who.preferred, lastName: who.last };
  const base: WinsAccess = {
    athleteId,
    personId: who.personId,
    caps,
    relationship: "none",
    isMinor: minor,
    firstName: publicName(parts, "first_name_only") ?? "Athlete",
    lastName: who.last,
    mode,
    displayName: publicName(parts, mode),
    isDemo: who.isDemo,
    org,
    today,
    canSee: false,
    canSubmit: false,
    canReview: false,
    canSetSharing: false,
    canConsent: false,
    canWithdraw: false,
    consentBlockedReason: null,
  };
  if (!caps.has("profile.read")) return base;
  if (isStaff(v)) {
    const review = can(v, "wins.review");
    return { ...base, relationship: "staff", canSee: true, canSubmit: review, canReview: review, consentBlockedReason: "Only the family can give marketing consent." };
  }
  const acts = caps.has("booking.create");
  if (v.role === "athlete") {
    return {
      ...base,
      relationship: "self",
      canSee: true,
      canSubmit: acts,
      canSetSharing: !minor,
      canConsent: !minor,
      canWithdraw: true,
      consentBlockedReason: minor ? "A parent or guardian decides about public marketing for athletes under 18." : null,
    };
  }
  if (v.role === "guardian") {
    const signs = caps.has("forms.sign");
    return {
      ...base,
      relationship: "guardian",
      canSee: true,
      canSubmit: acts,
      canSetSharing: minor && acts,
      canConsent: minor && signs,
      canWithdraw: minor,
      consentBlockedReason: !minor ? "This athlete is an adult and decides for themselves." : !signs ? "Your account is not set up to sign permissions for this athlete. Another parent or guardian can, or ask the front desk." : null,
    };
  }
  return base;
}
