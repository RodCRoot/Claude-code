/**
 * Catalog → public Showcase payload (pure; safe to import from client components).
 *
 * The CATALOG is everything about one athlete that is allowed to appear on a Showcase at all
 * (built server-side in ./catalog.ts from allowlisted columns). `composeShowcase` picks from the
 * catalog what a config turns on and returns the exact object the public page, the live preview
 * and the PDF render. It builds the output field by field, so a key that is not written here
 * cannot leave the server.
 */
import type { ShowcaseConfig } from "@/db/schema";

export type CatalogPoint = { value: number; date: string; verified: boolean };

export type CatalogMetric = {
  id: string;
  name: string;
  unit: string;
  precision: number;
  higherIsBetter: boolean | null;
  category: string;
  /** Test type name, e.g. "Hawkin CMJ". */
  testName: string;
  /** Protocol text of the test type (null = not recorded). */
  protocol: string | null;
  /** What the metric is, in plain words (metric description), when on file. */
  description: string | null;
  /** Who or what recorded it, e.g. "Hawkin Dynamics force plate" or "Teamwork coach, by hand". */
  recordedBy: string;
  latest: CatalogPoint;
  /** Best comparable result. Null when the metric has no better/worse direction. */
  best: CatalogPoint | null;
  /** Comparable results only (same test, protocol, source, unit), oldest first. */
  trend: { value: number; date: string }[];
  /** Results measured a different way that were left out of the trend. */
  notCompared: number;
};

export type CatalogLift = {
  exerciseId: string;
  name: string;
  value: number;
  unit: string;
  date: string;
  basis: "measured" | "estimated";
  /** "tested", "manual", "imported", or the estimate formula, e.g. "epley_v1". */
  method: string;
  verified: boolean;
  /** Max divided by body weight. Null when body weight is not on file or the unit is not a mass. */
  relative: number | null;
};

export type ShowcaseCatalog = {
  athlete: {
    firstName: string;
    lastName: string;
    sport: string | null;
    position: string | null;
    gradYear: number | null;
    school: string | null;
    /** e.g. "15 to 16". Never an exact age or a birthday. */
    ageBand: string | null;
    weightLb: number | null;
  };
  /** Null when the person building the Showcase may not see training data. */
  metrics: CatalogMetric[] | null;
  lifts: CatalogLift[] | null;
  consistency: { sessions12mo: number; streakWeeks: number; memberSince: string | null } | null;
};

export type ShowcaseOrg = { name: string; primaryColor: string; logoPath: string | null };

export type ShowcaseFact = { label: string; value: string };
export type ShowcaseTile = {
  id: string;
  name: string;
  unit: string;
  testName: string;
  latest: { text: string; date: string; verified: boolean };
  best: { text: string; date: string; verified: boolean } | null;
  /** Present with three or more comparable results. */
  trend: { values: number[]; firstDate: string; lastDate: string; summary: string; improving: boolean | null } | null;
};
export type ShowcaseLiftRow = { id: string; name: string; text: string; unit: string; date: string; basisLabel: string; verified: boolean; relative: string | null };
export type ShowcaseMethod = { name: string; text: string };

/** Exactly what the public page shows. Keys are asserted against the allowlist in tests. */
export type ShowcaseData = {
  displayName: string;
  headline: string | null;
  facts: ShowcaseFact[];
  bio: string | null;
  tiles: ShowcaseTile[];
  lifts: ShowcaseLiftRow[];
  consistency: ShowcaseFact[];
  videoUrl: string | null;
  contactEmail: string | null;
  methods: ShowcaseMethod[];
  org: ShowcaseOrg;
  /** Facility-local date the page was assembled. */
  asOf: string;
  inquireHref: string;
};

export const SHOWCASE_DATA_KEYS = ["displayName", "headline", "facts", "bio", "tiles", "lifts", "consistency", "videoUrl", "contactEmail", "methods", "org", "asOf", "inquireHref"] as const;

export const INQUIRE_HREF = "/inquire?ref=showcase";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-07" → "Oct 7, 2026" (no timezone math: these are facility-local calendar dates). */
export function prettyDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${MONTHS[(m || 1) - 1]} ${d}, ${y}`;
}
export function prettyMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[(m || 1) - 1]} ${y}`;
}

export function formatValue(v: number, precision: number): string {
  const p = Math.max(0, Math.min(4, precision));
  return v.toFixed(p);
}

const trimNum = (v: number, digits: number) => String(Number(v.toFixed(digits)));

export function displayName(a: { firstName: string; lastName: string }, mode: ShowcaseConfig["nameDisplay"]): string {
  const first = a.firstName.trim();
  const last = a.lastName.trim();
  if (mode === "full" && last) return `${first} ${last}`;
  if (mode === "first_initial" && last) return `${first} ${last[0].toUpperCase()}.`;
  return first;
}

function trendOf(m: CatalogMetric): ShowcaseTile["trend"] {
  if (m.trend.length < 3) return null;
  const first = m.trend[0];
  const last = m.trend[m.trend.length - 1];
  const delta = last.value - first.value;
  const improving = m.higherIsBetter === null || delta === 0 ? null : m.higherIsBetter ? delta > 0 : delta < 0;
  const size = `${formatValue(Math.abs(delta), m.precision)} ${m.unit}`;
  const word = delta === 0 ? "No change" : m.higherIsBetter === null ? (delta > 0 ? `Up ${size}` : `Down ${size}`) : improving ? `Improved by ${size}` : `Changed by ${size}`;
  return {
    values: m.trend.map((p) => p.value),
    firstDate: first.date,
    lastDate: last.date,
    summary: `${word} across ${m.trend.length} tests, ${prettyDate(first.date)} to ${prettyDate(last.date)}`,
    improving,
  };
}

