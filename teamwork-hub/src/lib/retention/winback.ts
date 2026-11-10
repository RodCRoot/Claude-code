import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { reasonLabel, retentionContext, tenureMonths } from "./common";

export type WinbackRow = {
  athleteId: string;
  personId: string;
  name: string;
  endedOn: string;
  lastPlan: string;
  /** Where the reason came from, so staff know how far to trust it. */
  endReason: string;
  reasonSource: "save log" | "cancellation" | "athlete record" | "none";
  memberSince: string;
  tenureMonths: number;
  lastTask: { title: string; at: Date } | null;
};

const ymd = (x: unknown) => (x == null ? null : x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));

/**
 * Winback list: athletes with NO live membership whose most recent membership ended in the last
 * 12 months (365 days). Read-only; outreach is a staff task, never an automatic message.
 * "Ended on" = the membership's end date, else its cancel date, else the day it was marked ended.
 */
export async function winbackList(tx: Tx, v: Viewer, opts: { today?: string } = {}): Promise<{ rows: WinbackRow[]; today: string; since: string }> {
  assertCan(v, "retention.manage");
  const { tz } = await retentionContext(tx, v.orgId);
  const today = opts.today ?? todayLocal(tz);
  const since = addDaysYmd(today, -365);
  const res = await tx.execute(sql`
    with ms as (
      select m.athlete_id, m.start_date, m.status, m.cancel_reason, pr.name as plan,
        coalesce(m.end_date, m.cancel_at, (m.updated_at at time zone ${tz})::date) as ended_on
      from memberships m join product_versions pv on pv.id = m.product_version_id join products pr on pr.id = pv.product_id
      where m.org_id = ${v.orgId} and m.status <> 'pending'),
    last as (
      select distinct on (athlete_id) athlete_id, plan, cancel_reason, ended_on from ms where status in ('cancelled','expired') order by athlete_id, ended_on desc)
    select a.id as athlete_id, a.person_id, p.first_name || ' ' || p.last_name as name, a.inactive_reason, last.plan, last.cancel_reason, last.ended_on,
      (select min(start_date) from ms where ms.athlete_id = a.id) as first_start,
      (select ra.reason_code from retention_actions ra where ra.athlete_id = a.id and ra.outcome = 'lost' order by ra.created_at desc limit 1) as lost_reason,
      (select t.title from tasks t where t.org_id = ${v.orgId} and t.related_person_id = a.person_id and t.created_at >= last.ended_on order by t.created_at desc limit 1) as task_title,
      (select t.created_at from tasks t where t.org_id = ${v.orgId} and t.related_person_id = a.person_id and t.created_at >= last.ended_on order by t.created_at desc limit 1) as task_at
    from athletes a join people p on p.id = a.person_id join last on last.athlete_id = a.id
    where a.org_id = ${v.orgId}
      and last.ended_on > ${since} and last.ended_on <= ${today}
      and not exists (select 1 from memberships m2 where m2.athlete_id = a.id and m2.status in ('pending','trialing','active','on_hold','past_due'))
    order by last.ended_on desc, p.last_name`);
  const rows = (res.rows as Record<string, unknown>[]).map((r): WinbackRow => {
    const endedOn = ymd(r.ended_on)!;
    const memberSince = ymd(r.first_start)!;
    const [endReason, reasonSource]: [string, WinbackRow["reasonSource"]] = r.lost_reason
      ? [reasonLabel(r.lost_reason as string), "save log"]
      : r.cancel_reason
        ? [r.cancel_reason as string, "cancellation"]
        : r.inactive_reason
          ? [r.inactive_reason as string, "athlete record"]
          : ["Not recorded", "none"];
    return {
      athleteId: r.athlete_id as string,
      personId: r.person_id as string,
      name: r.name as string,
      endedOn,
      lastPlan: r.plan as string,
      endReason,
      reasonSource,
      memberSince,
      tenureMonths: tenureMonths(memberSince, endedOn),
      lastTask: r.task_title ? { title: r.task_title as string, at: new Date(r.task_at as string) } : null,
    };
  });
  return { rows, today, since };
}
