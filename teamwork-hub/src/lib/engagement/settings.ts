import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { organizations, XP_KINDS, type XpKind } from "@/db/schema";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";

/** Stored at organizations.settings.engagement. Every value is configurable; these are defaults, not policy. */
export type EngagementSettings = {
  /** XP and levels shown and awarded. */
  levelsEnabled: boolean;
  /** Badges shown and awarded. */
  badgesEnabled: boolean;
  xp: Record<XpKind, number>;
};

export const DEFAULT_XP: Record<XpKind, number> = {
  session_attended: 20,
  workout_completed: 15,
  wellness_checkin: 5,
  pr_set: 25,
  goal_achieved: 50,
  form_signed: 10,
  on_your_own_completed: 10,
  coach_shoutout: 10,
};

export const DEFAULT_ENGAGEMENT_SETTINGS: EngagementSettings = { levelsEnabled: true, badgesEnabled: true, xp: DEFAULT_XP };

export const XP_KIND_LABEL: Record<XpKind, string> = {
  session_attended: "Session attended",
  workout_completed: "Workout completed",
  wellness_checkin: "Wellness check-in submitted",
  pr_set: "Personal record set",
  goal_achieved: "Goal achieved",
  form_signed: "Form signed",
  on_your_own_completed: "On Your Own session finished",
  coach_shoutout: "Coach shoutout received",
};

export const MAX_XP_PER_EVENT = 1000;

export function engagementSettingsOf(settings: Record<string, unknown> | null | undefined): EngagementSettings {
  const raw = (settings?.engagement ?? {}) as Partial<EngagementSettings>;
  const xp = { ...DEFAULT_XP };
  for (const k of XP_KINDS) {
    const n = (raw.xp as Record<string, unknown> | undefined)?.[k];
    if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_XP_PER_EVENT) xp[k] = n;
  }
  return { levelsEnabled: raw.levelsEnabled !== false, badgesEnabled: raw.badgesEnabled !== false, xp };
}

export async function engagementSettings(tx: Tx, orgId: string): Promise<EngagementSettings> {
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  return engagementSettingsOf(o?.settings);
}

const points = z.coerce.number().int("Whole numbers only").min(0).max(MAX_XP_PER_EVENT);
export const engagementSettingsInput = z.object({
  levelsEnabled: z.boolean(),
  badgesEnabled: z.boolean(),
  session_attended: points,
  workout_completed: points,
  wellness_checkin: points,
  pr_set: points,
  goal_achieved: points,
  form_signed: points,
  // Optional so a form saved without the newest field keeps the default.
  on_your_own_completed: points.default(DEFAULT_XP.on_your_own_completed),
  coach_shoutout: points.default(DEFAULT_XP.coach_shoutout),
});

/** Owner/admin only. New point values apply to future awards; the ledger is never rewritten. */
export async function saveEngagementSettings(tx: Tx, v: Viewer, raw: unknown): Promise<EngagementSettings> {
  assertCan(v, "settings.manage");
  const input = engagementSettingsInput.parse(raw);
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  const before = engagementSettingsOf(org.settings);
  const after: EngagementSettings = {
    levelsEnabled: input.levelsEnabled,
    badgesEnabled: input.badgesEnabled,
    xp: Object.fromEntries(XP_KINDS.map((k) => [k, input[k]])) as Record<XpKind, number>,
  };
  await tx.update(organizations).set({ settings: { ...org.settings, engagement: after } }).where(eq(organizations.id, v.orgId));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "org.engagement_settings_update", "organization", v.orgId, { summary: "Engagement settings saved", before, after });
  return after;
}
