import { defineWording } from "@/lib/sample-text";
/**
 * Wins and Competitions: labels, limits, pure text rules and caption templates. Safe to import
 * from client components (no database, no zod). See docs/modules/wins.md.
 */
import type { MarketingChannel, MarketingConsentState, TeamEventKind, TeamKind, WinStatus, WinType } from "@/db/schema/wins";

export const WIN_TYPE_LABEL: Record<WinType, string> = {
  personal_best: "Personal best",
  placing: "Win or placing",
  selection: "Selection or all-conference",
  commitment: "College commitment",
  team_championship: "Team championship",
  character: "Character and leadership",
  other: "Other",
  in_the_news: "In the news",
};

export const WIN_STATUS_LABEL: Record<WinStatus, string> = {
  awaiting_family: "Waiting for the family",
  pending: "Waiting for staff review",
  approved: "Approved",
  declined: "Declined by the family",
  removed: "Removed",
};

export const CONSENT_LABEL: Record<MarketingConsentState, string> = {
  none: "Not given",
  granted: "Given",
  declined: "Family said no",
  revoked: "Withdrawn",
};

export const CHANNEL_LABEL: Record<MarketingChannel, string> = { instagram: "Instagram", facebook: "Facebook", website: "Website", newsletter: "Newsletter", other: "Other" };
export const TEAM_KIND_LABEL: Record<TeamKind, string> = { school: "School team", club: "Club team", other: "Other" };
export const COMPETITION_KIND_LABEL: Record<TeamEventKind | "game" | "tournament", string> = { game: "Game", meet: "Meet", tournament: "Tournament" };

export const HEADLINE_MIN = 3;
export const HEADLINE_MAX = 120;
export const DETAIL_MAX = 500;
export const LEAD_NOTE_MAX = 300;
export const URL_MAX = 300;
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Sample wording, to be reviewed before real families use it. The exact text a family agreed to
 * is stored with every consent event.
 */
export const MARKETING_POLICY_VERSION = "wins-marketing-2026-1";
export const MARKETING_POLICY_TEXT =
  "SAMPLE WORDING. I agree that the gym may share this win in its public marketing, such as social media posts and its website, using the display name shown here and, if a photo was added and approved, that photo. No last name, age, school grade, health detail or contact detail is shared. I can withdraw this at any time from the Wins page, and the gym will stop using it and take down posts it controls.";

