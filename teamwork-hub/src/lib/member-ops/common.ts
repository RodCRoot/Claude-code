import { eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { organizations, type MemberRequestChannel, type MemberRequestStatus, type MemberRequestType } from "@/db/schema";
import { daysBetween } from "@/lib/time";

/**
 * Shared helpers for the member-operations tools (requests log, membership status page,
 * membership audit sweep). Everything here is read-only and pure where possible.
 */

export const REQUEST_TYPES: { key: MemberRequestType; label: string }[] = [
  { key: "hold", label: "Hold" },
  { key: "pause", label: "Pause" },
  { key: "cancel", label: "Cancel" },
  { key: "in_season", label: "In-season" },
  { key: "plan_change", label: "Plan change" },
  { key: "card_update", label: "Card update" },
  { key: "billing_question", label: "Billing question" },
  { key: "other", label: "Other" },
];

export const REQUEST_CHANNELS: { key: MemberRequestChannel; label: string }[] = [
  { key: "email_direct", label: "Email to memberships@" },
  { key: "email_forwarded", label: "Email forwarded by staff" },
  { key: "sms", label: "SMS / text" },
  { key: "messenger", label: "Facebook Messenger" },
  { key: "phone_ai_recap", label: "Phone (AI Call Recap email)" },
  { key: "web_form", label: "Website contact form" },
  { key: "in_app", label: "Teamwork Hub message" },
  { key: "in_person", label: "In person" },
  { key: "other", label: "Other" },
];

export const REQUEST_STATUSES: { key: MemberRequestStatus; label: string }[] = [
  { key: "new", label: "New" },
  { key: "in_progress", label: "In progress" },
  { key: "resolved", label: "Resolved" },
  { key: "declined", label: "Declined" },
  { key: "dismissed", label: "Dismissed (not a request)" },
];

export const OPEN_REQUEST_STATUSES: MemberRequestStatus[] = ["new", "in_progress"];
/** Request types that should stop or change the next bill when processed on time. */
export const BILL_AFFECTING_TYPES: MemberRequestType[] = ["hold", "pause", "cancel", "in_season", "plan_change"];

export const typeLabel = (t: string) => REQUEST_TYPES.find((x) => x.key === t)?.label ?? t;
export const channelLabel = (c: string) => REQUEST_CHANNELS.find((x) => x.key === c)?.label ?? c;

/**
 * Requests-log settings, stored in `organizations.settings.memberRequests`. These are operating
 * targets, not billing policy (billing policy lives in membership-policy.ts and is read-only here).
 */
export type MemberRequestSettings = {
  /** Same athlete + same type within this many days counts as a repeat ask. */
  repeatWindowDays: number;
  /** SLA: unprocessed for more than this many days → warning badge. */
  slaWarnDays: number;
  /** SLA: unprocessed for more than this many days → breached badge. */
  slaBreachDays: number;
  /** The audit sweep lists open requests older than this many days. */
  unprocessedAfterDays: number;
};

export const DEFAULT_REQUEST_SETTINGS: MemberRequestSettings = { repeatWindowDays: 30, slaWarnDays: 2, slaBreachDays: 5, unprocessedAfterDays: 7 };

export function requestSettingsFrom(settings: Record<string, unknown> | null | undefined): MemberRequestSettings {
  const saved = (settings?.memberRequests ?? {}) as Partial<MemberRequestSettings>;
  return { ...DEFAULT_REQUEST_SETTINGS, ...saved };
}

export async function requestSettings(tx: Tx, orgId: string): Promise<{ settings: MemberRequestSettings; tz: string }> {
  const [o] = await tx.select({ settings: organizations.settings, tz: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId));
  return { settings: requestSettingsFrom(o?.settings), tz: o?.tz ?? "America/Indiana/Indianapolis" };
}

/** Days a request has gone unprocessed: sent → resolved (if closed) or → today. */
export function daysUnprocessed(sentOn: string, closedOn: string | null, today: string): number {
  return Math.max(0, daysBetween(sentOn, closedOn ?? today));
}

export type SlaLevel = "ok" | "warn" | "breach" | "closed";
export function slaLevel(days: number, open: boolean, s: MemberRequestSettings): SlaLevel {
  if (!open) return "closed";
  if (days > s.slaBreachDays) return "breach";
  if (days > s.slaWarnDays) return "warn";
  return "ok";
}

// ---------------------------------------------------------------------------
// Plan shape helpers
// ---------------------------------------------------------------------------

export type PlanShape = {
  productName: string;
  priceMinor: number;
  interval: "none" | "week" | "month" | "year";
  intervalCount: number;
  creditsPerPeriod: number | null;
  unlimited: boolean;
  commitmentMonths: number;
};

/** Monthly-equivalent of a per-period amount (week → ×52/12, year → ÷12). Null for one-time items. */
export function monthlyEquivalent(amountMinor: number, interval: PlanShape["interval"], intervalCount: number): number | null {
  const c = Math.max(1, intervalCount);
  if (interval === "month") return Math.round(amountMinor / c);
  if (interval === "week") return Math.round((amountMinor * 52) / 12 / c);
  if (interval === "year") return Math.round(amountMinor / 12 / c);
  return null;
}

/**
 * The plan's weekly visit cap. Taken from the plan name ("2x/Week", "1x per Week") when present,
 * otherwise from credits per period (monthly credits ÷ 4, weekly credits as-is). Unlimited → null.
 */
export function weeklyCap(p: Pick<PlanShape, "productName" | "creditsPerPeriod" | "unlimited" | "interval" | "intervalCount">): number | null {
  if (p.unlimited) return null;
  const m = /(\d+)\s*x\s*(?:per|\/|a)?\s*week/i.exec(p.productName);
  if (m) return Number(m[1]);
  if (p.creditsPerPeriod == null) return null;
  if (p.interval === "week") return p.creditsPerPeriod / Math.max(1, p.intervalCount);
  if (p.interval === "month") return p.creditsPerPeriod / (4 * Math.max(1, p.intervalCount));
  return null;
}

/** In-season plans are identified by name ("In Season …"), matching Teamwork's plan naming. */
export function isInSeasonPlan(productName: string): boolean {
  return /in[\s-]?season/i.test(productName);
}

/** Whole calendar months between two dates (partial months round down), never negative. */
export function monthsBetween(fromYmd: string, toYmd: string): number {
  if (toYmd <= fromYmd) return 0;
  const [fy, fm, fd] = fromYmd.split("-").map(Number);
  const [ty, tm, td] = toYmd.split("-").map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  return Math.max(0, months);
}

/** Days of overlap between two inclusive date ranges. */
export function overlapDays(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  const s = aStart > bStart ? aStart : bStart;
  const e = aEnd < bEnd ? aEnd : bEnd;
  return e < s ? 0 : daysBetween(s, e) + 1;
}

/** Bill dates (anchored to a day of month) strictly after `afterYmd` and on/before `untilYmd`. */
export function billDatesBetween(afterYmd: string, untilYmd: string, anchorDay: number): string[] {
  const out: string[] = [];
  let y = Number(afterYmd.slice(0, 4));
  let m = Number(afterYmd.slice(5, 7));
  for (let i = 0; i < 60; i++) {
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = `${y}-${String(m).padStart(2, "0")}-${String(Math.min(anchorDay, dim)).padStart(2, "0")}`;
    if (d > untilYmd) break;
    if (d > afterYmd) out.push(d);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

const KEYWORDS: { type: MemberRequestType; re: RegExp; keyword: string }[] = [
  { type: "cancel", re: /\bcancel(?:l?ing|l?ed|lation)?\b/i, keyword: "cancel" },
  { type: "in_season", re: /\bin[\s-]?season\b/i, keyword: "in season" },
  { type: "hold", re: /\bhold(?:s|ing)?\b/i, keyword: "hold" },
  { type: "pause", re: /\bpaus(?:e|ed|ing)\b/i, keyword: "pause" },
  { type: "card_update", re: /\b(?:credit|debit|new|my|the)?\s*card\b/i, keyword: "card" },
];

/**
 * Keyword screen for family messages. Returns the most consequential match (cancel > in season >
 * hold > pause > card) or null. A match only ever produces a *suggestion* for staff to confirm.
 */
export function matchRequestKeyword(text: string): { type: MemberRequestType; keyword: string; excerpt: string } | null {
  for (const k of KEYWORDS) {
    const m = k.re.exec(text);
    if (m) {
      const start = Math.max(0, m.index - 60);
      const excerpt = `${start > 0 ? "…" : ""}${text.slice(start, m.index + m[0].length + 80).replace(/\s+/g, " ").trim()}${m.index + m[0].length + 80 < text.length ? "…" : ""}`;
      return { type: k.type, keyword: k.keyword, excerpt };
    }
  }
  return null;
}
