/**
 * The Showcase allowlist (pure; no database, no Next). This file is the single definition of what
 * a Showcase may hold and show. Anything not named here cannot be stored in a config, cannot be
 * put in the public payload, and so cannot reach the public page.
 *
 * NEVER available, whatever is posted: wellness answers or scores, body map reports, injury or
 * health intake, notes, billing, attendance details (only a 12-month count), date of birth (only
 * a graduation year or an age band), home address, account emails and phone numbers.
 */
import type { ShowcaseConfig } from "@/db/schema";

export const SHOWCASE_SHOW_KEYS = ["sport", "position", "gradYear", "school", "ageBand", "weight", "sessions", "streak", "memberSince", "relativeStrength"] as const;
export type ShowcaseShowKey = (typeof SHOWCASE_SHOW_KEYS)[number];

/** Top-level keys of a stored config. `sanitizeConfig` drops every other key. */
export const SHOWCASE_CONFIG_KEYS = ["nameDisplay", "show", "metricIds", "exerciseIds", "bio", "videoUrl", "contactEmail"] as const;

/** Show keys that display coaching data, so the editor needs training access to turn them on. */
export const TRAINING_SHOW_KEYS: ShowcaseShowKey[] = ["sessions", "streak", "relativeStrength"];

/**
 * Metric categories that may appear. Wearable (sleep, heart rate), anthropometric (body
 * composition), attendance and uncategorized metrics are never offered.
 */
export const SHOWCASE_METRIC_CATEGORIES = ["sprint", "jump", "strength", "force_plate"] as const;

/**
 * Whether a test metric may leave the coaching screens (Showcase and monthly recap). Besides the
 * category rule, left/right asymmetry measures are held back: coaches read them as an injury-risk
 * screen, so they are treated as health information here.
 */
export function isShareableMetric(m: { category: string; key?: string | null; name: string }): boolean {
  if (!(SHOWCASE_METRIC_CATEGORIES as readonly string[]).includes(m.category)) return false;
  return !/asymmetr/i.test(`${m.key ?? ""} ${m.name}`);
}

/** Names that must never appear as a key anywhere in a config or public payload (tests assert this). */
export const FORBIDDEN_KEYS = [
  "wellness", "readiness", "bodyMap", "body_map", "bodyRegion", "injury", "health", "medical", "notes", "note", "billing", "invoice", "invoices", "payment",
  "attendance", "bookings", "dateOfBirth", "date_of_birth", "dob", "birthday", "address", "phone", "email", "accountEmail", "guardian", "guardians",
] as const;

export const MAX_METRICS = 8;
export const MAX_LIFTS = 6;
export const MAX_BIO = 400;

export const SHOW_LABEL: Record<ShowcaseShowKey, string> = {
  sport: "Sport",
  position: "Position",
  gradYear: "Graduation year",
  school: "School",
  ageBand: "Age band (never a birthday)",
  weight: "Body weight",
  sessions: "Sessions in the last 12 months",
  streak: "Current weekly streak",
  memberSince: "Member since",
  relativeStrength: "Strength relative to body weight",
};

export const DEFAULT_SHOWCASE_CONFIG: ShowcaseConfig = {
  nameDisplay: "first_initial",
  show: { sport: true, position: true, gradYear: true, school: false, ageBand: false, weight: false, sessions: true, streak: false, memberSince: false, relativeStrength: false },
  metricIds: [],
  exerciseIds: [],
  bio: "",
  videoUrl: null,
  contactEmail: null,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;
const uniq = (xs: string[]) => [...new Set(xs)];
const ids = (v: unknown) => uniq((Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && UUID.test(x)));

/** Plain text only: control characters and angle brackets are removed, whitespace is collapsed. */
export function cleanPlainText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[<>]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** An https URL with a real host and no credentials. Anything else is rejected. */
export function cleanHttpsUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !u.hostname.includes(".") || u.username || u.password) return null;
  const s = u.toString();
  return s.length <= 300 ? s : null;
}

/**
 * Reads the allowlisted keys from anything, by name. Written by hand (no schema library) so this
 * file can be imported by the builder in the browser: validators that compile themselves with
 * `new Function` would trip the strict Content-Security-Policy there.
 */
function readRaw(raw: unknown) {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const show = (o.show && typeof o.show === "object" ? o.show : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    nameDisplay: (o.nameDisplay === "first" || o.nameDisplay === "full" ? o.nameDisplay : "first_initial") as ShowcaseConfig["nameDisplay"],
    show,
    metricIds: ids(o.metricIds),
    exerciseIds: ids(o.exerciseIds),
    bio: str(o.bio),
    videoUrl: str(o.videoUrl),
    contactEmail: str(o.contactEmail),
  };
}

export class ShowcaseInputError extends Error {
  constructor(
    message: string,
    public field: string,
  ) {
    super(message);
    this.name = "ShowcaseInputError";
  }
}

/**
 * Turn anything (a posted form, stored JSON) into a valid config holding ONLY allowlisted keys.
 * Unknown keys are dropped, not stored. Invalid values raise ShowcaseInputError when `strict`
 * (saving), and fall back to safe defaults otherwise (reading old rows).
 */
