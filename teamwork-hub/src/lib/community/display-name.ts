/**
 * Display consent: THE place where an athlete's name is turned into something other families may
 * see. Every board, leaderboard, shoutout feed and challenge in this module gets names from
 * `publicName` (through `communityRoster`), so "hidden" athletes are dropped in exactly one spot.
 *
 * Never returned from here: full last names, dates of birth or ages (only a coarse age band),
 * health data, billing data.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, communityDisplayPrefs, people, type DisplayNameMode } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { AuthzError, athleteCapabilities, isStaff, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { todayLocal } from "@/lib/time";
import { actorOf, communityOrg } from "./settings";
import { DISPLAY_MODE_LABEL, type AgeBand } from "./shared";

export type NameParts = { firstName: string; preferredName?: string | null; lastName: string };

/**
 * The one function that resolves a display name. Returns null when the athlete must not be shown
 * to other families; callers drop the athlete entirely (no placeholder row, no count).
 */
export function publicName(p: NameParts, mode: DisplayNameMode): string | null {
  if (mode === "hidden") return null;
  const first = (p.preferredName?.trim() || p.firstName.trim()).split(/\s+/)[0] ?? "";
  if (!first) return null;
  if (mode === "first_name_only") return first;
  const initial = p.lastName.trim().charAt(0).toUpperCase();
  return initial ? `${first} ${initial}.` : first;
}

export function ageOn(dateOfBirth: string | null, today: string): number | null {
  if (!dateOfBirth) return null;
  let age = Number(today.slice(0, 4)) - Number(dateOfBirth.slice(0, 4));
  if (today.slice(5) < dateOfBirth.slice(5)) age--;
  return age;
}

/**
 * Age band from a date of birth (the age itself is never shown). No birthday on file means no
 * band: the athlete is left off age-banded boards instead of being guessed into one.
 */
export function ageBandOf(dateOfBirth: string | null, today: string): AgeBand | null {
  const age = ageOn(dateOfBirth, today);
  if (age === null || age < 0) return null;
  if (age < 12) return "U12";
  if (age < 14) return "U14";
  if (age < 16) return "U16";
  if (age < 18) return "U18";
  return "Adult";
}

/** Under 18, or no birthday on file (treated as a minor to be safe). */
export const isMinor = (dateOfBirth: string | null, today: string) => {
  const age = ageOn(dateOfBirth, today);
  return age === null || age < 18;
};

export type RosterEntry = {
  athleteId: string;
  /** Null = hidden: never put this athlete in anything another family can see. */
  displayName: string | null;
  /** First name for the athlete's own "You" lines (shown only to the athlete and their guardians). */
  firstName: string;
  mode: DisplayNameMode;
  band: AgeBand | null;
  groupIds: string[];
  /** Kilograms, only for relative-strength ordering. Never output. */
  bodyMassKg: number | null;
};

/** Every active athlete in the organization with their resolved display name, age band and groups. */
export async function communityRoster(tx: Tx, orgId: string, opts: { today?: string; defaultMode?: DisplayNameMode } = {}): Promise<Map<string, RosterEntry>> {
  const org = opts.defaultMode && opts.today ? null : await communityOrg(tx, orgId);
  const today = opts.today ?? todayLocal(org!.tz);
  const defaultMode = opts.defaultMode ?? org!.settings.defaultDisplayMode;
  const rows = (
    await tx.execute(sql`
      select a.id, p.first_name, p.preferred_name, p.last_name, p.date_of_birth, a.body_mass_kg, dp.mode,
        coalesce((select array_agg(gm.group_id::text) from group_members gm join groups g on g.id = gm.group_id
                  where gm.athlete_id = a.id and g.org_id = ${orgId} and g.active), '{}') as group_ids
      from athletes a
      join people p on p.id = a.person_id
      left join community_display_prefs dp on dp.athlete_id = a.id and dp.org_id = ${orgId}
      where a.org_id = ${orgId} and a.active and p.status = 'active' and p.archived_at is null`)
  ).rows as { id: string; first_name: string; preferred_name: string | null; last_name: string; date_of_birth: string | Date | null; body_mass_kg: string | null; mode: DisplayNameMode | null; group_ids: string[] }[];
  const out = new Map<string, RosterEntry>();
  for (const r of rows) {
    const dob = r.date_of_birth == null ? null : r.date_of_birth instanceof Date ? r.date_of_birth.toISOString().slice(0, 10) : String(r.date_of_birth).slice(0, 10);
    const mode = r.mode ?? defaultMode;
    const parts = { firstName: r.first_name, preferredName: r.preferred_name, lastName: r.last_name };
    const mass = r.body_mass_kg == null ? NaN : Number(r.body_mass_kg);
    out.set(r.id, {
      athleteId: r.id,
      displayName: publicName(parts, mode),
      firstName: publicName(parts, "first_name_only") ?? "Athlete",
      mode,
      band: ageBandOf(dob, today),
      groupIds: r.group_ids ?? [],
      bodyMassKg: Number.isFinite(mass) && mass > 0 ? mass : null,
    });
  }
  return out;
}

