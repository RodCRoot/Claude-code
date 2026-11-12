import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db";
import { locations, organizations, products } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { addDaysYmd, DEFAULT_TZ, localDayBounds, todayLocal } from "@/lib/time";

/**
 * Owner scoreboard: shared context, the location / program filter and the SQL building blocks
 * every scoreboard number is made from. Definitions live in ./definitions.ts; each number is
 * computed in exactly one place and every tab reads it from there.
 *
 * READ-ONLY except for the settings / targets / manual entries the owner types in.
 */

export type ScoreboardFilter = { locationId: string | null; productId: string | null };

/** Thresholds are STARTING POINTS, not industry norms or Teamwork policy. Tune them on the page. */
export type ScoreboardThresholds = {
  /** A membership that starts within this many days of the same athlete's previous one ending is a plan change / rebuild, not a new sale and not a loss. */
  rebuildWindowDays: number;
  /** "Slipping" cohort: days since the last attended visit, inclusive on both ends. */
  cohortMinDays: number;
  cohortMaxDays: number;
  /** A session counts as full at or above this attended ÷ capacity percent. */
  slotFullPercent: number;
  /** A session counts as under-used below this attended ÷ capacity percent. */
  slotUnderPercent: number;
  /** "Consistently" = at least this percent of the slot's sessions in the period. */
  slotConsistencyPercent: number;
  /** Slots with fewer sessions than this in the period are never flagged. */
  slotMinSessions: number;
  /** A trial converted when a regular membership starts no later than this many days after the trial ended. */
  trialConversionDays: number;
  /** Full weeks looked at for "attending under half of the plan". */
  underuseWeeks: number;
};

export const DEFAULT_THRESHOLDS: ScoreboardThresholds = {
  rebuildWindowDays: 14,
  cohortMinDays: 10,
  cohortMaxDays: 25,
  slotFullPercent: 90,
  slotUnderPercent: 40,
  slotConsistencyPercent: 75,
  slotMinSessions: 4,
  trialConversionDays: 30,
  underuseWeeks: 4,
};

export const THRESHOLD_FIELDS: { key: keyof ScoreboardThresholds; label: string; hint: string; min: number; max: number }[] = [
  { key: "rebuildWindowDays", label: "Plan change / rebuild window (days)", hint: "A new membership this soon after the athlete's previous one ended is a plan change, not a sale or a loss.", min: 0, max: 90 },
  { key: "cohortMinDays", label: "Slipping cohort: from (days since last visit)", hint: "", min: 1, max: 60 },
  { key: "cohortMaxDays", label: "Slipping cohort: to (days since last visit)", hint: "", min: 2, max: 120 },
  { key: "slotFullPercent", label: "A session is full at (% of capacity attended)", hint: "", min: 50, max: 100 },
  { key: "slotUnderPercent", label: "A session is under-used below (% of capacity attended)", hint: "", min: 5, max: 80 },
  { key: "slotConsistencyPercent", label: "\"Consistently\" means at least (% of the slot's sessions)", hint: "", min: 50, max: 100 },
  { key: "slotMinSessions", label: "Fewest sessions before a slot is flagged", hint: "", min: 1, max: 52 },
  { key: "trialConversionDays", label: "Trial conversion window (days after the trial ends)", hint: "", min: 0, max: 120 },
  { key: "underuseWeeks", label: "Weeks looked at for \"under half of the plan\"", hint: "", min: 2, max: 12 },
];

export type ScoreboardSettings = { thresholds: ScoreboardThresholds; targets: Record<string, number> };

export function scoreboardSettingsFrom(settings: Record<string, unknown> | null | undefined): ScoreboardSettings {
  const saved = (settings?.scoreboard ?? {}) as { thresholds?: Partial<ScoreboardThresholds>; targets?: Record<string, unknown> };
  const thresholds = { ...DEFAULT_THRESHOLDS };
  for (const f of THRESHOLD_FIELDS) {
    const v = saved.thresholds?.[f.key];
    if (typeof v === "number" && Number.isInteger(v) && v >= f.min && v <= f.max) thresholds[f.key] = v;
  }
  const targets: Record<string, number> = {};
  for (const [k, v] of Object.entries(saved.targets ?? {})) if (typeof v === "number" && Number.isFinite(v) && v >= 0) targets[k] = v;
  return { thresholds, targets };
}

