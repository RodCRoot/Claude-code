import { defineWording } from "@/lib/sample-text";
/**
 * News watch: labels, wording, settings shape and the pure matching rules. Safe to import from
 * client components (no database). See docs/modules/newswatch.md.
 *
 * The matcher never matches a first name or a last name on its own. A headline is only ever
 * suggested for a person when their full name appears as a phrase in the headline or the feed's
 * summary, or when a news search that was asked for exactly that full name returned it.
 */
import type { NewsAudience, NewsClipStatus, NewsMatchLevel, NewsSourceKind } from "@/db/schema";
import { bannedTopic } from "@/lib/wins/shared";

export const NEWS_JOB_TYPE = "newswatch.fetch.nightly";

/** How the fetcher identifies itself. Honest and generic: it is a feed reader. */
export const NEWS_USER_AGENT = "TeamworkHub-NewsWatch/1.0 (feed reader)";

export const SOURCE_KIND_LABEL: Record<NewsSourceKind, string> = { rss: "Publisher feed (RSS or Atom)", search: "News search feed" };
export const AUDIENCE_LABEL: Record<NewsAudience, string> = { all: "Athletes and alumni", athletes: "Current athletes only", alumni: "Alumni only" };
export const CLIP_STATUS_LABEL: Record<NewsClipStatus, string> = {
  suggested: "Suggested by the matcher",
  confirmed: "Our athlete, waiting for approval",
  approved: "Approved",
  rejected: "Rejected",
  not_ours: "Not our athlete",
  ignored: "Ignored",
  withdrawn: "Closed: no longer watched",
  removed: "Taken down",
};
export const MATCH_LEVEL_LABEL: Record<NewsMatchLevel, string> = { likely: "Likely match", possible: "Possible match" };

/**
 * Sample wording, to be reviewed before real families use it. The exact text a family agreed to
 * is stored with every opt-in.
 */
export const NEWS_WATCH_POLICY_VERSION = "newswatch-optin-2026-1";
export const NEWS_WATCH_POLICY_TEXT =
  "SAMPLE WORDING. I agree that the gym may look for this athlete's full name in the headlines of local news feeds, and may send the name to a news search service to do so. When a headline looks like a match, gym staff check it. Nothing is shown until a person at the gym approves it. An approved clip shows the headline, the name of the publication, the date and a link to the public article, in the app's Wins feed and on the gym TV, under the athlete's display name. The linked article is public and may show the full name. It is never used in the gym's public marketing without a separate yes. I can switch this off at any time, which stops the search and takes down this athlete's news clips.";

export const SOURCE_NAME_MAX = 80;
export const SOURCE_URL_MAX = 400;
export const BASIS_MAX = 200;
export const NEWS_HEADLINE_MAX = 300;
export const NEWS_SNIPPET_MAX = 280;

// ---------------------------------------------------------------------------
// Settings (organizations.settings.newswatch)
// ---------------------------------------------------------------------------

export type NewsWatchSettings = {
  /** Master switch. Off: the nightly job reads nothing. */
  enabled: boolean;
  /** Most feed requests the organization makes in one day, all sources together. */
  dailyRequestCap: number;
  /** Headlines older than this are ignored. */
  maxAgeDays: number;
  /** Owner and admin can always approve clips. These add the two other staff roles. */
  operationsMayApprove: boolean;
  coachesMayApprove: boolean;
};

export const NEWS_DEFAULTS: NewsWatchSettings = { enabled: false, dailyRequestCap: 100, maxAgeDays: 30, operationsMayApprove: false, coachesMayApprove: false };
export const DAILY_CAP_MAX = 500;

export function newsSettingsOf(settings: Record<string, unknown> | null | undefined): NewsWatchSettings {
  const raw = (settings?.newswatch ?? {}) as Partial<NewsWatchSettings>;
  const int = (x: unknown, d: number, min: number, max: number) => (typeof x === "number" && Number.isInteger(x) && x >= min && x <= max ? x : d);
  return {
    enabled: raw.enabled === true,
    dailyRequestCap: int(raw.dailyRequestCap, NEWS_DEFAULTS.dailyRequestCap, 1, DAILY_CAP_MAX),
    maxAgeDays: int(raw.maxAgeDays, NEWS_DEFAULTS.maxAgeDays, 1, 365),
    operationsMayApprove: raw.operationsMayApprove === true,
    coachesMayApprove: raw.coachesMayApprove === true,
  };
}