function methodsFor(metrics: CatalogMetric[], lifts: CatalogLift[], cfg: ShowcaseConfig, orgName: string): ShowcaseMethod[] {
  const out: ShowcaseMethod[] = [];
  for (const m of metrics) {
    const parts = [
      m.description,
      `Test: ${m.testName}.`,
      m.protocol ? `Protocol: ${m.protocol}` : null,
      `Recorded by: ${m.recordedBy}.`,
      m.higherIsBetter === null ? null : m.higherIsBetter ? "Higher is better." : "Lower is better.",
      m.notCompared > 0 ? `${m.notCompared} earlier result${m.notCompared === 1 ? " was" : "s were"} measured a different way and left out.` : null,
    ].filter(Boolean);
    out.push({ name: m.name, text: parts.join(" ") });
  }
  if (lifts.some((l) => l.basis === "measured")) out.push({ name: "Measured max", text: `The heaviest load lifted for one full repetition, tested or entered by ${orgName} coaching staff on the date shown.` });
  if (lifts.some((l) => l.basis === "estimated")) out.push({ name: "Estimated max", text: "A one-rep max estimated from a heavier set of several reps using a named formula. It is an estimate, not a tested lift, and is labelled that way." });
  if (cfg.show.relativeStrength && lifts.some((l) => l.relative !== null)) out.push({ name: "x body weight", text: "The max divided by the athlete's body weight on file." });
  if (cfg.show.sessions) out.push({ name: "Sessions", text: `Coached sessions at ${orgName} marked attended in the last 12 months.` });
  if (cfg.show.streak) out.push({ name: "Weekly streak", text: "Weeks in a row with at least one attended session or completed workout." });
  return out;
}

export function composeShowcase(catalog: ShowcaseCatalog, cfg: ShowcaseConfig, org: ShowcaseOrg, asOf: string): ShowcaseData {
  const a = catalog.athlete;
  const facts: ShowcaseFact[] = [];
  if (cfg.show.sport && a.sport) facts.push({ label: "Sport", value: a.sport });
  if (cfg.show.position && a.position) facts.push({ label: "Position", value: a.position });
  if (cfg.show.gradYear && a.gradYear) facts.push({ label: "Class of", value: String(a.gradYear) });
  if (cfg.show.school && a.school) facts.push({ label: "School", value: a.school });
  if (cfg.show.ageBand && a.ageBand) facts.push({ label: "Age", value: a.ageBand });
  if (cfg.show.weight && a.weightLb !== null) facts.push({ label: "Weight", value: `${Math.round(a.weightLb)} lb` });

  const chosenMetrics = cfg.metricIds.map((id) => (catalog.metrics ?? []).find((m) => m.id === id)).filter((m): m is CatalogMetric => !!m);
  const chosenLifts = cfg.exerciseIds.map((id) => (catalog.lifts ?? []).find((l) => l.exerciseId === id)).filter((l): l is CatalogLift => !!l);

  const tiles: ShowcaseTile[] = chosenMetrics.map((m) => ({
    id: m.id,
    name: m.name,
    unit: m.unit,
    testName: m.testName,
    latest: { text: formatValue(m.latest.value, m.precision), date: m.latest.date, verified: m.latest.verified },
    best: m.best ? { text: formatValue(m.best.value, m.precision), date: m.best.date, verified: m.best.verified } : null,
    trend: trendOf(m),
  }));

  const lifts: ShowcaseLiftRow[] = chosenLifts.map((l) => ({
    id: l.exerciseId,
    name: l.name,
    text: trimNum(l.value, 1),
    unit: l.unit,
    date: l.date,
    basisLabel: l.basis === "measured" ? "Measured" : `Estimated (${l.method.replace(/_v\d+$/, "")})`,
    verified: l.verified,
    relative: cfg.show.relativeStrength && l.relative !== null ? `${l.relative.toFixed(2)} x body weight` : null,
  }));

  const consistency: ShowcaseFact[] = [];
  if (catalog.consistency) {
    const c = catalog.consistency;
    if (cfg.show.sessions) consistency.push({ label: "Sessions, last 12 months", value: String(c.sessions12mo) });
    if (cfg.show.streak) consistency.push({ label: "Weekly streak", value: `${c.streakWeeks} week${c.streakWeeks === 1 ? "" : "s"}` });
    if (cfg.show.memberSince && c.memberSince) consistency.push({ label: `Training at ${org.name} since`, value: prettyMonth(c.memberSince) });
  }

  const headline = [cfg.show.sport ? a.sport : null, cfg.show.position ? a.position : null, cfg.show.gradYear && a.gradYear ? `Class of ${a.gradYear}` : null].filter(Boolean).join(" · ") || null;

  return {
    displayName: displayName(a, cfg.nameDisplay),
    headline,
    facts,
    bio: cfg.bio || null,
    tiles,
    lifts,
    consistency,
    videoUrl: cfg.videoUrl,
    contactEmail: cfg.contactEmail,
    methods: methodsFor(chosenMetrics, chosenLifts, cfg, org.name),
    org,
    asOf,
    inquireHref: INQUIRE_HREF,
  };
}

/** Points for an SVG sparkline polyline in a `w` by `h` box (pure). */
export function sparklinePoints(values: number[], w: number, h: number, pad = 3): { x: number; y: number }[] {
  if (values.length < 2) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values.map((v, i) => ({
    x: Number((pad + (i * (w - 2 * pad)) / (values.length - 1)).toFixed(2)),
    y: Number((h - pad - ((v - min) / span) * (h - 2 * pad)).toFixed(2)),
  }));
}