export type Ctx = {
  orgId: string;
  tz: string;
  currency: string;
  /** Facility-local date. */
  today: string;
  now: Date;
  filter: ScoreboardFilter;
  filtered: boolean;
  settings: ScoreboardSettings;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const parseId = (v: string | undefined | null) => (v && UUID.test(v) ? v : null);

/** Programs offered in the filter: membership and trial products of this org. */
export async function programOptions(tx: Tx, orgId: string) {
  const rows = await tx.select({ id: products.id, name: products.name, kind: products.kind, active: products.active }).from(products).where(eq(products.orgId, orgId));
  return rows.filter((p) => p.kind === "recurring_membership" || p.kind === "trial").sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the context for one request. Checks `scoreboard.view`, and drops filter ids that do not
 * belong to the viewer's organization (ids come from the query string and are never trusted).
 */
export async function scoreboardContext(tx: Tx, v: Viewer, opts: { locationId?: string | null; productId?: string | null; today?: string; now?: Date } = {}): Promise<Ctx> {
  assertCan(v, "scoreboard.view");
  const [o] = await tx.select({ settings: organizations.settings, tz: organizations.timezone, currency: organizations.currency }).from(organizations).where(eq(organizations.id, v.orgId));
  const tz = o?.tz ?? DEFAULT_TZ;
  let locationId = parseId(opts.locationId);
  let productId = parseId(opts.productId);
  if (locationId) {
    const [l] = await tx.select({ id: locations.id }).from(locations).where(and(eq(locations.id, locationId), eq(locations.orgId, v.orgId)));
    if (!l) locationId = null;
  }
  if (productId) {
    const [p] = await tx.select({ id: products.id }).from(products).where(and(eq(products.id, productId), eq(products.orgId, v.orgId)));
    if (!p) productId = null;
  }
  const now = opts.now ?? new Date();
  return {
    orgId: v.orgId,
    tz,
    currency: o?.currency ?? "USD",
    today: opts.today ?? todayLocal(tz, now),
    now,
    filter: { locationId, productId },
    filtered: !!(locationId || productId),
    settings: scoreboardSettingsFrom(o?.settings),
  };
}

// ---------------------------------------------------------------------------
// Settings writes (owner / admin; audited)
// ---------------------------------------------------------------------------

async function saveSettings(tx: Tx, v: Viewer, patch: (cur: ScoreboardSettings) => ScoreboardSettings, action: string, summary: string) {
  assertCan(v, "scoreboard.manage");
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  const before = scoreboardSettingsFrom(org.settings);
  const after = patch(before);
  await tx.update(organizations).set({ settings: { ...org.settings, scoreboard: after } }).where(eq(organizations.id, v.orgId));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, action, "organization", v.orgId, { summary, before, after });
  return after;
}

export async function saveThresholds(tx: Tx, v: Viewer, raw: Record<string, unknown>) {
  assertCan(v, "scoreboard.manage");
  const errors: Record<string, string> = {};
  const next: Partial<ScoreboardThresholds> = {};
  for (const f of THRESHOLD_FIELDS) {
    if (!(f.key in raw)) continue;
    const n = Number(String(raw[f.key]).trim());
    if (String(raw[f.key]).trim() === "" || !Number.isInteger(n)) errors[f.key] = "Enter a whole number.";
    else if (n < f.min || n > f.max) errors[f.key] = `Must be ${f.min} to ${f.max}.`;
    else next[f.key] = n;
  }
  if (Object.keys(errors).length) throw new UserError("Check the highlighted fields.", errors);
  return saveSettings(
    tx,
    v,
    (cur) => {
      const thresholds = { ...cur.thresholds, ...next };
      if (thresholds.cohortMaxDays <= thresholds.cohortMinDays) throw new UserError("The slipping cohort's end must be after its start.", { cohortMaxDays: "Must be more than the start" });
      if (thresholds.slotUnderPercent >= thresholds.slotFullPercent) throw new UserError("The under-used threshold must be below the full threshold.", { slotUnderPercent: "Must be below the full threshold" });
      return { ...cur, thresholds };
    },
    "scoreboard.thresholds_update",
    "Scoreboard thresholds saved",
  );
}

/** Save "ideal" monthly targets. A blank value clears the target for that row. Unknown row keys are rejected. */
export async function saveTargets(tx: Tx, v: Viewer, raw: Record<string, unknown>, allowedKeys: readonly string[]) {
  assertCan(v, "scoreboard.manage");
  const errors: Record<string, string> = {};
  const set: Record<string, number | null> = {};
  for (const [k, val] of Object.entries(raw)) {
    if (!k.startsWith("target_")) continue;
    const key = k.slice(7);
    if (!allowedKeys.includes(key)) continue;
    const s = String(val ?? "").trim().replace(/[$,%\s]/g, "");
    if (s === "") set[key] = null;
    else if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) > 100_000_000) errors[k] = "Enter a number (0 or more).";
    else set[key] = Number(s);
  }
  if (Object.keys(errors).length) throw new UserError("Check the highlighted targets.", errors);
  return saveSettings(
    tx,
    v,
    (cur) => {
      const targets = { ...cur.targets };
      for (const [k, n] of Object.entries(set)) {
        if (n == null) delete targets[k];
        else targets[k] = n;
      }
      return { ...cur, targets };
    },
    "scoreboard.targets_update",
    "Scoreboard ideal targets saved",
  );
}

