/**
 * Member journey templates (pure, no database). Stored in `organizations.settings.journey`.
 *
 * Every default below is a STARTING POINT so the checklists are useful on day one. None is a
 * Teamwork policy; the owner edits names, owners, offsets and auto-complete rules in
 * Settings > Member journey, and the page labels what is still a default.
 */
import type { JourneyKind, JourneyOwnerRole } from "@/db/schema";
import { addDaysYmd, daysBetween } from "@/lib/time";

export const JOURNEY_KIND_LABEL: Record<JourneyKind, string> = {
  onboarding: "Onboarding",
  touchpoints: "Touchpoints",
  visit_milestones: "Visit milestones",
  review_referral: "Review and referral asks",
  hold: "Hold",
  offboarding: "Offboarding",
};

export const JOURNEY_KIND_HELP: Record<JourneyKind, string> = {
  onboarding: "Starts when a membership or trial begins. Offsets count from the start date.",
  touchpoints: "Personal check-ins counted from the member's start date. A check-in that falls inside a hold moves to after the hold ends.",
  visit_milestones: "Creates a \"recognise this\" step when a member reaches a visit count. The offset is how long staff have to recognise it.",
  review_referral: "Suggested once, after a visit milestone or a 5-star session rating, and never while the member is at risk or past due. No review site is contacted.",
  hold: "Starts when a hold is recorded. Offsets count from the hold start, its midpoint or its end date.",
  offboarding: "Starts when a cancellation is processed. Offsets count from that day.",
};

/** Things the system can detect on its own. Fixed list; a step may use one or none. */
export const AUTO_RULES = {
  staff_message_sent: { label: "A staff member wrote to the family in Messages", billing: false },
  documents_signed: { label: "Every requested form is signed", billing: false },
  payment_method_on_file: { label: "Payment method on file or autopay linked", billing: true },
  first_session_booked: { label: "A session is booked", billing: false },
  first_session_attended: { label: "A session was attended", billing: false },
  coach_assigned: { label: "An assigned coach is set", billing: false },
  program_assigned: { label: "Added to a training program", billing: false },
  shoutout_posted: { label: "A coach shoutout was posted", billing: false },
  hold_reason_recorded: { label: "The hold has a reason", billing: false },
  hold_return_date_set: { label: "The hold has a return date", billing: false },
  hold_return_reminder: { label: "The restart reminder automation ran for this hold", billing: false },
  cancel_reason_recorded: { label: "A cancellation reason is recorded", billing: false },
  final_bill_settled: { label: "No open invoice is left on the membership", billing: true },
  removed_from_program_groups: { label: "No active program and no group membership", billing: false },
} as const satisfies Record<string, { label: string; billing: boolean }>;
export type AutoRule = keyof typeof AUTO_RULES;
export const AUTO_RULE_KEYS = Object.keys(AUTO_RULES) as AutoRule[];
export const isAutoRule = (x: unknown): x is AutoRule => typeof x === "string" && x in AUTO_RULES;

export const OFFSET_UNITS = ["days", "weeks", "months"] as const;
export type OffsetUnit = (typeof OFFSET_UNITS)[number];
export const ANCHORS = ["start", "midpoint", "end"] as const;
export type Anchor = (typeof ANCHORS)[number];
export const OWNER_ROLES: JourneyOwnerRole[] = ["owner", "operations", "coach"];
export const OWNER_ROLE_LABEL: Record<JourneyOwnerRole, string> = { owner: "Owner", operations: "Front desk", coach: "Coach" };

/** Where a step sends staff to do the work. Nothing is sent from the journey itself. */
export const STEP_LINKS = {
  compose: "Write a message",
  referrals: "Referral page",
  goals: "Athlete goals",
  shoutout: "Post a shoutout",
  documents: "Documents",
  billing: "Billing",
  winback: "Win-back list",
} as const;
export type StepLink = keyof typeof STEP_LINKS;

/** What completing a step asks for. Fixed per built-in step; custom steps ask for nothing. */
export type StepInput = "none" | "note" | "outcome" | "date";

export type TemplateStep = {
  key: string;
  name: string;
  ownerRole: JourneyOwnerRole;
  /** May be negative with the "end" anchor (e.g. 7 days before a hold ends). */
  offset: number;
  unit: OffsetUnit;
  anchor: Anchor;
  autoRule: AutoRule | null;
  /** Billing-related steps are never shown to coaches. Always true when the rule reads billing data. */
  billing: boolean;
  enabled: boolean;
  link: StepLink | null;
  input: StepInput;
  /** Visit milestones only. */
  visits?: number;
};

