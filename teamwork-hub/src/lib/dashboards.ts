import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { accessibleAthleteIds, athleteCapabilities, coachAthleteIds, guardianLinks, payerAccountIdsFor, type Viewer } from "@/lib/authz/policy";
import { localDayBounds, todayLocal, addDaysYmd, DEFAULT_TZ } from "@/lib/time";

type Row = Record<string, unknown>;
const rows = async <T = Row>(tx: Tx, q: ReturnType<typeof sql>) => (await tx.execute(q)).rows as T[];

export type SessionSummary = { id: string; title: string; starts_at: string; ends_at: string; capacity: number; booked: number; waitlisted: number; checked_in: number; coach: string | null; status: string };

export async function todaysSessions(tx: Tx, orgId: string, opts: { coachUserId?: string; tz?: string; day?: string } = {}) {
  const tz = opts.tz ?? DEFAULT_TZ;
  const { start, end } = localDayBounds(opts.day ?? todayLocal(tz), tz);
  return rows<SessionSummary>(
    tx,
    sql`select s.id, s.title, s.starts_at, s.ends_at, s.capacity, s.status, u.display_name as coach,
          (select count(*)::int from bookings b where b.session_id = s.id and b.status in ('booked','attended','no_show')) as booked,
          (select count(*)::int from bookings b where b.session_id = s.id and b.status = 'waitlisted') as waitlisted,
          (select count(*)::int from bookings b where b.session_id = s.id and b.checked_in_at is not null) as checked_in
        from schedule_sessions s left join users u on u.id = s.coach_user_id
        where s.org_id = ${orgId} and s.starts_at >= ${start.toISOString()} and s.starts_at < ${end.toISOString()}
          ${opts.coachUserId ? sql`and s.coach_user_id = ${opts.coachUserId}` : sql``}
        order by s.starts_at`,
  );
}

/** Active athletes missing a completed, unexpired copy of each form template required for booking. */
export async function missingRequiredForms(tx: Tx, orgId: string, limit = 50) {
  return rows<{ athlete_id: string; person_id: string; name: string; template: string; status: string | null }>(
    tx,
    sql`select a.id as athlete_id, p.id as person_id, p.first_name || ' ' || p.last_name as name, ft.name as template,
          (select fr.status from form_requests fr join form_template_versions v on v.id = fr.template_version_id
            where fr.athlete_id = a.id and v.template_id = ft.id order by fr.created_at desc limit 1) as status
        from athletes a join people p on p.id = a.person_id
        cross join form_templates ft
        where a.org_id = ${orgId} and a.active and ft.org_id = ${orgId} and ft.active and ft.required_for_booking
          and not exists (
            select 1 from form_requests fr join form_template_versions v on v.id = fr.template_version_id
            where fr.athlete_id = a.id and v.template_id = ft.id and fr.status = 'completed'
              and (fr.expires_at is null or fr.expires_at > now()))
        order by p.last_name limit ${limit}`,
  );
}

export async function paymentExceptionsSummary(tx: Tx, orgId: string) {
  const [r] = await rows<{ past_due: number; past_due_minor: number; failed_attempts: number; pending_txn: number; pending_minor: number; webhook_failures: number }>(
    tx,
    sql`select
          (select count(*)::int from invoices where org_id = ${orgId} and status = 'open' and due_date < current_date) as past_due,
          (select coalesce(sum(i.total_minor - coalesce((select sum(t.amount_minor) from transactions t where t.invoice_id = i.id and t.status = 'settled' and t.kind in ('charge','manual_payment')),0)),0)::bigint
             from invoices i where i.org_id = ${orgId} and i.status = 'open' and i.due_date < current_date) as past_due_minor,
          (select count(*)::int from payment_attempts where org_id = ${orgId} and status = 'failed' and created_at > now() - interval '14 days') as failed_attempts,
          (select count(*)::int from transactions where org_id = ${orgId} and status = 'pending') as pending_txn,
          (select coalesce(sum(amount_minor),0)::bigint from transactions where org_id = ${orgId} and status = 'pending') as pending_minor,
          (select count(*)::int from webhook_events where status in ('failed','rejected') and received_at > now() - interval '14 days') as webhook_failures`,
  );
  return { ...r, past_due_minor: Number(r.past_due_minor), pending_minor: Number(r.pending_minor) };
}

