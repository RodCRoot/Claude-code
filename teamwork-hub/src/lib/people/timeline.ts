import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athleteCapabilities, isStaff, AuthzError, type Viewer } from "@/lib/authz/policy";

export type TimelineEvent = {
  at: string;
  kind: "booking" | "membership" | "invoice" | "payment" | "form" | "workout" | "max" | "wellness" | "body" | "test" | "message" | "note" | "task" | "lead";
  title: string;
  detail?: string | null;
  status?: string | null;
  href?: string | null;
  /** Which capability gated this row — shown so staff understand what families can see. */
  gate: string;
};

type Row = Record<string, unknown>;

async function q(tx: Tx, query: ReturnType<typeof sql>): Promise<Row[]> {
  return (await tx.execute(query)).rows as Row[];
}

/**
 * One chronological history for an athlete across every module. Each source is
 * included only when the viewer holds the capability that protects it.
 */
export async function athleteTimeline(tx: Tx, v: Viewer, athleteId: string, opts: { limit?: number; kinds?: string[] } = {}) {
  const caps = await athleteCapabilities(tx, v, athleteId);
  if (!caps.has("profile.read")) throw new AuthzError();
  const limit = Math.min(opts.limit ?? 150, 500);
  const events: TimelineEvent[] = [];
  const want = (k: string) => !opts.kinds?.length || opts.kinds.includes(k);

  if (want("booking")) {
    for (const r of await q(
      tx,
      sql`select b.id, b.status, b.checked_in_at, s.title, s.starts_at, s.id as session_id
          from bookings b join schedule_sessions s on s.id = b.session_id
          where b.athlete_id = ${athleteId} order by s.starts_at desc limit ${limit}`,
    )) {
      events.push({ at: String(new Date(r.starts_at as string).toISOString()), kind: "booking", title: String(r.title), status: String(r.status), href: isStaff(v) ? `/schedule/sessions/${r.session_id}` : null, gate: "profile.read" });
    }
  }

  if (want("form")) {
    for (const r of await q(
      tx,
      sql`select fr.id, fr.status, fr.created_at, fr.completed_at, v.title, v.version
          from form_requests fr join form_template_versions v on v.id = fr.template_version_id
          where fr.athlete_id = ${athleteId} order by coalesce(fr.completed_at, fr.created_at) desc limit ${limit}`,
    )) {
      events.push({
        at: new Date((r.completed_at ?? r.created_at) as string).toISOString(),
        kind: "form",
        title: `${r.title} (v${r.version})`,
        status: String(r.status),
        href: `/documents/requests/${r.id}`,
        gate: "profile.read",
      });
    }
  }

  if (caps.has("billing.read") && (want("membership") || want("invoice") || want("payment"))) {
    for (const r of await q(
      tx,
      sql`select me.type, me.created_at, p.name, m.id
          from membership_events me join memberships m on m.id = me.membership_id
          join product_versions pv on pv.id = m.product_version_id join products p on p.id = pv.product_id
          where m.athlete_id = ${athleteId} order by me.created_at desc limit ${limit}`,
    )) {
      events.push({ at: new Date(r.created_at as string).toISOString(), kind: "membership", title: `${r.name}: ${String(r.type).replaceAll("_", " ")}`, href: `/billing/memberships/${r.id}`, gate: "billing.read" });
    }
    for (const r of await q(
      tx,
      sql`select distinct i.id, i.number, i.status, i.total_minor, i.currency, coalesce(i.issued_at, i.created_at) as at
          from invoices i join invoice_lines il on il.invoice_id = i.id
          where il.athlete_id = ${athleteId} order by at desc limit ${limit}`,
    )) {
      events.push({
        at: new Date(r.at as string).toISOString(),
        kind: "invoice",
        title: `Invoice ${r.number}`,
        detail: new Intl.NumberFormat("en-US", { style: "currency", currency: String(r.currency) }).format(Number(r.total_minor) / 100),
        status: String(r.status),
        href: `/billing/invoices/${r.id}`,
        gate: "billing.read",
      });
    }
  }

  if (caps.has("training.read") && (want("workout") || want("max"))) {
    for (const r of await q(
      tx,
      sql`select id, title, status, scheduled_date, completed_at, session_rpe from workouts
          where athlete_id = ${athleteId} and (status in ('completed','skipped') or scheduled_date <= current_date)
          order by scheduled_date desc limit ${limit}`,
    )) {
      events.push({
        at: new Date((r.completed_at as string) ?? `${r.scheduled_date}T12:00:00Z`).toISOString(),
        kind: "workout",
        title: String(r.title),
        status: String(r.status),
        detail: r.session_rpe != null ? `sRPE ${r.session_rpe}` : null,
        href: `/training/workouts/${r.id}`,
        gate: "training.read",
      });
    }
    for (const r of await q(
      tx,
      sql`select m.value, m.unit, m.kind, m.method, m.recorded_on, e.name from maxes m join exercises e on e.id = m.exercise_id
          where m.athlete_id = ${athleteId} order by m.recorded_on desc limit ${limit}`,
    )) {
      events.push({ at: new Date(`${r.recorded_on}T12:00:00Z`).toISOString(), kind: "max", title: `${r.name} ${r.kind} max`, detail: `${Number(r.value)} ${r.unit} (${r.method})`, gate: "training.read" });
    }
    for (const r of await q(
      tx,
      sql`select ts.id, ts.tested_at, ts.source, tt.name from test_sessions ts join test_types tt on tt.id = ts.test_type_id
          where ts.athlete_id = ${athleteId} order by ts.tested_at desc limit ${limit}`,
    )) {
      events.push({ at: new Date(r.tested_at as string).toISOString(), kind: "test", title: String(r.name), detail: `source: ${r.source}`, href: `/performance/${athleteId}`, gate: "training.read" });
    }
  }

  if (caps.has("health.read") && (want("wellness") || want("body"))) {
    for (const r of await q(
      tx,
      sql`select for_date, submitted_at from questionnaire_responses where athlete_id = ${athleteId} order by for_date desc limit ${limit}`,
    )) {
      events.push({ at: new Date(r.submitted_at as string).toISOString(), kind: "wellness", title: `Wellness check-in for ${r.for_date}`, gate: "health.read" });
    }
    for (const r of await q(
      tx,
      sql`select region, side, kind, severity, reported_at, review_status from body_region_reports where athlete_id = ${athleteId} order by reported_at desc limit ${limit}`,
    )) {
      events.push({
        at: new Date(r.reported_at as string).toISOString(),
        kind: "body",
        title: `${String(r.kind)} — ${String(r.region).replaceAll("_", " ")} (${r.side})`,
        detail: `Self-reported severity ${r.severity}/10`,
        status: String(r.review_status),
        gate: "health.read",
      });
    }
  }

  if (isStaff(v) && want("message")) {
    for (const r of await q(
      tx,
      sql`select id, subject, status, coalesce(last_message_at, created_at) as at from threads where athlete_id = ${athleteId} order by at desc limit ${limit}`,
    )) {
      events.push({ at: new Date(r.at as string).toISOString(), kind: "message", title: `Thread: ${r.subject}`, status: String(r.status), href: `/messages/${r.id}`, gate: "staff" });
    }
  }

  events.sort((a, b) => (a.at < b.at ? 1 : -1));
  return events.slice(0, limit);
}