/** One plain line: control characters out, whitespace collapsed. */
export function oneLine(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Topics a win may never mention: health and injuries, body weight, school grades. This is a
 * keyword screen, not understanding; the staff approval step is the real check.
 */
const BANNED_TOPICS: { topic: string; pattern: RegExp }[] = [
  {
    topic: "health or injuries",
    pattern:
      /\b(injur\w*|concuss\w*|surger\w*|rehab\w*|acl|mcl|fractur\w*|sprain\w*|broken (arm|leg|wrist|ankle|foot|hand|collarbone|nose)|torn \w+|diagnos\w*|medical\w*|medicat\w*|illness\w*|asthma|diabet\w*|adhd|anxiety|depress\w*|therapy|therapist|doctor|hospital\w*|recover(y|ed|ing) from|cleared to play|mental health)\b/i,
  },
  { topic: "body weight", pattern: /\b(body ?weight|weigh(s|ed|ing)?|weigh-?ins?|weight class|weight loss|(cut|cutting|made|making) weight|(lost|gained|dropped) \d+ ?(lb|lbs|pounds|kg)|bmi|body fat|\d{2,3} ?(lb|lbs|pounds|kg) (class|division))\b/i },
  { topic: "school grades", pattern: /\b(gpa|grades|honor roll|report card|academic\w*|straight a'?s|test scores?|(sat|act) scores?|iep|valedictorian|dean'?s list)\b/i },
];

export function bannedTopic(text: string): string | null {
  for (const b of BANNED_TOPICS) if (b.pattern.test(text)) return b.topic;
  return null;
}

/** Whole-word, case-insensitive match of a last name (two letters or more). */
export function mentionsLastName(text: string, lastName: string | null | undefined): boolean {
  const last = (lastName ?? "").trim();
  if (last.length < 2) return false;
  const esc = last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}])${esc}([^\\p{L}]|$)`, "iu").test(text);
}

/** https only, a real host, no credentials. Returns the normalized URL or null. Never fetched. */
export function cleanSourceUrl(raw: unknown): { url: string | null; error: string | null } {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { url: null, error: null };
  if (s.length > URL_MAX) return { url: null, error: `Keep the link under ${URL_MAX} characters.` };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { url: null, error: "That does not look like a web link. Paste the full address starting with https://" };
  }
  if (u.protocol !== "https:") return { url: null, error: "Links must start with https://" };
  if (u.username || u.password) return { url: null, error: "Remove the sign-in part of the link." };
  if (!u.hostname.includes(".")) return { url: null, error: "That does not look like a web link." };
  return { url: u.toString(), error: null };
}

// ---------------------------------------------------------------------------
// Caption drafts (fixed templates, filled in locally; no AI and no outside service)
// ---------------------------------------------------------------------------

export type CaptionInput = { displayName: string; headline: string; type: WinType; sport: string; orgName: string };

const stripEnd = (s: string) => s.replace(/[.!\s]+$/, "");
const tag = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "");

const TYPE_OPENER: Record<WinType, string> = {
  personal_best: "New personal best",
  placing: "Big result",
  selection: "Honors earned",
  commitment: "Next level",
  team_championship: "Champions",
  character: "Leading the right way",
  other: "Worth celebrating",
  in_the_news: "In the news",
};

/** Three ready-to-copy drafts. Sample wording for staff to edit; display name only. */
export function captionDrafts(i: CaptionInput): { label: string; text: string }[] {
  const h = stripEnd(i.headline);
  const sportTag = tag(i.sport);
  const orgTag = tag(i.orgName);
  return [
    { label: "Short", text: `${TYPE_OPENER[i.type]}! ${i.displayName}: ${h}. Proud of you from everyone at ${i.orgName}.` },
    { label: "Work behind it", text: `${h}. ${i.displayName} has been putting in the work in ${i.sport.toLowerCase()} and it shows. Congratulations from your coaches at ${i.orgName}!` },
    { label: "With hashtags", text: `Shoutout to ${i.displayName}! ${h}. ${orgTag ? `#${orgTag}` : ""}${sportTag ? ` #${sportTag}` : ""} #AthleteWins`.replace(/\s+/g, " ").trim() },
  ];
}

// ---------------------------------------------------------------------------
// Team schedule lines
// ---------------------------------------------------------------------------

export type ParsedScheduleLine = { eventDate: string; startTimeLocal: string | null; opponent: string | null; location: string | null };

/**
 * One line per date: `YYYY-MM-DD`, then optionally a 24-hour time, an opponent and a location,
 * separated by commas. Example: `2026-11-20, 19:00, Sample Valley Hawks, Away`. Pure.
 */
export function parseScheduleLines(raw: string, maxLines = 80): { rows: ParsedScheduleLine[]; errors: string[] } {
  const rows: ParsedScheduleLine[] = [];
  const errors: string[] = [];
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > maxLines) errors.push(`Enter up to ${maxLines} dates at a time.`);
  lines.slice(0, maxLines).forEach((line, idx) => {
    const parts = line.split(",").map((p) => oneLine(p));
    const d = parts.shift() ?? "";
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;
    if (!valid) {
      errors.push(`Line ${idx + 1}: start with a date like 2026-11-20.`);
      return;
    }
    let time: string | null = null;
    if (parts.length && /^\d{1,2}:\d{2}$/.test(parts[0])) {
      const [h, m] = parts.shift()!.split(":").map(Number);
      if (h > 23 || m > 59) {
        errors.push(`Line ${idx + 1}: use a 24-hour time like 19:00.`);
        return;
      }
      time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
    const opponent = (parts.shift() ?? "").replace(/^(vs\.?|at|@)\s+/i, "").slice(0, 80) || null;
    const location = parts.join(", ").slice(0, 120) || null;
    rows.push({ eventDate: d, startTimeLocal: time, opponent, location });
  });
  return { rows, errors };
}

export const WINS_MARKETING_WORDING = defineWording({
  id: "wins_marketing_consent",
  label: "Wins marketing consent",
  version: MARKETING_POLICY_VERSION,
  isSample: true,
  shownAt: "Shown to a family before a win may be used in the gym's public marketing.",
  source: "src/lib/wins/shared.ts",
  href: "/wins/marketing",
});