export async function integrationHealth(tx: Tx, orgId: string) {
  const integrations = await rows<{ provider: string; status: string; mode: string; last_checked_at: string | null; last_error: string | null }>(
    tx,
    sql`select provider, status, mode, last_checked_at, last_error from integrations where org_id = ${orgId} order by provider`,
  );
  const [jobs] = await rows<{ dead: number; failing: number; pending: number }>(
    tx,
    sql`select count(*) filter (where status = 'dead')::int as dead,
               count(*) filter (where status = 'pending' and attempts > 0)::int as failing,
               count(*) filter (where status = 'pending')::int as pending
        from jobs where org_id = ${orgId} or org_id is null`,
  );
  const imports = await rows<{ id: string; source: string; entity_type: string; status: string; created_at: string }>(
    tx,
    sql`select id, source, entity_type, status, created_at from import_batches where org_id = ${orgId} order by created_at desc limit 5`,
  );
  const syncs = await rows<{ provider: string; status: string; started_at: string; error: string | null }>(
    tx,
    sql`select provider, status, started_at, error from sync_runs where org_id = ${orgId} order by started_at desc limit 5`,
  );
  return { integrations, jobs, imports, syncs };
}

export async function myOpenTasks(tx: Tx, v: Viewer, limit = 8) {
  return rows<{ id: string; title: string; due_at: string | null; priority: string; source: string; related_person_id: string | null; person: string | null }>(
    tx,
    sql`select t.id, t.title, t.due_at, t.priority, t.source, t.related_person_id, p.first_name || ' ' || p.last_name as person
        from tasks t left join people p on p.id = t.related_person_id
        where t.org_id = ${v.orgId} and t.assignee_user_id = ${v.userId} and t.status in ('open','in_progress')
        order by t.due_at asc nulls last, t.created_at limit ${limit}`,
  );
}

export async function leadSummary(tx: Tx, orgId: string) {
  const [r] = await rows<{ new_leads: number; open_leads: number; uncontacted_48h: number }>(
    tx,
    sql`select count(*) filter (where stage = 'new')::int as new_leads,
               count(*) filter (where converted_at is null and stage not in ('won','lost'))::int as open_leads,
               count(*) filter (where stage = 'new' and created_at < now() - interval '48 hours')::int as uncontacted_48h
        from leads where org_id = ${orgId}`,
  );
  return r;
}

export async function bodyReviewQueue(tx: Tx, v: Viewer) {
  const scope = await accessibleAthleteIds(tx, v, "health.review");
  if (scope !== "all" && scope.length === 0) return [];
  return rows<{ id: string; athlete_id: string; person_id: string; name: string; region: string; side: string; kind: string; severity: number; reported_at: string }>(
    tx,
    sql`select r.id, r.athlete_id, p.id as person_id, p.first_name || ' ' || p.last_name as name, r.region, r.side, r.kind, r.severity, r.reported_at
        from body_region_reports r join athletes a on a.id = r.athlete_id join people p on p.id = a.person_id
        where r.org_id = ${v.orgId} and r.review_status = 'new'
          ${scope === "all" ? sql`` : sql`and r.athlete_id in ${scope}`}
        order by r.severity desc, r.reported_at desc limit 10`,
  );
}

