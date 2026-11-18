import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { DISPLAY_NAME_MODES, organizations, type DisplayNameMode } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit, type AuditActor } from "@/lib/audit";
import { lintBlockMessage, lintFamilyMessage } from "@/lib/messaging/family-style";
import { DEFAULT_TZ } from "@/lib/time";
import { PANEL_KEYS, type PanelKey } from "./shared";

export const actorOf = (v: Viewer): AuditActor => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

/** Stored at organizations.settings.community. Every value is configurable; these are defaults, not policy. */
export type CommunitySettings = {
  /** Master switch: off hides the TV board content, leaderboards, shoutouts and challenges. */
  enabled: boolean;
  /** Used for athletes with no explicit choice. */
  defaultDisplayMode: DisplayNameMode;
  panels: Record<PanelKey, boolean>;
  rotationSeconds: number;
  /** Shoutouts one staff member may post per facility-local day. */
  shoutoutDailyLimit: number;
  /** Optional plain-text message for the TV board. */
  orgMessage: string | null;
};

export const ROTATION_MIN = 6;
export const ROTATION_MAX = 120;
export const SHOUTOUT_LIMIT_MAX = 50;
export const ORG_MESSAGE_MAX = 160;

export const DEFAULT_COMMUNITY_SETTINGS: CommunitySettings = {
  enabled: true,
  defaultDisplayMode: "first_last_initial",
  panels: Object.fromEntries(PANEL_KEYS.map((k) => [k, true])) as Record<PanelKey, boolean>,
  rotationSeconds: 15,
  shoutoutDailyLimit: 10,
  orgMessage: null,
};

const intIn = (x: unknown, min: number, max: number, fallback: number) => (typeof x === "number" && Number.isInteger(x) && x >= min && x <= max ? x : fallback);

export function communitySettingsOf(settings: Record<string, unknown> | null | undefined): CommunitySettings {
  const raw = (settings?.community ?? {}) as Partial<CommunitySettings>;
  const d = DEFAULT_COMMUNITY_SETTINGS;
  const panels = { ...d.panels };
  for (const k of PANEL_KEYS) if ((raw.panels as Record<string, unknown> | undefined)?.[k] === false) panels[k] = false;
  return {
    enabled: raw.enabled !== false,
    defaultDisplayMode: DISPLAY_NAME_MODES.includes(raw.defaultDisplayMode as DisplayNameMode) ? (raw.defaultDisplayMode as DisplayNameMode) : d.defaultDisplayMode,
    panels,
    rotationSeconds: intIn(raw.rotationSeconds, ROTATION_MIN, ROTATION_MAX, d.rotationSeconds),
    shoutoutDailyLimit: intIn(raw.shoutoutDailyLimit, 1, SHOUTOUT_LIMIT_MAX, d.shoutoutDailyLimit),
    orgMessage: typeof raw.orgMessage === "string" && raw.orgMessage.trim() ? raw.orgMessage.trim().slice(0, ORG_MESSAGE_MAX) : null,
  };
}

export type CommunityOrg = { settings: CommunitySettings; tz: string; name: string; orgSettings: Record<string, unknown> };

export async function communityOrg(tx: Tx, orgId: string): Promise<CommunityOrg> {
  const [o] = await tx.select({ settings: organizations.settings, tz: organizations.timezone, name: organizations.name, branding: organizations.branding }).from(organizations).where(eq(organizations.id, orgId));
  return { settings: communitySettingsOf(o?.settings), tz: o?.tz ?? DEFAULT_TZ, name: o?.branding?.displayName ?? o?.name ?? "Teamwork", orgSettings: o?.settings ?? {} };
}

export const communitySettingsInput = z.object({
  enabled: z.boolean(),
  defaultDisplayMode: z.enum(["first_last_initial", "first_name_only", "hidden"]),
  panels: z.array(z.enum(PANEL_KEYS)),
  rotationSeconds: z.coerce.number().int("Whole seconds only").min(ROTATION_MIN).max(ROTATION_MAX),
  shoutoutDailyLimit: z.coerce.number().int("Whole numbers only").min(1).max(SHOUTOUT_LIMIT_MAX),
  orgMessage: z.preprocess((x) => (typeof x === "string" && x.trim() === "" ? null : x), z.string().trim().max(ORG_MESSAGE_MAX).nullable()),
});

/** Owner/admin only. Audited. The gym message is plain text and passes the family style rules. */
export async function saveCommunitySettings(tx: Tx, v: Viewer, raw: unknown): Promise<CommunitySettings> {
  assertCan(v, "settings.manage");
  const input = communitySettingsInput.parse(raw);
  if (input.orgMessage) {
    const lint = lintFamilyMessage(input.orgMessage, { requireSignOff: false });
    if (lint.blocks.length) throw new UserError(lintBlockMessage(lint, "The gym message"), { orgMessage: lint.blocks[0].message });
  }
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  const before = communitySettingsOf(org.settings);
  const after: CommunitySettings = {
    enabled: input.enabled,
    defaultDisplayMode: input.defaultDisplayMode,
    panels: Object.fromEntries(PANEL_KEYS.map((k) => [k, input.panels.includes(k)])) as Record<PanelKey, boolean>,
    rotationSeconds: input.rotationSeconds,
    shoutoutDailyLimit: input.shoutoutDailyLimit,
    orgMessage: input.orgMessage,
  };
  await tx.update(organizations).set({ settings: { ...org.settings, community: after } }).where(eq(organizations.id, v.orgId));
  await audit(tx, actorOf(v), "org.community_settings_update", "organization", v.orgId, { summary: "Community settings saved", before, after });
  return after;
}