export function sanitizeConfig(raw: unknown, opts: { strict?: boolean } = {}): ShowcaseConfig {
  const parsed = readRaw(raw);
  const fail = (field: string, msg: string) => {
    if (opts.strict) throw new ShowcaseInputError(msg, field);
  };
  const show = Object.fromEntries(SHOWCASE_SHOW_KEYS.map((k) => [k, parsed.show[k] === true])) as ShowcaseConfig["show"];

  let bio = cleanPlainText(parsed.bio);
  if (bio.length > MAX_BIO) {
    fail("bio", `Keep the bio to ${MAX_BIO} characters or fewer.`);
    bio = bio.slice(0, MAX_BIO);
  }

  let videoUrl: string | null = null;
  if (parsed.videoUrl && parsed.videoUrl.trim()) {
    videoUrl = cleanHttpsUrl(parsed.videoUrl);
    if (!videoUrl) fail("videoUrl", "The highlight video link must start with https:// and be a full web address.");
  }

  let contactEmail: string | null = null;
  if (parsed.contactEmail && parsed.contactEmail.trim()) {
    const e = parsed.contactEmail.trim().toLowerCase();
    if (e.length <= 200 && EMAIL.test(e)) contactEmail = e;
    else fail("contactEmail", "Enter a valid contact email, or leave it blank.");
  }

  if (parsed.metricIds.length > MAX_METRICS) fail("metricIds", `Choose up to ${MAX_METRICS} test results.`);
  if (parsed.exerciseIds.length > MAX_LIFTS) fail("exerciseIds", `Choose up to ${MAX_LIFTS} lifts.`);

  return {
    nameDisplay: parsed.nameDisplay,
    show,
    metricIds: parsed.metricIds.slice(0, MAX_METRICS),
    exerciseIds: parsed.exerciseIds.slice(0, MAX_LIFTS),
    bio,
    videoUrl,
    contactEmail,
  };
}

/** Form posts arrive flat (`show.sport=on`, repeated `metricIds`). Only allowlisted names are read. */
export function configFromForm(form: Record<string, string | string[] | undefined>): unknown {
  const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  return {
    nameDisplay: one(form.nameDisplay),
    show: Object.fromEntries(SHOWCASE_SHOW_KEYS.map((k) => [k, one(form[`show.${k}`]) === "on"])),
    metricIds: list(form.metricIds),
    exerciseIds: list(form.exerciseIds),
    bio: one(form.bio),
    videoUrl: one(form.videoUrl) || null,
    contactEmail: one(form.contactEmail) || null,
  };
}

/** True when a config shows anything that needs training access to see. */
export function usesTrainingData(c: ShowcaseConfig): boolean {
  return c.metricIds.length > 0 || c.exerciseIds.length > 0 || TRAINING_SHOW_KEYS.some((k) => c.show[k]);
}

/** Stable JSON for comparing two configs and for hashing. */
export function canonicalConfig(c: ShowcaseConfig): string {
  const s = sanitizeConfig(c);
  return JSON.stringify({
    nameDisplay: s.nameDisplay,
    show: Object.fromEntries(SHOWCASE_SHOW_KEYS.map((k) => [k, s.show[k]])),
    metricIds: [...s.metricIds].sort(),
    exerciseIds: [...s.exerciseIds].sort(),
    bio: s.bio,
    videoUrl: s.videoUrl,
    contactEmail: s.contactEmail,
  });
}

/** Short human list of what a config shows (consent screen, staff list, audit summary). */
export function describeConfig(c: ShowcaseConfig, counts?: { metrics?: number; lifts?: number }): string[] {
  const out: string[] = [];
  out.push(c.nameDisplay === "full" ? "Full name" : c.nameDisplay === "first_initial" ? "First name and last initial" : "First name only");
  for (const k of SHOWCASE_SHOW_KEYS) if (c.show[k]) out.push(SHOW_LABEL[k]);
  const m = counts?.metrics ?? c.metricIds.length;
  const l = counts?.lifts ?? c.exerciseIds.length;
  if (m) out.push(`${m} test result${m === 1 ? "" : "s"}`);
  if (l) out.push(`${l} lift max${l === 1 ? "" : "es"}`);
  if (c.bio) out.push("Short bio");
  if (c.videoUrl) out.push("Highlight video link");
  if (c.contactEmail) out.push(`Contact email (${c.contactEmail})`);
  return out;
}

/**
 * SAMPLE consent wording. Teamwork should have this reviewed before production use. The exact
 * text and version are stored with every consent, so changing it only affects future consents.
 */
export const SHOWCASE_POLICY_VERSION = "showcase-2026-1";
export const SHOWCASE_POLICY_TEXT =
  `[Showcase consent ${SHOWCASE_POLICY_VERSION}] I am this athlete's parent or legal guardian, or I am the athlete and I am 18 or older. ` +
  "I agree that Teamwork may show the items listed above on a private web page that anyone with the link can open, and in a PDF I can download. " +
  "The page is not listed in search engines and has no public directory. I choose who receives the link. " +
  "I can change what is shown or turn the link off at any time, and the link stops working right away when I do. " +
  "Wellness, health, injury, billing, notes, date of birth, address and account contact details are never shown.";
