/**
 * Journey generator: turns real events (a membership starting, a hold, a cancellation, a visit
 * count, a 5-star rating) into checklist steps, and ticks steps the system can already see are
 * done. One function, `syncJourneys`, used by the nightly job, by "Refresh" on the follow-ups
 * page and (for one athlete) by the profile panel.
 *
 * Idempotent: journeys are unique per (org, anchor key), steps per (journey, step key), tasks per
 * (org, dedupe key), and the whole pass holds a per-organization advisory lock. Running it twice
 * creates nothing new.
 *
 * Sends nothing: it only writes journeys, tasks and journey_steps.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db";
import { journeySteps, journeys, organizations, tasks, type JourneyKind } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { Viewer } from "@/lib/authz/policy";
import { retentionRadar } from "@/lib/retention/radar";
import { DEFAULT_TZ, addDaysYmd, localDayBounds, localYmd, todayLocal } from "@/lib/time";
import { currentStint, isAutoRule, journeySettingsFrom, shiftForHolds, stepDueOn, type AutoRule, type JourneySettings, type TemplateStep } from "./templates";

const LIVE = ["trialing", "active", "on_hold", "past_due"];
const rowsOf = async <T>(tx: Tx, q: SQL) => (await tx.execute(q)).rows as T[];
const ymd = (x: unknown) => (x == null ? null : x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));
const inList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}`), sql`, `);

export type SyncResult = { date: string; journeysCreated: number; stepsCreated: number; autoCompleted: number; moved: number; closed: number; journeysCompleted: number };

/** Read-only viewer used to ask the retention radar for the whole organization. */
const systemViewer = (orgId: string): Viewer => ({ userId: "00000000-0000-0000-0000-000000000000", orgId, role: "owner", personId: null, displayName: "System", mfaVerified: true });

export async function journeyContext(tx: Tx, orgId: string): Promise<{ settings: JourneySettings; tz: string; orgSettings: Record<string, unknown> }> {
  const [o] = await tx.select({ settings: organizations.settings, tz: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId));
  return { settings: journeySettingsFrom(o?.settings), tz: o?.tz || DEFAULT_TZ, orgSettings: o?.settings ?? {} };
}

type M = { id: string; athleteId: string; status: string; kind: string; startDate: string; endDate: string | null; cancelAt: string | null; cancelReason: string | null; payerAccountId: string | null; providerSubscriptionId: string | null; endedOn: string | null; cancelEventOn: string | null };
type Hold = { id: string; membershipId: string; athleteId: string; startDate: string; endDate: string; reason: string | null };
type StepRow = { taskId: string; journeyId: string; athleteId: string; kind: JourneyKind; stepKey: string; autoRule: string | null; dueOn: string; originalDueOn: string | null; suppressed: boolean; status: string };
type JRow = { id: string; athleteId: string; kind: JourneyKind; anchorKey: string; anchorId: string | null; startedOn: string; status: string };

/** Everything the auto-complete rules read about one athlete. Never health data. */
export type RuleFacts = {
  /** Staff-written messages to the family (instants). */
  staffMessages: Date[];
  pendingForms: number;
  completedForms: number;
  hasPaymentMethod: boolean;
  /** Session start times of live bookings (booked / attended / no-show). */
  bookedStarts: Date[];
  attendedStarts: Date[];
  coachAssigned: boolean;
  programAssigned: boolean;
  inGroup: boolean;
  /** Facility-local dates of shoutouts that are still posted. */
  shoutoutDays: string[];
};

export type RuleTarget = {
  /** Facility-local start date of the journey. */
  startedOn: string;
  startInstant: Date;
  /** Visit milestone steps: local date the count was reached. */
  reachedOn?: string | null;
  hold?: { reason: string | null; endDate: string | null; reminderRan: boolean } | null;
  membership?: { cancelReason: string | null; lostReasonLogged: boolean; openInvoices: number } | null;
};

/**
 * Pure: is this rule satisfied? Returns the moment it became true when the system knows it
 * (so "time to complete" is honest), else `true`.
 */
