import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { membershipPolicy } from "@/lib/membership-policy";
import { percentOf } from "@/lib/money";
import { addDaysYmd, daysBetween, localDayBounds, localYmd } from "@/lib/time";
import { addMonthsYmd } from "@/lib/billing/util";
import { billDatesBetween, isInSeasonPlan, monthlyEquivalent, monthsBetween, requestSettings, weeklyCap } from "./common";
import { membershipAuditSweep, type MembershipException } from "./membership-audit";
import { canManageRequests, listRequests, type RequestRow } from "./requests";

/**
 * One read-only report per athlete: WHO / CORRESPONDENCE / ATTENDANCE / MEMBERSHIP /
 * RATE vs USAGE / FLAGS / RECOMMENDED. Never changes anything. Staff with billing.view_all.
 */

type R = Record<string, unknown>;
const rowsOf = async <T = R>(tx: Tx, q: SQL) => (await tx.execute(q)).rows as T[];
const ymd = (x: unknown) => (x == null ? null : x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));
const inList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}`), sql`, `);
const LIVE = ["pending", "trialing", "active", "on_hold", "past_due"];

export type StatusReport = Awaited<ReturnType<typeof membershipStatusReport>>;

export async function membershipStatusReport(tx: Tx, v: Viewer, personId: string, today?: string) {
  assertCan(v, "billing.view_all");
  const policy = await membershipPolicy(tx, v.orgId);
  const { tz } = await requestSettings(tx, v.orgId);
  const t = today ?? localYmd(new Date(), tz);

  const [ath] = await rowsOf(
    tx,
    sql`select a.id, a.active, a.sport, p.id as person_id, p.first_name, p.last_name, p.email, p.phone, p.date_of_birth
        from athletes a join people p on p.id = a.person_id where a.person_id = ${personId} and a.org_id = ${v.orgId}`,
  );
  if (!ath) return null;
  const athleteId = ath.id as string;

  // ---------------------------------------------------------------- WHO
  const guardians = await rowsOf<{ person_id: string; name: string; relationship: string; email: string | null; phone: string | null; can_book: boolean }>(
    tx,
    sql`select p.id as person_id, p.first_name || ' ' || p.last_name as name, g.relationship, p.email, p.phone, g.can_book
        from guardianships g join people p on p.id = g.guardian_person_id
        where g.athlete_id = ${athleteId} and g.org_id = ${v.orgId} and g.status = 'active' order by p.last_name, p.first_name`,
  );
  const payers = await rowsOf<{ id: string; name: string; billing_email: string | null; people: string | null }>(
    tx,
    sql`select pa.id, pa.name, pa.billing_email,
          (select string_agg(p.first_name || ' ' || p.last_name || case when z.can_pay then '' else ' (view only)' end, ', ' order by p.last_name)
             from payer_authorizations z join people p on p.id = z.person_id where z.payer_account_id = pa.id) as people
        from payer_beneficiaries pb join payer_accounts pa on pa.id = pb.payer_account_id
        where pb.athlete_id = ${athleteId} and pa.org_id = ${v.orgId} order by pa.name`,
  );
  const guardianIds = guardians.map((g) => g.person_id);
  const payerIds = payers.map((p) => p.id);
  const siblings = await rowsOf<{ athlete_id: string; person_id: string; name: string; active: boolean; plan: string | null; status: string | null }>(
    tx,
    sql`select a.id as athlete_id, p.id as person_id, p.first_name || ' ' || p.last_name as name, a.active,
          (select pr.name from memberships m join product_versions pv on pv.id = m.product_version_id join products pr on pr.id = pv.product_id
            where m.athlete_id = a.id and m.status in ('pending','trialing','active','on_hold','past_due') order by m.start_date desc limit 1) as plan,
          (select m.status from memberships m where m.athlete_id = a.id and m.status in ('pending','trialing','active','on_hold','past_due') order by m.start_date desc limit 1) as status
        from athletes a join people p on p.id = a.person_id
        where a.org_id = ${v.orgId} and a.id <> ${athleteId} and (
          ${guardianIds.length ? sql`exists (select 1 from guardianships g where g.athlete_id = a.id and g.status = 'active' and g.guardian_person_id in (${inList(guardianIds)}))` : sql`false`}
          or ${payerIds.length ? sql`exists (select 1 from payer_beneficiaries pb where pb.athlete_id = a.id and pb.payer_account_id in (${inList(payerIds)}))` : sql`false`})
        order by p.first_name`,
  );

  // ---------------------------------------------------------------- CORRESPONDENCE
  const familyPeople = [personId, ...guardianIds];
  const contacts = await rowsOf<{ id: string; thread_id: string; subject: string; created_at: Date | string; body: string; inbound_channel: string | null; sender: string | null; is_staff: boolean }>(
    tx,
    sql`select m.id, m.thread_id, t.subject, m.created_at, m.body, m.inbound_channel,
          coalesce(u.display_name, sp.first_name || ' ' || sp.last_name) as sender,
          coalesce(u.role in ('owner','admin','operations','coach'), false) as is_staff
        from messages m join threads t on t.id = m.thread_id
        left join users u on u.id = m.sender_user_id left join people sp on sp.id = m.sender_person_id
        where t.org_id = ${v.orgId} and t.kind <> 'staff' and not m.is_internal_note
          and (t.athlete_id = ${athleteId} or exists (select 1 from thread_participants tp where tp.thread_id = t.id and tp.person_id in (${inList(familyPeople)})))
        order by m.created_at desc limit 12`,
  );
  const lastIn = contacts.find((c) => !c.is_staff);
  const lastOut = contacts.find((c) => c.is_staff);
  const requests: RequestRow[] = canManageRequests(v) ? (await listRequests(tx, v, { view: "all", athleteId }, t)).rows.filter((r) => r.status !== "dismissed") : [];

  // ---------------------------------------------------------------- MEMBERSHIP
  const mRows = await rowsOf(
    tx,
    sql`select m.id, m.status, m.start_date, m.end_date, m.cancel_at, m.next_bill_date, m.billing_anchor_day, m.billing_provider, m.payer_account_id,
          pr.name as product, pr.kind, pv.price_minor, pv.interval, pv.interval_count, pv.credits_per_period, pv.unlimited, pv.commitment_months, pv.cancellation_notice_days,
          d.name as discount_name, d.kind as discount_kind, d.value as discount_value, d.active as discount_active
        from memberships m join product_versions pv on pv.id = m.product_version_id join products pr on pr.id = pv.product_id
        left join discounts d on d.id = m.discount_id
        where m.athlete_id = ${athleteId} and m.org_id = ${v.orgId}
        order by case when m.status in ('pending','trialing','active','on_hold','past_due') then 0 else 1 end, m.start_date desc`,
  );
  const mIds = mRows.map((m) => m.id as string);
  const invRows = mIds.length
    ? await rowsOf(
        tx,
        sql`select i.id, i.membership_id, i.number, i.period_start, i.period_end, i.total_minor, i.discount_minor, i.status,
              coalesce((select sum(tr.amount_minor) from transactions tr where tr.invoice_id = i.id and tr.status = 'settled' and tr.kind in ('charge','manual_payment')),0)::bigint as paid_minor
            from invoices i where i.membership_id in (${inList(mIds)}) order by i.period_start desc nulls last limit 60`,
      )
    : [];
  const holdRows = mIds.length ? await rowsOf(tx, sql`select membership_id, start_date, end_date, reason, requested_at from membership_holds where membership_id in (${inList(mIds)}) order by start_date desc`) : [];
  const memberships = mRows.map((m) => {
    const price = Number(m.price_minor);
    const discount = m.discount_kind && m.discount_active !== false ? (m.discount_kind === "percent" ? percentOf(price, Number(m.discount_value)) : Math.min(Number(m.discount_value), price)) : 0;
    const net = price - discount;
    const interval = m.interval as "none" | "week" | "month" | "year";
    const monthly = monthlyEquivalent(net, interval, Number(m.interval_count));
    const start = ymd(m.start_date)!;
    const endOrToday = [ymd(m.end_date), t].filter((x): x is string => !!x).sort()[0];
    const commitment = Number(m.commitment_months ?? 0);
    const served = monthsBetween(start, endOrToday);
    const commitEnd = commitment > 0 ? addMonthsYmd(start, commitment) : null;
    const remaining = commitment > 0 ? Math.max(0, monthsBetween(t, commitEnd!)) : 0;
    const live = LIVE.includes(m.status as string);
    const invs = invRows
      .filter((i) => i.membership_id === m.id)
      .map((i) => ({ id: i.id as string, number: i.number as string, periodStart: ymd(i.period_start), periodEnd: ymd(i.period_end), totalMinor: Number(i.total_minor), discountMinor: Number(i.discount_minor), paidMinor: Number(i.paid_minor), status: i.status as string }));
    const counts = new Map<number, number>();
    for (const i of invs.filter((x) => x.status !== "void")) counts.set(i.totalMinor, (counts.get(i.totalMinor) ?? 0) + 1);
    const usual = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? null;
    return {
      id: m.id as string,
      product: m.product as string,
      status: m.status as string,
      live,
      inSeason: isInSeasonPlan(m.product as string),
      billingProvider: m.billing_provider as string,
      priceMinor: price,
      discountName: (m.discount_name as string) ?? null,
      netMinor: net,
      interval,
      intervalCount: Number(m.interval_count),
      monthlyMinor: monthly,
      weeklyCap: weeklyCap({ productName: m.product as string, creditsPerPeriod: m.credits_per_period == null ? null : Number(m.credits_per_period), unlimited: !!m.unlimited, interval, intervalCount: Number(m.interval_count) }),
      unlimited: !!m.unlimited,
      startDate: start,
      endDate: ymd(m.end_date),
      cancelAt: ymd(m.cancel_at),
      nextBillDate: ymd(m.next_bill_date),
      anchorDay: m.billing_anchor_day == null ? policy.billingAnchorDay : Number(m.billing_anchor_day),
      commitmentMonths: commitment,
      commitmentEnd: commitEnd,
      monthsServed: served,
      monthsRemaining: remaining,
      remainingContractMinor: monthly == null ? null : remaining * monthly,
      monthToMonthSince: commitment > 0 && commitEnd! <= t && policy.commitmentRollsToMonthToMonth ? commitEnd : null,
      holds: holdRows.filter((h) => h.membership_id === m.id).map((h) => ({ startDate: ymd(h.start_date)!, endDate: ymd(h.end_date)!, reason: (h.reason as string) ?? null })),
      usualBillMinor: usual,
      invoices: invs.map((i) => ({ ...i, differs: i.status !== "void" && usual != null && i.totalMinor !== usual })),
    };
  });
  const current = memberships.find((m) => m.live) ?? null;

  // Open requests: has a bill date passed since the family asked?
  const openRequests = requests
    .filter((r) => r.status === "new" || r.status === "in_progress")
    .map((r) => {
      const dates = [
        ...new Set(
          memberships
            .filter((m) => m.live && m.billingProvider !== "none" && m.startDate <= t)
            .flatMap((m) => billDatesBetween(r.sentOn, t, m.anchorDay)),
        ),
      ].sort();
      return { ...r, billDatesPassed: dates };
    });

  // ---------------------------------------------------------------- ATTENDANCE
  const end = localDayBounds(t, tz).end.toISOString();
  const from = localDayBounds(addDaysYmd(t, -400), tz).start.toISOString();
  const visits = (
    await rowsOf<{ starts_at: Date | string; service: string }>(
      tx,
      sql`select s.starts_at, st.name as service from bookings b join schedule_sessions s on s.id = b.session_id join service_types st on st.id = s.service_type_id
          where b.athlete_id = ${athleteId} and b.org_id = ${v.orgId} and b.status = 'attended' and s.status <> 'cancelled' and s.starts_at >= ${from} and s.starts_at < ${end}
          order by s.starts_at`,
    )
  ).map((x) => ({ day: localYmd(new Date(x.starts_at), tz), service: x.service }));
  const [notVisits] = await rowsOf<{ cancelled: number; late_cancelled: number; no_show: number; booked: number }>(
    tx,
    sql`select count(*) filter (where b.status = 'cancelled')::int as cancelled, count(*) filter (where b.status = 'late_cancelled')::int as late_cancelled,
          count(*) filter (where b.status = 'no_show')::int as no_show, count(*) filter (where b.status = 'booked')::int as booked
        from bookings b join schedule_sessions s on s.id = b.session_id
        where b.athlete_id = ${athleteId} and b.org_id = ${v.orgId} and s.starts_at >= ${localDayBounds(addDaysYmd(t, -59), tz).start.toISOString()} and s.starts_at < ${end}`,
  );
  const [lastEver] = await rowsOf<{ last_at: Date | string | null }>(
    tx,
    sql`select max(s.starts_at) as last_at from bookings b join schedule_sessions s on s.id = b.session_id
        where b.athlete_id = ${athleteId} and b.org_id = ${v.orgId} and b.status = 'attended' and s.status <> 'cancelled' and s.starts_at < ${end}`,
  );
  const lastVisit = lastEver?.last_at ? localYmd(new Date(lastEver.last_at), tz) : null;
  const inLast = (n: number) => visits.filter((x) => x.day > addDaysYmd(t, -n)).length;
  const perMonth: { month: string; visits: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const mo = addMonthsYmd(`${t.slice(0, 7)}-01`, -i).slice(0, 7);
    perMonth.push({ month: mo, visits: visits.filter((x) => x.day.startsWith(mo)).length });
  }
  // Current term: the current commitment cycle, else (month-to-month) the last 90 days or since start.
  let termStart: string | null = null;
  let termLabel = "";
  if (current) {
    if (current.commitmentMonths > 0 && !current.monthToMonthSince) {
      const cycles = Math.floor(monthsBetween(current.startDate, t) / current.commitmentMonths);
      termStart = addMonthsYmd(current.startDate, cycles * current.commitmentMonths);
      termLabel = `current ${current.commitmentMonths}-month commitment term`;
    } else {
      const ninety = addDaysYmd(t, -89);
      termStart = current.startDate > ninety ? current.startDate : ninety;
      termLabel = current.startDate > ninety ? "since the membership started" : "last 90 days (month-to-month)";
    }
  }
  const termVisits = termStart ? visits.filter((x) => x.day >= termStart!).length : 0;
  const termWeeks = termStart ? Math.max(1, (daysBetween(termStart, t) + 1) / 7) : null;
  const gapWindowStart = [addDaysYmd(t, -364), memberships.length ? memberships.map((m) => m.startDate).sort()[0] : t].sort().reverse()[0];
  const gaps: { from: string; to: string; days: number; ongoing: boolean }[] = [];
  const days = [...new Set(visits.map((x) => x.day))].filter((d) => d >= gapWindowStart);
  for (let i = 1; i < days.length; i++) {
    const g = daysBetween(days[i - 1], days[i]);
    if (g > policy.attendanceGapDays) gaps.push({ from: days[i - 1], to: days[i], days: g, ongoing: false });
  }
  const trailingFrom = lastVisit ?? current?.startDate ?? null;
  if (trailingFrom && daysBetween(trailingFrom, t) > policy.attendanceGapDays) gaps.push({ from: trailingFrom, to: t, days: daysBetween(trailingFrom, t), ongoing: true });

  // ---------------------------------------------------------------- FLAGS (shared detectors, scoped to the family)
  const audit = await membershipAuditSweep(tx, v.orgId, { today: t, athleteIds: [athleteId, ...siblings.map((s) => s.athlete_id)] });
  const flags: MembershipException[] = audit.exceptions.filter((e) => e.athleteIds.includes(athleteId));

  // ---------------------------------------------------------------- RATE vs USAGE
  const avgPerWeek = termWeeks ? termVisits / termWeeks : null;
  const daysSinceVisit = lastVisit ? daysBetween(lastVisit, t) : null;
  const billedNow = current && (current.status === "active" || current.status === "past_due") && current.billingProvider !== "none" && !current.holds.some((h) => h.startDate <= t && h.endDate >= t);
  const rateVsUsage = current
    ? {
        monthlyMinor: current.monthlyMinor,
        weeklyCap: current.weeklyCap,
        avgPerWeek,
        visits30: inLast(30),
        costPerVisit30Minor: current.monthlyMinor != null && inLast(30) > 0 ? Math.round(current.monthlyMinor / inLast(30)) : null,
        payingNotAttending: !!billedNow && (daysSinceVisit == null ? daysBetween(current.startDate, t) >= policy.dormantAfterDays : daysSinceVisit >= policy.dormantAfterDays),
        aboveCap: flags.some((f) => f.type === "over_cap_usage"),
      }
    : null;

  // ---------------------------------------------------------------- RECOMMENDED
  const recommended = [...new Set(flags.map((f) => f.recommendation))];

  return {
    asOf: t,
    policy,
    who: {
      athlete: { athleteId, personId, name: `${ath.first_name} ${ath.last_name}`, email: (ath.email as string) ?? null, phone: (ath.phone as string) ?? null, active: !!ath.active, sport: (ath.sport as string) ?? null },
      guardians,
      payers,
      siblings,
    },
    correspondence: {
      lastInbound: lastIn ? { at: new Date(lastIn.created_at), threadId: lastIn.thread_id } : null,
      lastOutbound: lastOut ? { at: new Date(lastOut.created_at), threadId: lastOut.thread_id } : null,
      contacts: contacts.map((c) => ({
        id: c.id,
        threadId: c.thread_id,
        subject: c.subject,
        at: new Date(c.created_at),
        direction: c.is_staff ? ("out" as const) : ("in" as const),
        sender: c.sender,
        channel: c.inbound_channel ?? "in_app",
        snippet: c.body.length > 160 ? `${c.body.slice(0, 160)}…` : c.body,
      })),
      openRequests,
      closedRequests: requests.filter((r) => r.status === "resolved" || r.status === "declined").slice(0, 10),
      requestsVisible: canManageRequests(v),
    },
    attendance: {
      lastVisit,
      daysSinceVisit,
      visits30: inLast(30),
      visits60: inLast(60),
      perMonth,
      termStart,
      termLabel,
      termVisits,
      avgPerWeek,
      gaps,
      notVisits60: notVisits ?? { cancelled: 0, late_cancelled: 0, no_show: 0, booked: 0 },
    },
    memberships,
    current,
    rateVsUsage,
    flags,
    recommended,
    skipped: audit.skipped,
  };
}