/** Coach overview for assigned athletes. */
export async function coachOverview(tx: Tx, v: Viewer, tz = DEFAULT_TZ) {
  const ids = await coachAthleteIds(tx, v);
  const today = todayLocal(tz);
  if (!ids.length) return { athleteCount: 0, wellness: { answered: 0, total: 0 }, toReview: [], recentTests: [], today };
  const [w] = await rows<{ answered: number }>(
    tx,
    sql`select count(distinct athlete_id)::int as answered from questionnaire_responses where for_date = ${today} and athlete_id in ${ids}`,
  );
  const toReview = await rows<{ id: string; title: string; completed_at: string; name: string; person_id: string; session_rpe: number | null }>(
    tx,
    sql`select w.id, w.title, w.completed_at, w.session_rpe, p.id as person_id, p.first_name || ' ' || p.last_name as name
        from workouts w join athletes a on a.id = w.athlete_id join people p on p.id = a.person_id
        where w.athlete_id in ${ids} and w.status = 'completed' and w.coach_reviewed_at is null
        order by w.completed_at desc nulls last limit 8`,
  );
  const recentTests = await rows<{ id: string; tested_at: string; test: string; name: string; athlete_id: string; source: string }>(
    tx,
    sql`select ts.id, ts.tested_at, tt.name as test, p.first_name || ' ' || p.last_name as name, ts.athlete_id, ts.source
        from test_sessions ts join test_types tt on tt.id = ts.test_type_id join athletes a on a.id = ts.athlete_id join people p on p.id = a.person_id
        where ts.athlete_id in ${ids} and ts.tested_at > now() - interval '21 days'
        order by ts.tested_at desc limit 8`,
  );
  return { athleteCount: ids.length, wellness: { answered: w?.answered ?? 0, total: ids.length }, toReview, recentTests, today };
}

export type FamilyChild = { athleteId: string; personId: string; name: string; caps: string[] };

