import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db";
import { tasks } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { accessibleAthleteIds, assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { addDaysYmd, localDayBounds, localYmd, startOfWeekYmd, todayLocal } from "@/lib/time";
import { retentionContext } from "./common";

/**
 * Milestones in the current facility-local week (Monday–Sunday): membership anniversaries,
 * 25/50/100/250 sessions attended, birthdays (staff only: this module is never shown to families)
 * and "first 30 days complete". Read-only; the only action is a staff "shoutout" task.
 * No automatic messages.
 */
export const SESSION_MILESTONES = [25, 50, 100, 250] as const;
/** "Coming up" when the athlete is this many attended sessions (or fewer) away. */
export const SESSIONS_AWAY = 2;

export type Milestone = {
  /** Stable id for dedupe and for the shoutout action, e.g. `sessions:50`, `anniversary:2026`. */
  key: string;
  kind: "anniversary" | "sessions" | "birthday" | "first_30_days";
  athleteId: string;
  personId: string;
  name: string;
  label: string;
  /** Local date of the milestone; null for an upcoming session count. */
  date: string | null;
  when: "recent" | "today" | "upcoming";
};

const rowsOf = async <T>(tx: Tx, q: SQL) => (await tx.execute(q)).rows as T[];
const ymd = (x: unknown) => (x == null ? null : x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** The date in `year` on which a month/day recurs (Feb 29 is observed on Feb 28 outside leap years). */
export function recurrenceIn(year: number, sourceYmd: string): string {
  const [, m, d] = sourceYmd.split("-").map(Number);
  const day = m === 2 && d === 29 && !isLeap(year) ? 28 : d;
  return `${year}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function weekOf(today: string): { start: string; end: string } {
  const start = startOfWeekYmd(today);
  return { start, end: addDaysYmd(start, 6) };
}

const ordinalYears = (n: number) => `${n}-year membership anniversary`;

/** Pure milestone math for one athlete. `attendedDays` are facility-local dates, ascending. */
export function milestonesFor(a: { athleteId: string; personId: string; name: string; dateOfBirth: string | null; firstStart: string | null; attendedDays: string[] }, today: string): Milestone[] {
  const { start, end } = weekOf(today);
  const out: Milestone[] = [];
  const when = (d: string): Milestone["when"] => (d < today ? "recent" : d === today ? "today" : "upcoming");
  const base = { athleteId: a.athleteId, personId: a.personId, name: a.name };
  const years = [...new Set([Number(start.slice(0, 4)), Number(end.slice(0, 4))])];
  if (a.firstStart) {
    for (const y of years) {
      const d = recurrenceIn(y, a.firstStart);
      const n = y - Number(a.firstStart.slice(0, 4));
      if (n >= 1 && d >= start && d <= end) out.push({ ...base, key: `anniversary:${y}`, kind: "anniversary", label: ordinalYears(n), date: d, when: when(d) });
    }
    const d30 = addDaysYmd(a.firstStart, 30);
    if (d30 >= start && d30 <= end) out.push({ ...base, key: "first_30_days", kind: "first_30_days", label: "First 30 days complete", date: d30, when: when(d30) });
  }
  if (a.dateOfBirth) {
    for (const y of years) {
      const d = recurrenceIn(y, a.dateOfBirth);
      if (y > Number(a.dateOfBirth.slice(0, 4)) && d >= start && d <= end) out.push({ ...base, key: `birthday:${y}`, kind: "birthday", label: "Birthday", date: d, when: when(d) });
    }
  }
  const n = a.attendedDays.length;
  for (const t of SESSION_MILESTONES) {
    if (n >= t) {
      const d = a.attendedDays[t - 1];
      if (d >= start && d <= end) out.push({ ...base, key: `sessions:${t}`, kind: "sessions", label: `${t} sessions attended`, date: d, when: d === today ? "today" : "recent" });
    } else {
      if (t - n <= SESSIONS_AWAY) out.push({ ...base, key: `sessions:${t}`, kind: "sessions", label: `${t - n} session${t - n === 1 ? "" : "s"} away from ${t}`, date: null, when: "upcoming" });
      break;
    }
  }
  return out;
}

/** Milestones this week for active members in the viewer's scope (coaches: assigned athletes only). */
export async function milestonesThisWeek(tx: Tx, v: Viewer, opts: { today?: string } = {}): Promise<{ today: string; week: { start: string; end: string }; items: Milestone[] }> {
  assertCan(v, "retention.view");
  const ids = await accessibleAthleteIds(tx, v, "profile.read");
  const { tz } = await retentionContext(tx, v.orgId);
  const today = opts.today ?? todayLocal(tz);
  const week = weekOf(today);
  if (ids !== "all" && !ids.length) return { today, week, items: [] };
  const scope = ids === "all" ? sql`` : sql`and a.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`;
  const members = await rowsOf<{ id: string; person_id: string; name: string; date_of_birth: unknown; first_start: unknown }>(
    tx,
    sql`select a.id, a.person_id, p.first_name || ' ' || p.last_name as name, p.date_of_birth,
          (select min(m.start_date) from memberships m where m.athlete_id = a.id and m.status <> 'pending') as first_start
        from athletes a join people p on p.id = a.person_id
        where a.org_id = ${v.orgId} and a.active ${scope}
          and exists (select 1 from memberships m where m.athlete_id = a.id and m.status in ('trialing','active','on_hold','past_due') and m.start_date <= ${today})`,
  );
  if (!members.length) return { today, week, items: [] };
  const endOfToday = localDayBounds(today, tz).end.toISOString();
  const attended = await rowsOf<{ athlete_id: string; starts_at: string | Date }>(
    tx,
    sql`select b.athlete_id, s.starts_at from bookings b join schedule_sessions s on s.id = b.session_id
        where b.org_id = ${v.orgId} and b.status = 'attended' and s.status <> 'cancelled' and s.starts_at < ${endOfToday}
          and b.athlete_id in (${sql.join(members.map((m) => sql`${m.id}`), sql`, `)})
        order by s.starts_at`,
  );
  const days = new Map<string, string[]>();
  for (const r of attended) days.set(r.athlete_id, [...(days.get(r.athlete_id) ?? []), localYmd(new Date(r.starts_at), tz)]);
  const order = { today: 0, upcoming: 1, recent: 2 };
  const items = members
    .flatMap((m) => milestonesFor({ athleteId: m.id, personId: m.person_id, name: m.name, dateOfBirth: ymd(m.date_of_birth), firstStart: ymd(m.first_start), attendedDays: days.get(m.id) ?? [] }, today))
    .sort((a, b) => order[a.when] - order[b.when] || (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.name.localeCompare(b.name));
  return { today, week, items };
}

/** "Create shoutout task": the milestone is re-derived server-side from the athlete id + key (labels are never taken from the client). */
export async function createShoutoutTask(tx: Tx, v: Viewer, input: { athleteId: string; key: string }, opts: { today?: string } = {}) {
  const { items, week } = await milestonesThisWeek(tx, v, opts);
  const m = items.find((x) => x.athleteId === input.athleteId && x.key === input.key);
  if (!m) throw new UserError("That milestone is no longer in this week's list.");
  const { tz } = await retentionContext(tx, v.orgId);
  const [t] = await tx
    .insert(tasks)
    .values({
      orgId: v.orgId,
      title: `Shoutout: ${m.name}: ${m.label}`,
      description: "From Milestones this week. Give a personal shoutout in class or on the whiteboard. Nothing is sent automatically.",
      dueAt: localDayBounds(m.date && m.date >= (opts.today ?? todayLocal(tz)) ? m.date : week.end, tz).end,
      assigneeUserId: v.userId,
      relatedPersonId: m.personId,
      relatedType: "athlete",
      relatedId: m.athleteId,
      source: "retention",
      dedupeKey: `milestone:${m.athleteId}:${m.key}`,
      createdBy: v.userId,
    })
    .onConflictDoNothing({ target: [tasks.orgId, tasks.dedupeKey] })
    .returning();
  if (!t) return { created: false as const };
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "task.create", "task", t.id, { summary: t.title });
  return { created: true as const, task: t };
}