const s = (key: string, name: string, ownerRole: JourneyOwnerRole, offset: number, unit: OffsetUnit, extra: Partial<TemplateStep> = {}): TemplateStep => ({
  key,
  name,
  ownerRole,
  offset,
  unit,
  anchor: "start",
  autoRule: null,
  billing: false,
  enabled: true,
  link: null,
  input: "none",
  ...extra,
});

/** The visit counts the journey recognises. Extends the attendance-history list (10 to 500) to 1000. */
export const VISIT_MILESTONES = [10, 25, 50, 100, 250, 500, 750, 1000] as const;

export const DEFAULT_TEMPLATES: Record<JourneyKind, TemplateStep[]> = {
  onboarding: [
    s("welcome_message", "Welcome message sent", "operations", 0, "days", { autoRule: "staff_message_sent", link: "compose" }),
    s("documents_signed", "Documents signed", "operations", 2, "days", { autoRule: "documents_signed", link: "documents" }),
    s("payment_method", "Payment method on file / autopay on", "operations", 2, "days", { autoRule: "payment_method_on_file", billing: true, link: "billing" }),
    s("first_session_booked", "First session booked", "operations", 2, "days", { autoRule: "first_session_booked" }),
    s("first_session_attended", "First session attended", "coach", 7, "days", { autoRule: "first_session_attended" }),
    s("coach_assigned", "Assigned coach set", "owner", 3, "days", { autoRule: "coach_assigned" }),
    s("program_assigned", "Added to training program", "coach", 7, "days", { autoRule: "program_assigned" }),
    s("day_one_contact", "Day-one call or message logged", "coach", 0, "days", { input: "note", link: "compose" }),
    s("next_day_checkin", "Next-day check-in logged", "coach", 1, "days", { input: "note", link: "compose" }),
    s("thank_you_card", "Thank-you card sent", "operations", 7, "days"),
    s("bring_a_friend", "\"Bring a friend\" ask made", "coach", 21, "days", { link: "referrals" }),
  ],
  touchpoints: [
    s("touch_6_weeks", "6-week personal check-in", "coach", 6, "weeks", { input: "note" }),
    s("goal_review", "Goal review", "coach", 12, "weeks", { input: "note", link: "goals" }),
    s("touch_6_months", "6-month personal check-in", "coach", 6, "months", { input: "note" }),
    s("touch_12_months", "12-month personal check-in", "coach", 12, "months", { input: "note" }),
    s("touch_18_months", "18-month personal check-in", "coach", 18, "months", { input: "note" }),
    s("touch_24_months", "24-month personal check-in", "coach", 24, "months", { input: "note" }),
  ],
  visit_milestones: VISIT_MILESTONES.map((n) => s(`visits_${n}`, `Recognise ${n} visits`, "coach", 7, "days", { autoRule: "shoutout_posted", link: "shoutout", visits: n })),
  review_referral: [
    s("review_ask", "Ask for a review", "operations", 3, "days", { input: "outcome" }),
    s("referral_ask", "Ask for a referral", "coach", 3, "days", { input: "outcome", link: "referrals" }),
  ],
  hold: [
    s("hold_reason", "Hold reason recorded", "operations", 0, "days", { autoRule: "hold_reason_recorded" }),
    s("hold_return_date", "Return date set", "operations", 0, "days", { autoRule: "hold_return_date_set" }),
    s("hold_miss_you", "\"We miss you\" check-in", "coach", 0, "days", { anchor: "midpoint", input: "note", link: "compose" }),
    s("hold_return_reminder", "Return reminder before the end date", "operations", -7, "days", { anchor: "end", autoRule: "hold_return_reminder", link: "compose" }),
  ],
  offboarding: [
    s("off_reason", "Cancellation reason recorded", "operations", 0, "days", { autoRule: "cancel_reason_recorded" }),
    s("off_save_conversation", "Save conversation logged", "owner", 1, "days", { input: "note" }),
    s("off_final_bill", "Final bill settled", "operations", 7, "days", { autoRule: "final_bill_settled", billing: true, link: "billing" }),
    s("off_removed", "Removed from training program and groups", "coach", 7, "days", { autoRule: "removed_from_program_groups" }),
    s("off_thank_you", "Thank-you sent", "operations", 7, "days", { link: "compose" }),
    s("off_exit_survey", "Exit survey answered", "operations", 14, "days", { input: "note" }),
    s("off_winback", "Win-back date set", "owner", 14, "days", { input: "date", link: "winback" }),
  ],
};

