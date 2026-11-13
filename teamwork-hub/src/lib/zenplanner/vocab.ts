import { eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { organizations } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";

/**
 * Zen Planner controlled vocabularies, copied from the 2026-11-13 account map
 * (docs/ZENPLANNER-MAP.md, "Controlled vocabularies"). These are the hub's default lists so an
 * imported value maps one to one. Nothing here is invented: where the map names only some of a
 * list's values (`complete: false`), the rest are unknown until an owner adds them (Imports →
 * Zen Planner → Lists) or a real export shows them. Unknown values always import as-is and are flagged.
 */
export type VocabKey = "prospectStatus" | "source" | "interest" | "priority" | "holdReason" | "dropReason" | "incomeCategory" | "membershipCategory";

export type VocabDef = {
  key: VocabKey;
  label: string;
  /** Zen Planner field the list belongs to. */
  zpField: string;
  values: string[];
  /** false = the map names only some of the values; `total` is the count the map reports. */
  complete: boolean;
  total?: number;
  note?: string;
};

export const ZP_VOCAB: Record<VocabKey, VocabDef> = {
  prospectStatus: {
    key: "prospectStatus",
    label: "Prospect Status",
    zpField: "Person: Prospect Status",
    values: ["New Prospect", "Call 1", "Call 2", "Ready to Sign", "Not Interested"],
    complete: true,
    note: "Mapped onto the hub's lead stages; the Zen Planner status is kept on the lead.",
  },
  source: {
    key: "source",
    label: "Source",
    zpField: "Person: Source",
    values: ["Flyer", "Newspaper Advertisement", "Facebook", "Referral", "Walk-in", "Drive By", "Website", "Other"],
    complete: true,
  },
  interest: {
    key: "interest",
    label: "Interest",
    zpField: "Person: Interest",
    values: ["General Fitness", "Performance Training", "Weight Loss", "Police/Fire/Military", "Endurance", "Other"],
    complete: true,
  },
  priority: { key: "priority", label: "Priority", zpField: "Person: Prospect Priority", values: ["Low", "Medium", "High"], complete: true },
  holdReason: {
    key: "holdReason",
    label: "Hold Reason",
    zpField: "Membership: Hold Reason",
    // Spelled and cased exactly as configured in Zen Planner.
    values: ["Vacation", "Illness", "Injury", "Financial", "maternity", "busy", "sports"],
    complete: true,
  },
  dropReason: {
    key: "dropReason",
    label: "Drop / Cancel Reason",
    zpField: "Membership: Cancel Reason",
    values: ["Price is too expensive", "Doesn't fit my schedule", "Membership Upgrade", "Administrative Drop"],
    complete: false,
    total: 12,
  },
  incomeCategory: {
    key: "incomeCategory",
    label: "Income Category",
    zpField: "Membership: Income Category",
    values: ["Sports Performance", "Youth", "Adult Performance Training", "Six Week Challenges"],
    complete: false,
    total: 12,
  },
  membershipCategory: {
    key: "membershipCategory",
    label: "Membership Category",
    zpField: "Membership option: Category",
    values: ["Sport Performance and Youth Memberships", "In-Season", "Add-On"],
    complete: false,
    total: 14,
  },
};

export const VOCAB_KEYS = Object.keys(ZP_VOCAB) as VocabKey[];

/**
 * Zen Planner Prospect Status → hub lead stage key (src/lib/crm/stages.ts DEFAULT_STAGES).
 * The hub's pipeline is organised around the assessment, Zen Planner's around phone calls, so two
 * statuses share a stage. The original status is always kept on the lead (inquiry.zenplanner.prospectStatus).
 */
export const PROSPECT_STATUS_TO_STAGE: Record<string, { stage: string; why: string }> = {
  "new prospect": { stage: "new", why: "Not contacted yet." },
  "call 1": { stage: "contacted", why: "First call made." },
  "call 2": { stage: "contacted", why: "Second call made; the hub has one Contacted stage." },
  "ready to sign": { stage: "assessment_done", why: "Last open stage before Won in the hub's pipeline." },
  "not interested": { stage: "lost", why: 'Closed without a sale; the lost reason is set to "Not Interested".' },
};

const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export type VocabMatch = { value: string; known: boolean };

/** Canonical spelling when the value is on the list (case-insensitive); otherwise the value as-is, flagged unknown. */
export function matchVocab(key: VocabKey, raw: string | null | undefined, extra: string[] = []): VocabMatch | null {
  if (raw == null || !raw.trim()) return null;
  const all = [...ZP_VOCAB[key].values, ...extra];
  const hit = all.find((v) => fold(v) === fold(raw));
  return hit ? { value: hit, known: true } : { value: raw.trim(), known: false };
}

export type VocabOverrides = Partial<Record<VocabKey, string[]>>;

/** Values an owner added to a list (organizations.settings.zenplannerVocab). */
export function vocabOverridesFromSettings(settings: Record<string, unknown> | null | undefined): VocabOverrides {
  const raw = (settings?.zenplannerVocab ?? {}) as Record<string, unknown>;
  const out: VocabOverrides = {};
  for (const k of VOCAB_KEYS) if (Array.isArray(raw[k])) out[k] = (raw[k] as unknown[]).filter((x): x is string => typeof x === "string");
  return out;
}

export async function vocabOverrides(tx: Tx, orgId: string): Promise<VocabOverrides> {
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  return vocabOverridesFromSettings(o?.settings as Record<string, unknown> | null);
}

/** The effective list for the org: Zen Planner defaults first, then values an owner added. */
export function vocabList(key: VocabKey, overrides: VocabOverrides = {}): string[] {
  const out = [...ZP_VOCAB[key].values];
  for (const v of overrides[key] ?? []) if (!out.some((x) => fold(x) === fold(v))) out.push(v);
  return out;
}

/** Replace the org's extra values for one list (the Zen Planner defaults cannot be removed). Audited. */
export async function saveVocabExtras(tx: Tx, v: Viewer, key: VocabKey, values: string[]) {
  assertCan(v, "imports.manage");
  if (!VOCAB_KEYS.includes(key)) throw new Error("Unknown list");
  const defaults = ZP_VOCAB[key].values;
  const clean: string[] = [];
  for (const raw of values) {
    const s = raw.trim().slice(0, 80);
    if (!s || defaults.some((d) => fold(d) === fold(s)) || clean.some((c) => fold(c) === fold(s))) continue;
    clean.push(s);
  }
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  const settings = { ...((o?.settings ?? {}) as Record<string, unknown>) };
  const before = vocabOverridesFromSettings(settings);
  settings.zenplannerVocab = { ...before, [key]: clean.slice(0, 50) };
  await tx.update(organizations).set({ settings }).where(eq(organizations.id, v.orgId));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "zenplanner.vocab_saved", "organization", v.orgId, {
    summary: `Saved extra values for the ${ZP_VOCAB[key].label} list`,
    before: before[key] ?? [],
    after: clean,
  });
  return clean;
}
