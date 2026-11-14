import { eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { organizations } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { chipKey, DEFAULT_DISLIKED_CHIPS, DEFAULT_LIKED_CHIPS, WORDING_VERSION, type ChipDef } from "./questions";

/**
 * Session check-in settings, stored in `organizations.settings.checkins`.
 * Every default is a STARTING POINT (labelled "Default" in Settings until edited), not a norm
 * and not a Teamwork policy. The low-rating threshold is NOT here: it stays in the retention
 * settings (`lowRatingThreshold`) so there is one number, not two.
 */
export type CheckinSettings = {
  preEnabled: boolean;
  postEnabled: boolean;
  /** Offer the ready check on the kiosk right after a PIN check-in. */
  kioskOffer: boolean;
  /** The ready check opens this many hours before the session starts (closes 15 minutes after the start). */
  preOpensHoursBefore: number;
  /** Effort and body questions of the after check close this many hours after the session ends. */
  postClosesHoursAfter: number;
  askSleepHours: boolean;
  askFatigue: boolean;
  askMood: boolean;
  askStress: boolean;
  askPriorSoreness: boolean;
  likedChips: ChipDef[];
  dislikedChips: ChipDef[];
  /** Ready-check soreness at or above this opens the "where?" body map prompt. */
  bodyMapSorenessAt: number;
  /** checkin_baseline_v1: answers needed before a baseline exists. */
  baselineMinAnswers: number;
  /** checkin_baseline_v1: only answers from this many days back count. */
  baselineWindowDays: number;
  /** Alert when soreness (0 to 10) is at least this far ABOVE the athlete's own baseline. */
  sorenessAboveBaseline: number;
  /** Alert when readiness (1 to 5) is at least this far BELOW the athlete's own baseline. */
  readinessBelowBaseline: number;
  /** Bumped whenever chips or optional questions change. */
  revision: number;
};

export const PRE_GRACE_MINUTES = 15;

export const DEFAULT_CHECKIN_SETTINGS: CheckinSettings = {
  preEnabled: true,
  postEnabled: true,
  kioskOffer: true,
  preOpensHoursBefore: 4,
  postClosesHoursAfter: 48,
  askSleepHours: true,
  askFatigue: true,
  askMood: true,
  askStress: false,
  askPriorSoreness: true,
  likedChips: DEFAULT_LIKED_CHIPS,
  dislikedChips: DEFAULT_DISLIKED_CHIPS,
  bodyMapSorenessAt: 6,
  baselineMinAnswers: 5,
  baselineWindowDays: 42,
  sorenessAboveBaseline: 3,
  readinessBelowBaseline: 1.5,
  revision: 1,
};

const isChips = (x: unknown): x is ChipDef[] => Array.isArray(x) && x.every((c) => c && typeof c === "object" && typeof (c as ChipDef).key === "string" && typeof (c as ChipDef).label === "string");

export function checkinSettingsFrom(settings: Record<string, unknown> | null | undefined): CheckinSettings {
  const raw = (settings?.checkins ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_CHECKIN_SETTINGS } as Record<string, unknown>;
  for (const [k, d] of Object.entries(DEFAULT_CHECKIN_SETTINGS)) {
    const v = raw[k];
    if (typeof d === "boolean" && typeof v === "boolean") out[k] = v;
    else if (typeof d === "number" && typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (Array.isArray(d) && isChips(v)) out[k] = v;
  }
  return out as CheckinSettings;
}

export async function checkinSettings(tx: Tx, orgId: string): Promise<CheckinSettings> {
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  return checkinSettingsFrom(o?.settings);
}

export const questionSetVersion = (s: CheckinSettings) => `${WORDING_VERSION}.${s.revision}`;

/** Which settings still hold their default value (drives the "Default" labels). */
export function defaultFlags(s: CheckinSettings): Record<keyof CheckinSettings, boolean> {
  const out = {} as Record<keyof CheckinSettings, boolean>;
  for (const k of Object.keys(DEFAULT_CHECKIN_SETTINGS) as (keyof CheckinSettings)[]) out[k] = JSON.stringify(s[k]) === JSON.stringify(DEFAULT_CHECKIN_SETTINGS[k]);
  return out;
}

export const NUMBER_FIELDS: { key: keyof CheckinSettings; label: string; hint: string; min: number; max: number; step?: number }[] = [
  { key: "preOpensHoursBefore", label: "Ready check opens (hours before the session)", hint: "It closes 15 minutes after the session starts.", min: 1, max: 24 },
  { key: "postClosesHoursAfter", label: "After check: effort and body questions close (hours after the session)", hint: "The rating, likes and dislikes stay open for the feedback window in the retention settings.", min: 2, max: 168 },
  { key: "bodyMapSorenessAt", label: "Ask \"where?\" when soreness is at or above (0 to 10)", hint: "The athlete can always tap \"Something hurts\" below this.", min: 1, max: 10 },
  { key: "baselineMinAnswers", label: "Answers needed before a personal baseline exists", hint: "Until then trends say \"not enough data yet\" and no baseline alert fires.", min: 3, max: 20 },
  { key: "baselineWindowDays", label: "Baseline looks back (days)", hint: "Only the athlete's own earlier answers in this window count.", min: 14, max: 180 },
  { key: "sorenessAboveBaseline", label: "Alert when soreness is this far above the athlete's baseline (points, 0 to 10 scale)", hint: "", min: 1, max: 10, step: 0.5 },
  { key: "readinessBelowBaseline", label: "Alert when readiness is this far below the athlete's baseline (points, 1 to 5 scale)", hint: "", min: 0.5, max: 4, step: 0.5 },
];
const BOOL_FIELDS = ["preEnabled", "postEnabled", "kioskOffer", "askSleepHours", "askFatigue", "askMood", "askStress", "askPriorSoreness"] as const;

function parseChips(raw: unknown, what: string): ChipDef[] {
  const lines = String(raw ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 12) throw new UserError(`Keep the "${what}" list to 12 chips or fewer so the screen stays short.`);
  const out: ChipDef[] = [];
  for (const label of lines) {
    if (label.length > 40) throw new UserError(`"${label.slice(0, 20)}…" is too long for a chip (40 characters at most).`);
    if (/[—–]/.test(label)) throw new UserError("Please do not use long dashes in chip text.");
    const key = chipKey(label);
    if (!key) throw new UserError(`"${label}" needs at least one letter or number.`);
    if (out.some((c) => c.key === key)) throw new UserError(`"${label}" is listed twice.`);
    out.push({ key, label });
  }
  return out;
}

/** Owner / admin. Changing chips or optional questions bumps the revision; windows and thresholds do not. */
export async function saveCheckinSettings(tx: Tx, v: Viewer, raw: Record<string, unknown>): Promise<CheckinSettings> {
  assertCan(v, "settings.manage");
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  const before = checkinSettingsFrom(org.settings);
  const after: CheckinSettings = { ...before };
  const errors: Record<string, string> = {};
  for (const f of NUMBER_FIELDS) {
    const n = Number(raw[f.key]);
    if (raw[f.key] === undefined || raw[f.key] === "" || !Number.isFinite(n)) errors[f.key] = "Enter a number.";
    else if (n < f.min || n > f.max) errors[f.key] = `Must be ${f.min} to ${f.max}.`;
    else if (!f.step && !Number.isInteger(n)) errors[f.key] = "Whole numbers only.";
    else (after[f.key] as number) = n;
  }
  if (Object.keys(errors).length) throw new UserError("Please fix the highlighted fields.", errors);
  for (const k of BOOL_FIELDS) after[k] = raw[k] === true || raw[k] === "on" || raw[k] === "true";
  after.likedChips = parseChips(raw.likedChips, "liked");
  after.dislikedChips = parseChips(raw.dislikedChips, "did not like");
  const questionsChanged = (["askSleepHours", "askFatigue", "askMood", "askStress", "askPriorSoreness", "likedChips", "dislikedChips"] as const).some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (questionsChanged) after.revision = before.revision + 1;
  await tx.update(organizations).set({ settings: { ...org.settings, checkins: after } }).where(eq(organizations.id, v.orgId));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "org.checkin_settings_update", "organization", v.orgId, {
    summary: `Session check-in settings saved${questionsChanged ? ` (question set ${questionSetVersion(after)})` : ""}`,
    before,
    after,
  });
  return after;
}

export async function resetCheckinSettings(tx: Tx, v: Viewer): Promise<void> {
  assertCan(v, "settings.manage");
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  const before = checkinSettingsFrom(org.settings);
  const after = { ...DEFAULT_CHECKIN_SETTINGS, revision: before.revision + 1 };
  await tx.update(organizations).set({ settings: { ...org.settings, checkins: after } }).where(eq(organizations.id, v.orgId));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "org.checkin_settings_reset", "organization", v.orgId, { summary: "Session check-in settings reset to defaults", before, after });
}
