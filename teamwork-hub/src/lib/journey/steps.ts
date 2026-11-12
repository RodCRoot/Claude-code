/**
 * Journey steps for staff: the follow-ups queue, the per-member panel, and the actions
 * (complete, skip with a reason, snooze, assign, log a reach-out). Every action is audited.
 *
 * Scope: coaches only ever get steps for athletes assigned to them and never billing-related
 * steps (`journey.billing_steps`). Nothing here sends a message.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { athletes, journeySteps, notes, people, tasks, users, type JourneyKind, type JourneyOwnerRole } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { AuthzError, accessibleAthleteIds, assertCan, can, canOnAthlete, type Viewer } from "@/lib/authz/policy";
import { policyFromSettings } from "@/lib/membership-policy";
import { retentionRadar } from "@/lib/retention/radar";
import { addDaysYmd, daysBetween, localDayBounds, todayLocal } from "@/lib/time";
import { journeyContext, settleJourneys, syncJourneys } from "./sync";
import { DEFAULT_TEMPLATES, JOURNEY_KIND_LABEL, REVIEW_OUTCOMES, stepDueOn, shiftForHolds, type StepInput, type StepLink } from "./templates";

const actor = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });
const rowsOf = async <T>(tx: Tx, q: SQL) => (await tx.execute(q)).rows as T[];
const ymd = (x: unknown) => (x == null ? null : x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));
const inList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}`), sql`, `);

export type StepState = "open" | "snoozed" | "done" | "skipped";
export type StepView = {
  taskId: string;
  journeyId: string;
  athleteId: string;
  personId: string;
  athleteName: string;
  kind: JourneyKind;
  kindLabel: string;
  stepKey: string;
  name: string;
  ownerRole: JourneyOwnerRole;
  autoRule: string | null;
  billing: boolean;
  dueOn: string;
  originalDueOn: string | null;
  snoozedUntil: string | null;
  state: StepState;
  overdueDays: number;
  assigneeUserId: string | null;
  assigneeName: string | null;
  completedAt: Date | null;
  completedVia: "staff" | "auto" | null;
  completedByName: string | null;
  skipReason: string | null;
  outcome: string | null;
  note: string | null;
  input: StepInput;
  link: StepLink | null;
};

/** What completing a built-in step asks for, and where it links. Custom steps ask for nothing. */
export function stepMeta(kind: JourneyKind, stepKey: string): { input: StepInput; link: StepLink | null } {
  const d = DEFAULT_TEMPLATES[kind]?.find((x) => x.key === stepKey);
  return { input: d?.input ?? "none", link: d?.link ?? null };
}

/** Where a step's link goes. Message steps open the normal compose page; nothing is sent from here. */
export function stepHref(link: StepLink | null, s: { personId: string; athleteId: string }): string | null {
  switch (link) {
    case "compose":
      return `/messages/new?athlete=${s.athleteId}`;
    case "referrals":
      return "/people/referrals";
    case "goals":
      return `/people/${s.personId}#goals`;
    case "shoutout":
      return `/people/${s.personId}#shoutouts`;
    case "documents":
      return `/people/${s.personId}#documents`;
    case "billing":
      return `/people/${s.personId}#billing`;
    case "winback":
      return "/people/retention/winback";
    default:
      return null;
  }
}

