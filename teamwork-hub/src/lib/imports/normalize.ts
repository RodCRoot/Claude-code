import { createHash } from "node:crypto";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { FieldDef, FieldValue, MetricCell, ParsedDateTime, ParsedNumber } from "./types";

/** Source tokens that mean "no value". They become null — never 0. */
const NULL_TOKENS = new Set(["", "n/a", "na", "null", "none", "-", "—", "--", "nan", "undefined"]);

export function isNullToken(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  return NULL_TOKENS.has(String(v).trim().toLowerCase());
}

export function cleanCell(v: unknown): string | null {
  if (isNullToken(v)) return null;
  return String(v).trim();
}

// ---------------------------------------------------------------------------
// Dates & times
// ---------------------------------------------------------------------------

const pad = (n: number | string) => String(n).padStart(2, "0");

function validYmd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** "2026-07-04", "7/4/2026", "07/04/26", "7-4-2026", ISO timestamps → YYYY-MM-DD (US month-first). */
export function parseDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(t);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})(?:\s.*)?$/.exec(t);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return validYmd(y, +m[1], +m[2]);
  }
  return null;
}

/** "13:05", "1:05 PM", "1:05:30 pm" → "HH:MM:SS". */
export function parseTime(s: string): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i.exec(s.trim());
  if (!m) return null;
  let h = +m[1];
  const ampm = m[4]?.toLowerCase().replaceAll(".", "");
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === "pm" && h !== 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
  }
  if (h > 23 || +m[2] > 59 || (m[3] && +m[3] > 59)) return null;
  return `${pad(h)}:${m[2]}:${m[3] ?? "00"}`;
}

function formatOffset(o: string): string {
  if (o === "Z" || o === "z") return "Z";
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(o);
  return m ? `${m[1]}${m[2]}:${m[3] ?? "00"}` : o;
}

/**
 * Parse a local date + time in a timezone, flagging DST gaps (time does not
 * exist) and overlaps (time occurs twice). The earlier instant is used for overlaps.
 */
export function zonedLocalToInstant(ymd: string, hms: string, tz: string): { date: Date; warning?: string } {
  const local = `${ymd}T${hms}`;
  const d = fromZonedTime(local, tz);
  const back = formatInTimeZone(d, tz, "yyyy-MM-dd'T'HH:mm:ss");
  if (back !== local) return { date: d, warning: `Local time ${ymd} ${hms} does not exist in ${tz} (DST change); interpreted as ${back.replace("T", " ")}.` };
  const earlier = new Date(d.getTime() - 3_600_000);
  const later = new Date(d.getTime() + 3_600_000);
  if (formatInTimeZone(earlier, tz, "yyyy-MM-dd'T'HH:mm:ss") === local) {
    return { date: earlier, warning: `Local time ${ymd} ${hms} occurs twice in ${tz} (DST change); the first occurrence was assumed.` };
  }
  if (formatInTimeZone(later, tz, "yyyy-MM-dd'T'HH:mm:ss") === local) {
    return { date: d, warning: `Local time ${ymd} ${hms} occurs twice in ${tz} (DST change); the first occurrence was assumed.` };
  }
  return { date: d };
}

/**
 * Datetime parsing that keeps the source text verbatim. Explicit offsets are
 * honored; without one, the facility timezone is assumed (and reported).
 * Unix seconds (10 digits) and milliseconds (13 digits) are accepted (APIs).
 */
