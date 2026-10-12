import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db";
import type { MemberRequestStatus, MemberRequestType, MembershipStatus } from "@/db/schema";
import { membershipPolicy, type MembershipPolicy } from "@/lib/membership-policy";
import { percentOf } from "@/lib/money";
import { addDaysYmd, daysBetween, localDayBounds, localYmd, startOfWeekYmd } from "@/lib/time";
import { addMonthsYmd } from "@/lib/billing/util";
import {
  BILL_AFFECTING_TYPES,
  billDatesBetween,
  daysUnprocessed,
  isInSeasonPlan,
  monthlyEquivalent,
  monthsBetween,
  overlapDays,
  requestSettings,
  typeLabel,
  weeklyCap,
} from "./common";

/**
 * Membership audit: screens every membership with a few set-based queries, then runs pure
 * detectors over the loaded facts. READ-ONLY — it reports exceptions and recommended actions and
 * never changes a membership, invoice, or request. The per-athlete status page reuses the same
 * detectors (scoped to the athlete's family) so both always agree.
 */

export type ExceptionType =
  | "dormant_billed"
  | "over_cap_usage"
  | "hold_over_cap"
  | "hold_no_end"
  | "in_season_over_cap"
  | "in_season_no_end"
  | "commitment_renewed"
  | "commitment_locked"
  | "family_discount_missing"
  | "unsigned_docs_billed"
  | "failing_card"
  | "request_unprocessed"
  | "request_billed_anyway";

export const EXCEPTION_LABELS: Record<ExceptionType, string> = {
  dormant_billed: "Billed while not attending",
  over_cap_usage: "Using more than the plan allows",
  hold_over_cap: "Hold over the yearly cap",
  hold_no_end: "On hold with no end date",
  in_season_over_cap: "In-season over the 365-day cap",
  in_season_no_end: "In-season with no end date",
  commitment_renewed: "Rolled into a new commitment",
  commitment_locked: "Cancellation held past commitment + notice",
  family_discount_missing: "Family discount missing",
  unsigned_docs_billed: "Billed but blocked by unsigned documents",
  failing_card: "Failing card",
  request_unprocessed: "Request not processed",
  request_billed_anyway: "Asked before a bill date, billed anyway",
};

export type MembershipException = {
  type: ExceptionType;
  label: string;
  /** Athletes this exception concerns (one for most; every athlete on the payer for a card). */
  athleteIds: string[];
  athleteNames: string;
  personId: string | null;
  payerName: string | null;
  membershipId: string | null;
  requestId: string | null;
  detail: string;
  /** Dollar figure in minor units; null only when it genuinely cannot be computed (see basis). */
  impactMinor: number | null;
  impactBasis: string;
  recommendation: string;
};

export type AuditResult = {
  asOf: string;
  policy: MembershipPolicy;
  exceptions: MembershipException[];
  screened: { memberships: number; live: number; billed: number; athletes: number; requests: number; payers: number };
  skipped: string[];
};

type MRow = {
  id: string;
  athleteId: string;
  personId: string;
  athleteName: string;
  payerAccountId: string | null;
  payerName: string | null;
  status: MembershipStatus;
  startDate: string;
  endDate: string | null;
  cancelAt: string | null;
  nextBillDate: string | null;
  anchorDay: number | null;
  billingProvider: string;
  productName: string;
  productKind: string;
  priceMinor: number;
  interval: "none" | "week" | "month" | "year";
  intervalCount: number;
  creditsPerPeriod: number | null;
  unlimited: boolean;
  commitmentMonths: number;
  siblingPercentOff: number | null;
  discountId: string | null;
  discountKind: "percent" | "fixed" | null;
  discountValue: number | null;
  discountActive: boolean | null;
  netMinor: number;
  monthlyMinor: number | null;
};

type ReqRow = {
  id: string;
  type: MemberRequestType;
  status: MemberRequestStatus;
  suggested: boolean;
  sentOn: string;
  resolvedOn: string | null;
  athleteIds: string[];
};