export type DisplayModeAccess = {
  athleteId: string;
  firstName: string;
  /** The explicit choice, or null when the organization default applies. */
  chosen: DisplayNameMode | null;
  effective: DisplayNameMode;
  /** What other families see right now (null = nothing). */
  preview: string | null;
  canChange: boolean;
  /** Staff may change it only on the family's request, with a note. */
  staffOnRequest: boolean;
  /** Why the viewer cannot change it, when that deserves an explanation. */
  blockedReason: string | null;
};

/**
 * Who may change how an athlete is shown:
 *  - a minor (or an athlete with no birthday on file): a guardian with profile access;
 *  - an adult athlete: the athlete;
 *  - staff with profile.write (owner, admin, operations): on the family's request, with a note.
 * Everything derives from `athleteCapabilities` in policy.ts.
 */
export async function displayModeAccess(tx: Tx, v: Viewer, athleteId: string, today?: string): Promise<DisplayModeAccess> {
  const caps = await athleteCapabilities(tx, v, athleteId);
  if (!caps.has("profile.read")) throw new AuthzError();
  const org = await communityOrg(tx, v.orgId);
  const day = today ?? todayLocal(org.tz);
  const [who] = await tx
    .select({ firstName: people.firstName, preferredName: people.preferredName, lastName: people.lastName, dob: people.dateOfBirth, mode: communityDisplayPrefs.mode })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .leftJoin(communityDisplayPrefs, and(eq(communityDisplayPrefs.athleteId, athletes.id), eq(communityDisplayPrefs.orgId, v.orgId)))
    .where(and(eq(athletes.id, athleteId), eq(athletes.orgId, v.orgId)));
  if (!who) throw new AuthzError();
  const minor = isMinor(who.dob, day);
  let canChange = false;
  let staffOnRequest = false;
  let blockedReason: string | null = null;
  if (isStaff(v)) {
    canChange = staffOnRequest = caps.has("profile.write");
    if (!canChange) blockedReason = "The family or the front desk changes this.";
  } else if (v.role === "guardian") {
    canChange = minor;
    if (!canChange) blockedReason = "Adult athletes choose this from their own login.";
  } else if (v.role === "athlete") {
    canChange = !minor;
    if (!canChange) blockedReason = "A parent or guardian chooses this for athletes under 18.";
  }
  const effective = who.mode ?? org.settings.defaultDisplayMode;
  return {
    athleteId,
    firstName: publicName(who, "first_name_only") ?? "Athlete",
    chosen: who.mode ?? null,
    effective,
    preview: publicName(who, effective),
    canChange,
    staffOnRequest,
    blockedReason,
  };
}

const MODES: DisplayNameMode[] = ["first_last_initial", "first_name_only", "hidden"];

/** Change an athlete's display mode. Audited; a staff change records who in the family asked. */
export async function setDisplayMode(tx: Tx, v: Viewer, input: { athleteId: string; mode: string; requestedBy?: string | null }, today?: string): Promise<DisplayNameMode> {
  const access = await displayModeAccess(tx, v, input.athleteId, today);
  if (!access.canChange) throw new AuthzError(access.blockedReason ?? undefined);
  if (!MODES.includes(input.mode as DisplayNameMode)) throw new UserError("Choose how the name is shown.");
  const mode = input.mode as DisplayNameMode;
  const requestedBy = input.requestedBy?.trim() || null;
  if (access.staffOnRequest && (!requestedBy || requestedBy.length < 3)) throw new UserError("Note who in the family asked for this change.", { requestedBy: "Required for staff changes" });
  if (requestedBy && requestedBy.length > 200) throw new UserError("Keep the note under 200 characters.");
  const [a] = await tx.select({ isDemo: athletes.isDemo }).from(athletes).where(and(eq(athletes.id, input.athleteId), eq(athletes.orgId, v.orgId)));
  await tx
    .insert(communityDisplayPrefs)
    .values({ orgId: v.orgId, athleteId: input.athleteId, mode, setBy: v.userId, isDemo: a?.isDemo ?? false })
    .onConflictDoUpdate({ target: communityDisplayPrefs.athleteId, set: { mode, setBy: v.userId, updatedAt: new Date() } });
  await audit(tx, actorOf(v), "community.display_mode.set", "athlete", input.athleteId, {
    summary: `Display name set to "${DISPLAY_MODE_LABEL[mode]}"${access.staffOnRequest ? " by staff on the family's request" : ""}`,
    before: { mode: access.chosen, effective: access.effective },
    after: { mode, ...(access.staffOnRequest ? { requestedBy } : {}) },
  });
  return mode;
}