export function evaluateRule(rule: AutoRule, f: RuleFacts, t: RuleTarget): Date | boolean {
  const first = (xs: Date[], from: Date) => xs.filter((x) => x >= from).sort((a, b) => a.getTime() - b.getTime())[0] ?? false;
  // A first session is often booked before the membership's start date (a trial week): look back two weeks.
  const sessionFloor = new Date(t.startInstant.getTime() - 14 * 86_400_000);
  switch (rule) {
    case "staff_message_sent":
      return first(f.staffMessages, t.startInstant);
    case "documents_signed":
      return f.completedForms > 0 && f.pendingForms === 0;
    case "payment_method_on_file":
      return f.hasPaymentMethod;
    case "first_session_booked":
      return f.bookedStarts.some((x) => x >= sessionFloor);
    case "first_session_attended":
      return first(f.attendedStarts, sessionFloor);
    case "coach_assigned":
      return f.coachAssigned;
    case "program_assigned":
      return f.programAssigned;
    case "shoutout_posted":
      return !!t.reachedOn && f.shoutoutDays.some((d) => d >= t.reachedOn!);
    case "hold_reason_recorded":
      return !!t.hold?.reason?.trim();
    case "hold_return_date_set":
      return !!t.hold?.endDate;
    case "hold_return_reminder":
      return !!t.hold?.reminderRan;
    case "cancel_reason_recorded":
      return !!t.membership && (!!t.membership.cancelReason?.trim() || t.membership.lostReasonLogged);
    case "final_bill_settled":
      return !!t.membership && t.membership.openInvoices === 0;
    case "removed_from_program_groups":
      return !f.programAssigned && !f.inGroup;
  }
}

const emptyFacts = (): RuleFacts => ({ staffMessages: [], pendingForms: 0, completedForms: 0, hasPaymentMethod: false, bookedStarts: [], attendedStarts: [], coachAssigned: false, programAssigned: false, inGroup: false, shoutoutDays: [] });

/**
 * Generate and auto-complete for one organization (optionally only some athletes).
 * `today` is the facility-local date; `now` the instant written on auto-completions.
 */