export const REVIEW_OUTCOMES = { asked: "Asked", reviewed: "Left a review", referred: "Referred someone", declined: "Declined" } as const;
export type ReviewOutcome = keyof typeof REVIEW_OUTCOMES;

export type ScorecardTargets = { utilisationPercent: number; reachOuts: number; meetings: number; touchpointsOnTimePercent: number };

export type JourneySettings = {
  templates: Record<JourneyKind, TemplateStep[]>;
  /** Touchpoint steps are created this many days before they are due. */
  lookaheadDays: number;
  /** Nothing older than this is generated the first time a member is seen (no backlog of years). */
  backfillDays: number;
  /** A touchpoint that falls inside a hold moves to this many days after the hold ends. */
  holdGraceDays: number;
  /** A review ask is suggested within this many days of a positive moment. */
  positiveMomentDays: number;
  /** "Absent" follow-ups stop after this many days without a visit (the win-back list takes over). */
  absentMaxDays: number;
  targets: ScorecardTargets;
};

export const DEFAULT_TARGETS: ScorecardTargets = { utilisationPercent: 70, reachOuts: 10, meetings: 3, touchpointsOnTimePercent: 90 };
export const DEFAULT_JOURNEY_NUMBERS = { lookaheadDays: 14, backfillDays: 30, holdGraceDays: 7, positiveMomentDays: 14, absentMaxDays: 60 };

export const NUMBER_FIELDS: { key: keyof typeof DEFAULT_JOURNEY_NUMBERS; label: string; hint: string; min: number; max: number }[] = [
  { key: "lookaheadDays", label: "Create touchpoints this many days ahead", hint: "They show under Upcoming before that.", min: 0, max: 60 },
  { key: "backfillDays", label: "Do not generate anything older than (days)", hint: "Stops a backlog for long-standing members.", min: 7, max: 120 },
  { key: "holdGraceDays", label: "Days after a hold ends before a moved touchpoint is due", hint: "", min: 0, max: 60 },
  { key: "positiveMomentDays", label: "Suggest a review ask within (days) of a positive moment", hint: "", min: 1, max: 60 },
  { key: "absentMaxDays", label: "Stop listing absent members after (days)", hint: "The lower bound is the attendance gap in the membership policy.", min: 14, max: 365 },
];
export const TARGET_FIELDS: { key: keyof ScorecardTargets; label: string; min: number; max: number }[] = [
  { key: "utilisationPercent", label: "Session utilisation (%)", min: 0, max: 100 },
  { key: "reachOuts", label: "Client reach-outs logged per week", min: 0, max: 500 },
  { key: "meetings", label: "Client meetings / assessments held per week", min: 0, max: 200 },
  { key: "touchpointsOnTimePercent", label: "Touchpoints completed on time (%)", min: 0, max: 100 },
];

const int = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

export function cleanStep(raw: unknown, kind: JourneyKind): TemplateStep | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r.key === "string" && /^[a-z0-9_]{1,60}$/.test(r.key) ? r.key : null;
  const name = typeof r.name === "string" ? r.name.trim().slice(0, 120) : "";
  const offset = int(r.offset, -3650, 3650);
  if (!key || !name || offset === null) return null;
  const def = DEFAULT_TEMPLATES[kind].find((d) => d.key === key);
  const autoRule = isAutoRule(r.autoRule) ? r.autoRule : null;
  const visits = kind === "visit_milestones" ? int(r.visits, 1, 100000) : null;
  if (kind === "visit_milestones" && visits === null) return null;
  return {
    key,
    name,
    ownerRole: OWNER_ROLES.includes(r.ownerRole as JourneyOwnerRole) ? (r.ownerRole as JourneyOwnerRole) : "operations",
    offset,
    unit: OFFSET_UNITS.includes(r.unit as OffsetUnit) ? (r.unit as OffsetUnit) : "days",
    anchor: kind === "hold" && ANCHORS.includes(r.anchor as Anchor) ? (r.anchor as Anchor) : "start",
    autoRule,
    billing: r.billing === true || (autoRule ? AUTO_RULES[autoRule].billing : false),
    enabled: r.enabled !== false,
    // Link and input belong to the built-in step; a custom step has neither.
    link: def?.link ?? null,
    input: def?.input ?? "none",
    ...(visits !== null ? { visits } : {}),
  };
}

