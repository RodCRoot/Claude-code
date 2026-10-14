/**
 * Comparability of two measurements. Pure functions only (no database, no Next).
 *
 * A trend, baseline, personal best or change % is only meaningful when the two values were
 * measured the same way. Two values are comparable only when they share the test type, the
 * protocol text, the source (vendor vs Teamwork, and the calculation version for derived values),
 * a unit that converts exactly, the aggregation level (individual trial vs vendor mean vs
 * derived), and, for metrics relative to body mass, whether body mass was known.
 *
 * Nothing here converts or merges: units are only accepted when `convertUnit` has an exact
 * factor for them, and every mismatch is returned as a reason so the UI can disclose it.
 */

import { convertUnit } from "./formulas";
import { VENDOR_LABEL } from "./labels";

export type MeasurementContext = {
  testTypeId: string | null;
  /** Protocol text of the test type (null = not recorded). */
  protocol: string | null;
  /** MetricSource of the value (e.g. "hawkin", "teamwork_manual", "teamwork_derived"). */
  source: string;
  /** Calculation version for Teamwork-derived values. */
  formulaVersion?: string | null;
  unit: string;
  /** "single" | "trial" | "vendor_mean" | "vendor_best" | "derived". */
  aggregation: string;
  /** True when the metric is expressed relative to body mass (e.g. W/kg). */
  relativeToBodyMass?: boolean;
  /** Whether the athlete's body mass was known for this measurement (null = unknown). */
  bodyMassKnown?: boolean | null;
};

export type Comparability = { comparable: boolean; reasons: string[] };

const AGGREGATION_LABEL: Record<string, string> = {
  single: "single value",
  trial: "individual trial",
  vendor_mean: "vendor mean",
  vendor_best: "vendor best",
  derived: "Teamwork-derived value",
};

const normProtocol = (p: string | null | undefined) => (p ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const sourceLabel = (s: string) => VENDOR_LABEL[s] ?? s;
const aggLabel = (a: string) => AGGREGATION_LABEL[a] ?? a;

/** Does a metric unit express a value per unit of body mass (e.g. "W/kg", "N/kg")? */
export function isRelativeToBodyMass(unit: string): boolean {
  return /\/\s*(kg|lb)\b/i.test(unit);
}

/**
 * Compare two measurement contexts. `comparable` is true only when every rule passes;
 * `reasons` lists each failing rule in plain language (empty when comparable).
 */
export function compareContexts(a: MeasurementContext, b: MeasurementContext): Comparability {
  const reasons: string[] = [];
  if ((a.testTypeId ?? null) !== (b.testTypeId ?? null)) reasons.push("Different test type.");
  const pa = normProtocol(a.protocol);
  const pb = normProtocol(b.protocol);
  if (pa !== pb) {
    const show = (p: string | null | undefined) => (p && p.trim() ? `"${p.trim()}"` : "not recorded");
    reasons.push(`Different protocol: ${show(a.protocol)} vs ${show(b.protocol)}.`);
  }
  if (a.source !== b.source) reasons.push(`Different source: ${sourceLabel(a.source)} vs ${sourceLabel(b.source)}.`);
  else if ((a.formulaVersion ?? null) !== (b.formulaVersion ?? null)) {
    reasons.push(`Different calculation version: ${a.formulaVersion ?? "none"} vs ${b.formulaVersion ?? "none"}.`);
  }
  if (a.unit !== b.unit && convertUnit(1, a.unit, b.unit) === null) reasons.push(`Units ${a.unit} and ${b.unit} cannot be converted exactly.`);
  if (a.aggregation !== b.aggregation) reasons.push(`Different aggregation level: ${aggLabel(a.aggregation)} vs ${aggLabel(b.aggregation)}.`);
  if (a.relativeToBodyMass || b.relativeToBodyMass) {
    const ka = a.bodyMassKnown === true;
    const kb = b.bodyMassKnown === true;
    if (ka !== kb) reasons.push("Body mass was known for one measurement but not the other (relative metric).");
  }
  return { comparable: reasons.length === 0, reasons };
}

export type ExclusionSummary = { reason: string; count: number };

/** Collapse a list of reasons into `{ reason, count }` rows (first-seen order). */
export function summarizeExclusions(reasons: readonly string[]): ExclusionSummary[] {
  const out = new Map<string, number>();
  for (const r of reasons) out.set(r, (out.get(r) ?? 0) + 1);
  return [...out.entries()].map(([reason, count]) => ({ reason, count }));
}
