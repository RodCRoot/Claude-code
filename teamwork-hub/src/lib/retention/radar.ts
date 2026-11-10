import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db";
import type { MembershipStatus } from "@/db/schema";
import { accessibleAthleteIds, assertCan, can, type Viewer } from "@/lib/authz/policy";
import { monthlyEquivalent } from "@/lib/member-ops/common";
import { typeLabel } from "@/lib/member-ops/common";
import { policyFromSettings, type MembershipPolicy } from "@/lib/membership-policy";
import { percentOf } from "@/lib/money";
import { addDaysYmd, daysBetween, localDayBounds, localYmd, todayLocal } from "@/lib/time";
import { BILLING_SIGNALS, retentionContext, SIGNALS, tenureMonths, type RetentionSettings, type RiskLevel, type SignalKey } from "./common";

/**
 * Retention radar: a transparent, rule-based risk level for every active member.
 *
 * READ-ONLY: nothing in this file writes. Every signal is a documented rule with a configurable
 * threshold and carries the evidence that triggered it (docs/modules/retention.md). There is no
 * score and no model. Health / wellness data is never read here.
 */

export type Signal = { key: SignalKey; label: string; evidence: string; weight: "high" | "medium"; /** Where staff can read more (only set when the viewer may open it). */ href?: string };

export type RadarRow = {
  athleteId: string;
  personId: string;
  name: string;
  /** "parent" when the athlete has an active guardian, else "athlete" (adult). */
  contact: "parent" | "athlete";
  plan: string;
  planStatus: MembershipStatus;
  membershipId: string;
  /** ESTIMATE: the primary plan's monthly-equivalent price after discounts. Null when unknown or the viewer has no billing access. */
  valueAtRiskMinor: number | null;
  currency: string;
  level: RiskLevel;
  signals: Signal[];
  lastContact: { kind: "message" | "task" | "outcome"; at: Date; label: string } | null;
  recommendation: { key: string; label: string };
  memberSince: string;
  tenureMonths: number;
  coaches: { id: string; name: string }[];
  lastOutcome: { outcome: string; at: Date } | null;
};

export type RadarSummary = {
  members: number;
  atRisk: number;
  watch: number;
  /** Sum of the estimates for at-risk members; null without billing access. */
  revenueAtRiskMinor: number | null;
  savesThisMonth: number;
  avgTenureMonths: number | null;
  currency: string;
};

export type RadarResult = { rows: RadarRow[]; summary: RadarSummary; settings: RetentionSettings; policy: MembershipPolicy; today: string; tz: string; showBilling: boolean };