/** The news search address used by the sample defaults. `{query}` is replaced with the search words. */
export const DEFAULT_SEARCH_TEMPLATE = "https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en";

/**
 * Sample defaults for a gym in Bloomington and Linton, Indiana. Each can be edited, switched off
 * or deleted in Settings. See docs/modules/newswatch.md for what each returned when checked.
 */
export const DEFAULT_SOURCES: { name: string; kind: NewsSourceKind; url: string; sites: string[]; minIntervalMinutes: number }[] = [
  { name: "Greene County Daily World (publisher feed)", kind: "rss", url: "https://www.suncommercial.com/search/?f=rss&t=article&c=gcdailyworld&l=50&s=start_time&sd=desc", sites: [], minIntervalMinutes: 360 },
  { name: "The Herald-Times, Bloomington (news search)", kind: "search", url: DEFAULT_SEARCH_TEMPLATE, sites: ["heraldtimesonline.com"], minIntervalMinutes: 720 },
  { name: "The Times-Mail, Bedford (news search)", kind: "search", url: DEFAULT_SEARCH_TEMPLATE, sites: ["tmnews.com"], minIntervalMinutes: 720 },
  { name: "Greene County Daily World (news search)", kind: "search", url: DEFAULT_SEARCH_TEMPLATE, sites: ["suncommercial.com"], minIntervalMinutes: 720 },
];

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Lowercase, accents removed, everything that is not a letter or digit turned into one space. */
export function normText(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Whole-phrase match on normalized text ("ann lee" does not match "joann leeds"). */
export function hasPhrase(normHaystack: string, normNeedle: string): boolean {
  if (!normNeedle) return false;
  return ` ${normHaystack} `.includes(` ${normNeedle} `);
}

/** At most `max` sentences and `maxChars` characters of plain text. */
export function clipSnippet(raw: string | null | undefined, max = 2, maxChars = NEWS_SNIPPET_MAX): string | null {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text];
  let out = sentences.slice(0, max).join("").trim();
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 3).trimEnd()}...`;
  return out || null;
}

const GENERIC_SCHOOL_WORDS = new Set(["high", "school", "schools", "junior", "senior", "middle", "university", "college", "of", "the", "at", "academy", "community", "sample", "hs", "jr", "sr"]);

/** "Fictional Falls High School" also counts when the headline only says "Fictional Falls". */
export function schoolForms(school: string | null | undefined): string[] {
  const full = normText(school);
  if (!full) return [];
  const short = full
    .split(" ")
    .filter((w) => !GENERIC_SCHOOL_WORDS.has(w))
    .join(" ");
  return [...new Set([full, short].filter((f) => f.length >= 4))];
}

/** Very common United States first names and surnames. Both common: the name alone proves little. */
const COMMON_FIRST = new Set(
  "james john robert michael william david richard joseph thomas charles christopher daniel matthew anthony mark andrew joshua ryan jacob nicholas tyler brandon justin jack luke noah liam mason ethan logan mary patricia jennifer linda elizabeth sarah jessica emily ashley emma olivia ava sophia isabella madison abigail hannah grace anna lauren megan chris mike matt nick josh alex sam ben will katie kate".split(" "),
);
const COMMON_LAST = new Set(
  "smith johnson williams brown jones garcia miller davis rodriguez martinez hernandez lopez gonzalez wilson anderson thomas taylor moore jackson martin lee perez thompson white harris sanchez clark ramirez lewis robinson walker young allen king wright scott torres nguyen hill flores green adams nelson baker hall rivera campbell mitchell carter roberts".split(" "),
);

export function isCommonName(first: string, last: string): "both" | "last" | null {
  const l = COMMON_LAST.has(normText(last));
  if (!l) return null;
  return COMMON_FIRST.has(normText(first).split(" ")[0] ?? "") ? "both" : "last";
}

// ---------------------------------------------------------------------------
// Sensitive topics
// ---------------------------------------------------------------------------

const SENSITIVE: { label: string; pattern: RegExp }[] = [
  { label: "an arrest or a crime", pattern: /\b(arrest\w*|charged with|criminal charges?|faces? charges|felony|misdemeanor|police|sheriff\w*|jail\w*|dui|owi|assault\w*|theft|robber\w*|gunfire|shots fired)\b/i },
  { label: "a court case", pattern: /\b(in court|court (case|date|hearing|records|documents|appearance)|courtroom|judge|lawsuit\w*|sued|sentenc\w*|on trial|jury|plea|pleads?|guilty|indict\w*|probation)\b/i },
  { label: "a death", pattern: /\b(dies|died|dead|death|obituar\w*|killed|fatal\w*|funeral|mourn\w*|passed away)\b/i },
  { label: "discipline", pattern: /\b(suspend\w*|suspension|expel\w*|expulsion|disciplin\w*|dismissed from|kicked off|banned|ineligible|violation\w*|hazing|misconduct)\b/i },
  { label: "a crash or an accident", pattern: /\b(crash\w*|accident\w*|wreck\w*)\b/i },
];

export type SensitiveResult = {
  /** A topic wins may never mention (health or injuries, body weight, school grades): cannot be shared. */
  blocked: string | null;
  /** A warning label staff see on the pending clip. */
  warning: string | null;
};

/**
 * A word-list screen over the headline and summary. It is not understanding: it will miss things
 * and will sometimes flag a harmless headline ("shot" in a basketball story). The person who
 * approves the clip is the real check.
 */
export function sensitiveCheck(headline: string, snippet?: string | null): SensitiveResult {
  const text = `${headline} ${snippet ?? ""}`;
  const hits = SENSITIVE.filter((s) => s.pattern.test(text)).map((s) => s.label);
  return { blocked: bannedTopic(text), warning: hits.length ? `May mention ${hits.join(", ")}` : null };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export type WatchedPerson = {
  kind: "athlete" | "alumni";
  id: string;
  firstName: string;
  preferredName?: string | null;
  lastName: string;
  /** School (athletes) or college (alumni). */
  school?: string | null;
  sport?: string | null;
  town?: string | null;
  /** Another person at this gym (member, athlete or alumnus) has the same full name. */
  sameNameInOrg: boolean;
  negatives?: { titleKeys: string[]; publications: Record<string, number>; terms: string[] };
};

export type MatchInput = {
  headline: string;
  snippet?: string | null;
  /** Normalized publication name (for "not our athlete" history). */
  publication?: string;
  titleKey?: string;
  /** True when a news search asked for exactly this person's full name returned the item. */
  searchedForThisPerson?: boolean;
};

export type MatchResult = { level: NewsMatchLevel | "unlikely"; score: number; reasons: string[] };

export const LIKELY_SCORE = 60;
export const POSSIBLE_SCORE = 30;

/** Full-name phrases for a person: "first last" and, when there is one, "preferred last". Never one name alone. */
export function fullNameForms(p: Pick<WatchedPerson, "firstName" | "preferredName" | "lastName">): string[] {
  const last = normText(p.lastName);
  if (last.length < 2) return [];
  const firsts = [normText(p.firstName), normText(p.preferredName)].filter((f) => f.length >= 2);
  return [...new Set(firsts.map((f) => `${f} ${last}`))];
}

/**
 * Score one headline against one watched person.
 *
 *   +60 full name in the headline, or +50 full name only in the feed's summary,
 *   or +30 when neither has it but a news search for exactly this name returned the item
 *   +20 the school or college is named, +10 the sport, +10 the town
 *   -30 someone else at this gym has the same name
 *   -20 a very common first and last name (-10 a very common last name)
 *   -15 for each earlier "not our athlete" from the same publication (up to -45)
 *
 * 60 or more is "likely", 30 to 59 "possible", lower is dropped. No full-name evidence at all is
 * always dropped, whatever else matches.
 */
export function scoreMatch(person: WatchedPerson, item: MatchInput): MatchResult {
  const none: MatchResult = { level: "unlikely", score: 0, reasons: [] };
  const names = fullNameForms(person);
  if (!names.length) return none;
  const head = normText(item.headline);
  const body = normText(item.snippet);
  const all = `${head} ${body}`.trim();
  const neg = person.negatives;
  if (neg && item.titleKey && neg.titleKeys.includes(item.titleKey)) return none;
  if (neg && neg.terms.some((t) => hasPhrase(all, normText(t)))) return none;

  const reasons: string[] = [];
  let score = 0;
  if (names.some((n) => hasPhrase(head, n))) {
    score += 60;
    reasons.push("The full name is in the headline.");
  } else if (names.some((n) => hasPhrase(body, n))) {
    score += 50;
    reasons.push("The full name is in the feed's summary.");
  } else if (item.searchedForThisPerson) {
    score += 30;
    reasons.push("A news search for this exact full name returned it. The name is not in the headline, so open the article to check.");
  } else {
    return none;
  }
  const school = schoolForms(person.school).find((f) => hasPhrase(all, f));
  if (school) {
    score += 20;
    reasons.push(`It also names ${person.kind === "alumni" ? "the college" : "the school"} on file.`);
  }
  const sport = normText(person.sport);
  if (sport.length >= 3 && hasPhrase(all, sport)) {
    score += 10;
    reasons.push("It also names the sport on file.");
  }
  const town = normText(person.town);
  if (town.length >= 3 && hasPhrase(all, town)) {
    score += 10;
    reasons.push("It also names the town on file.");
  }
  if (person.sameNameInOrg) {
    score -= 30;
    reasons.push("Someone else at this gym has the same name, so check carefully.");
  }
  const common = isCommonName(person.preferredName || person.firstName, person.lastName);
  if (common) {
    score -= common === "both" ? 20 : 10;
    reasons.push("This is a very common name.");
  }
  const earlier = (neg && item.publication ? neg.publications[item.publication] : 0) ?? 0;
  if (earlier > 0) {
    score -= Math.min(45, earlier * 15);
    reasons.push(`Staff said "not our athlete" ${earlier} time${earlier === 1 ? "" : "s"} before for this publication.`);
  }
  return { level: score >= LIKELY_SCORE ? "likely" : score >= POSSIBLE_SCORE ? "possible" : "unlikely", score, reasons };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameRe = (parts: string[]) => new RegExp(`(?<![\\p{L}])${parts.map(esc).join("[\\s\\u00a0]+")}(?![\\p{L}])`, "giu");

/**
 * The headline as it may be shown to other families: the person's full name (and any last name
 * left standing on its own) is replaced with `shownAs`, long dashes become plain ones, and it is
 * cut to `max` characters. Nothing else about the publication's headline is changed.
 */
export function displayHeadline(raw: string, p: { firstName: string; preferredName?: string | null; lastName: string }, shownAs: string, opts: { keepLastName?: boolean; max?: number } = {}): string {
  let h = raw.replace(/\s*[—―]\s*/g, " - ").replace(/\s--\s/g, " - ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  const firsts = [p.firstName, p.preferredName ?? ""].map((f) => f.trim()).filter(Boolean);
  const last = p.lastName.trim();
  if (last.length >= 2) {
    for (const f of firsts) h = h.replace(nameRe([...f.split(/\s+/), ...last.split(/\s+/)]), shownAs);
    if (!opts.keepLastName) h = h.replace(nameRe(last.split(/\s+/)), shownAs);
  }
  const max = opts.max ?? 120;
  if (h.length > max) h = `${h.slice(0, max - 3).trimEnd()}...`;
  return h;
}

/** How an alumnus is named to families: first name and last initial, or the full name when they agreed. */
export function alumniDisplayName(a: { firstName: string; lastName: string; fullNameOk: boolean }): string {
  const first = a.firstName.trim();
  const last = a.lastName.trim();
  if (a.fullNameOk) return `${first} ${last}`.trim();
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first;
}

export const NEWS_WATCH_WORDING = defineWording({
  id: "newswatch_optin",
  label: "News watch opt-in",
  version: NEWS_WATCH_POLICY_VERSION,
  isSample: true,
  shownAt: "Shown to a family before they switch on news watch for an athlete.",
  source: "src/lib/newswatch/shared.ts",
  href: "/settings/newswatch",
});
