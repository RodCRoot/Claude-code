import { matchVocab, vocabList, type VocabOverrides } from "@/lib/zenplanner/vocab";

/**
 * Lead Source, Interest and Priority as lists.
 *
 * The lists are the gym's Zen Planner lists (src/lib/zenplanner/vocab.ts) plus any values an owner
 * added. New leads store the list's own spelling. Older leads stored other things in the same
 * columns (the intake channel in `source`, the sport in `interest`): those rows are never rewritten.
 * They stay valid, are shown as they are, and are grouped by the normalised value worked out here.
 */
export const OTHER = "Other";
/** Form value meaning "leave the stored value alone" (for older values that are not on the list). */
export const KEEP = "__keep__";
export const NO_SOURCE = "No source";
export const NO_INTEREST = "No interest recorded";

/** How earlier versions of the hub wrote a source. Matched after folding case, spaces and underscores. */
const LEGACY_SOURCE: Record<string, string> = {
  "web inquiry": "Website",
  web: "Website",
  "walk in": "Walk-in",
  walkin: "Walk-in",
  referral: "Referral",
  "referral link": "Referral",
  other: OTHER,
};
/** Stored values that say who typed the lead in, not where the family heard of the gym. */
const NOT_A_SOURCE = new Set(["staff", "zenplanner", "import"]);

const fold = (s: string) => s.trim().toLowerCase().replace(/[_\s]+/g, " ");
const tidy = (s: string) => {
  const t = s.trim().replace(/_/g, " ").replace(/\s+/g, " ");
  return t ? t[0].toUpperCase() + t.slice(1) : t;
};

export type Normalised = { label: string; onList: boolean };

/** The value a lead's stored source is grouped and reported under. */
export function normalizeLeadSource(raw: string | null | undefined, overrides: VocabOverrides = {}): Normalised {
  if (raw == null || !raw.trim() || NOT_A_SOURCE.has(fold(raw))) return { label: NO_SOURCE, onList: false };
  const list = vocabList("source", overrides);
  const hit = list.find((x) => fold(x) === fold(raw));
  if (hit) return { label: hit, onList: true };
  const legacy = LEGACY_SOURCE[fold(raw)];
  if (legacy) return { label: legacy, onList: true };
  return { label: tidy(raw), onList: false };
}

export function normalizeLeadInterest(raw: string | null | undefined, overrides: VocabOverrides = {}): Normalised {
  if (raw == null || !raw.trim()) return { label: NO_INTEREST, onList: false };
  const m = matchVocab("interest", raw, overrides.interest ?? []);
  return m?.known ? { label: m.value, onList: true } : { label: tidy(raw), onList: false };
}

export type LeadLists = { sources: string[]; interests: string[]; priorities: string[] };

export function leadLists(overrides: VocabOverrides = {}): LeadLists {
  return { sources: vocabList("source", overrides), interests: vocabList("interest", overrides), priorities: vocabList("priority", overrides) };
}

/**
 * A form choice checked against its list. Returns the list's spelling, or null when nothing (or
 * something not on the list) was chosen. "Other" keeps the free text beside it.
 */
export function listChoice(key: "source" | "interest" | "priority", choice: string | null | undefined, otherText: string | null | undefined, overrides: VocabOverrides = {}): { value: string | null; other: string | null } {
  const m = matchVocab(key, choice, overrides[key] ?? []);
  if (!m?.known) return { value: null, other: null };
  const other = m.value === OTHER ? (otherText ?? "").trim().slice(0, 120) || null : null;
  return { value: m.value, other };
}

/** "Other: Radio ad", "Facebook", "Walk-in" (from the legacy "walk_in"), or null when nothing is stored. */
export function sourceDisplay(raw: string | null | undefined, other: string | null | undefined, overrides: VocabOverrides = {}): string | null {
  const nrm = normalizeLeadSource(raw, overrides);
  if (nrm.label === NO_SOURCE) return null;
  return nrm.label === OTHER && other ? `${OTHER}: ${other}` : nrm.label;
}

export function interestDisplay(raw: string | null | undefined, other: string | null | undefined, overrides: VocabOverrides = {}): string | null {
  const nrm = normalizeLeadInterest(raw, overrides);
  if (nrm.label === NO_INTEREST) return null;
  return nrm.label === OTHER && other ? `${OTHER}: ${other}` : nrm.label;
}

/** The athlete's sport on a lead. Older leads kept it in `interest`; an Interest list value is not a sport. */
export function leadSport(lead: { interest: string | null; inquiry: Record<string, unknown> }, overrides: VocabOverrides = {}): string | null {
  const s = lead.inquiry?.sport;
  if (typeof s === "string" && s.trim()) return s.trim();
  if ("sport" in (lead.inquiry ?? {})) return null;
  if (!lead.interest || normalizeLeadInterest(lead.interest, overrides).onList) return null;
  return lead.interest;
}

export type Utm = { source: string | null; campaign: string | null; medium: string | null; term: string | null };
const clip = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 200) : null);

/** Tracking values from a query string or a stored lead. Null when none of the four is present. */
export function utmFrom(raw: Record<string, unknown> | null | undefined): Utm | null {
  if (!raw) return null;
  const u: Utm = {
    source: clip(raw.utm_source ?? raw.source),
    campaign: clip(raw.utm_campaign ?? raw.campaign),
    medium: clip(raw.utm_medium ?? raw.medium),
    term: clip(raw.utm_term ?? raw.term),
  };
  return u.source || u.campaign || u.medium || u.term ? u : null;
}

/** Priority on a lead: the hub's own, else the one imported from Zen Planner. */
export function leadPriority(inquiry: Record<string, unknown>): string | null {
  if (typeof inquiry.priority === "string" && inquiry.priority) return inquiry.priority;
  const zp = inquiry.zenplanner as Record<string, unknown> | undefined;
  return typeof zp?.priority === "string" && zp.priority ? zp.priority : null;
}