export function parseDateTime(s: string, tz: string): { value: ParsedDateTime | null; warning?: string } {
  const raw = s.trim();
  if (/^\d{10}(\.\d+)?$/.test(raw)) return { value: { iso: new Date(Number(raw) * 1000).toISOString(), raw, offset: "Z" } };
  if (/^\d{13}$/.test(raw)) return { value: { iso: new Date(Number(raw)).toISOString(), raw, offset: "Z" } };

  // ISO-ish: 2026-03-08T01:30:00-05:00 / 2026-03-08 01:30 -0500 / ...Z
  let m = /^(\d{4}-\d{1,2}-\d{1,2})[T\s]+(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\s*(Z|z|[+-]\d{2}:?\d{2}|[+-]\d{2})?$/.exec(raw);
  let ymd: string | null = null;
  let time: string | null = null;
  let offset: string | null = null;
  if (m) {
    ymd = parseDate(m[1]);
    time = parseTime(m[2].replace(/\.\d+$/, ""));
    offset = m[3] ? formatOffset(m[3]) : null;
  } else {
    // US style: 3/8/2026 1:30 AM [-05:00]
    m = /^(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(raw);
    if (m) {
      ymd = parseDate(m[1]);
      time = parseTime(m[2]);
      offset = m[3] ? formatOffset(m[3]) : null;
    } else {
      const dOnly = parseDate(raw);
      if (dOnly && !/[T\s]\d/.test(raw)) {
        const r = zonedLocalToInstant(dOnly, "00:00:00", tz);
        return { value: { iso: r.date.toISOString(), raw, offset: null, assumedTz: tz }, warning: `No time in "${raw}"; start of day in ${tz} assumed.` };
      }
    }
  }
  if (!ymd || !time) return { value: null };
  if (offset) {
    const d = new Date(`${ymd}T${time}${offset}`);
    if (Number.isNaN(d.getTime())) return { value: null };
    return { value: { iso: d.toISOString(), raw, offset } };
  }
  const r = zonedLocalToInstant(ymd, time, tz);
  return { value: { iso: r.date.toISOString(), raw, offset: null, assumedTz: tz }, warning: r.warning };
}

/** Facility-local calendar date of a parsed datetime. Uses the source offset when present. */
export function localDateOf(p: ParsedDateTime, tz: string): string {
  if (p.offset && p.offset !== "Z") {
    const m = /^(\d{4}-\d{1,2}-\d{1,2})/.exec(p.raw);
    const d = m ? parseDate(m[1]) : null;
    if (d) return d;
  }
  return formatInTimeZone(new Date(p.iso), tz, "yyyy-MM-dd");
}

// ---------------------------------------------------------------------------
// Numbers & units
// ---------------------------------------------------------------------------

/** Parses "1,234.50", "$45", "0.4312" keeping the source string. Returns undefined when not numeric. */
export function parseNumber(s: string): ParsedNumber | undefined {
  const raw = s.trim();
  const cleaned = raw.replace(/^\$/, "").replace(/,(?=\d{3}\b)/g, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(cleaned)) return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) ? { value, raw } : undefined;
}

export function decimalsOf(raw: string): number {
  const m = /\.(\d+)/.exec(raw.replace(/e[+-]?\d+$/i, ""));
  return m ? m[1].length : 0;
}

const UNIT_ALIASES: Record<string, string> = {
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb", "#": "lb",
  kg: "kg", kgs: "kg", kilogram: "kg", kilograms: "kg",
  cm: "cm", centimeter: "cm", centimeters: "cm",
  in: "in", inch: "in", inches: "in", '"': "in",
  m: "m", meter: "m", meters: "m", metre: "m", metres: "m",
  ft: "ft", feet: "ft",
  yd: "yd", yds: "yd", yards: "yd",
  s: "s", sec: "s", secs: "s", seconds: "s",
  ms: "ms", milliseconds: "ms",
  n: "N", newton: "N", newtons: "N",
  "n/kg": "N/kg",
  "n/s": "N/s",
  w: "W", watts: "W", "w/kg": "W/kg",
  "m/s": "m/s", "m/s^2": "m/s²", "m/s²": "m/s²",
  "%": "%", percent: "%",
  "n.s": "N·s", "n*s": "N·s", "n·s": "N·s",
  j: "J",
  bpm: "bpm",
  "ms rmssd": "ms",
  min: "min", mins: "min", minutes: "min",
  h: "h", hr: "h", hrs: "h", hours: "h",
  kcal: "kcal",
  steps: "steps",
  reps: "reps",
  au: "AU",
  deg: "deg", degrees: "deg",
};

/** Canonical unit, or null when unrecognized (the original is preserved by callers). */
export function canonicalUnit(u: string | null | undefined): string | null {
  if (!u) return null;
  const k = u.trim().toLowerCase();
  return UNIT_ALIASES[k] ?? null;
}

/** "Jump Height(m)", "Peak Force (N)", "Weight [kg]" → { label, unit }. */
export function splitHeaderUnit(header: string): { label: string; unit: string } | null {
  const m = /^(.*?)\s*[([]([^()[\]]{1,12})[)\]]\s*$/.exec(header.trim());
  if (!m || !m[1].trim()) return null;
  return { label: m[1].trim(), unit: m[2].trim() };
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/%/g, " pct ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

/** Build a metric cell from a "Label (unit)" header and its raw value. */
export function metricCell(header: string, rawValue: unknown): MetricCell | null {
  const split = splitHeaderUnit(header);
  if (!split) return null;
  const raw = cleanCell(rawValue);
  const unit = canonicalUnit(split.unit) ?? split.unit;
  const num = raw === null ? undefined : parseNumber(raw);
  return {
    header,
    label: split.label,
    key: `${slug(split.label)}__${slug(unit) || "unitless"}`,
    unit,
    raw,
    value: num ? num.value : null,
    decimals: raw !== null && num ? decimalsOf(raw) : null,
  };
}

// ---------------------------------------------------------------------------
// Field typing
// ---------------------------------------------------------------------------

export function typeField(def: FieldDef, rawValue: string | null, tz: string): { value: FieldValue; error?: string; warning?: string } {
  if (rawValue === null) return { value: null };
  const s = rawValue.trim();
  switch (def.type) {
    case "text":
      return { value: s };
    case "email": {
      const e = s.toLowerCase();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? { value: e } : { value: null, error: `${def.label}: "${s}" is not a valid email` };
    }
    case "date": {
      const d = parseDate(s);
      return d ? { value: d } : { value: null, error: `${def.label}: unrecognized date "${s}"` };
    }
    case "time": {
      const t = parseTime(s);
      return t ? { value: t } : { value: null, error: `${def.label}: unrecognized time "${s}"` };
    }
    case "datetime": {
      const r = parseDateTime(s, tz);
      return r.value ? { value: r.value, warning: r.warning } : { value: null, error: `${def.label}: unrecognized date/time "${s}"` };
    }
    case "number": {
      const n = parseNumber(s);
      return n ? { value: n } : { value: null, error: `${def.label}: "${s}" is not a number` };
    }
    case "integer": {
      const n = parseNumber(s);
      return n && Number.isInteger(n.value) ? { value: n } : { value: null, error: `${def.label}: "${s}" is not a whole number` };
    }
    case "boolean": {
      const b = s.toLowerCase();
      if (["true", "yes", "y", "1", "active", "x"].includes(b)) return { value: true };
      if (["false", "no", "n", "0", "inactive"].includes(b)) return { value: false };
      return { value: null, error: `${def.label}: "${s}" is not yes/no` };
    }
    case "unit": {
      const u = canonicalUnit(s);
      return u ? { value: u } : { value: s, warning: `${def.label}: unit "${s}" not recognized; kept as written` };
    }
  }
}

// ---------------------------------------------------------------------------
// Names & ids
// ---------------------------------------------------------------------------

/** "Maya Parker" → Maya / Parker; "Parker, Maya" → Maya / Parker. */
export function splitName(full: string | null): { first: string | null; last: string | null } {
  if (!full) return { first: null, last: null };
  const t = full.trim().replace(/\s+/g, " ");
  if (t.includes(",")) {
    const [last, first] = t.split(",").map((x) => x.trim());
    return { first: first || null, last: last || null };
  }
  const i = t.lastIndexOf(" ");
  if (i < 0) return { first: t, last: null };
  return { first: t.slice(0, i), last: t.slice(i + 1) };
}

/** Deterministic id for source records that have no vendor id. Org-scoped so tenants never collide. */
export function syntheticId(orgId: string, ...parts: unknown[]): string {
  return "syn:" + createHash("sha256").update([orgId, ...parts.map((p) => (p === null || p === undefined ? "" : String(p)))].join("\u0001")).digest("hex").slice(0, 32);
}

export const asText = (v: FieldValue): string | null => (v === null || v === undefined ? null : typeof v === "object" ? ("raw" in v ? v.raw : null) : String(v));
export const asNum = (v: FieldValue): ParsedNumber | null => (v && typeof v === "object" && "value" in v ? (v as ParsedNumber) : null);
export const asDT = (v: FieldValue): ParsedDateTime | null => (v && typeof v === "object" && "iso" in v ? (v as ParsedDateTime) : null);

export function ageOn(dob: string, onYmd: string): number {
  const [y, m, d] = dob.split("-").map(Number);
  const [ty, tm, td] = onYmd.split("-").map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}