export function journeySettingsFrom(settings: Record<string, unknown> | null | undefined): JourneySettings {
  const saved = (settings?.journey ?? {}) as Record<string, unknown>;
  const savedT = (saved.templates ?? {}) as Record<string, unknown>;
  const templates = {} as Record<JourneyKind, TemplateStep[]>;
  for (const kind of Object.keys(DEFAULT_TEMPLATES) as JourneyKind[]) {
    const list = Array.isArray(savedT[kind]) ? (savedT[kind] as unknown[]).map((x) => cleanStep(x, kind)).filter((x): x is TemplateStep => !!x) : null;
    const seen = new Set<string>();
    templates[kind] = list ? list.filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true))) : DEFAULT_TEMPLATES[kind].map((x) => ({ ...x }));
  }
  const nums = { ...DEFAULT_JOURNEY_NUMBERS };
  for (const f of NUMBER_FIELDS) nums[f.key] = int(saved[f.key], f.min, f.max) ?? nums[f.key];
  const targets = { ...DEFAULT_TARGETS };
  const st = (saved.targets ?? {}) as Record<string, unknown>;
  for (const f of TARGET_FIELDS) targets[f.key] = int(st[f.key], f.min, f.max) ?? targets[f.key];
  return { templates, ...nums, targets };
}

/** True when a step is exactly the shipped default (the settings page labels these). */
export function isDefaultStep(kind: JourneyKind, step: TemplateStep): boolean {
  const d = DEFAULT_TEMPLATES[kind].find((x) => x.key === step.key);
  return !!d && d.name === step.name && d.ownerRole === step.ownerRole && d.offset === step.offset && d.unit === step.unit && d.anchor === step.anchor && d.autoRule === step.autoRule && d.billing === step.billing && d.enabled === step.enabled && d.visits === step.visits;
}

// ---------------------------------------------------------------------------
// Due-date arithmetic. Everything is a facility-local calendar date (YYYY-MM-DD).
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** Calendar months, clamped to the end of the month (Aug 31 + 6 months = Feb 28 or 29). */
export function addMonthsYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`;
}

export function addOffset(ymd: string, offset: number, unit: OffsetUnit): string {
  return unit === "months" ? addMonthsYmd(ymd, offset) : addDaysYmd(ymd, unit === "weeks" ? offset * 7 : offset);
}

/** The midpoint of a hold, rounded down (a 7-day hold starting on the 1st has its midpoint on the 4th). */
export function midpointYmd(start: string, end: string): string {
  return addDaysYmd(start, Math.floor(daysBetween(start, end) / 2));
}

/** Due date of a template step. `end` is only used by hold steps; without it every anchor is the start. */
export function stepDueOn(step: Pick<TemplateStep, "offset" | "unit" | "anchor">, start: string, end?: string | null): string {
  const base = !end || step.anchor === "start" ? start : step.anchor === "end" ? end : midpointYmd(start, end);
  return addOffset(base, step.offset, step.unit);
}

export type HoldSpan = { startDate: string; endDate: string };

/**
 * Touchpoints and holds (documented decision): tenure keeps counting through a hold, exactly as
 * membership anniversaries do, so due dates are NOT stretched by the length of a hold. But a
 * check-in that would fall while the member is on hold is pointless, so it moves to `graceDays`
 * after that hold ends (the hold checklist has its own mid-hold check-in). Back-to-back holds
 * are followed until the date lands outside every hold.
 */
export function shiftForHolds(due: string, holds: HoldSpan[], graceDays: number): string {
  let out = due;
  for (let i = 0; i <= holds.length; i++) {
    const h = holds.find((x) => x.startDate <= out && out <= x.endDate);
    if (!h) break;
    out = addDaysYmd(h.endDate, Math.max(graceDays, 1));
  }
  return out;
}

export type MembershipSpan = { id: string; startDate: string; endedOn: string | null };

/**
 * The membership that started the member's CURRENT stint. A stint breaks when more than
 * `gapDays` pass between one membership ending and the next starting, so a member who comes back
 * after months is onboarded again and their touchpoints restart, while a plan change is not.
 */
export function currentStint(ms: MembershipSpan[], today: string, gapDays = 30): MembershipSpan | null {
  const started = ms.filter((m) => m.startDate <= today).sort((a, b) => a.startDate.localeCompare(b.startDate));
  let first: MembershipSpan | null = null;
  let maxEnd: string | null = "";
  for (const m of started) {
    if (!first || (maxEnd !== null && daysBetween(maxEnd, m.startDate) > gapDays)) {
      first = m;
      maxEnd = m.endedOn;
    } else if (maxEnd !== null) {
      maxEnd = m.endedOn === null ? null : m.endedOn > maxEnd ? m.endedOn : maxEnd;
    }
  }
  return first;
}