// ---------------------------------------------------------------------------
// SQL building blocks
// ---------------------------------------------------------------------------

export type Row = Record<string, unknown>;
export const rowsOf = async <T = Row>(tx: Tx, q: SQL) => (await tx.execute(q)).rows as T[];
export const num = (v: unknown) => (v == null ? 0 : Number(v));
export const numOrNull = (v: unknown) => (v == null ? null : Number(v));
export const ymdOf = (x: unknown) => (x == null ? null : x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));

/** UTC instant where local day `ymd` ends (= the next local midnight), as ISO text for SQL. */
export const dayEnd = (c: Pick<Ctx, "tz">, ymd: string) => localDayBounds(ymd, c.tz).end.toISOString();
export const dayStart = (c: Pick<Ctx, "tz">, ymd: string) => localDayBounds(ymd, c.tz).start.toISOString();
/** The instant a day's "as of" snapshot is taken: now for today (or later), otherwise the end of that local day. */
export const cutoff = (c: Ctx, day: string) => (day >= c.today ? c.now.toISOString() : dayEnd(c, day));

export const monthStart = (ymd: string) => `${ymd.slice(0, 7)}-01`;
export function addMonths(ymd: string, n: number): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7)) - 1 + n;
  const d = new Date(Date.UTC(y + Math.floor(m / 12), ((m % 12) + 12) % 12, 1));
  return d.toISOString().slice(0, 10);
}
export const monthEnd = (ymd: string) => addDaysYmd(addMonths(monthStart(ymd), 1), -1);
export const monthLabel = (ymd: string) => new Date(`${ymd.slice(0, 7)}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/**
 * The two membership CTEs everything else reads:
 *  - `allm`: every non-pending membership of the org with its plan, its net monthly price and the
 *    day it ended (`ended_on`: end date, else for cancelled / expired the cancel date, else the
 *    day it was marked ended; the same rule as the Retention saves report).
 *  - `ms`: `allm` narrowed by the page filter. Program = the membership's product. Location = the
 *    membership's location scope (its own override, else the product's) covers the location; a
 *    scope with no locations is valid everywhere and therefore matches every location.
 * A membership is ACTIVE on day D when start_date <= D and (ended_on is null or ended_on > D).
 */
export function membershipCtes(c: Ctx): SQL {
  const f = c.filter;
  const cond: SQL[] = [];
  if (f.productId) cond.push(sql`product_id = ${f.productId}`);
  if (f.locationId) cond.push(sql`(jsonb_array_length(loc_scope) = 0 or loc_scope @> ${JSON.stringify([f.locationId])}::jsonb)`);
  const where = cond.length ? sql`where ${sql.join(cond, sql` and `)}` : sql``;
  return sql`allm as (
      select m.id, m.athlete_id, a.person_id, p.first_name || ' ' || p.last_name as name, m.payer_account_id, m.status, m.kind, m.start_date, m.end_date, m.cancel_at,
        m.billing_provider, m.provider_subscription_id, m.next_bill_date, m.created_at,
        case when m.end_date is not null then m.end_date
             when m.status in ('cancelled','expired') then coalesce(m.cancel_at, (m.updated_at at time zone ${c.tz})::date) end as ended_on,
        pr.id as product_id, pr.name as product, (pr.kind = 'trial') as trial_product, pv.trial_days,
        (m.start_date + pv.trial_days) as trial_until,
        pv.classes_per_week, pv.unlimited, pv.interval, pv.interval_count, pv.credits_per_period, pv.currency,
        coalesce(case when jsonb_typeof(m.location_ids) = 'array' then m.location_ids end, pr.location_ids, '[]'::jsonb) as loc_scope,
        (pv.price_minor - case when d.id is null or not d.active then 0
                               when d.kind = 'percent' then round(pv.price_minor * d.value / 100.0)
                               else least(d.value, pv.price_minor) end)::bigint as period_minor
      from memberships m
      join athletes a on a.id = m.athlete_id
      join people p on p.id = a.person_id
      join product_versions pv on pv.id = m.product_version_id
      join products pr on pr.id = pv.product_id
      left join discounts d on d.id = m.discount_id
      where m.org_id = ${c.orgId} and m.status <> 'pending'),
    allmx as (
      select allm.*,
        case interval when 'month' then round(period_minor::numeric / greatest(1, interval_count))
                      when 'week' then round(period_minor * 52.0 / 12 / greatest(1, interval_count))
                      when 'year' then round(period_minor / 12.0 / greatest(1, interval_count)) end::bigint as monthly_minor
      from allm),
    ms as (select * from allmx ${where})`;
}

/** Predicate: membership alias `x` is active on day `d`. */
const D = (d: string | SQL) => (typeof d === "string" ? sql`${d}::date` : d);
export const activeOn = (x: string, d: string | SQL) => sql`(${sql.raw(x)}.start_date <= ${D(d)} and (${sql.raw(x)}.ended_on is null or ${sql.raw(x)}.ended_on > ${D(d)}))`;
/** Predicate: membership alias `x` is a trial on day `d` (a trial product, or still inside the plan's trial days). */
export const trialOn = (x: string, d: string | SQL) => sql`(${sql.raw(x)}.trial_product or ${D(d)} < ${sql.raw(x)}.trial_until)`;
/** Predicate: membership alias `x` is a trial product or was sold with trial days (used for "trials sold"). */
export const isTrialPlan = (x: string) => sql`(${sql.raw(x)}.trial_product or ${sql.raw(x)}.trial_days > 0)`;

/**
 * Predicate: membership alias `x` continues an earlier membership of the same athlete (a plan
 * change or rebuild): another non-trial-product membership started before it and was still running
 * `rebuildWindowDays` before this one started. Looks at ALL memberships, not the filtered set.
 */
export const continuesEarlier = (c: Ctx, x: string) => sql`exists (
    select 1 from allmx o where o.athlete_id = ${sql.raw(x)}.athlete_id and o.id <> ${sql.raw(x)}.id and not o.trial_product
      and (o.start_date < ${sql.raw(x)}.start_date or (o.start_date = ${sql.raw(x)}.start_date and o.id < ${sql.raw(x)}.id))
      and (o.ended_on is null or o.ended_on >= ${sql.raw(x)}.start_date - ${c.settings.thresholds.rebuildWindowDays}::int))`;

/**
 * Predicate: membership alias `x`, which has ended, is continued by another membership of the same
 * athlete: one that is still running on the end day or starts within `rebuildWindowDays` after it.
 */
export const continuedLater = (c: Ctx, x: string) => sql`exists (
    select 1 from allmx o where o.athlete_id = ${sql.raw(x)}.athlete_id and o.id <> ${sql.raw(x)}.id and not o.trial_product
      and o.start_date <= ${sql.raw(x)}.ended_on + ${c.settings.thresholds.rebuildWindowDays}::int
      and (o.ended_on is null or o.ended_on > ${sql.raw(x)}.ended_on or (o.ended_on = ${sql.raw(x)}.ended_on and o.id > ${sql.raw(x)}.id)))`;

/** Session filter on alias `s` (strict location match, like the Attendance and Utilization reports). */
export const sessionLoc = (c: Ctx) => (c.filter.locationId ? sql`and s.location_id = ${c.filter.locationId}` : sql``);
/** Booking filter on aliases `b` + `s`: with a program filter, only athletes holding that program on the session's local day. */
export const bookingProgram = (c: Ctx) =>
  c.filter.productId
    ? sql`and exists (select 1 from ms where ms.athlete_id = b.athlete_id and ms.start_date <= (s.starts_at at time zone ${c.tz})::date and (ms.ended_on is null or ms.ended_on > (s.starts_at at time zone ${c.tz})::date))`
    : sql``;
/** Invoice filter on alias `i`: with any filter, only invoices tied to a membership in the filtered set. */
export const invoiceFilter = (c: Ctx) => (c.filtered ? sql`and i.membership_id in (select id from ms)` : sql``);

/** Settled money in for an invoice up to an instant. Same rule as Receivables: settled charges and manual payments only. */
export const settledBefore = (at: string) =>
  sql`coalesce((select sum(t.amount_minor) from transactions t where t.invoice_id = i.id and t.status = 'settled' and t.kind in ('charge','manual_payment') and coalesce(t.settled_at, t.occurred_at) < ${at}), 0)`;
