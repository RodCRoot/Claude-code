import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { athletes, organizations, people, type AnywhereCategory, type AnywhereEquipment, type SeasonEventKind } from "@/db/schema";
import { assertCan, athleteCapabilities, type Capability, type Viewer } from "@/lib/authz/policy";
import { audit, type AuditActor } from "@/lib/audit";
import { DEFAULT_TZ, todayLocal } from "@/lib/time";

export const actorOf = (v: Viewer): AuditActor => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

/** Shown on every On Your Own session, in the library, the player and the coach builder. */
export const SAFETY_COPY = "Stop if anything hurts and tell your coach or a parent.";

export const CATEGORY_LABEL: Record<AnywhereCategory, string> = {
  mobility: "Mobility",
  recovery: "Recovery",
  core: "Core",
  speed_agility: "Speed and agility",
  bodyweight_strength: "Bodyweight strength",
  travel: "Travel and hotel",
  pre_game_warmup: "Pre-game warm-up",
};

export const EQUIPMENT_LABEL: Record<AnywhereEquipment, string> = { none: "No equipment", band: "Band", ball: "Ball", field: "Field or open space" };

export const EVENT_KIND_LABEL: Record<SeasonEventKind, string> = { game: "Game", practice: "Practice", tournament: "Tournament", travel: "Travel day", rest: "Rest day" };

export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date");
export const optText = (max: number) => z.preprocess((x) => (typeof x === "string" && x.trim() === "" ? null : x), z.string().trim().max(max).nullable().optional());

/** Athletes younger than this (or with no birthday on file) only see sessions marked suitable. */
export const UNDER_13_AGE = 13;

export function ageOn(dateOfBirth: string | null, today: string): number | null {
  if (!dateOfBirth) return null;
  let age = Number(today.slice(0, 4)) - Number(dateOfBirth.slice(0, 4));
  if (today.slice(5) < dateOfBirth.slice(5)) age--;
  return age;
}

export type AnywhereAccess = {
  caps: Set<Capability>;
  firstName: string;
  /** True when the athlete is under 13, or has no birthday on file (treated as under 13 to be safe). */
  restricted: boolean;
  /** Browse the library, see assignments, completions, sport logs (RPE, duration): same as load data. */
  canSeeTraining: boolean;
  /** Finish a session, log practice or a game, tick a habit: same as logging load. */
  canLog: boolean;
  /** See the season calendar. */
  canSeeSeason: boolean;
  /** Add or change the season and its events. */
  canEditSeason: boolean;
};

/**
 * What the viewer may do in this module for one athlete. Everything comes from
 * `athleteCapabilities` in policy.ts; nothing is granted here that policy.ts does not grant.
 * Returns null when the athlete is not in the viewer's organization.
 */
export async function anywhereAccess(tx: Tx, v: Viewer, athleteId: string, today = todayLocal()): Promise<AnywhereAccess | null> {
  const [who] = await tx
    .select({ first: people.firstName, preferred: people.preferredName, dob: people.dateOfBirth })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.id, athleteId), eq(athletes.orgId, v.orgId)));
  if (!who) return null;
  const caps = await athleteCapabilities(tx, v, athleteId);
  const age = ageOn(who.dob, today);
  return {
    caps,
    firstName: who.preferred ?? who.first,
    restricted: age === null || age < UNDER_13_AGE,
    canSeeTraining: caps.has("training.read"),
    canLog: caps.has("training.log"),
    canSeeSeason: caps.has("profile.read"),
    canEditSeason: caps.has("profile.read") && caps.has("booking.create"),
  };
}

// ---------------------------------------------------------------------------
// Settings (organizations.settings.anywhere)
// ---------------------------------------------------------------------------

export type AnywhereSettings = {
  /** Show an informational "ask about In Season" link while a season is active. Never changes a membership. */
  showInSeasonOption: boolean;
};
export const DEFAULT_ANYWHERE_SETTINGS: AnywhereSettings = { showInSeasonOption: false };

export function anywhereSettingsOf(settings: Record<string, unknown> | null | undefined): AnywhereSettings {
  const raw = (settings?.anywhere ?? {}) as Partial<AnywhereSettings>;
  return { showInSeasonOption: raw.showInSeasonOption === true };
}

export async function orgAnywhere(tx: Tx, orgId: string): Promise<{ settings: AnywhereSettings; tz: string }> {
  const [o] = await tx.select({ settings: organizations.settings, tz: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId));
  return { settings: anywhereSettingsOf(o?.settings), tz: o?.tz ?? DEFAULT_TZ };
}

export async function saveAnywhereSettings(tx: Tx, v: Viewer, raw: { showInSeasonOption: boolean }): Promise<AnywhereSettings> {
  assertCan(v, "settings.manage");
  const after: AnywhereSettings = { showInSeasonOption: raw.showInSeasonOption === true };
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  const before = anywhereSettingsOf(org.settings);
  await tx.update(organizations).set({ settings: { ...org.settings, anywhere: after } }).where(eq(organizations.id, v.orgId));
  await audit(tx, actorOf(v), "org.anywhere_settings_update", "organization", v.orgId, { summary: "On Your Own settings saved", before, after });
  return after;
}
