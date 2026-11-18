import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { organizations } from "@/db/schema";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";

/** Stored at organizations.settings.showcase. Every value is configurable; these are defaults, not policy. */
export type ShowcaseSettings = {
  /** Off: nobody can build or publish a Showcase and every shared link shows the generic page. */
  enabled: boolean;
  /** Athletes younger than this cannot draft their own Showcase; only a guardian can. */
  minAge: number;
  /** Link lifetime offered by default when publishing. */
  defaultExpiryDays: number;
  /** Monthly recaps are assembled and shown to families. */
  recapEnabled: boolean;
  /** Days after a month ends before its recap is finalized, so coaches can add a note. */
  recapGraceDays: number;
};

export const DEFAULT_SHOWCASE_SETTINGS: ShowcaseSettings = { enabled: true, minAge: 13, defaultExpiryDays: 90, recapEnabled: true, recapGraceDays: 3 };

/** Link lifetimes a publisher may choose. 0 = no expiry. */
export const EXPIRY_CHOICES = [30, 90, 180, 365, 0] as const;
export const ADULT_AGE = 18;

const int = (v: unknown, min: number, max: number, d: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : d);

export function showcaseSettingsOf(settings: Record<string, unknown> | null | undefined): ShowcaseSettings {
  const raw = (settings?.showcase ?? {}) as Partial<ShowcaseSettings>;
  const d = DEFAULT_SHOWCASE_SETTINGS;
  return {
    enabled: raw.enabled !== false,
    minAge: int(raw.minAge, 8, 17, d.minAge),
    defaultExpiryDays: (EXPIRY_CHOICES as readonly number[]).includes(raw.defaultExpiryDays as number) ? (raw.defaultExpiryDays as number) : d.defaultExpiryDays,
    recapEnabled: raw.recapEnabled !== false,
    recapGraceDays: int(raw.recapGraceDays, 0, 14, d.recapGraceDays),
  };
}

export async function showcaseSettings(tx: Tx, orgId: string): Promise<ShowcaseSettings> {
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  return showcaseSettingsOf(o?.settings);
}

export const showcaseSettingsInput = z.object({
  enabled: z.boolean(),
  minAge: z.coerce.number().int("Whole numbers only").min(8).max(17),
  defaultExpiryDays: z.coerce.number().refine((n) => (EXPIRY_CHOICES as readonly number[]).includes(n), "Choose one of the listed lifetimes"),
  recapEnabled: z.boolean(),
  recapGraceDays: z.coerce.number().int("Whole numbers only").min(0).max(14),
});

/** Owner/admin only. Turning Showcase off makes every shared link show the generic page at once. */
export async function saveShowcaseSettings(tx: Tx, v: Viewer, raw: unknown): Promise<ShowcaseSettings> {
  assertCan(v, "settings.manage");
  const after: ShowcaseSettings = showcaseSettingsInput.parse(raw);
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  const before = showcaseSettingsOf(org.settings);
  await tx.update(organizations).set({ settings: { ...org.settings, showcase: after } }).where(eq(organizations.id, v.orgId));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "org.showcase_settings_update", "organization", v.orgId, { summary: "Showcase and recap settings saved", before, after });
  return after;
}