const LIVE: MembershipStatus[] = ["trialing", "active", "on_hold", "past_due"];
const ymd = (x: unknown) => (x == null ? null : x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));
const rowsOf = async <T>(tx: Tx, q: SQL) => (await tx.execute(q)).rows as T[];
const inList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}`), sql`, `);
const day = (d: string) => {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd, 12)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

type MFact = {
  id: string;
  athleteId: string;
  status: MembershipStatus;
  kind: string;
  startDate: string;
  endDate: string | null;
  cancelAt: string | null;
  commitmentEndsOn: string | null;
  payerAccountId: string | null;
  productName: string;
  classesPerWeek: number | null;
  monthlyMinor: number | null;
  currency: string;
};

export type AthleteFacts = {
  athleteId: string;
  personId: string;
  name: string;
  hasGuardian: boolean;
  memberships: MFact[];
  holds: { membershipId: string; startDate: string; endDate: string; kind: string }[];
  firstStart: string;
  /** Local dates of attended sessions in the loaded look-back. */
  visitDays: string[];
  lastVisit: string | null;
  /** Resolved bookings (attended / no_show / late_cancelled) with the session's local date. */
  outcomes: { day: string; status: string }[];
  upcoming: number;
  payment: { failedCount: number; lastFailed: string; reason: string | null } | null;
  pastDueInvoices: { count: number; oldestDue: string } | null;
  card: { brand: string | null; last4: string | null; expMonth: number; expYear: number } | null;
  requests: { type: string; sentOn: string }[];
  feedback: { id: string; rating: number; hasComment: boolean; day: string; tellCoach: boolean }[];
  missingForms: string | null;
};

const lastDayOfMonth = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;

/**
 * Pure rule evaluation over one athlete's facts. Exported for tests and for the docs to point at:
 * each block below is one documented signal.
 */
export function evaluateSignals(f: AthleteFacts, s: RetentionSettings, policy: Pick<MembershipPolicy, "attendanceGapDays">, today: string, opts: { billing: boolean; allFeedback: boolean }): Signal[] {
  const out: Signal[] = [];
  const add = (key: SignalKey, evidence: string) => out.push({ key, label: SIGNALS[key].label, weight: SIGNALS[key].weight, evidence });
  const holdToday = (m: MFact) => m.status === "on_hold" || f.holds.some((h) => h.membershipId === m.id && h.startDate <= today && h.endDate >= today);
  // Paused = every live membership is on hold today. Attendance rules do not apply while paused.
  const paused = f.memberships.every(holdToday);
  const visits = [...f.visitDays].sort();
  const tenureDays = daysBetween(f.firstStart, today);

  // --- Hold just ended and not back yet / days since last visit ------------------------
  const endedHolds = f.holds.filter((h) => h.endDate < today).map((h) => h.endDate).sort();
  const lastHoldEnd = endedHolds.length ? endedHolds[endedHolds.length - 1] : null;
  const backSinceHold = lastHoldEnd ? f.lastVisit != null && f.lastVisit > lastHoldEnd : true;
  const recentRestart = !paused && lastHoldEnd != null && daysBetween(lastHoldEnd, today) <= s.holdRestartDays && !backSinceHold;
  if (recentRestart) add("hold_restart", `Hold ended ${day(lastHoldEnd!)} (${plural(daysBetween(lastHoldEnd!, today), "day")} ago) and no visit since.`);
  if (!paused && !recentRestart) {
    // Time on hold never counts as absence: the clock starts at the later of last visit / hold end / join date.
    const ref = [f.lastVisit, lastHoldEnd, f.lastVisit ? null : f.firstStart].filter((x): x is string => !!x).sort().pop()!;
    const gap = daysBetween(ref, today);
    if (gap >= policy.attendanceGapDays) {
      add(
        "attendance_gap",
        f.lastVisit
          ? `Last visit ${day(f.lastVisit)}: ${gap} days ago${ref !== f.lastVisit ? " not counting time on hold" : ""} (threshold ${policy.attendanceGapDays} days).`
          : `No visits recorded since joining ${day(f.firstStart)} (${gap} days, threshold ${policy.attendanceGapDays}).`,
      );
    }
  }

  // --- Attendance drop vs the athlete's own baseline -----------------------------------
  const recentFrom = addDaysYmd(today, -s.attendanceWindowDays);
  const baseFrom = addDaysYmd(recentFrom, -s.baselineWindowDays);
  const holdInWindows = f.holds.some((h) => h.endDate >= baseFrom && h.startDate <= today);
  if (!paused && !holdInWindows) {
    const recent = visits.filter((d) => d > recentFrom && d <= today).length;
    const base = visits.filter((d) => d > baseFrom && d <= recentFrom).length;
    const recentRate = recent / (s.attendanceWindowDays / 7);
    const baseRate = base / (s.baselineWindowDays / 7);
    if (base >= s.minBaselineVisits && recentRate <= baseRate * (1 - s.attendanceDropPercent / 100)) {
      const pct = Math.round((1 - recentRate / baseRate) * 100);
      add(
        "attendance_drop",
        `${plural(recent, "visit")} in the last ${s.attendanceWindowDays} days (${recentRate.toFixed(1)}/week) vs ${base} in the ${s.baselineWindowDays} days before (${baseRate.toFixed(1)}/week): down ${pct}% (threshold ${s.attendanceDropPercent}%).`,
      );
    }
  }

  // --- No-show / late-cancel rate rising ------------------------------------------------
  {
    const from = addDaysYmd(today, -s.noShowWindowDays);
    const prevFrom = addDaysYmd(from, -s.noShowWindowDays);
    const cur = f.outcomes.filter((o) => o.day > from && o.day <= today);
    const prev = f.outcomes.filter((o) => o.day > prevFrom && o.day <= from);
    const miss = (xs: typeof cur) => xs.filter((o) => o.status !== "attended").length;
    const rate = cur.length ? miss(cur) / cur.length : 0;
    const prevRate = prev.length ? miss(prev) / prev.length : 0;
    if (miss(cur) >= s.noShowMinMisses && rate * 100 >= s.noShowRatePercent && rate > prevRate) {
      add(
        "no_show_rate",
        `${miss(cur)} of ${plural(cur.length, "booking")} in the last ${s.noShowWindowDays} days were no-shows or late cancels (${Math.round(rate * 100)}%), up from ${prev.length ? `${Math.round(prevRate * 100)}% (${miss(prev)} of ${prev.length})` : "none"} in the ${s.noShowWindowDays} days before.`,
      );
    }
  }

  // --- No upcoming bookings ---------------------------------------------------------------
  if (!paused && f.upcoming === 0) add("no_upcoming", `Nothing booked in the next ${s.upcomingLookaheadDays} days.`);

  // --- Failed / past-due payment; card needs updating (billing access only) --------------
  if (opts.billing) {
    const pastDue = f.memberships.some((m) => m.status === "past_due");
    if (f.payment || f.pastDueInvoices || pastDue) {
      const parts: string[] = [];
      if (f.payment) parts.push(`${plural(f.payment.failedCount, "failed payment")} (latest ${day(f.payment.lastFailed)}${f.payment.reason ? `: ${f.payment.reason}` : ""}) with no successful payment since`);
      if (f.pastDueInvoices) parts.push(`${plural(f.pastDueInvoices.count, "open invoice")} past due since ${day(f.pastDueInvoices.oldestDue)}`);
      else if (pastDue) parts.push("membership is marked past due");
      add("payment_failed", `${parts.join("; ")}.`.replace(/^./, (c) => c.toUpperCase()));
    }
    if (f.card) {
      const exp = lastDayOfMonth(f.card.expYear, f.card.expMonth);
      const left = daysBetween(today, exp);
      if (left <= s.cardExpiryDays) {
        const which = `${f.card.brand ?? "Card"}${f.card.last4 ? ` ending ${f.card.last4}` : ""}`;
        add("card_expiring", left < 0 ? `${which} expired ${String(f.card.expMonth).padStart(2, "0")}/${f.card.expYear}.` : `${which} expires ${String(f.card.expMonth).padStart(2, "0")}/${f.card.expYear} (in ${plural(left, "day")}, threshold ${s.cardExpiryDays}).`);
      }
    }
  }

  // --- Hold ending soon -------------------------------------------------------------------
  const currentHolds = f.holds.filter((h) => h.kind !== "in_season" && h.startDate <= today && h.endDate >= today).sort((a, b) => a.endDate.localeCompare(b.endDate));
  if (currentHolds.length) {
    const h = currentHolds[currentHolds.length - 1];
    const left = daysBetween(today, h.endDate);
    if (left <= s.holdEndingDays) add("hold_ending", `Hold ends ${day(h.endDate)} (in ${plural(left, "day")}, threshold ${s.holdEndingDays}).${f.upcoming === 0 ? " Nothing booked for the restart yet." : ""}`);
  }

  // --- Commitment ending -------------------------------------------------------------------
  for (const m of f.memberships) {
    if (m.commitmentEndsOn && m.commitmentEndsOn >= today && daysBetween(today, m.commitmentEndsOn) <= s.commitmentEndingDays) {
      add("commitment_ending", `Commitment on ${m.productName} ends ${day(m.commitmentEndsOn)} (in ${plural(daysBetween(today, m.commitmentEndsOn), "day")}, threshold ${s.commitmentEndingDays}).`);
      break;
    }
  }

  // --- In Season term ending ---------------------------------------------------------------
  {
    const terms = [
      ...f.memberships.filter((m) => m.kind === "in_season" && m.endDate).map((m) => m.endDate!),
      ...f.holds.filter((h) => h.kind === "in_season" && h.startDate <= today).map((h) => h.endDate),
    ].filter((e) => e >= today && daysBetween(today, e) <= s.inSeasonEndingDays).sort();
    if (terms.length) add("in_season_ending", `In Season term ends ${day(terms[0])} (in ${plural(daysBetween(today, terms[0]), "day")}, threshold ${s.inSeasonEndingDays}).`);
  }

  // --- Open member request / cancel requested ---------------------------------------------
  {
    const cancelReq = f.requests.filter((r) => r.type === "cancel");
    // In Season plans are fixed-term (cancel_at is always set), so only a regular plan's cancel date counts.
    const scheduled = f.memberships.find((m) => m.kind !== "in_season" && m.cancelAt && m.cancelAt >= today);
    if (cancelReq.length || scheduled) {
      const parts: string[] = [];
      if (cancelReq.length) parts.push(`Cancel request sent ${day(cancelReq[0].sentOn)} is still open`);
      if (scheduled) parts.push(`${cancelReq.length ? "c" : "C"}ancellation of ${scheduled.productName} is scheduled for ${day(scheduled.cancelAt!)}`);
      add("cancel_requested", `${parts.join("; ")}.`);
    }
    const other = f.requests.filter((r) => r.type !== "cancel");
    if (other.length) add("open_request", `${typeLabel(other[0].type)} request sent ${day(other[0].sentOn)} is unresolved (${plural(daysBetween(other[0].sentOn, today), "day")})${other.length > 1 ? `, plus ${other.length - 1} more` : ""}.`);
  }

  // --- Low session feedback / negative comment (comment text is never shown here) ---------
  {
    const seen = f.feedback.filter((x) => opts.allFeedback || x.tellCoach);
    const low = seen.filter((x) => x.rating <= s.lowRatingThreshold || (x.hasComment && x.rating <= s.negativeCommentMaxRating)).sort((a, b) => b.day.localeCompare(a.day));
    if (low.length) {
      const x = low[0];
      add("low_feedback", `Rated a session ${x.rating} of 5 on ${day(x.day)}${x.hasComment ? " and left a comment" : ""}${low.length > 1 ? ` (${low.length} low ratings in ${s.feedbackLookbackDays} days)` : ""}.`);
      out[out.length - 1].href = `/people/retention/feedback/${x.id}`;
    }
  }

  // --- Onboarding: new member with fewer visits than expected ------------------------------
  if (!paused && tenureDays >= 14 && tenureDays <= 90 && !f.holds.some((h) => h.startDate >= f.firstStart)) {
    const checkpoint = tenureDays >= 90 ? 90 : tenureDays >= 60 ? 60 : tenureDays >= 30 ? 30 : tenureDays;
    const target = checkpoint === 90 ? s.onboardingVisits90 : checkpoint === 60 ? s.onboardingVisits60 : checkpoint === 30 ? s.onboardingVisits30 : Math.floor((s.onboardingVisits30 * checkpoint) / 30);
    const cap = Math.max(...f.memberships.map((m) => m.classesPerWeek ?? Infinity));
    const expected = Math.min(target, Number.isFinite(cap) ? cap * Math.floor(checkpoint / 7) : target);
    const until = addDaysYmd(f.firstStart, checkpoint);
    const got = visits.filter((d) => d >= f.firstStart && d <= until).length;
    if (expected > 0 && got < expected) add("onboarding", `New member (day ${tenureDays}): ${plural(got, "visit")} in the first ${checkpoint} days, expected at least ${expected}.`);
  }

  // --- Missing required forms blocking booking ---------------------------------------------
  if (f.missingForms) add("missing_forms", `Required form not completed, so booking is blocked: ${f.missingForms}.`);

  return out;
}

/** Any high-weight signal, or `signalsForAtRisk` signals together → at risk; one or more → watch; none → low. */
export function levelFor(signals: Signal[], s: Pick<RetentionSettings, "signalsForAtRisk">): RiskLevel {
  if (signals.some((x) => x.weight === "high") || signals.length >= s.signalsForAtRisk) return "at_risk";
  return signals.length ? "watch" : "low";
}

const RECOMMEND: [SignalKey[], string, (who: string) => string][] = [
  [["cancel_requested"], "call", (w) => `Call the ${w} about the cancellation before it takes effect`],
  [["payment_failed", "card_expiring"], "card_update_request", () => "Send a card update request"],
  [["open_request"], "resolve_request", (w) => `Resolve the open request and tell the ${w} what was done`],
  [["low_feedback"], "call", (w) => `Call the ${w} to follow up on session feedback`],
  [["attendance_gap", "attendance_drop", "no_show_rate"], "offer_makeup", (w) => `Call the ${w} and offer a makeup session`],
  [["hold_ending", "hold_restart"], "book_restart", (w) => `Confirm the restart with the ${w} and book the first session back`],
  [["commitment_ending", "in_season_ending"], "goal_review", () => "Schedule a goal review before the term ends"],
  [["onboarding"], "goal_review", () => "Onboarding check-in: schedule a goal review"],
  [["missing_forms"], "forms", (w) => `Ask the ${w} to complete the required form`],
  [["no_upcoming"], "book", (w) => `Help the ${w} book the next sessions`],
];

export function recommendationFor(signals: Signal[], contact: "parent" | "athlete"): { key: string; label: string } {
  for (const [keys, key, label] of RECOMMEND) if (signals.some((x) => keys.includes(x.key))) return { key, label: label(contact) };
  return { key: "none", label: "No action needed" };
}

/** Athlete ids the viewer may see on the radar ("all" for org-wide staff). */
export async function radarScope(tx: Tx, v: Viewer): Promise<string[] | "all"> {
  assertCan(v, "retention.view");
  return accessibleAthleteIds(tx, v, "profile.read");
}

async function loadFacts(tx: Tx, orgId: string, today: string, tz: string, s: RetentionSettings, scope: string[] | "all"): Promise<AthleteFacts[]> {
  if (scope !== "all" && !scope.length) return [];
  const sc = (col: SQL) => (scope === "all" ? sql`` : sql`and ${col} in (${inList(scope)})`);
  const mRaw = await rowsOf<Record<string, unknown>>(
    tx,
    sql`select m.id, m.athlete_id, a.person_id, p.first_name || ' ' || p.last_name as name, m.status, m.kind, m.start_date, m.end_date, m.cancel_at,
          m.commitment_ends_on, m.payer_account_id, pr.name as product_name, pv.price_minor, pv.currency, pv.interval, pv.interval_count, pv.classes_per_week,
          d.kind as discount_kind, d.value as discount_value, d.active as discount_active,
          exists (select 1 from guardianships g where g.athlete_id = a.id and g.status = 'active') as has_guardian
        from memberships m
        join athletes a on a.id = m.athlete_id and a.active
        join people p on p.id = a.person_id
        join product_versions pv on pv.id = m.product_version_id join products pr on pr.id = pv.product_id
        left join discounts d on d.id = m.discount_id
        where m.org_id = ${orgId} and m.status in (${inList(LIVE)}) and m.start_date <= ${today} ${sc(sql`m.athlete_id`)}
        order by p.last_name, p.first_name`,
  );
  if (!mRaw.length) return [];
  const byAthlete = new Map<string, AthleteFacts>();
  for (const r of mRaw) {
    const price = Number(r.price_minor);
    const net =
      !r.discount_kind || r.discount_value == null || r.discount_active === false
        ? price
        : price - (r.discount_kind === "percent" ? percentOf(price, Number(r.discount_value)) : Math.min(Number(r.discount_value), price));
    const m: MFact = {
      id: r.id as string,
      athleteId: r.athlete_id as string,
      status: r.status as MembershipStatus,
      kind: r.kind as string,
      startDate: ymd(r.start_date)!,
      endDate: ymd(r.end_date),
      cancelAt: ymd(r.cancel_at),
      commitmentEndsOn: ymd(r.commitment_ends_on),
      payerAccountId: (r.payer_account_id as string) ?? null,
      productName: r.product_name as string,
      classesPerWeek: r.classes_per_week == null ? null : Number(r.classes_per_week),
      monthlyMinor: monthlyEquivalent(net, r.interval as "none" | "week" | "month" | "year", Number(r.interval_count)),
      currency: r.currency as string,
    };
    let f = byAthlete.get(m.athleteId);
    if (!f) {
      f = { athleteId: m.athleteId, personId: r.person_id as string, name: r.name as string, hasGuardian: !!r.has_guardian, memberships: [], holds: [], firstStart: m.startDate, visitDays: [], lastVisit: null, outcomes: [], upcoming: 0, payment: null, pastDueInvoices: null, card: null, requests: [], feedback: [], missingForms: null };
      byAthlete.set(m.athleteId, f);
    }
    f.memberships.push(m);
  }
  const ids = [...byAthlete.keys()];
  const idList = inList(ids);
  const mIds = mRaw.map((r) => r.id as string);

  for (const r of await rowsOf<{ athlete_id: string; first: unknown }>(tx, sql`select athlete_id, min(start_date) as first from memberships where org_id = ${orgId} and status <> 'pending' and athlete_id in (${idList}) group by athlete_id`)) {
    byAthlete.get(r.athlete_id)!.firstStart = ymd(r.first)!;
  }
  // Holds on any of the athlete's memberships (an ended hold on an earlier plan still explains an absence).
  for (const h of await rowsOf<Record<string, unknown>>(
    tx,
    sql`select m.athlete_id, h.membership_id, h.start_date, h.end_date, h.kind from membership_holds h join memberships m on m.id = h.membership_id
        where m.org_id = ${orgId} and m.athlete_id in (${idList}) and h.end_date >= ${addDaysYmd(today, -400)}`,
  )) {
    byAthlete.get(h.athlete_id as string)!.holds.push({ membershipId: h.membership_id as string, startDate: ymd(h.start_date)!, endDate: ymd(h.end_date)!, kind: h.kind as string });
  }

  const endOfToday = localDayBounds(today, tz).end.toISOString();
  const startOfToday = localDayBounds(today, tz).start.toISOString();
  const lookback = Math.max(s.attendanceWindowDays + s.baselineWindowDays, 2 * s.noShowWindowDays, 91) + 1;
  const since = localDayBounds(addDaysYmd(today, -lookback), tz).start.toISOString();
  for (const b of await rowsOf<{ athlete_id: string; status: string; starts_at: string | Date }>(
    tx,
    sql`select b.athlete_id, b.status, s.starts_at from bookings b join schedule_sessions s on s.id = b.session_id
        where b.org_id = ${orgId} and b.status in ('attended','no_show','late_cancelled') and s.status <> 'cancelled'
          and s.starts_at >= ${since} and s.starts_at < ${endOfToday} and b.athlete_id in (${idList})`,
  )) {
    const f = byAthlete.get(b.athlete_id)!;
    const d = localYmd(new Date(b.starts_at), tz);
    f.outcomes.push({ day: d, status: b.status });
    if (b.status === "attended") f.visitDays.push(d);
  }
  for (const l of await rowsOf<{ athlete_id: string; last_at: string | Date }>(
    tx,
    sql`select b.athlete_id, max(s.starts_at) as last_at from bookings b join schedule_sessions s on s.id = b.session_id
        where b.org_id = ${orgId} and b.status = 'attended' and s.status <> 'cancelled' and s.starts_at < ${endOfToday} and b.athlete_id in (${idList}) group by b.athlete_id`,
  )) {
    byAthlete.get(l.athlete_id)!.lastVisit = localYmd(new Date(l.last_at), tz);
  }
  const ahead = localDayBounds(addDaysYmd(today, s.upcomingLookaheadDays), tz).end.toISOString();
  for (const u of await rowsOf<{ athlete_id: string; n: number }>(
    tx,
    sql`select b.athlete_id, count(*)::int as n from bookings b join schedule_sessions s on s.id = b.session_id
        where b.org_id = ${orgId} and b.status in ('booked','waitlisted') and s.status = 'scheduled' and s.starts_at >= ${startOfToday} and s.starts_at < ${ahead}
          and b.athlete_id in (${idList}) group by b.athlete_id`,
  )) {
    byAthlete.get(u.athlete_id)!.upcoming = Number(u.n);
  }

  // Billing facts are per payer account; attach to each athlete whose live membership uses that payer.
  const payerIds = [...new Set(mRaw.map((r) => r.payer_account_id as string | null).filter((x): x is string => !!x))];
  if (payerIds.length) {
    const pl = inList(payerIds);
    const athletesOf = (payer: string) => [...byAthlete.values()].filter((f) => f.memberships.some((m) => m.payerAccountId === payer));
    for (const c of await rowsOf<{ payer_account_id: string; last_failed: string | Date; n_failed: number; reason: string | null }>(
      tx,
      sql`with f as (
            select i.payer_account_id, pa.created_at as at, coalesce(pa.failure_message, pa.failure_code) as reason
            from payment_attempts pa join invoices i on i.id = pa.invoice_id
            where pa.org_id = ${orgId} and pa.status = 'failed' and pa.created_at > ${today}::date - ${s.failedPaymentLookbackDays}::int and i.payer_account_id in (${pl})
            union all
            select t.payer_account_id, t.occurred_at, null::text from transactions t
            where t.org_id = ${orgId} and t.kind = 'charge' and t.status = 'failed' and t.occurred_at > ${today}::date - ${s.failedPaymentLookbackDays}::int and t.payer_account_id in (${pl})),
          s as (
            select i.payer_account_id, max(pa.created_at) as at from payment_attempts pa join invoices i on i.id = pa.invoice_id
            where pa.org_id = ${orgId} and pa.status = 'succeeded' group by 1
            union all
            select payer_account_id, max(coalesce(settled_at, occurred_at)) from transactions
            where org_id = ${orgId} and status = 'settled' and kind in ('charge','manual_payment') group by 1)
          select f.payer_account_id, max(f.at) as last_failed, count(*)::int as n_failed, (array_agg(f.reason order by f.at desc))[1] as reason
          from f where not exists (select 1 from s where s.payer_account_id = f.payer_account_id and s.at > f.at)
          group by f.payer_account_id`,
    )) {
      for (const f of athletesOf(c.payer_account_id)) f.payment = { failedCount: Number(c.n_failed), lastFailed: localYmd(new Date(c.last_failed), tz), reason: c.reason };
    }
    for (const i of await rowsOf<{ membership_id: string; n: number; oldest: unknown }>(
      tx,
      sql`select membership_id, count(*)::int as n, min(due_date) as oldest from invoices
          where org_id = ${orgId} and status = 'open' and due_date < ${today} and membership_id in (${inList(mIds)}) group by membership_id`,
    )) {
      const f = [...byAthlete.values()].find((x) => x.memberships.some((m) => m.id === i.membership_id));
      if (f) f.pastDueInvoices = { count: (f.pastDueInvoices?.count ?? 0) + Number(i.n), oldestDue: [f.pastDueInvoices?.oldestDue, ymd(i.oldest)!].filter((x): x is string => !!x).sort()[0] };
    }
    for (const c of await rowsOf<{ payer_account_id: string; brand: string | null; last4: string | null; exp_month: number; exp_year: number }>(
      tx,
      sql`select distinct on (payer_account_id) payer_account_id, brand, last4, exp_month, exp_year from payment_methods
          where payer_account_id in (${pl}) and exp_month is not null and exp_year is not null order by payer_account_id, is_default desc, created_at desc`,
    )) {
      for (const f of athletesOf(c.payer_account_id)) f.card = { brand: c.brand, last4: c.last4, expMonth: Number(c.exp_month), expYear: Number(c.exp_year) };
    }
  }

  for (const r of await rowsOf<{ athlete_id: string; type: string; sent_on: unknown }>(
    tx,
    sql`select ra.athlete_id, r.type, r.sent_on from member_requests r join member_request_athletes ra on ra.request_id = r.id
        where r.org_id = ${orgId} and r.status in ('new','in_progress') and not r.suggested and ra.athlete_id in (${idList}) order by r.sent_on`,
  )) {
    byAthlete.get(r.athlete_id)!.requests.push({ type: r.type, sentOn: ymd(r.sent_on)! });
  }
  const fbSince = localDayBounds(addDaysYmd(today, -s.feedbackLookbackDays), tz).start.toISOString();
  for (const r of await rowsOf<{ id: string; athlete_id: string; rating: number; has_comment: boolean; tell_coach: boolean; starts_at: string | Date }>(
    tx,
    sql`select sf.id, sf.athlete_id, sf.rating, (sf.comment is not null and btrim(sf.comment) <> '') as has_comment, sf.tell_coach, s.starts_at
        from session_feedback sf join schedule_sessions s on s.id = sf.session_id
        where sf.org_id = ${orgId} and s.starts_at >= ${fbSince} and sf.athlete_id in (${idList})`,
  )) {
    byAthlete.get(r.athlete_id)!.feedback.push({ id: r.id, rating: Number(r.rating), hasComment: !!r.has_comment, tellCoach: !!r.tell_coach, day: localYmd(new Date(r.starts_at), tz) });
  }
  for (const d of await rowsOf<{ athlete_id: string; forms: string }>(
    tx,
    sql`with req as (
          select ft.id, ft.name from form_templates ft where ft.org_id = ${orgId} and ft.active
            and (ft.required_for_booking or exists (select 1 from service_types st where st.org_id = ${orgId} and st.active
              and coalesce(st.eligibility->'requiredFormTemplateIds', '[]'::jsonb) ? ft.id::text)))
        select a.id as athlete_id, string_agg(req.name, ', ' order by req.name) as forms
        from athletes a cross join req
        where a.org_id = ${orgId} and a.id in (${idList})
          and not exists (select 1 from form_requests fr join form_template_versions v on v.id = fr.template_version_id
            where fr.org_id = ${orgId} and v.template_id = req.id and fr.status = 'completed'
              and (fr.athlete_id = a.id or (fr.athlete_id is null and fr.subject_person_id = a.person_id))
              and (fr.expires_at is null or fr.expires_at > ${endOfToday}))
        group by a.id`,
  )) {
    byAthlete.get(d.athlete_id)!.missingForms = d.forms;
  }
  return [...byAthlete.values()];
}

async function loadContext(tx: Tx, orgId: string, ids: string[]) {
  const lastContact = new Map<string, RadarRow["lastContact"]>();
  const coaches = new Map<string, { id: string; name: string }[]>();
  const lastOutcome = new Map<string, { outcome: string; at: Date }>();
  if (!ids.length) return { lastContact, coaches, lastOutcome };
  const idList = inList(ids);
  const consider = (athleteId: string, c: NonNullable<RadarRow["lastContact"]>) => {
    const cur = lastContact.get(athleteId);
    if (!cur || cur.at < c.at) lastContact.set(athleteId, c);
  };
  // Staff-written messages only: not internal notes, automations or broadcast campaigns.
  for (const r of await rowsOf<{ athlete_id: string; at: string | Date; who: string }>(
    tx,
    sql`select distinct on (t.athlete_id) t.athlete_id, m.created_at as at, u.display_name as who
        from messages m join threads t on t.id = m.thread_id join users u on u.id = m.sender_user_id
        where t.org_id = ${orgId} and t.athlete_id in (${idList}) and u.role in ('owner','admin','operations','coach')
          and not m.is_internal_note and m.automation_rule_id is null and m.campaign_id is null
        order by t.athlete_id, m.created_at desc`,
  )) {
    consider(r.athlete_id, { kind: "message", at: new Date(r.at), label: `Message from ${r.who}` });
  }
  for (const r of await rowsOf<{ athlete_id: string; at: string | Date; title: string }>(
    tx,
    sql`select distinct on (a.id) a.id as athlete_id, t.created_at as at, t.title from tasks t join athletes a on a.person_id = t.related_person_id
        where t.org_id = ${orgId} and a.id in (${idList}) and t.status <> 'cancelled' order by a.id, t.created_at desc`,
  )) {
    consider(r.athlete_id, { kind: "task", at: new Date(r.at), label: `Task: ${r.title}` });
  }
  for (const r of await rowsOf<{ athlete_id: string; at: string | Date; outcome: string }>(
    tx,
    sql`select distinct on (athlete_id) athlete_id, created_at as at, outcome from retention_actions where org_id = ${orgId} and athlete_id in (${idList}) order by athlete_id, created_at desc`,
  )) {
    lastOutcome.set(r.athlete_id, { outcome: r.outcome, at: new Date(r.at) });
    consider(r.athlete_id, { kind: "outcome", at: new Date(r.at), label: "Outcome logged" });
  }
  for (const r of await rowsOf<{ athlete_id: string; id: string; name: string }>(
    tx,
    sql`select distinct x.athlete_id, u.id, u.display_name as name from (
          select ca.athlete_id, ca.coach_user_id from coach_assignments ca
            where ca.org_id = ${orgId} and ca.athlete_id is not null and (ca.starts_on is null or ca.starts_on <= current_date) and (ca.ends_on is null or ca.ends_on >= current_date)
          union
          select gm.athlete_id, ca.coach_user_id from coach_assignments ca join group_members gm on gm.group_id = ca.group_id
            where ca.org_id = ${orgId} and (ca.starts_on is null or ca.starts_on <= current_date) and (ca.ends_on is null or ca.ends_on >= current_date)) x
        join users u on u.id = x.coach_user_id where x.athlete_id in (${idList}) order by u.display_name`,
  )) {
    coaches.set(r.athlete_id, [...(coaches.get(r.athlete_id) ?? []), { id: r.id, name: r.name }]);
  }
  return { lastContact, coaches, lastOutcome };
}

/**
 * The radar for the viewer's scope (coaches: assigned athletes only). `today` is the facility-local
 * date and defaults to now. Viewers without billing access never get payment signals or dollar values.
 */
export async function retentionRadar(tx: Tx, v: Viewer, opts: { today?: string; athleteIds?: string[] } = {}): Promise<RadarResult> {
  const full = await radarScope(tx, v);
  const scope = opts.athleteIds ? (full === "all" ? opts.athleteIds : full.filter((id) => opts.athleteIds!.includes(id))) : full;
  const { settings, tz, orgSettings, currency } = await retentionContext(tx, v.orgId);
  const policy = policyFromSettings(orgSettings);
  const today = opts.today ?? todayLocal(tz);
  const showBilling = can(v, "retention.manage") && can(v, "billing.view_all");
  const allFeedback = can(v, "feedback.review");
  const facts = await loadFacts(tx, v.orgId, today, tz, settings, scope);
  const ctx = await loadContext(tx, v.orgId, facts.map((f) => f.athleteId));
  const rows: RadarRow[] = facts.map((f) => {
    const signals = evaluateSignals(f, settings, policy, today, { billing: showBilling, allFeedback }).filter((x) => showBilling || !BILLING_SIGNALS.includes(x.key));
    const primary = [...f.memberships].sort((a, b) => (b.monthlyMinor ?? -1) - (a.monthlyMinor ?? -1) || a.startDate.localeCompare(b.startDate))[0];
    const contact = f.hasGuardian ? ("parent" as const) : ("athlete" as const);
    return {
      athleteId: f.athleteId,
      personId: f.personId,
      name: f.name,
      contact,
      plan: primary.productName,
      planStatus: primary.status,
      membershipId: primary.id,
      valueAtRiskMinor: showBilling ? primary.monthlyMinor : null,
      currency: primary.currency,
      level: levelFor(signals, settings),
      signals,
      lastContact: ctx.lastContact.get(f.athleteId) ?? null,
      recommendation: recommendationFor(signals, contact),
      memberSince: f.firstStart,
      tenureMonths: tenureMonths(f.firstStart, today),
      coaches: ctx.coaches.get(f.athleteId) ?? [],
      lastOutcome: ctx.lastOutcome.get(f.athleteId) ?? null,
    };
  });
  const order: Record<RiskLevel, number> = { at_risk: 0, watch: 1, low: 2 };
  rows.sort((a, b) => order[a.level] - order[b.level] || (b.valueAtRiskMinor ?? 0) - (a.valueAtRiskMinor ?? 0) || a.name.localeCompare(b.name));

  const monthStart = localDayBounds(`${today.slice(0, 7)}-01`, tz).start.toISOString();
  const [saves] = await rowsOf<{ n: number }>(
    tx,
    sql`select count(*)::int as n from retention_actions where org_id = ${v.orgId} and outcome = 'saved' and created_at >= ${monthStart}
        ${scope === "all" ? sql`` : scope.length ? sql`and athlete_id in (${inList(scope)})` : sql`and false`}`,
  );
  const atRisk = rows.filter((r) => r.level === "at_risk");
  return {
    rows,
    summary: {
      members: rows.length,
      atRisk: atRisk.length,
      watch: rows.filter((r) => r.level === "watch").length,
      revenueAtRiskMinor: showBilling ? atRisk.reduce((sum, r) => sum + (r.valueAtRiskMinor ?? 0), 0) : null,
      savesThisMonth: Number(saves?.n ?? 0),
      avgTenureMonths: rows.length ? Math.round((rows.reduce((sum, r) => sum + r.tenureMonths, 0) / rows.length) * 10) / 10 : null,
      currency,
    },
    settings,
    policy,
    today,
    tz,
    showBilling,
  };
}

export type RadarFilter = { level?: RiskLevel | "all"; coach?: string; plan?: string; signal?: SignalKey; sort?: "value" | "level" | "name" };

/** Page filters. Default view hides "low" members; sort defaults to value at risk. */
export function filterRadar(rows: RadarRow[], f: RadarFilter): RadarRow[] {
  const out = rows.filter(
    (r) =>
      (f.level === "all" ? true : f.level ? r.level === f.level : r.level !== "low") &&
      (!f.coach || r.coaches.some((c) => c.id === f.coach)) &&
      (!f.plan || r.plan === f.plan) &&
      (!f.signal || r.signals.some((x) => x.key === f.signal)),
  );
  const order: Record<RiskLevel, number> = { at_risk: 0, watch: 1, low: 2 };
  if (f.sort === "name") out.sort((a, b) => a.name.localeCompare(b.name));
  else if (f.sort === "level") out.sort((a, b) => order[a.level] - order[b.level] || (b.valueAtRiskMinor ?? 0) - (a.valueAtRiskMinor ?? 0));
  else out.sort((a, b) => (b.valueAtRiskMinor ?? -1) - (a.valueAtRiskMinor ?? -1) || order[a.level] - order[b.level] || a.name.localeCompare(b.name));
  return out;
}