/** Children (or self) a family viewer can act for, with their capabilities. */
export async function familyAthletes(tx: Tx, v: Viewer): Promise<FamilyChild[]> {
  const out: FamilyChild[] = [];
  if (v.role === "guardian") {
    for (const link of await guardianLinks(tx, v)) {
      const [p] = await rows<{ id: string; name: string }>(tx, sql`select p.id, p.first_name || ' ' || p.last_name as name from athletes a join people p on p.id = a.person_id where a.id = ${link.athleteId}`);
      out.push({ athleteId: link.athleteId, personId: p.id, name: p.name, caps: [...(await athleteCapabilities(tx, v, link.athleteId))] });
    }
  } else if (v.role === "athlete" && v.personId) {
    const [a] = await rows<{ id: string; name: string }>(tx, sql`select a.id, p.first_name || ' ' || p.last_name as name from athletes a join people p on p.id = a.person_id where a.person_id = ${v.personId}`);
    if (a) out.push({ athleteId: a.id, personId: v.personId, name: a.name, caps: [...(await athleteCapabilities(tx, v, a.id))] });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function familyChildSummary(tx: Tx, v: Viewer, child: FamilyChild, tz = DEFAULT_TZ) {
  const today = todayLocal(tz);
  const { start } = localDayBounds(today, tz);
  const { start: horizon } = localDayBounds(addDaysYmd(today, 14), tz);
  const upcoming = await rows<{ id: string; title: string; starts_at: string; status: string; waitlist_position: number | null }>(
    tx,
    sql`select b.id, s.title, s.starts_at, b.status, b.waitlist_position from bookings b join schedule_sessions s on s.id = b.session_id
        where b.athlete_id = ${child.athleteId} and b.status in ('booked','waitlisted') and s.starts_at >= ${start.toISOString()} and s.starts_at < ${horizon.toISOString()}
        order by s.starts_at limit 6`,
  );
  const forms = child.caps.includes("forms.sign")
    ? await rows<{ id: string; title: string; status: string; due_date: string | null }>(
        tx,
        sql`select fr.id, v.title, fr.status, fr.due_date from form_requests fr join form_template_versions v on v.id = fr.template_version_id
            where fr.athlete_id = ${child.athleteId} and fr.status in ('pending','partially_signed') order by fr.due_date nulls last`,
      )
    : [];
  const workouts = child.caps.includes("training.read")
    ? await rows<{ id: string; title: string; scheduled_date: string; status: string }>(
        tx,
        sql`select id, title, scheduled_date, status from workouts where athlete_id = ${child.athleteId} and scheduled_date between ${addDaysYmd(today, -14)} and ${today}
            order by scheduled_date desc limit 5`,
      )
    : [];
  const [credits] = await rows<{ available: number }>(
    tx,
    sql`select coalesce(sum(available),0)::int as available from credit_buckets where athlete_id = ${child.athleteId} and status = 'active' and (expires_at is null or expires_at > now())`,
  );
  const [membership] = await rows<{ name: string; status: string; unlimited: boolean }>(
    tx,
    sql`select p.name, m.status, pv.unlimited from memberships m join product_versions pv on pv.id = m.product_version_id join products p on p.id = pv.product_id
        where m.athlete_id = ${child.athleteId} and m.status in ('active','trialing','on_hold','past_due') order by m.start_date desc limit 1`,
  );
  return { upcoming, forms, workouts, credits: credits?.available ?? 0, membership: membership ?? null, today };
}

export async function familyBilling(tx: Tx, v: Viewer) {
  const payerIds = await payerAccountIdsFor(tx, v, "view");
  if (!payerIds.length) return { open: [], canPayIds: [] as string[] };
  const canPayIds = await payerAccountIdsFor(tx, v, "pay");
  const open = await rows<{ id: string; number: string; total_minor: number; currency: string; due_date: string | null; payer_account_id: string }>(
    tx,
    sql`select id, number, total_minor, currency, due_date, payer_account_id from invoices where payer_account_id in ${payerIds} and status = 'open' order by due_date nulls last limit 10`,
  );
  return { open: open.map((o) => ({ ...o, total_minor: Number(o.total_minor) })), canPayIds };
}

export async function unreadThreads(tx: Tx, v: Viewer) {
  const [r] = await rows<{ n: number }>(
    tx,
    sql`select count(*)::int as n from thread_participants tp join threads t on t.id = tp.thread_id
        where (tp.user_id = ${v.userId} ${v.personId ? sql`or tp.person_id = ${v.personId}` : sql``})
          and t.last_message_at is not null and (tp.last_read_at is null or tp.last_read_at < t.last_message_at)`,
  );
  return r?.n ?? 0;
}

export async function athleteToday(tx: Tx, athleteId: string, tz = DEFAULT_TZ) {
  const today = todayLocal(tz);
  const workouts = await rows<{ id: string; title: string; status: string }>(tx, sql`select id, title, status from workouts where athlete_id = ${athleteId} and scheduled_date = ${today} order by created_at`);
  const [checkin] = await rows<{ n: number }>(tx, sql`select count(*)::int as n from questionnaire_responses where athlete_id = ${athleteId} and for_date = ${today}`);
  const habits = await rows<{ id: string; name: string; status: string | null }>(
    tx,
    sql`select h.id, h.name, (select c.status from habit_checkins c where c.habit_id = h.id and c.athlete_id = ${athleteId} and c.for_date = ${today}) as status
        from habits h where h.active and exists (
          select 1 from habit_assignments ha left join group_members gm on gm.group_id = ha.group_id
          where ha.habit_id = h.id and (ha.athlete_id = ${athleteId} or gm.athlete_id = ${athleteId})
            and ha.start_date <= ${today} and (ha.end_date is null or ha.end_date >= ${today}))
        order by h.name`,
  );
  const goals = await rows<{ id: string; title: string; due_date: string | null; status: string }>(
    tx,
    sql`select id, title, due_date, status from goals where athlete_id = ${athleteId} and status = 'active' order by due_date nulls last limit 5`,
  );
  return { workouts, checkedIn: (checkin?.n ?? 0) > 0, habits, goals, today };
}