export async function syncJourneys(tx: Tx, orgId: string, opts: { today?: string; now?: Date; athleteIds?: string[] } = {}): Promise<SyncResult> {
  const { settings, tz } = await journeyContext(tx, orgId);
  const now = opts.now ?? new Date();
  const today = opts.today ?? todayLocal(tz, now);
  const out: SyncResult = { date: today, journeysCreated: 0, stepsCreated: 0, autoCompleted: 0, moved: 0, closed: 0, journeysCompleted: 0 };
  if (opts.athleteIds && !opts.athleteIds.length) return out;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"journey:" + orgId}))`);
  const sc = (col: SQL) => (opts.athleteIds ? sql`and ${col} in (${inList(opts.athleteIds)})` : sql``);
  const endOfDay = (d: string) => localDayBounds(d, tz).end;
  const startOfDay = (d: string) => localDayBounds(d, tz).start;
  const floor = addDaysYmd(today, -settings.backfillDays);

  // ---- facts ---------------------------------------------------------------------------------
  const people = new Map<string, { personId: string; name: string }>();
  for (const r of await rowsOf<{ id: string; person_id: string; name: string }>(
    tx,
    sql`select a.id, a.person_id, p.first_name || ' ' || p.last_name as name from athletes a join people p on p.id = a.person_id where a.org_id = ${orgId} ${sc(sql`a.id`)}`,
  ))
    people.set(r.id, { personId: r.person_id, name: r.name });

  const ms: M[] = (
    await rowsOf<Record<string, unknown>>(
      tx,
      sql`select m.id, m.athlete_id, m.status, m.kind, m.start_date, m.end_date, m.cancel_at, m.cancel_reason, m.payer_account_id, m.provider_subscription_id,
            (m.updated_at at time zone ${tz})::date as updated_on,
            (select min((e.created_at at time zone ${tz})::date) from membership_events e where e.membership_id = m.id and e.type in ('cancelled','cancel_scheduled')) as cancel_event_on
          from memberships m where m.org_id = ${orgId} and m.status <> 'pending' ${sc(sql`m.athlete_id`)}`,
    )
  ).map((r) => {
    const ended = r.status === "cancelled" || r.status === "expired";
    return {
      id: r.id as string,
      athleteId: r.athlete_id as string,
      status: r.status as string,
      kind: r.kind as string,
      startDate: ymd(r.start_date)!,
      endDate: ymd(r.end_date),
      cancelAt: ymd(r.cancel_at),
      cancelReason: (r.cancel_reason as string) ?? null,
      payerAccountId: (r.payer_account_id as string) ?? null,
      providerSubscriptionId: (r.provider_subscription_id as string) ?? null,
      // Same rule as the retention reports: end date, else cancel date, else the day it was marked ended.
      endedOn: ended ? (ymd(r.end_date) ?? ymd(r.cancel_at) ?? ymd(r.updated_on)) : null,
      cancelEventOn: ymd(r.cancel_event_on),
    };
  });
  const msByAthlete = new Map<string, M[]>();
  for (const m of ms) msByAthlete.set(m.athleteId, [...(msByAthlete.get(m.athleteId) ?? []), m]);
  const msById = new Map(ms.map((m) => [m.id, m]));
  const isLive = (m: M) => LIVE.includes(m.status) && m.startDate <= today;

  const holds: Hold[] = (
    await rowsOf<Record<string, unknown>>(
      tx,
      sql`select h.id, h.membership_id, m.athlete_id, h.start_date, h.end_date, h.reason from membership_holds h join memberships m on m.id = h.membership_id
          where m.org_id = ${orgId} and h.kind = 'hold' ${sc(sql`m.athlete_id`)}`,
    )
  ).map((r) => ({ id: r.id as string, membershipId: r.membership_id as string, athleteId: r.athlete_id as string, startDate: ymd(r.start_date)!, endDate: ymd(r.end_date)!, reason: (r.reason as string) ?? null }));
  const holdsByAthlete = new Map<string, Hold[]>();
  for (const h of holds) holdsByAthlete.set(h.athleteId, [...(holdsByAthlete.get(h.athleteId) ?? []), h]);
  const holdById = new Map(holds.map((h) => [h.id, h]));

  const facts = new Map<string, RuleFacts>();
  const fact = (id: string) => {
    let f = facts.get(id);
    if (!f) facts.set(id, (f = emptyFacts()));
    return f;
  };
  const visitDays = new Map<string, string[]>();
  for (const r of await rowsOf<{ athlete_id: string; status: string; starts_at: string | Date }>(
    tx,
    sql`select b.athlete_id, b.status, s.starts_at from bookings b join schedule_sessions s on s.id = b.session_id
        where b.org_id = ${orgId} and b.status in ('booked','attended','no_show') and s.status <> 'cancelled' ${sc(sql`b.athlete_id`)}
        order by s.starts_at`,
  )) {
    const at = new Date(r.starts_at);
    fact(r.athlete_id).bookedStarts.push(at);
    if (r.status === "attended" && at < endOfDay(today)) {
      fact(r.athlete_id).attendedStarts.push(at);
      visitDays.set(r.athlete_id, [...(visitDays.get(r.athlete_id) ?? []), localYmd(at, tz)]);
    }
  }
  for (const r of await rowsOf<{ athlete_id: string; created_at: string | Date }>(
    tx,
    sql`select t.athlete_id, msg.created_at from messages msg join threads t on t.id = msg.thread_id join users u on u.id = msg.sender_user_id
        where t.org_id = ${orgId} and t.athlete_id is not null and not msg.is_internal_note and msg.automation_rule_id is null and msg.campaign_id is null
          and u.role in ('owner','admin','operations','coach') and msg.created_at >= ${startOfDay(addDaysYmd(floor, -60)).toISOString()} ${sc(sql`t.athlete_id`)}`,
  ))
    fact(r.athlete_id).staffMessages.push(new Date(r.created_at));
  for (const r of await rowsOf<{ athlete_id: string; pending: number; completed: number }>(
    tx,
    sql`select a.id as athlete_id,
          count(*) filter (where fr.status in ('pending','partially_signed'))::int as pending,
          count(*) filter (where fr.status = 'completed')::int as completed
        from form_requests fr join athletes a on (a.id = fr.athlete_id or (fr.athlete_id is null and a.person_id = fr.subject_person_id))
        where fr.org_id = ${orgId} and a.org_id = ${orgId} ${sc(sql`a.id`)} group by a.id`,
  )) {
    fact(r.athlete_id).pendingForms = Number(r.pending);
    fact(r.athlete_id).completedForms = Number(r.completed);
  }
  const payersWithMethod = new Set(
    (await rowsOf<{ id: string }>(tx, sql`select distinct pm.payer_account_id as id from payment_methods pm join payer_accounts pa on pa.id = pm.payer_account_id where pa.org_id = ${orgId}`)).map((r) => r.id),
  );
  for (const m of ms) if (isLive(m) && (m.providerSubscriptionId || (m.payerAccountId && payersWithMethod.has(m.payerAccountId)))) fact(m.athleteId).hasPaymentMethod = true;
  const directCoach = new Map<string, string>();
  for (const r of await rowsOf<{ athlete_id: string; coach_user_id: string; direct: boolean }>(
    tx,
    sql`select coalesce(ca.athlete_id, gm.athlete_id) as athlete_id, ca.coach_user_id, (ca.athlete_id is not null) as direct
        from coach_assignments ca left join group_members gm on gm.group_id = ca.group_id
        where ca.org_id = ${orgId} and (ca.starts_on is null or ca.starts_on <= ${today}) and (ca.ends_on is null or ca.ends_on >= ${today})
          and coalesce(ca.athlete_id, gm.athlete_id) is not null
        order by ca.created_at`,
  )) {
    if (opts.athleteIds && !opts.athleteIds.includes(r.athlete_id)) continue;
    fact(r.athlete_id).coachAssigned = true;
    if (r.direct && !directCoach.has(r.athlete_id)) directCoach.set(r.athlete_id, r.coach_user_id);
  }
  for (const r of await rowsOf<{ athlete_id: string }>(
    tx,
    sql`select distinct coalesce(pa.athlete_id, gm.athlete_id) as athlete_id from program_assignments pa left join group_members gm on gm.group_id = pa.group_id
        where pa.org_id = ${orgId} and pa.status = 'active' and coalesce(pa.athlete_id, gm.athlete_id) is not null`,
  ))
    fact(r.athlete_id).programAssigned = true;
  for (const r of await rowsOf<{ athlete_id: string }>(tx, sql`select distinct gm.athlete_id from group_members gm join groups g on g.id = gm.group_id where g.org_id = ${orgId}`)) fact(r.athlete_id).inGroup = true;
  for (const r of await rowsOf<{ athlete_id: string; local_date: unknown }>(tx, sql`select athlete_id, local_date from community_shoutouts where org_id = ${orgId} and removed_at is null ${sc(sql`athlete_id`)}`))
    fact(r.athlete_id).shoutoutDays.push(ymd(r.local_date)!);

  // ---- existing rows ---------------------------------------------------------------------------
  const jRows: JRow[] = (
    await rowsOf<Record<string, unknown>>(tx, sql`select id, athlete_id, kind, anchor_key, anchor_id, started_on, status from journeys where org_id = ${orgId} ${sc(sql`athlete_id`)}`)
  ).map((r) => ({ id: r.id as string, athleteId: r.athlete_id as string, kind: r.kind as JourneyKind, anchorKey: r.anchor_key as string, anchorId: (r.anchor_id as string) ?? null, startedOn: ymd(r.started_on)!, status: r.status as string }));
  const jByAnchor = new Map(jRows.map((j) => [j.anchorKey, j]));
  const sRows: StepRow[] = (
    await rowsOf<Record<string, unknown>>(
      tx,
      sql`select js.task_id, js.journey_id, js.athlete_id, js.kind, js.step_key, js.auto_rule, js.due_on, js.original_due_on, js.suppressed, t.status
          from journey_steps js join tasks t on t.id = js.task_id where js.org_id = ${orgId} ${sc(sql`js.athlete_id`)}`,
    )
  ).map((r) => ({ taskId: r.task_id as string, journeyId: r.journey_id as string, athleteId: r.athlete_id as string, kind: r.kind as JourneyKind, stepKey: r.step_key as string, autoRule: (r.auto_rule as string) ?? null, dueOn: ymd(r.due_on)!, originalDueOn: ymd(r.original_due_on), suppressed: !!r.suppressed, status: r.status as string }));
  const stepKeys = new Set(sRows.map((x) => `${x.journeyId}:${x.stepKey}`));

  // ---- writers ---------------------------------------------------------------------------------
  const ensureJourney = async (athleteId: string, kind: JourneyKind, anchorKey: string, anchorId: string | null, startedOn: string): Promise<{ j: JRow; isNew: boolean }> => {
    const have = jByAnchor.get(anchorKey);
    if (have) return { j: have, isNew: false };
    const [row] = await tx.insert(journeys).values({ orgId, athleteId, kind, anchorKey, anchorId, startedOn }).onConflictDoNothing({ target: [journeys.orgId, journeys.anchorKey] }).returning({ id: journeys.id });
    const id = row?.id ?? (await tx.select({ id: journeys.id }).from(journeys).where(and(eq(journeys.orgId, orgId), eq(journeys.anchorKey, anchorKey))))[0].id;
    const j: JRow = { id, athleteId, kind, anchorKey, anchorId, startedOn, status: "active" };
    jByAnchor.set(anchorKey, j);
    jRows.push(j);
    if (row) out.journeysCreated++;
    return { j, isNew: !!row };
  };
  const addStep = async (j: JRow, step: TemplateStep, dueOn: string, opts2: { dedupeKey?: string; originalDueOn?: string | null } = {}) => {
    if (stepKeys.has(`${j.id}:${step.key}`)) return;
    const who = people.get(j.athleteId);
    if (!who) return;
    const dedupeKey = opts2.dedupeKey ?? `journey:${j.anchorKey}:${step.key}`;
    const [made] = await tx
      .insert(tasks)
      .values({
        orgId,
        title: `${step.name}: ${who.name}`,
        description: "Member journey step. Nothing is sent automatically.",
        dueAt: endOfDay(dueOn),
        assigneeUserId: step.ownerRole === "coach" && !step.billing ? (directCoach.get(j.athleteId) ?? null) : null,
        relatedPersonId: who.personId,
        relatedType: "athlete",
        relatedId: j.athleteId,
        source: "journey",
        dedupeKey,
      })
      .onConflictDoNothing({ target: [tasks.orgId, tasks.dedupeKey] })
      .returning({ id: tasks.id, status: tasks.status });
    // An existing task with this key (e.g. a "Create shoutout task" from Milestones this week) is adopted, not duplicated.
    const task = made ?? (await tx.select({ id: tasks.id, status: tasks.status }).from(tasks).where(and(eq(tasks.orgId, orgId), eq(tasks.dedupeKey, dedupeKey))))[0];
    const [ins] = await tx
      .insert(journeySteps)
      .values({ taskId: task.id, orgId, journeyId: j.id, athleteId: j.athleteId, kind: j.kind, stepKey: step.key, name: step.name, ownerRole: step.ownerRole, autoRule: step.autoRule, billing: step.billing, dueOn, originalDueOn: opts2.originalDueOn ?? null })
      .onConflictDoNothing()
      .returning({ taskId: journeySteps.taskId });
    stepKeys.add(`${j.id}:${step.key}`);
    if (!ins) return;
    sRows.push({ taskId: task.id, journeyId: j.id, athleteId: j.athleteId, kind: j.kind, stepKey: step.key, autoRule: step.autoRule, dueOn, originalDueOn: opts2.originalDueOn ?? null, suppressed: false, status: task.status });
    out.stepsCreated++;
  };
  const setDue = async (st: StepRow, dueOn: string, originalDueOn: string | null) => {
    await tx.update(journeySteps).set({ dueOn, originalDueOn, updatedAt: now }).where(eq(journeySteps.taskId, st.taskId));
    await tx.update(tasks).set({ dueAt: endOfDay(dueOn) }).where(eq(tasks.id, st.taskId));
    st.dueOn = dueOn;
    st.originalDueOn = originalDueOn;
    out.moved++;
  };
  const closeJourney = async (j: JRow, reason: string) => {
    const open = sRows.filter((x) => x.journeyId === j.id && (x.status === "open" || x.status === "in_progress"));
    if (open.length) {
      const ids = open.map((x) => x.taskId);
      await tx.update(tasks).set({ status: "cancelled" }).where(inArray(tasks.id, ids));
      await tx.update(journeySteps).set({ skipReason: reason, updatedAt: now }).where(inArray(journeySteps.taskId, ids));
      for (const x of open) x.status = "cancelled";
    }
    await tx.update(journeys).set({ status: "closed", closedReason: reason, updatedAt: now }).where(eq(journeys.id, j.id));
    j.status = "closed";
    out.closed++;
    await audit(tx, { orgId, actorUserId: null, actorRole: "system" }, "journey.close", "journey", j.id, { summary: `${j.kind} journey closed: ${reason}` });
  };
  const T = settings.templates;
  const enabled = (kind: JourneyKind) => T[kind].filter((x) => x.enabled);

  // ---- generation ------------------------------------------------------------------------------
  for (const [athleteId, list] of msByAthlete) {
    const stint = currentStint(list, today);
    const live = list.filter(isLive);
    const athleteHolds = holdsByAthlete.get(athleteId) ?? [];

    // Onboarding: the membership (or trial) that began this stint, if it began recently.
    if (stint && stint.startDate >= floor && live.length) {
      const { j, isNew } = await ensureJourney(athleteId, "onboarding", `onboarding:${stint.id}`, stint.id, stint.startDate);
      if (isNew) for (const step of enabled("onboarding")) await addStep(j, step, stepDueOn(step, stint.startDate));
    }

    // Touchpoints: created a little ahead of their due date; a hold moves them.
    if (stint && live.length) {
      const key = `touchpoints:${stint.id}`;
      for (const step of enabled("touchpoints")) {
        const original = stepDueOn(step, stint.startDate);
        const due = shiftForHolds(original, athleteHolds, settings.holdGraceDays);
        if (due < floor || due > addDaysYmd(today, settings.lookaheadDays)) continue;
        const { j } = await ensureJourney(athleteId, "touchpoints", key, stint.id, stint.startDate);
        await addStep(j, step, due, { originalDueOn: due === original ? null : original });
      }
      const j = jByAnchor.get(key);
      if (j)
        for (const st of sRows.filter((x) => x.journeyId === j.id && x.status === "open")) {
          const original = st.originalDueOn ?? st.dueOn;
          const due = shiftForHolds(original, athleteHolds, settings.holdGraceDays);
          if (due !== st.dueOn) await setDue(st, due, due === original ? null : original);
        }
    }

    // Visit milestones: a "recognise this" step when a count is reached. Shares its task with Milestones this week.
    const days = visitDays.get(athleteId) ?? [];
    if (live.length && days.length) {
      for (const step of enabled("visit_milestones")) {
        const n = step.visits ?? 0;
        const reached = n > 0 ? days[n - 1] : undefined;
        if (!reached || reached < floor) continue;
        const { j } = await ensureJourney(athleteId, "visit_milestones", `visit_milestones:${athleteId}`, null, days[0]);
        await addStep(j, step, stepDueOn(step, reached), { dedupeKey: `milestone:${athleteId}:sessions:${n}` });
      }
    }

    // Holds that are running or about to start.
    for (const h of athleteHolds) {
      if (h.endDate < today || h.startDate > addDaysYmd(today, settings.lookaheadDays)) continue;
      const { j, isNew } = await ensureJourney(athleteId, "hold", `hold:${h.id}`, h.id, h.startDate);
      if (isNew) for (const step of enabled("hold")) await addStep(j, step, stepDueOn(step, h.startDate, h.endDate));
    }

    // Offboarding: a cancellation was processed and nothing else continues.
    const continuing = list.some((m) => (LIVE.includes(m.status) || m.status === "pending") && !m.cancelAt);
    for (const m of list) {
      if (m.kind !== "regular" || !(m.status === "cancelled" || m.cancelAt) || m.status === "expired") continue;
      const effective = m.endedOn ?? m.cancelAt!;
      if (effective < floor || continuing) continue;
      const startedOn = m.cancelEventOn && m.cancelEventOn <= today ? m.cancelEventOn : today;
      const { j, isNew } = await ensureJourney(athleteId, "offboarding", `offboarding:${m.id}`, m.id, startedOn);
      if (isNew) for (const step of enabled("offboarding")) await addStep(j, step, stepDueOn(step, startedOn));
    }
  }

  // Journeys whose reason went away.
  for (const j of jRows.filter((x) => x.status === "active")) {
    if (j.kind === "hold" && j.anchorId) {
      const h = holdById.get(j.anchorId);
      if (!h) {
        await closeJourney(j, "Hold removed");
        continue;
      }
      // The hold's dates changed: open steps follow them.
      for (const st of sRows.filter((x) => x.journeyId === j.id && x.status === "open")) {
        const step = T.hold.find((x) => x.key === st.stepKey);
        const due = step ? stepDueOn(step, h.startDate, h.endDate) : st.dueOn;
        if (due !== st.dueOn) await setDue(st, due, null);
      }
    }
    if (j.kind === "offboarding" && j.anchorId) {
      const m = msById.get(j.anchorId);
      if (m && LIVE.includes(m.status) && !m.cancelAt) await closeJourney(j, "Cancellation withdrawn");
    }
  }

  // Review and referral asks: once, after a positive moment, never while at risk or past due.
  const reviewSteps = enabled("review_referral");
  const openReview = sRows.filter((x) => x.kind === "review_referral" && x.status === "open");
  const momentFloor = addDaysYmd(today, -settings.positiveMomentDays);
  const candidates: string[] = [];
  if (reviewSteps.length) {
    const fiveStar = new Set(
      (
        await rowsOf<{ athlete_id: string }>(
          tx,
          sql`select distinct athlete_id from session_feedback where org_id = ${orgId} and rating = 5 and created_at >= ${startOfDay(momentFloor).toISOString()} ${sc(sql`athlete_id`)}`,
        )
      ).map((r) => r.athlete_id),
    );
    const counts = enabled("visit_milestones").map((x) => x.visits ?? 0).filter((n) => n > 0);
    for (const [athleteId, list] of msByAthlete) {
      if (!list.some(isLive) || jByAnchor.has(`review_referral:${athleteId}`)) continue;
      const days = visitDays.get(athleteId) ?? [];
      const milestone = counts.some((n) => days[n - 1] !== undefined && days[n - 1] >= momentFloor);
      if (milestone || fiveStar.has(athleteId)) candidates.push(athleteId);
    }
  }
  if (candidates.length || openReview.length) {
    const ids = [...new Set([...candidates, ...openReview.map((x) => x.athleteId)])];
    const radar = await retentionRadar(tx, systemViewer(orgId), { today, athleteIds: ids });
    const blocked = new Set(radar.rows.filter((r) => r.level === "at_risk" || r.planStatus === "past_due" || r.signals.some((x) => x.key === "payment_failed")).map((r) => r.athleteId));
    for (const m of ms) if (m.status === "past_due") blocked.add(m.athleteId);
    for (const athleteId of candidates) {
      if (blocked.has(athleteId)) continue;
      const { j, isNew } = await ensureJourney(athleteId, "review_referral", `review_referral:${athleteId}`, null, today);
      if (isNew) for (const step of reviewSteps) await addStep(j, step, stepDueOn(step, today));
    }
    for (const st of openReview) {
      const want = blocked.has(st.athleteId);
      if (want !== st.suppressed) {
        await tx.update(journeySteps).set({ suppressed: want, updatedAt: now }).where(eq(journeySteps.taskId, st.taskId));
        st.suppressed = want;
      }
    }
  }

  // ---- auto-complete ---------------------------------------------------------------------------
  const open = sRows.filter((x) => isAutoRule(x.autoRule) && (x.status === "open" || x.status === "in_progress"));
  const jById = new Map(jRows.map((j) => [j.id, j]));
  const needReminder = open.some((x) => x.autoRule === "hold_return_reminder");
  const reminded = new Set(
    needReminder
      ? (await rowsOf<{ period: string }>(tx, sql`select payload->>'period' as period from jobs where org_id = ${orgId} and type = 'automation.dispatch' and status = 'done' and payload->>'period' like 'restart:%'`)).map((r) => r.period.slice(8))
      : [],
  );
  const offIds = [...new Set(open.filter((x) => x.kind === "offboarding").map((x) => jById.get(x.journeyId)?.anchorId).filter((x): x is string => !!x))];
  const openInv = new Map<string, number>();
  const lost = new Set<string>();
  if (offIds.length) {
    for (const r of await rowsOf<{ membership_id: string; n: number }>(tx, sql`select membership_id, count(*)::int as n from invoices where org_id = ${orgId} and status = 'open' and membership_id in (${inList(offIds)}) group by membership_id`))
      openInv.set(r.membership_id, Number(r.n));
    for (const r of await rowsOf<{ athlete_id: string }>(tx, sql`select distinct athlete_id from retention_actions where org_id = ${orgId} and outcome = 'lost' and reason_code is not null`)) lost.add(r.athlete_id);
  }
  for (const st of open) {
    const j = jById.get(st.journeyId);
    if (!j || j.status !== "active") continue;
    const h = j.kind === "hold" && j.anchorId ? holdById.get(j.anchorId) : null;
    const m = j.kind === "offboarding" && j.anchorId ? msById.get(j.anchorId) : null;
    const n = st.kind === "visit_milestones" ? Number(st.stepKey.replace("visits_", "")) : 0;
    const res = evaluateRule(st.autoRule as AutoRule, facts.get(st.athleteId) ?? emptyFacts(), {
      startedOn: j.startedOn,
      startInstant: startOfDay(j.startedOn),
      reachedOn: n ? ((visitDays.get(st.athleteId) ?? [])[n - 1] ?? null) : null,
      hold: h ? { reason: h.reason, endDate: h.endDate, reminderRan: reminded.has(h.id) } : null,
      membership: m ? { cancelReason: m.cancelReason, lostReasonLogged: lost.has(m.athleteId), openInvoices: openInv.get(m.id) ?? 0 } : null,
    });
    if (!res) continue;
    const at = res instanceof Date && res <= now ? res : now;
    const upd = await tx.update(tasks).set({ status: "done", completedAt: at, completedBy: null }).where(and(eq(tasks.id, st.taskId), inArray(tasks.status, ["open", "in_progress"]))).returning({ id: tasks.id });
    if (!upd.length) continue;
    await tx.update(journeySteps).set({ completedVia: "auto", updatedAt: now }).where(eq(journeySteps.taskId, st.taskId));
    await audit(tx, { orgId, actorUserId: null, actorRole: "system" }, "journey.step_auto_complete", "task", st.taskId, { summary: `Ticked automatically (${st.autoRule}): ${st.stepKey}`, after: { journeyId: j.id, athleteId: st.athleteId, rule: st.autoRule } });
    st.status = "done";
    out.autoCompleted++;
  }

  out.journeysCompleted = await settleJourneys(tx, orgId, now, opts.athleteIds);
  return out;
}

/** A one-off checklist (onboarding, hold, offboarding, review asks) is complete once no step is open. */
export async function settleJourneys(tx: Tx, orgId: string, now = new Date(), athleteIds?: string[]): Promise<number> {
  if (athleteIds && !athleteIds.length) return 0;
  const res = await tx.execute(sql`
    update journeys j set status = 'completed', updated_at = ${now.toISOString()},
      completed_at = coalesce((select max(case when t.status = 'done' then t.completed_at else js.updated_at end) from journey_steps js join tasks t on t.id = js.task_id where js.journey_id = j.id), ${now.toISOString()})
    where j.org_id = ${orgId} and j.status = 'active' and j.kind in ('onboarding','hold','offboarding','review_referral')
      ${athleteIds ? sql`and j.athlete_id in (${inList(athleteIds)})` : sql``}
      and exists (select 1 from journey_steps js where js.journey_id = j.id)
      and not exists (select 1 from journey_steps js join tasks t on t.id = js.task_id where js.journey_id = j.id and t.status in ('open','in_progress'))
    returning j.id`);
  return res.rows.length;
}