type Raw = Record<string, unknown>;
function toView(r: Raw, today: string): StepView {
  const status = r.status as string;
  const snoozedUntil = ymd(r.snoozed_until);
  const dueOn = ymd(r.due_on)!;
  const state: StepState = status === "done" ? "done" : status === "cancelled" ? "skipped" : snoozedUntil && snoozedUntil > today ? "snoozed" : "open";
  const kind = r.kind as JourneyKind;
  return {
    taskId: r.task_id as string,
    journeyId: r.journey_id as string,
    athleteId: r.athlete_id as string,
    personId: r.person_id as string,
    athleteName: r.athlete_name as string,
    kind,
    kindLabel: JOURNEY_KIND_LABEL[kind],
    stepKey: r.step_key as string,
    name: r.name as string,
    ownerRole: r.owner_role as JourneyOwnerRole,
    autoRule: (r.auto_rule as string) ?? null,
    billing: !!r.billing,
    dueOn,
    originalDueOn: ymd(r.original_due_on),
    snoozedUntil,
    state,
    overdueDays: state === "open" || state === "snoozed" ? Math.max(0, daysBetween(dueOn, today)) : 0,
    assigneeUserId: (r.assignee_user_id as string) ?? null,
    assigneeName: (r.assignee_name as string) ?? null,
    completedAt: r.completed_at ? new Date(r.completed_at as string) : null,
    completedVia: status === "done" ? ((r.completed_via as "staff" | "auto") ?? "staff") : null,
    completedByName: (r.completed_by_name as string) ?? null,
    skipReason: (r.skip_reason as string) ?? null,
    outcome: (r.outcome as string) ?? null,
    note: (r.note as string) ?? null,
    ...stepMeta(kind, r.step_key as string),
  };
}

const SELECT = sql`
  select js.task_id, js.journey_id, js.athlete_id, a.person_id, p.first_name || ' ' || p.last_name as athlete_name, js.kind, js.step_key, js.name, js.owner_role,
    js.auto_rule, js.billing, js.due_on, js.original_due_on, js.snoozed_until, js.skip_reason, js.completed_via, js.outcome, js.note,
    t.status, t.assignee_user_id, t.completed_at, au.display_name as assignee_name, cu.display_name as completed_by_name
  from journey_steps js
  join tasks t on t.id = js.task_id
  join athletes a on a.id = js.athlete_id
  join people p on p.id = a.person_id
  left join users au on au.id = t.assignee_user_id
  left join users cu on cu.id = t.completed_by`;

/** The SQL condition that keeps a viewer inside their scope. Shared by every journey read. */
async function scopeSql(tx: Tx, v: Viewer): Promise<SQL | null> {
  assertCan(v, "journey.view");
  const ids = await accessibleAthleteIds(tx, v, "profile.read");
  if (ids !== "all" && !ids.length) return null;
  return sql`${ids === "all" ? sql`true` : sql`js.athlete_id in (${inList(ids)})`} ${can(v, "journey.billing_steps") ? sql`` : sql`and not js.billing`}`;
}

export type QueueFilter = { owner?: string; location?: string | null; kind?: JourneyKind };

/**
 * Today's follow-ups: every open step that is due today or overdue (not snoozed, not a held-back
 * review ask), in the viewer's scope. `owner` is "me", "unassigned", a role (owner / operations /
 * coach) or a staff user id.
 */
export async function followUpQueue(tx: Tx, v: Viewer, f: QueueFilter = {}, opts: { today?: string } = {}): Promise<{ today: string; steps: StepView[]; groups: { kind: JourneyKind; label: string; steps: StepView[] }[] }> {
  const scope = await scopeSql(tx, v);
  const { tz } = await journeyContext(tx, v.orgId);
  const today = opts.today ?? todayLocal(tz);
  if (!scope) return { today, steps: [], groups: [] };
  const owner =
    !f.owner || f.owner === "all"
      ? sql``
      : f.owner === "me"
        ? sql`and t.assignee_user_id = ${v.userId}`
        : f.owner === "unassigned"
          ? sql`and t.assignee_user_id is null`
          : ["owner", "operations", "coach"].includes(f.owner)
            ? sql`and js.owner_role = ${f.owner}`
            : z.string().uuid().safeParse(f.owner).success
              ? sql`and t.assignee_user_id = ${f.owner}`
              : sql`and false`;
  const loc = f.location
    ? sql`and exists (select 1 from memberships m join product_versions pv on pv.id = m.product_version_id join products pr on pr.id = pv.product_id
        where m.athlete_id = js.athlete_id and m.status <> 'pending'
          and (jsonb_array_length(coalesce(m.location_ids, pr.location_ids, '[]'::jsonb)) = 0 or coalesce(m.location_ids, pr.location_ids) @> ${JSON.stringify([f.location])}::jsonb))`
    : sql``;
  const rows = await rowsOf<Raw>(
    tx,
    sql`${SELECT}
        where js.org_id = ${v.orgId} and ${scope} and t.status in ('open','in_progress') and js.due_on <= ${today}
          and (js.snoozed_until is null or js.snoozed_until <= ${today}) and not js.suppressed
          ${f.kind ? sql`and js.kind = ${f.kind}` : sql``} ${owner} ${loc}
        order by js.due_on, p.last_name, p.first_name limit 500`,
  );
  const steps = rows.map((r) => toView(r, today));
  const order: JourneyKind[] = ["onboarding", "touchpoints", "visit_milestones", "review_referral", "hold", "offboarding"];
  const groups = order.map((kind) => ({ kind, label: JOURNEY_KIND_LABEL[kind], steps: steps.filter((s) => s.kind === kind) })).filter((g) => g.steps.length);
  return { today, steps, groups };
}