const LIVE: MembershipStatus[] = ["pending", "trialing", "active", "on_hold", "past_due"];
const ymd = (x: unknown) => (x == null ? null : x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));
const rowsOf = async <T>(tx: Tx, q: SQL) => (await tx.execute(q)).rows as T[];
const inList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}`), sql`, `);
const DAYS_PER_MONTH = 30.4375;
const money = (minor: number) => `$${(minor / 100).toFixed(2)}`;

function netPerPeriod(m: Pick<MRow, "priceMinor" | "discountKind" | "discountValue" | "discountActive">): number {
  if (!m.discountKind || m.discountValue == null || m.discountActive === false) return m.priceMinor;
  return m.priceMinor - (m.discountKind === "percent" ? percentOf(m.priceMinor, m.discountValue) : Math.min(m.discountValue, m.priceMinor));
}

/** Facts for the sweep; `athleteIds` limits the scope (status page) — otherwise the whole org. */
async function loadFacts(tx: Tx, orgId: string, today: string, tz: string, athleteIds?: string[]) {
  const scopeM = athleteIds ? (athleteIds.length ? sql`and m.athlete_id in (${inList(athleteIds)})` : sql`and false`) : sql``;
  const scopeB = athleteIds ? (athleteIds.length ? sql`and b.athlete_id in (${inList(athleteIds)})` : sql`and false`) : sql``;
  const raw = await rowsOf<Record<string, unknown>>(
    tx,
    sql`select m.id, m.athlete_id, a.person_id, p.first_name || ' ' || p.last_name as athlete_name, m.payer_account_id, pa.name as payer_name,
          m.status, m.start_date, m.end_date, m.cancel_at, m.next_bill_date, m.billing_anchor_day, m.billing_provider,
          pr.name as product_name, pr.kind as product_kind, pv.price_minor, pv.interval, pv.interval_count, pv.credits_per_period, pv.unlimited,
          pv.commitment_months, (pv.family_discount->>'siblingPercentOff')::int as sibling_pct,
          m.discount_id, d.kind as discount_kind, d.value as discount_value, d.active as discount_active
        from memberships m
        join product_versions pv on pv.id = m.product_version_id join products pr on pr.id = pv.product_id
        join athletes a on a.id = m.athlete_id join people p on p.id = a.person_id
        left join payer_accounts pa on pa.id = m.payer_account_id
        left join discounts d on d.id = m.discount_id
        where m.org_id = ${orgId} ${scopeM}
        order by m.start_date`,
  );
  const memberships: MRow[] = raw.map((r) => {
    const base = {
      id: r.id as string,
      athleteId: r.athlete_id as string,
      personId: r.person_id as string,
      athleteName: r.athlete_name as string,
      payerAccountId: (r.payer_account_id as string) ?? null,
      payerName: (r.payer_name as string) ?? null,
      status: r.status as MembershipStatus,
      startDate: ymd(r.start_date)!,
      endDate: ymd(r.end_date),
      cancelAt: ymd(r.cancel_at),
      nextBillDate: ymd(r.next_bill_date),
      anchorDay: r.billing_anchor_day == null ? null : Number(r.billing_anchor_day),
      billingProvider: r.billing_provider as string,
      productName: r.product_name as string,
      productKind: r.product_kind as string,
      priceMinor: Number(r.price_minor),
      interval: r.interval as MRow["interval"],
      intervalCount: Number(r.interval_count),
      creditsPerPeriod: r.credits_per_period == null ? null : Number(r.credits_per_period),
      unlimited: !!r.unlimited,
      commitmentMonths: Number(r.commitment_months ?? 0),
      siblingPercentOff: r.sibling_pct == null ? null : Number(r.sibling_pct),
      discountId: (r.discount_id as string) ?? null,
      discountKind: (r.discount_kind as MRow["discountKind"]) ?? null,
      discountValue: r.discount_value == null ? null : Number(r.discount_value),
      discountActive: r.discount_active == null ? null : !!r.discount_active,
    };
    const netMinor = netPerPeriod(base);
    return { ...base, netMinor, monthlyMinor: monthlyEquivalent(netMinor, base.interval, base.intervalCount) };
  });
  const mIds = memberships.map((m) => m.id);
  const holds = mIds.length
    ? (await rowsOf<Record<string, unknown>>(tx, sql`select membership_id, start_date, end_date from membership_holds where membership_id in (${inList(mIds)})`)).map((h) => ({
        membershipId: h.membership_id as string,
        startDate: ymd(h.start_date)!,
        endDate: ymd(h.end_date)!,
      }))
    : [];
  const invoices = mIds.length
    ? (
        await rowsOf<Record<string, unknown>>(
          tx,
          sql`select id, membership_id, period_start, total_minor, status from invoices where membership_id in (${inList(mIds)}) and status <> 'void' and period_start >= ${addDaysYmd(today, -400)}`,
        )
      ).map((i) => ({ id: i.id as string, membershipId: i.membership_id as string, periodStart: ymd(i.period_start)!, totalMinor: Number(i.total_minor), status: i.status as string }))
    : [];
  const end = localDayBounds(today, tz).end.toISOString();
  const lastVisits = await rowsOf<{ athlete_id: string; last_at: string | Date }>(
    tx,
    sql`select b.athlete_id, max(s.starts_at) as last_at from bookings b join schedule_sessions s on s.id = b.session_id
        where b.org_id = ${orgId} and b.status = 'attended' and s.status <> 'cancelled' and s.starts_at < ${end} ${scopeB} group by b.athlete_id`,
  );
  const since = localDayBounds(addDaysYmd(startOfWeekYmd(today), -7 * 8), tz).start.toISOString();
  const recent = await rowsOf<{ athlete_id: string; starts_at: string | Date }>(
    tx,
    sql`select b.athlete_id, s.starts_at from bookings b join schedule_sessions s on s.id = b.session_id
        where b.org_id = ${orgId} and b.status = 'attended' and s.status <> 'cancelled' and s.starts_at >= ${since} and s.starts_at < ${end} ${scopeB}`,
  );
  const scopeR = athleteIds ? (athleteIds.length ? sql`and ra.athlete_id in (${inList(athleteIds)})` : sql`and false`) : sql``;
  const reqRaw = await rowsOf<Record<string, unknown>>(
    tx,
    sql`select r.id, r.type, r.status, r.suggested, r.sent_on, (r.resolved_at at time zone ${tz})::date as resolved_on,
          array_agg(ra.athlete_id) as athlete_ids
        from member_requests r join member_request_athletes ra on ra.request_id = r.id
        where r.org_id = ${orgId} and r.status <> 'dismissed' and (r.status in ('new','in_progress') or r.sent_on >= ${addDaysYmd(today, -400)}) ${scopeR}
        group by r.id order by r.sent_on`,
  );
  const requests: ReqRow[] = reqRaw.map((r) => ({
    id: r.id as string,
    type: r.type as MemberRequestType,
    status: r.status as MemberRequestStatus,
    suggested: !!r.suggested,
    sentOn: ymd(r.sent_on)!,
    resolvedOn: ymd(r.resolved_on),
    athleteIds: (r.athlete_ids as string[]) ?? [],
  }));
  const reqAthleteIds = [...new Set(requests.flatMap((r) => r.athleteIds))];
  const athleteRows = reqAthleteIds.length
    ? await rowsOf<{ id: string; person_id: string; name: string }>(
        tx,
        sql`select a.id, a.person_id, p.first_name || ' ' || p.last_name as name from athletes a join people p on p.id = a.person_id where a.org_id = ${orgId} and a.id in (${inList(reqAthleteIds)})`,
      )
    : [];
  const payerIds = [...new Set(memberships.map((m) => m.payerAccountId).filter((x): x is string => !!x))];
  const cards = payerIds.length
    ? await rowsOf<{ payer_account_id: string; last_failed: string | Date; n_failed: number; last_success: string | Date | null; reason: string | null; failed_minor: number; open_minor: number }>(
        tx,
        sql`with f as (
              select i.payer_account_id, pa.created_at as at, pa.amount_minor, coalesce(pa.failure_message, pa.failure_code) as reason
              from payment_attempts pa join invoices i on i.id = pa.invoice_id
              where pa.org_id = ${orgId} and pa.status = 'failed' and pa.created_at > ${today}::date - 60 and i.payer_account_id in (${inList(payerIds)})
              union all
              select t.payer_account_id, t.occurred_at, t.amount_minor, t.notes from transactions t
              where t.org_id = ${orgId} and t.kind = 'charge' and t.status = 'failed' and t.occurred_at > ${today}::date - 60 and t.payer_account_id in (${inList(payerIds)})),
            s as (
              select i.payer_account_id, max(pa.created_at) as at from payment_attempts pa join invoices i on i.id = pa.invoice_id
              where pa.org_id = ${orgId} and pa.status = 'succeeded' group by 1
              union all
              select payer_account_id, max(coalesce(settled_at, occurred_at)) from transactions
              where org_id = ${orgId} and status = 'settled' and kind in ('charge','manual_payment') group by 1)
            select f.payer_account_id, max(f.at) as last_failed, count(*)::int as n_failed, (select max(s.at) from s where s.payer_account_id = f.payer_account_id) as last_success,
              (array_agg(f.reason order by f.at desc))[1] as reason, max(f.amount_minor)::bigint as failed_minor,
              coalesce((select sum(i.total_minor - coalesce((select sum(t.amount_minor) from transactions t where t.invoice_id = i.id and t.status = 'settled' and t.kind in ('charge','manual_payment')),0))
                 from invoices i where i.payer_account_id = f.payer_account_id and i.status = 'open'),0)::bigint as open_minor
            from f group by f.payer_account_id`,
      )
    : [];
  const billedAthletes = [...new Set(memberships.filter((m) => LIVE.includes(m.status) && m.billingProvider !== "none").map((m) => m.athleteId))];
  const docs = billedAthletes.length
    ? await rowsOf<{ athlete_id: string; forms: string }>(
        tx,
        sql`with req as (
              select ft.id, ft.name from form_templates ft where ft.org_id = ${orgId} and ft.active
                and (ft.required_for_booking or exists (select 1 from service_types st where st.org_id = ${orgId} and st.active
                  and coalesce(st.eligibility->'requiredFormTemplateIds', '[]'::jsonb) ? ft.id::text)))
            select a.id as athlete_id, string_agg(req.name, ', ' order by req.name) as forms
            from athletes a cross join req
            where a.org_id = ${orgId} and a.id in (${inList(billedAthletes)})
              and not exists (select 1 from form_requests fr join form_template_versions v on v.id = fr.template_version_id
                where fr.org_id = ${orgId} and v.template_id = req.id and fr.status = 'completed'
                  and (fr.athlete_id = a.id or (fr.athlete_id is null and fr.subject_person_id = a.person_id))
                  and (fr.expires_at is null or fr.expires_at > ${end}))
            group by a.id`,
      )
    : [];
  return {
    memberships,
    holds,
    invoices,
    lastVisit: new Map(lastVisits.map((l) => [l.athlete_id, localYmd(new Date(l.last_at), tz)])),
    recentVisits: recent.map((r) => ({ athleteId: r.athlete_id, day: localYmd(new Date(r.starts_at), tz) })),
    requests,
    cards: cards.map((c) => ({ ...c, last_failed: new Date(c.last_failed), last_success: c.last_success ? new Date(c.last_success) : null, failed_minor: Number(c.failed_minor), open_minor: Number(c.open_minor) })),
    docs: new Map(docs.map((d) => [d.athlete_id, d.forms])),
    athletes: new Map(athleteRows.map((a) => [a.id, { personId: a.person_id, name: a.name }])),
  };
}

export type AuditFacts = Awaited<ReturnType<typeof loadFacts>>;

/** Pure detectors over loaded facts. Exported for unit tests. */
export function detectExceptions(f: AuditFacts, policy: MembershipPolicy, today: string, opts: { unprocessedAfterDays: number; repeatWindowDays: number }): { exceptions: MembershipException[]; skipped: string[]; billedCount: number } {
  const out: MembershipException[] = [];
  const skipped: string[] = [];
  const holdsBy = new Map<string, { startDate: string; endDate: string }[]>();
  for (const h of f.holds) holdsBy.set(h.membershipId, [...(holdsBy.get(h.membershipId) ?? []), h]);
  const invBy = new Map<string, typeof f.invoices>();
  for (const i of f.invoices) invBy.set(i.membershipId, [...(invBy.get(i.membershipId) ?? []), i]);
  const holdOn = (m: MRow, d: string) => (holdsBy.get(m.id) ?? []).some((h) => h.startDate <= d && h.endDate >= d);
  const live = f.memberships.filter((m) => LIVE.includes(m.status) && m.startDate <= today);
  const billedNow = (m: MRow) => (m.status === "active" || m.status === "past_due") && m.billingProvider !== "none" && !holdOn(m, today);
  const billed = live.filter(billedNow);
  const anchor = (m: MRow) => m.anchorDay ?? policy.billingAnchorDay;
  const ext = (m: MRow) => m.billingProvider === "external_zenplanner";
  const liveOn = (m: MRow, d: string) => m.startDate <= d && (!m.endDate || m.endDate >= d) && (!m.cancelAt || m.cancelAt > d) && !holdOn(m, d);
  /** Money billed (or, for Zen Planner-billed memberships, estimated) for bill dates in (after, until]. */
  const billedBetween = (m: MRow, after: string, until: string, exclude = new Set<string>()) => {
    if (ext(m)) {
      // Estimated bill dates are keyed by membership + date so repeat asks never count one bill twice.
      const dates = billDatesBetween(after, until, anchor(m)).filter((d) => liveOn(m, d) && !exclude.has(`${m.id}:${d}`));
      return { minor: dates.length * (m.monthlyMinor ?? 0), count: dates.length, estimated: true, invoiceIds: dates.map((d) => `${m.id}:${d}`), dates };
    }
    const inv = (invBy.get(m.id) ?? []).filter((i) => i.periodStart > after && i.periodStart <= until && !exclude.has(i.id));
    return { minor: inv.reduce((s, i) => s + i.totalMinor, 0), count: inv.length, estimated: false, invoiceIds: inv.map((i) => i.id), dates: inv.map((i) => i.periodStart) };
  };
  const base = (m: MRow) => ({ athleteIds: [m.athleteId], athleteNames: m.athleteName, personId: m.personId, payerName: m.payerName, membershipId: m.id, requestId: null });
  const push = (e: Omit<MembershipException, "label">) => out.push({ ...e, label: EXCEPTION_LABELS[e.type] });

  // 1. Dormant but billed.
  for (const m of billed) {
    const cutoff = addDaysYmd(today, -policy.dormantAfterDays);
    if (m.startDate > cutoff) continue;
    const last = f.lastVisit.get(m.athleteId) ?? null;
    if (last && last > cutoff) continue;
    const since = last && last > m.startDate ? last : m.startDate;
    const b = billedBetween(m, since, today);
    const per = m.monthlyMinor;
    push({
      ...base(m),
      type: "dormant_billed",
      detail: `${last ? `No attended visit since ${last} (${daysBetween(last, today)} days)` : `No attended visit since the membership started ${m.startDate}`}; ${m.productName} still billing${b.count ? ` — ${b.count} bill(s) since` : ""}.`,
      impactMinor: b.minor > 0 ? b.minor : per,
      impactBasis: b.minor > 0 ? (b.estimated ? `${b.count} Zen Planner bill date(s) × plan rate since last visit (estimate — verify in Zen Planner)` : `${b.count} bill(s) since the last visit`) : "per month going forward",
      recommendation: `Likely refund/hold request. Contact the family before the next bill; if they ask, date any hold to their request date. Unused already-billed sessions can become a punch card valid ${policy.punchCardExpiryMonths} months (needs an active membership). Do not change billing until they confirm.`,
    });
  }

  // 2. Consistent use above the plan's weekly cap (last 8 complete weeks).
  const weekStart = startOfWeekYmd(today);
  const weeks = Array.from({ length: 8 }, (_, i) => addDaysYmd(weekStart, -7 * (8 - i)));
  let uncapped = 0;
  for (const m of live.filter((x) => x.status !== "on_hold" && !holdOn(x, today))) {
    const cap = weeklyCap(m);
    if (cap == null) {
      uncapped++;
      continue;
    }
    const counts = weeks.map((w) => f.recentVisits.filter((v) => v.athleteId === m.athleteId && v.day >= w && v.day < addDaysYmd(w, 7) && v.day >= m.startDate).length);
    const above = counts.filter((c) => c > cap).length;
    const avg = counts.reduce((s, c) => s + c, 0) / counts.length;
    if (above < 5 || avg <= cap) continue;
    push({
      ...base(m),
      type: "over_cap_usage",
      detail: `${m.productName} allows ${cap}/week; averaged ${avg.toFixed(1)}/week over the last 8 weeks (above the cap in ${above} of 8).`,
      impactMinor: m.monthlyMinor == null ? null : Math.round((m.monthlyMinor * (avg - cap)) / cap),
      impactBasis: "per month (estimate: extra visits/week ÷ cap × plan rate)",
      recommendation: "Talk with the family about the plan that matches how often the athlete actually comes (or enforce the cap at booking). Do not change the plan without their agreement.",
    });
  }

  // 3. Holds over the per-membership-year cap / on hold with no end date.
  for (const m of live) {
    const yearsIn = Math.floor(monthsBetween(m.startDate, today) / 12);
    const yStart = addMonthsYmd(m.startDate, 12 * yearsIn);
    const yEnd = addDaysYmd(addMonthsYmd(m.startDate, 12 * (yearsIn + 1)), -1);
    const hs = holdsBy.get(m.id) ?? [];
    const days = hs.reduce((s, h) => s + overlapDays(h.startDate, h.endDate, yStart, yEnd), 0);
    const months = days / DAYS_PER_MONTH;
    if (months > policy.holdMaxMonthsPerMembershipYear + 0.05) {
      const excess = months - policy.holdMaxMonthsPerMembershipYear;
      push({
        ...base(m),
        type: "hold_over_cap",
        detail: `${months.toFixed(1)} months on hold in the membership year ${yStart} – ${yEnd}; policy allows ${policy.holdMaxMonthsPerMembershipYear}.`,
        impactMinor: m.monthlyMinor == null ? null : Math.round(excess * m.monthlyMinor),
        impactBasis: `${excess.toFixed(1)} month(s) over the cap × plan rate (revenue deferred)`,
        recommendation: `Confirm an owner-approved exception, or set the restart date so total hold stays within ${policy.holdMaxMonthsPerMembershipYear} months; nudge the family ${policy.restartNudgeDaysBefore} days before restart.`,
      });
    }
    if (m.status === "on_hold" && !holdOn(m, today)) {
      push({
        ...base(m),
        type: "hold_no_end",
        detail: `Membership status is "on hold" but no hold period (with a restart date) covers today.`,
        impactMinor: m.monthlyMinor,
        impactBasis: "per month not billed while the hold is open-ended",
        recommendation: `Record the hold with a firm restart date (policy default ${policy.defaultHoldMonths} months, dated to the family's request) and schedule the restart nudge ${policy.restartNudgeDaysBefore} days before.`,
      });
    }
  }

  // 4. In-season over the rolling-365-day cap / with no end date.
  const byAthlete = new Map<string, MRow[]>();
  for (const m of f.memberships) byAthlete.set(m.athleteId, [...(byAthlete.get(m.athleteId) ?? []), m]);
  for (const [, ms] of byAthlete) {
    const inSeason = ms.filter((m) => isInSeasonPlan(m.productName));
    if (!inSeason.length) continue;
    const regular = ms.filter((m) => !isInSeasonPlan(m.productName) && m.productKind === "recurring_membership" && m.monthlyMinor != null).sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
    const winStart = addDaysYmd(today, -364);
    const used = inSeason.reduce((s, m) => {
      const e = [m.endDate, m.cancelAt ? addDaysYmd(m.cancelAt, -1) : null, today].filter((x): x is string => !!x).sort()[0];
      return s + overlapDays(m.startDate, e, winStart, today);
    }, 0);
    const months = used / DAYS_PER_MONTH;
    const latest = [...inSeason].sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
    const diff = regular && latest.monthlyMinor != null ? regular.monthlyMinor! - latest.monthlyMinor : null;
    if (months > policy.inSeasonMaxMonthsPer365Days + 0.05) {
      const excess = months - policy.inSeasonMaxMonthsPer365Days;
      push({
        ...base(latest),
        type: "in_season_over_cap",
        detail: `${months.toFixed(1)} in-season months in the last 365 days; policy allows ${policy.inSeasonMaxMonthsPer365Days}.`,
        impactMinor: diff == null ? null : Math.round(excess * diff),
        impactBasis: diff == null ? "not calculable: no regular plan on file to compare against" : `${excess.toFixed(1)} month(s) over the cap × (regular ${money(regular!.monthlyMinor!)} − in-season ${money(latest.monthlyMinor!)})`,
        recommendation: "Confirm an owner-approved exception or return the athlete to their regular plan; tell the family the date in writing.",
      });
    }
    for (const m of inSeason.filter((x) => LIVE.includes(x.status) && !x.endDate && !x.cancelAt)) {
      push({
        ...base(m),
        type: "in_season_no_end",
        detail: `${m.productName} has no end date — in-season plans must end (policy: max ${policy.inSeasonMaxMonthsPer365Days} months per 365 days).`,
        impactMinor: diff,
        impactBasis: diff == null ? "not calculable: no regular plan on file to compare against" : `per month (regular ${money(regular!.monthlyMinor!)} − in-season ${money(m.monthlyMinor!)})`,
        recommendation: `Set the in-season end date and the date the regular plan resumes; nudge the family ${policy.restartNudgeDaysBefore} days before.`,
      });
    }
  }

  // 5. Commitment ended: renewed into a new commitment, or cancellation held past commitment + notice.
  for (const [, ms] of byAthlete) {
    const sorted = [...ms].sort((a, b) => a.startDate.localeCompare(b.startDate));
    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];
      if (!policy.commitmentRollsToMonthToMonth || next.commitmentMonths <= 0 || !LIVE.includes(next.status)) continue;
      const prev = sorted.slice(0, i).reverse().find((p) => p.commitmentMonths > 0);
      if (!prev) continue;
      const prevEnd = addMonthsYmd(prev.startDate, prev.commitmentMonths);
      if (next.startDate < addDaysYmd(prevEnd, -7) || next.startDate > addDaysYmd(prevEnd, 45)) continue;
      const nextEnd = addMonthsYmd(next.startDate, next.commitmentMonths);
      const remaining = Math.max(0, monthsBetween(today, nextEnd));
      push({
        ...base(next),
        type: "commitment_renewed",
        detail: `${prev.productName} commitment (${prev.commitmentMonths} mo) ended ${prevEnd}; a new ${next.commitmentMonths}-month commitment started ${next.startDate} (runs to ${nextEnd}).`,
        impactMinor: next.monthlyMinor == null ? null : remaining * next.monthlyMinor,
        impactBasis: `remaining contract value (${remaining} month(s) × ${next.monthlyMinor == null ? "rate" : money(next.monthlyMinor)})`,
        recommendation: "Agreement §5: after a commitment ends the membership continues month-to-month at the committed rate. Confirm the family knowingly signed a new commitment; if not, convert it to month-to-month.",
      });
    }
  }
  for (const m of live.filter((x) => x.commitmentMonths > 0)) {
    const commitEnd = addMonthsYmd(m.startDate, m.commitmentMonths);
    if (commitEnd > today || !m.cancelAt) continue;
    const ask = f.requests.find((r) => r.type === "cancel" && r.athleteIds.includes(m.athleteId) && r.status !== "declined");
    if (!ask) continue;
    const allowedEnd = [addDaysYmd(ask.sentOn, policy.cancellationNoticeDays), commitEnd].sort().reverse()[0];
    if (m.cancelAt <= allowedEnd) continue;
    const dates = billDatesBetween(addDaysYmd(allowedEnd, -1), addDaysYmd(m.cancelAt, -1), anchor(m));
    push({
      ...base(m),
      type: "commitment_locked",
      requestId: ask.id,
      detail: `Commitment ended ${commitEnd}; cancellation asked ${ask.sentOn}, so with ${policy.cancellationNoticeDays}-day notice the last billable date is ${allowedEnd}, but cancellation is set for ${m.cancelAt}.`,
      impactMinor: m.monthlyMinor == null ? null : dates.length * m.monthlyMinor,
      impactBasis: `${dates.length} extra bill date(s) between ${allowedEnd} and ${m.cancelAt}`,
      recommendation: `Move the cancellation to ${allowedEnd} (notice counted from the family's request date) and refund any period billed after it.`,
    });
  }

  // 6. Families with 2+ billed athletes missing the family discount (grouped by payer account).
  const byPayer = new Map<string, MRow[]>();
  let noPayer = 0;
  for (const m of live.filter((x) => x.billingProvider !== "none" && x.productKind === "recurring_membership")) {
    if (!m.payerAccountId) {
      noPayer++;
      continue;
    }
    byPayer.set(m.payerAccountId, [...(byPayer.get(m.payerAccountId) ?? []), m]);
  }
  for (const [, ms] of byPayer) {
    if (new Set(ms.map((m) => m.athleteId)).size < 2) continue;
    const sorted = [...ms].sort((a, b) => (b.monthlyMinor ?? 0) - (a.monthlyMinor ?? 0));
    for (const m of sorted.slice(1)) {
      if (m.discountId && m.discountActive !== false) continue;
      const pct = m.siblingPercentOff ?? policy.familyDiscountPercent;
      const unconfirmed = m.siblingPercentOff == null && policy.unconfirmed.includes("familyDiscountPercent");
      push({
        ...base(m),
        type: "family_discount_missing",
        detail: `${sorted.length} athletes billed to ${m.payerName ?? "this payer"}; ${m.athleteName}'s ${m.productName} has no family discount.`,
        impactMinor: m.monthlyMinor == null ? null : percentOf(m.monthlyMinor, pct),
        impactBasis: `per month (${pct}% of ${m.monthlyMinor == null ? "rate" : money(m.monthlyMinor)}${unconfirmed ? "; percent still needs owner confirmation" : ""})`,
        recommendation: `Apply the ${pct}% family discount (policy: once 2+ athletes in a family are enrolled) and review bills since the second athlete enrolled for a credit.`,
      });
    }
  }

  // 7. Billed while unsigned required documents block attendance.
  for (const m of billed) {
    const forms = f.docs.get(m.athleteId);
    if (!forms) continue;
    push({
      ...base(m),
      type: "unsigned_docs_billed",
      detail: `Required to book: ${forms} — not completed (or expired), so the athlete can't be booked while ${m.productName} bills.`,
      impactMinor: m.monthlyMinor,
      impactBasis: "per month billed while unable to book",
      recommendation: `Send ${forms} for signature (Documents) today and tell the family the athlete can't be booked until it's signed.`,
    });
  }

  // 8. Failing cards (provider-reported failures with no success since).
  for (const c of f.cards) {
    if (c.last_success && c.last_success > c.last_failed) continue;
    const ms = live.filter((m) => m.payerAccountId === c.payer_account_id);
    const names = [...new Set(ms.map((m) => m.athleteName))];
    push({
      type: "failing_card",
      athleteIds: [...new Set(ms.map((m) => m.athleteId))],
      athleteNames: names.join(", ") || "(no live membership)",
      personId: ms[0]?.personId ?? null,
      payerName: ms[0]?.payerName ?? null,
      membershipId: ms[0]?.id ?? null,
      requestId: null,
      detail: `${c.n_failed} failed charge(s) in the last 60 days, last ${localYmd(c.last_failed)}${c.reason ? ` (${c.reason})` : ""}; no successful payment since.`,
      impactMinor: c.open_minor > 0 ? c.open_minor : c.failed_minor,
      impactBasis: c.open_minor > 0 ? "open invoice balance" : "amount of the last failed charge",
      recommendation: "Ask the payer to update the card (never take card numbers by email/text); retry once updated. Check for a card-update request already logged.",
    });
  }

  // 9. Requests unprocessed for more than X days (repeat asks folded into the earliest one).
  const group = (t: MemberRequestType) => (t === "pause" ? "hold" : t);
  const open = f.requests.filter((r) => r.status === "new" || r.status === "in_progress");
  const memFor = (athleteIds: string[]) => billed.filter((m) => athleteIds.includes(m.athleteId));
  for (const r of open) {
    const days = daysUnprocessed(r.sentOn, null, today);
    if (days <= opts.unprocessedAfterDays) continue;
    const sameGroup = open.filter((o) => group(o.type) === group(r.type) && o.athleteIds.some((a) => r.athleteIds.includes(a)) && Math.abs(daysBetween(o.sentOn, r.sentOn)) <= opts.repeatWindowDays);
    const earliest = [...sameGroup].sort((a, b) => a.sentOn.localeCompare(b.sentOn) || a.id.localeCompare(b.id))[0];
    if (earliest.id !== r.id) continue;
    const ms = memFor(r.athleteIds);
    const names = r.athleteIds.map((id) => f.athletes.get(id)?.name).filter((x): x is string => !!x);
    const perMonth = BILL_AFFECTING_TYPES.includes(r.type) && ms.length ? ms.reduce((s, m) => s + (m.monthlyMinor ?? 0), 0) : null;
    push({
      type: "request_unprocessed",
      athleteIds: r.athleteIds,
      athleteNames: names.join(", ") || "(no athlete linked)",
      personId: ms[0]?.personId ?? f.athletes.get(r.athleteIds[0])?.personId ?? null,
      payerName: ms[0]?.payerName ?? null,
      membershipId: ms[0]?.id ?? null,
      requestId: r.id,
      detail: `${typeLabel(r.type)} request sent ${r.sentOn} is still ${r.status.replace("_", " ")}${r.suggested ? " (unconfirmed suggestion)" : ""} after ${days} days${sameGroup.length > 1 ? `; the family asked ${sameGroup.length} times` : ""}.`,
      impactMinor: perMonth,
      impactBasis: perMonth == null ? (BILL_AFFECTING_TYPES.includes(r.type) ? "not calculable: the athlete has no membership billing right now" : "no direct billing impact (respond for service)") : "per month the request sits (current billing)",
      recommendation: `Reply today and process it dated to ${r.sentOn} (when the family asked), not today${sameGroup.length > 1 ? `; apologize — they asked ${sameGroup.length} times` : ""}.`,
    });
  }

  // 10. Asked before a bill date, billed anyway.
  const attributed = new Set<string>();
  for (const r of [...f.requests].sort((a, b) => a.sentOn.localeCompare(b.sentOn))) {
    if (!["hold", "pause", "cancel", "in_season"].includes(r.type) || r.status === "declined") continue;
    const after = r.type === "cancel" ? addDaysYmd(r.sentOn, policy.cancellationNoticeDays - 1) : r.sentOn;
    const until = r.status === "resolved" && r.resolvedOn ? r.resolvedOn : today;
    for (const m of f.memberships.filter((x) => r.athleteIds.includes(x.athleteId) && x.productKind === "recurring_membership" && x.billingProvider !== "none" && x.startDate <= r.sentOn)) {
      const b = billedBetween(m, after, until, attributed);
      if (!b.count) continue;
      b.invoiceIds.forEach((id) => attributed.add(id));
      push({
        ...base(m),
        requestId: r.id,
        type: "request_billed_anyway",
        detail: `${typeLabel(r.type)} asked ${r.sentOn}${r.type === "cancel" ? ` (${policy.cancellationNoticeDays}-day notice → billable through ${after})` : ""}; ${m.productName} billed on ${b.dates.join(", ")} anyway${r.status === "resolved" ? ` before it was resolved ${r.resolvedOn}` : " and the request is still open"}.`,
        impactMinor: b.minor,
        impactBasis: b.estimated ? `${b.count} Zen Planner bill date(s) × plan rate (estimate — verify in Zen Planner)` : `${b.count} bill(s) after the request date`,
        recommendation: `Date the change to ${r.sentOn} (the family's request date) and credit or refund ${money(b.minor)} — or, per policy, convert unused sessions to a punch card valid ${policy.punchCardExpiryMonths} months. Apologize in writing.`,
      });
    }
  }

  out.sort((a, b) => (b.impactMinor ?? -1) - (a.impactMinor ?? -1) || a.athleteNames.localeCompare(b.athleteNames));

  const zp = live.filter(ext).length;
  const none = f.memberships.filter((m) => LIVE.includes(m.status) && m.billingProvider === "none").length;
  skipped.push(
    "Requests by phone (AI Call Recap emails), Facebook Messenger, forwarded email and the website form are only included when staff logged them in the Requests log — they never reach the Hub on their own.",
    "Attendance counts only attended visits (checked in / marked attended); booked, cancelled, late-cancelled and no-show reservations are not visits.",
  );
  if (zp) skipped.push(`${zp} Zen Planner-billed membership(s): the Hub has no bill history for them, so their amounts are estimates (bill dates on the anchor day × plan rate) and their card status is not visible here. Verify in Zen Planner.`);
  if (none) skipped.push(`${none} live membership(s) with no billing provider were skipped for billing checks.`);
  if (noPayer) skipped.push(`${noPayer} live membership(s) with no payer account were skipped for the family-discount check.`);
  if (uncapped) skipped.push(`${uncapped} live membership(s) have no weekly cap (unlimited or no credits) and were skipped for over-use.`);
  skipped.push(
    "Families are grouped by payer account for the family discount; siblings billed to separate payer accounts are not compared.",
    "In-season plans are recognized by plan name (\"In Season\"). Hold/in-season months use 30.44-day months.",
    `Policy used: dormant after ${policy.dormantAfterDays} days, hold max ${policy.holdMaxMonthsPerMembershipYear} mo/membership year, in-season max ${policy.inSeasonMaxMonthsPer365Days} mo/365 days, ${policy.cancellationNoticeDays}-day cancellation notice, family discount ${policy.familyDiscountPercent}%${policy.unconfirmed.length ? ` (unconfirmed: ${policy.unconfirmed.join(", ")})` : ""}.`,
    "Read-only: nothing was changed. Every recommendation needs a staff decision.",
  );
  return { exceptions: out, skipped, billedCount: billed.length };
}

/** Run the sweep for an org (or a set of athletes) as of a local date. */
export async function membershipAuditSweep(tx: Tx, orgId: string, opts: { today: string; athleteIds?: string[]; unprocessedAfterDays?: number }): Promise<AuditResult> {
  const policy = await membershipPolicy(tx, orgId);
  const { settings, tz } = await requestSettings(tx, orgId);
  const facts = await loadFacts(tx, orgId, opts.today, tz, opts.athleteIds);
  const { exceptions, skipped, billedCount } = detectExceptions(facts, policy, opts.today, {
    unprocessedAfterDays: opts.unprocessedAfterDays ?? settings.unprocessedAfterDays,
    repeatWindowDays: settings.repeatWindowDays,
  });
  const live = facts.memberships.filter((m) => LIVE.includes(m.status));
  return {
    asOf: opts.today,
    policy,
    exceptions,
    screened: {
      memberships: facts.memberships.length,
      live: live.length,
      billed: billedCount,
      athletes: new Set(facts.memberships.map((m) => m.athleteId)).size,
      requests: facts.requests.length,
      payers: new Set(live.map((m) => m.payerAccountId).filter(Boolean)).size,
    },
    skipped,
  };
}