export type JourneyPanel = {
  today: string;
  athleteId: string;
  journeys: { id: string; kind: JourneyKind; label: string; startedOn: string; status: string; closedReason: string | null; done: number; total: number; steps: StepView[] }[];
  /** Touchpoints from the template that are not created yet (computed, nothing stored). */
  upcoming: { key: string; name: string; dueOn: string; moved: boolean }[];
  milestones: { visits: number; reachedOn: string | null; recognised: "recognised" | "open" | "skipped" | "not_tracked" | null }[];
  visits: number;
};

/**
 * The journey panel for one athlete. Brings that athlete's journey up to date first (the same
 * generator the nightly job runs), so the panel is right even when no worker is deployed.
 */
export async function journeyPanel(tx: Tx, v: Viewer, athleteId: string, opts: { today?: string; now?: Date; sync?: boolean } = {}): Promise<JourneyPanel | null> {
  assertCan(v, "journey.view");
  if (!(await canOnAthlete(tx, v, athleteId, "profile.read"))) return null;
  const { tz, settings } = await journeyContext(tx, v.orgId);
  const today = opts.today ?? todayLocal(tz, opts.now);
  if (opts.sync !== false) await syncJourneys(tx, v.orgId, { today, now: opts.now, athleteIds: [athleteId] });
  const billing = can(v, "journey.billing_steps") ? sql`` : sql`and not js.billing`;
  const steps = (await rowsOf<Raw>(tx, sql`${SELECT} where js.org_id = ${v.orgId} and js.athlete_id = ${athleteId} ${billing} order by js.due_on, js.created_at`)).map((r) => toView(r, today));
  const js = await rowsOf<Raw>(tx, sql`select id, kind, started_on, status, closed_reason, anchor_id from journeys where org_id = ${v.orgId} and athlete_id = ${athleteId} order by started_on desc, created_at desc`);
  const journeysOut = js
    .map((j) => {
      const mine = steps.filter((s) => s.journeyId === j.id);
      return { id: j.id as string, kind: j.kind as JourneyKind, label: JOURNEY_KIND_LABEL[j.kind as JourneyKind], startedOn: ymd(j.started_on)!, status: j.status as string, closedReason: (j.closed_reason as string) ?? null, done: mine.filter((s) => s.state === "done" || s.state === "skipped").length, total: mine.length, steps: mine };
    })
    .filter((j) => j.steps.length);

  // Upcoming touchpoints: template steps of the current touchpoint journey that have no step yet.
  const upcoming: JourneyPanel["upcoming"] = [];
  const [tp] = await rowsOf<Raw>(
    tx,
    sql`select m.id, m.start_date from memberships m where m.org_id = ${v.orgId} and m.athlete_id = ${athleteId} and m.status in ('trialing','active','on_hold','past_due') order by m.start_date limit 1`,
  );
  if (tp) {
    const tj = js.find((j) => j.kind === "touchpoints" && j.status === "active");
    const start = tj ? ymd(tj.started_on)! : ymd(tp.start_date)!;
    const have = new Set(steps.filter((s) => s.kind === "touchpoints" && (!tj || s.journeyId === tj.id)).map((s) => s.stepKey));
    const holds = (
      await rowsOf<Raw>(tx, sql`select h.start_date, h.end_date from membership_holds h join memberships m on m.id = h.membership_id where m.org_id = ${v.orgId} and m.athlete_id = ${athleteId} and h.kind = 'hold'`)
    ).map((h) => ({ startDate: ymd(h.start_date)!, endDate: ymd(h.end_date)! }));
    for (const step of settings.templates.touchpoints.filter((x) => x.enabled && !have.has(x.key))) {
      const original = stepDueOn(step, start);
      const dueOn = shiftForHolds(original, holds, settings.holdGraceDays);
      if (dueOn >= today) upcoming.push({ key: step.key, name: step.name, dueOn, moved: dueOn !== original });
    }
    upcoming.sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  }

  // Milestones reached and whether each was recognised.
  const endOfToday = localDayBounds(today, tz).end.toISOString();
  const attended = await rowsOf<{ d: unknown }>(
    tx,
    sql`select (s.starts_at at time zone ${tz})::date as d from bookings b join schedule_sessions s on s.id = b.session_id
        where b.org_id = ${v.orgId} and b.athlete_id = ${athleteId} and b.status = 'attended' and s.status <> 'cancelled' and s.starts_at < ${endOfToday} order by s.starts_at`,
  );
  const milestones = settings.templates.visit_milestones
    .filter((x) => x.enabled && x.visits)
    .map((x) => {
      const reachedOn = ymd(attended[x.visits! - 1]?.d) ?? null;
      const st = steps.find((s) => s.kind === "visit_milestones" && s.stepKey === x.key);
      return { visits: x.visits!, reachedOn, recognised: !reachedOn ? null : !st ? ("not_tracked" as const) : st.state === "done" ? ("recognised" as const) : st.state === "skipped" ? ("skipped" as const) : ("open" as const) };
    });
  return { today, athleteId, journeys: journeysOut, upcoming, milestones, visits: attended.length };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Loaded = { step: typeof journeySteps.$inferSelect; task: typeof tasks.$inferSelect; personId: string; athleteName: string };

/** Load one step for an action: organization, coach scope and billing visibility are all re-checked. */
async function loadStep(tx: Tx, v: Viewer, taskId: string): Promise<Loaded> {
  assertCan(v, "journey.view");
  const [row] = await tx
    .select({ step: journeySteps, task: tasks, personId: athletes.personId, first: people.firstName, last: people.lastName })
    .from(journeySteps)
    .innerJoin(tasks, eq(tasks.id, journeySteps.taskId))
    .innerJoin(athletes, eq(athletes.id, journeySteps.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(journeySteps.taskId, taskId), eq(journeySteps.orgId, v.orgId)))
    .for("update", { of: tasks });
  if (!row) throw new UserError("That step no longer exists.");
  if (row.step.billing && !can(v, "journey.billing_steps")) throw new AuthzError();
  if (!(await canOnAthlete(tx, v, row.step.athleteId, "profile.read"))) throw new AuthzError();
  return { step: row.step, task: row.task, personId: row.personId, athleteName: `${row.first} ${row.last}` };
}

const isOpen = (t: { status: string }) => t.status === "open" || t.status === "in_progress";

export const completeSchema = z.object({
  taskId: z.string().uuid(),
  note: z.string().trim().max(2000).optional(),
  outcome: z.string().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/**
 * One-tap complete. Steps that record a conversation need a short note (saved to the member's
 * staff notes as a check-in / reach-out); review and referral asks need an outcome; the win-back
 * step needs a date and creates the follow-up task the win-back list shows.
 */
export async function completeStep(tx: Tx, v: Viewer, raw: unknown, opts: { now?: Date; today?: string } = {}) {
  const input = completeSchema.parse(raw);
  const { step, task, personId, athleteName } = await loadStep(tx, v, input.taskId);
  if (!isOpen(task)) throw new UserError("That step is already finished.");
  const now = opts.now ?? new Date();
  const { tz } = await journeyContext(tx, v.orgId);
  const today = opts.today ?? todayLocal(tz, now);
  const meta = stepMeta(step.kind, step.stepKey);
  const note = input.note?.trim() || null;
  let outcome: string | null = null;
  if (meta.input === "note" && (!note || note.length < 3)) throw new UserError("Add a short note about the conversation.", { note: "Required" });
  if (meta.input === "outcome") {
    if (!input.outcome || !(input.outcome in REVIEW_OUTCOMES)) throw new UserError("Choose what happened.", { outcome: "Required" });
    outcome = input.outcome;
  }
  if (meta.input === "date") {
    if (!input.date) throw new UserError("Choose a win-back date.", { date: "Required" });
    if (input.date < today) throw new UserError("The win-back date cannot be in the past.", { date: "Choose today or later" });
    outcome = input.date;
    const [t] = await tx
      .insert(tasks)
      .values({
        orgId: v.orgId,
        title: `Winback outreach: ${athleteName}`,
        description: "Win-back date set during offboarding. Reach out personally; nothing is sent automatically.",
        dueAt: localDayBounds(input.date, tz).end,
        assigneeUserId: v.userId,
        relatedPersonId: personId,
        relatedType: "athlete",
        relatedId: step.athleteId,
        source: "retention",
        dedupeKey: `journey:winback:${step.journeyId}`,
        createdBy: v.userId,
      })
      .onConflictDoNothing({ target: [tasks.orgId, tasks.dedupeKey] })
      .returning({ id: tasks.id });
    if (t) await audit(tx, actor(v), "task.create", "task", t.id, { summary: `Winback outreach: ${athleteName}` });
  }
  await tx.update(tasks).set({ status: "done", completedAt: now, completedBy: v.userId }).where(eq(tasks.id, task.id));
  await tx.update(journeySteps).set({ completedVia: "staff", note, outcome, snoozedUntil: null, updatedAt: now }).where(eq(journeySteps.taskId, task.id));
  if (note && meta.input === "note") {
    await tx.insert(notes).values({ orgId: v.orgId, subjectPersonId: personId, authorUserId: v.userId, body: `${step.name}: ${note}`, category: step.kind === "touchpoints" ? "check_in" : "reach_out", visibility: "coaches_assigned" });
  }
  await audit(tx, actor(v), "journey.step_complete", "task", task.id, { summary: `${step.name}: ${athleteName}`, after: { journeyId: step.journeyId, athleteId: step.athleteId, stepKey: step.stepKey, outcome, dueOn: step.dueOn } });
  await settleJourneys(tx, v.orgId, now, [step.athleteId]);
  return { ok: true as const };
}

/** Skip with a reason (required). The task is cancelled; the reason stays on the step. */
export async function skipStep(tx: Tx, v: Viewer, raw: { taskId: string; reason: string }, opts: { now?: Date } = {}) {
  const input = z.object({ taskId: z.string().uuid(), reason: z.string().trim().min(3, "Say why in a few words").max(300) }).parse(raw);
  const { step, task, athleteName } = await loadStep(tx, v, input.taskId);
  if (!isOpen(task)) throw new UserError("That step is already finished.");
  const now = opts.now ?? new Date();
  await tx.update(tasks).set({ status: "cancelled" }).where(eq(tasks.id, task.id));
  await tx.update(journeySteps).set({ skipReason: input.reason, snoozedUntil: null, updatedAt: now }).where(eq(journeySteps.taskId, task.id));
  await audit(tx, actor(v), "journey.step_skip", "task", task.id, { summary: `${step.name}: ${athleteName} skipped`, after: { journeyId: step.journeyId, athleteId: step.athleteId, stepKey: step.stepKey, reason: input.reason } });
  await settleJourneys(tx, v.orgId, now, [step.athleteId]);
  return { ok: true as const };
}

/** Snooze: hide from the queue until a local date (1 to 60 days ahead). The due date does not change, so it still counts as late. */
export async function snoozeStep(tx: Tx, v: Viewer, raw: { taskId: string; days?: number; until?: string }, opts: { today?: string } = {}) {
  const { step, task, athleteName } = await loadStep(tx, v, z.string().uuid().parse(raw.taskId));
  if (!isOpen(task)) throw new UserError("That step is already finished.");
  const { tz } = await journeyContext(tx, v.orgId);
  const today = opts.today ?? todayLocal(tz);
  const until = raw.until && /^\d{4}-\d{2}-\d{2}$/.test(raw.until) ? raw.until : addDaysYmd(today, Number.isInteger(raw.days) ? Number(raw.days) : 3);
  if (until <= today || until > addDaysYmd(today, 60)) throw new UserError("Snooze to a date between tomorrow and 60 days from now.");
  await tx.update(journeySteps).set({ snoozedUntil: until, updatedAt: new Date() }).where(eq(journeySteps.taskId, task.id));
  await audit(tx, actor(v), "journey.step_snooze", "task", task.id, { summary: `${step.name}: ${athleteName} snoozed to ${until}`, before: { snoozedUntil: step.snoozedUntil }, after: { snoozedUntil: until } });
  return { ok: true as const, until };
}

/** Assign a step to a staff member (or nobody). Coaches may only take a step themselves; a billing step never goes to a coach. */
export async function assignStep(tx: Tx, v: Viewer, raw: { taskId: string; userId: string | null }) {
  const { step, task, athleteName } = await loadStep(tx, v, z.string().uuid().parse(raw.taskId));
  if (!isOpen(task)) throw new UserError("That step is already finished.");
  let name = "nobody";
  if (raw.userId) {
    const [u] = await tx.select({ id: users.id, role: users.role, name: users.displayName, disabledAt: users.disabledAt }).from(users).where(and(eq(users.id, raw.userId), eq(users.orgId, v.orgId)));
    if (!u || u.disabledAt || !["owner", "admin", "operations", "coach"].includes(u.role)) throw new UserError("Choose a staff member.");
    if (v.role === "coach" && u.id !== v.userId) throw new AuthzError("Coaches can only assign a step to themselves.");
    if (u.role === "coach") {
      if (step.billing) throw new UserError("Billing steps cannot be assigned to a coach.");
      const [link] = await rowsOf<{ ok: number }>(
        tx,
        sql`select 1 as ok from coach_assignments ca left join group_members gm on gm.group_id = ca.group_id
            where ca.org_id = ${v.orgId} and ca.coach_user_id = ${u.id} and coalesce(ca.athlete_id, gm.athlete_id) = ${step.athleteId}
              and (ca.starts_on is null or ca.starts_on <= current_date) and (ca.ends_on is null or ca.ends_on >= current_date) limit 1`,
      );
      if (!link) throw new UserError("That coach is not assigned to this athlete, so they could not open the step.");
    }
    name = u.name;
  } else if (v.role === "coach" && task.assigneeUserId !== v.userId) throw new AuthzError("Coaches can only unassign their own steps.");
  await tx.update(tasks).set({ assigneeUserId: raw.userId }).where(eq(tasks.id, task.id));
  await audit(tx, actor(v), "journey.step_assign", "task", task.id, { summary: `${step.name}: ${athleteName} assigned to ${name}`, before: { assigneeUserId: task.assigneeUserId }, after: { assigneeUserId: raw.userId } });
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// No-shows and absent members
// ---------------------------------------------------------------------------

export type ReachOutRow = { athleteId: string; personId: string; name: string; detail: string; lastReachOut: { at: Date; by: string | null } | null };

/**
 * Yesterday's no-shows and members absent in the actionable window: at least the membership
 * policy's attendance gap (the retention radar's "No recent visit" rule, which already skips
 * members on hold) and at most `absentMaxDays`. Each row carries the latest logged reach-out.
 */
export async function reachOutLists(tx: Tx, v: Viewer, opts: { today?: string } = {}): Promise<{ today: string; noShows: ReachOutRow[]; absent: ReachOutRow[]; window: { from: number; to: number } }> {
  assertCan(v, "journey.view");
  const { tz, settings, orgSettings } = await journeyContext(tx, v.orgId);
  const today = opts.today ?? todayLocal(tz);
  const gap = policyFromSettings(orgSettings).attendanceGapDays;
  const window = { from: gap, to: Math.max(gap, settings.absentMaxDays) };
  const ids = await accessibleAthleteIds(tx, v, "profile.read");
  if (ids !== "all" && !ids.length) return { today, noShows: [], absent: [], window };
  const y = localDayBounds(addDaysYmd(today, -1), tz);
  const ns = await rowsOf<Raw>(
    tx,
    sql`select b.athlete_id, a.person_id, p.first_name || ' ' || p.last_name as name, s.title, s.starts_at
        from bookings b join schedule_sessions s on s.id = b.session_id join athletes a on a.id = b.athlete_id join people p on p.id = a.person_id
        where b.org_id = ${v.orgId} and b.status = 'no_show' and s.starts_at >= ${y.start.toISOString()} and s.starts_at < ${y.end.toISOString()}
          ${ids === "all" ? sql`` : sql`and b.athlete_id in (${inList(ids)})`}
        order by s.starts_at, p.last_name`,
  );
  const radar = await retentionRadar(tx, v, { today });
  const absentRows = radar.rows
    .map((r) => ({ r, sig: r.signals.find((x) => x.key === "attendance_gap") }))
    .filter((x): x is { r: (typeof radar.rows)[number]; sig: NonNullable<typeof x.sig> } => !!x.sig);
  const people2 = [...new Set([...ns.map((r) => r.person_id as string), ...absentRows.map((x) => x.r.personId)])];
  const last = new Map<string, { at: Date; by: string | null }>();
  if (people2.length)
    for (const r of await rowsOf<Raw>(
      tx,
      sql`select distinct on (n.subject_person_id) n.subject_person_id, n.created_at, u.display_name from notes n left join users u on u.id = n.author_user_id
          where n.org_id = ${v.orgId} and n.category = 'reach_out' and n.subject_person_id in (${inList(people2)}) order by n.subject_person_id, n.created_at desc`,
    ))
      last.set(r.subject_person_id as string, { at: new Date(r.created_at as string), by: (r.display_name as string) ?? null });
  const seen = new Set<string>();
  const noShows: ReachOutRow[] = [];
  for (const r of ns) {
    if (seen.has(r.athlete_id as string)) continue;
    seen.add(r.athlete_id as string);
    noShows.push({ athleteId: r.athlete_id as string, personId: r.person_id as string, name: r.name as string, detail: `No-show: ${r.title as string}`, lastReachOut: last.get(r.person_id as string) ?? null });
  }
  // Days since the last visit come from the radar's own evidence, so both screens always agree.
  const absent: ReachOutRow[] = [];
  for (const { r, sig } of absentRows) {
    const m = /(\d+) days?/.exec(sig.evidence);
    const days = m ? Number(m[1]) : null;
    if (days !== null && days > window.to) continue;
    absent.push({ athleteId: r.athleteId, personId: r.personId, name: r.name, detail: sig.evidence, lastReachOut: last.get(r.personId) ?? null });
  }
  return { today, noShows, absent, window };
}

/** Log a reach-out (a call, a text from a personal phone, a word at the door). Saved as a staff note; nothing is sent. */
export async function logReachOut(tx: Tx, v: Viewer, raw: unknown) {
  assertCan(v, "journey.view");
  const input = z.object({ athleteId: z.string().uuid(), note: z.string().trim().min(3, "Add a short note").max(2000), reason: z.enum(["no_show", "absent", "other"]).default("other") }).parse(raw);
  if (!(await canOnAthlete(tx, v, input.athleteId, "profile.read"))) throw new AuthzError();
  const [a] = await tx.select({ personId: athletes.personId, first: people.firstName, last: people.lastName }).from(athletes).innerJoin(people, eq(people.id, athletes.personId)).where(and(eq(athletes.id, input.athleteId), eq(athletes.orgId, v.orgId)));
  if (!a) throw new AuthzError();
  const label = input.reason === "no_show" ? "Reach-out after a no-show" : input.reason === "absent" ? "Reach-out after an absence" : "Reach-out";
  const [n] = await tx.insert(notes).values({ orgId: v.orgId, subjectPersonId: a.personId, authorUserId: v.userId, body: `${label}: ${input.note}`, category: "reach_out", visibility: "coaches_assigned" }).returning({ id: notes.id });
  await audit(tx, actor(v), "journey.reach_out_log", "note", n.id, { summary: `${label}: ${a.first} ${a.last}`, after: { athleteId: input.athleteId, reason: input.reason } });
  return { ok: true as const, noteId: n.id };
}
