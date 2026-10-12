import Link from "next/link";
import { db } from "@/db";
import { can, isAdmin, type Viewer } from "@/lib/authz/policy";
import {
  bodyReviewQueue,
  integrationHealth,
  leadSummary,
  missingRequiredForms,
  myOpenTasks,
  paymentExceptionsSummary,
  todaysSessions,
  unreadThreads,
  type SessionSummary,
} from "@/lib/dashboards";
import { Badge, ButtonLink, StatusBadge } from "@/components/ui";
import { KpiTile, MemberAvatar, Meter, Widget, WidgetEmpty } from "@/components/profile/studio";
import { fmt, fmtTime } from "@/lib/time";
import { formatMoney } from "@/lib/money";
import { TimeClockCard } from "@/components/time-clock-card";

/** Front-desk dashboard (owner/admin/operations): KPI row + widget grid. Same data and checks as before. */
export async function StaffToday({ v, tz, greeting, dateLabel }: { v: Viewer; tz?: string; greeting: string; dateLabel: string }) {
  const [sessions, tasks, forms, pay, health, leads, review, unread] = await Promise.all([
    todaysSessions(db, v.orgId, { tz }),
    myOpenTasks(db, v),
    missingRequiredForms(db, v.orgId, 8),
    can(v, "billing.view_all") ? paymentExceptionsSummary(db, v.orgId) : null,
    integrationHealth(db, v.orgId),
    can(v, "crm.manage") ? leadSummary(db, v.orgId) : null,
    isAdmin(v) ? bodyReviewQueue(db, v) : Promise.resolve([]),
    unreadThreads(db, v),
  ]);
  const totalBooked = sessions.reduce((s, x) => s + x.booked, 0);
  const totalIn = sessions.reduce((s, x) => s + x.checked_in, 0);
  const brokenIntegrations = health.integrations.filter((i) => i.status === "error");
  return (
    <>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="kicker">{dateLabel}</div>
          <h1 className="text-[22px] font-bold tracking-tight">{`${greeting}, ${v.displayName.split(" ")[0]}`}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <ButtonLink href="/kiosk" variant="secondary">
            Open check-in kiosk
          </ButtonLink>
          {can(v, "people.manage") ? <ButtonLink href="/people/new">Register athlete</ButtonLink> : null}
        </div>
      </header>

      <div className="mb-4 grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-4">
        <KpiTile icon="schedule" label="Classes today" value={sessions.length} hint={`${totalIn} of ${totalBooked} booked checked in`} href="/schedule" />
        <KpiTile icon="today" label="My open tasks" value={tasks.length} href="/people/tasks" />
        <KpiTile icon="documents" label="Missing required forms" value={forms.length} tone={forms.length ? "warn" : "ok"} hint="active athletes" href="/documents" />
        {pay ? (
          <KpiTile icon="billing" label="Past-due invoices" value={pay.past_due} tone={pay.past_due ? "bad" : "ok"} hint={pay.past_due ? `${formatMoney(pay.past_due_minor)} outstanding` : "none"} href="/billing/invoices?status=past_due" />
        ) : (
          <KpiTile icon="messages" label="Unread messages" value={unread} href="/messages" />
        )}
      </div>

      <TimeClockCard v={v} tz={tz} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Widget title="Today's classes" icon="schedule" count={sessions.length} href="/schedule" linkLabel="Full schedule" className="lg:col-span-2" flush>
          <ClassesToday sessions={sessions} tz={tz} />
        </Widget>

        <div className="grid min-w-0 gap-4">
          <Widget title="My follow-ups" icon="today" count={tasks.length} href="/people/tasks" linkContext="tasks">
            {tasks.length === 0 ? <WidgetEmpty>You&apos;re all caught up.</WidgetEmpty> : null}
            <ul className="divide-y divide-edge">
              {tasks.map((t) => (
                <li key={t.id} className="py-2 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium">{t.title}</span>
                    {t.priority === "high" ? <Badge variant="red">high</Badge> : null}
                  </div>
                  <div className="text-xs text-ink-3">
                    {t.person ? (
                      <Link href={`/people/${t.related_person_id}`} className="font-medium text-ink-2 underline">
                        {t.person}
                      </Link>
                    ) : null}
                    {t.due_at ? ` · due ${fmt(t.due_at, "MMM d", tz)}` : ""}
                    {t.source !== "manual" ? ` · ${t.source}` : ""}
                  </div>
                </li>
              ))}
            </ul>
            {unread ? (
              <div className="mt-2 border-t border-edge pt-2 text-sm">
                <Link href="/messages" className="font-medium text-brand underline">
                  {unread} unread conversation{unread === 1 ? "" : "s"}
                </Link>
              </div>
            ) : null}
          </Widget>

          {leads ? (
            <Widget title="Leads & sign-ups" icon="people" href="/people/leads" linkLabel="Pipeline">
              <dl className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-md bg-surface-2 px-2 py-2">
                  <dt className="text-[11px] font-semibold text-ink-3">New</dt>
                  <dd className="text-xl font-bold tabular">{leads.new_leads}</dd>
                </div>
                <div className="rounded-md bg-surface-2 px-2 py-2">
                  <dt className="text-[11px] font-semibold text-ink-3">Open</dt>
                  <dd className="text-xl font-bold tabular">{leads.open_leads}</dd>
                </div>
                <div className={`rounded-md px-2 py-2 ${leads.uncontacted_48h ? "bg-bad/10" : "bg-surface-2"}`}>
                  <dt className="text-[11px] font-semibold text-ink-3">Waiting &gt;48h</dt>
                  <dd className={`text-xl font-bold tabular ${leads.uncontacted_48h ? "text-bad" : ""}`}>{leads.uncontacted_48h}</dd>
                </div>
              </dl>
            </Widget>
          ) : null}
        </div>

        <Widget title="Missing forms" icon="documents" count={forms.length} href="/documents" linkLabel="Documents" flush>
          {forms.length === 0 ? (
            <div className="px-4 py-3">
              <WidgetEmpty>Every active athlete has current required forms.</WidgetEmpty>
            </div>
          ) : (
            <ul className="divide-y divide-edge">
              {forms.map((f, i) => (
                <li key={i}>
                  <Link href={`/people/${f.person_id}`} className="flex items-center gap-3 px-4 py-2 hover:bg-surface-2">
                    <MemberAvatar name={f.name} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{f.name}</span>
                      <span className="block truncate text-xs text-ink-3">{f.template}</span>
                    </span>
                    {f.status ? <StatusBadge status={f.status} /> : <Badge variant="red">not sent</Badge>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Widget>

        {pay ? (
          <Widget title="Payment exceptions" icon="billing" href="/billing" linkLabel="Billing" flush>
            <table className="w-full text-sm">
              <caption className="sr-only">Payment exceptions</caption>
              <tbody className="[&_tr]:border-b [&_tr]:border-edge/70 [&_tr:last-child]:border-0">
                <tr>
                  <th scope="row" className="px-4 py-2 text-left font-normal">
                    <Link href="/billing/invoices?status=past_due" className="hover:underline">
                      Past-due invoices
                    </Link>
                  </th>
                  <td className="px-2 py-2 text-right tabular">{pay.past_due}</td>
                  <td className={`px-4 py-2 text-right font-semibold tabular ${pay.past_due ? "text-bad" : ""}`}>{formatMoney(pay.past_due_minor)}</td>
                </tr>
                <tr>
                  <th scope="row" className="px-4 py-2 text-left font-normal">
                    Failed payment attempts <span className="text-ink-3">(14d)</span>
                  </th>
                  <td className="px-2 py-2 text-right tabular">{pay.failed_attempts}</td>
                  <td className="px-4 py-2 text-right text-ink-3">—</td>
                </tr>
                <tr>
                  <th scope="row" className="px-4 py-2 text-left font-normal" title="Initiated but not yet settled (e.g. bank transfers)">
                    Pending, not yet settled
                  </th>
                  <td className="px-2 py-2 text-right tabular">{pay.pending_txn}</td>
                  <td className="px-4 py-2 text-right font-semibold tabular text-warn">{formatMoney(pay.pending_minor)}</td>
                </tr>
                <tr>
                  <th scope="row" className="px-4 py-2 text-left font-normal">
                    Webhook failures <span className="text-ink-3">(14d)</span>
                  </th>
                  <td className="px-2 py-2 text-right tabular">{pay.webhook_failures}</td>
                  <td className="px-4 py-2 text-right text-ink-3">—</td>
                </tr>
              </tbody>
            </table>
          </Widget>
        ) : null}

        <Widget title="Imports & integrations" icon="imports" href={isAdmin(v) ? "/settings/integrations" : null} linkLabel="Details" bodyClassName="space-y-2 text-sm">
          <ul className="flex flex-wrap gap-1">
            {health.integrations.map((i) => (
              <li key={i.provider}>
                <Badge variant={i.status === "connected" || i.status === "verified_sandbox" ? "green" : i.status === "error" ? "red" : "neutral"} title={i.last_error ?? undefined}>
                  {i.provider.replace("_", " ")}: {i.status.replace(/_/g, " ")}
                </Badge>
              </li>
            ))}
          </ul>
          {brokenIntegrations.length ? <p className="text-bad">{brokenIntegrations.length} integration(s) reporting errors.</p> : null}
          <div className="flex justify-between border-t border-edge pt-2">
            <span>Background jobs failing / dead</span>
            <span className="tabular">
              {health.jobs?.failing ?? 0} / {health.jobs?.dead ?? 0}
            </span>
          </div>
          {health.imports.length ? (
            <div>
              <div className="kicker mt-1">Recent imports</div>
              <ul>
                {health.imports.map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-2 py-0.5">
                    <Link href={`/imports/${b.id}`} className="truncate hover:underline">
                      {b.source} · {b.entity_type}
                    </Link>
                    <StatusBadge status={b.status} />
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-ink-3">No imports yet.</p>
          )}
        </Widget>

        {review.length ? (
          <Widget title="Body-map reviews" icon="science" count={review.length} href="/science/body-map" linkLabel="Review queue" flush>
            <p className="border-b border-edge px-4 py-1.5 text-xs text-ink-3">Self-reported — needs coach review</p>
            <ul className="divide-y divide-edge text-sm">
              {review.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 px-4 py-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <MemberAvatar name={r.name} size="sm" />
                    <span className="truncate font-medium">{r.name}</span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-ink-3">
                    {r.kind} · {r.region.replaceAll("_", " ")} ({r.side}) · {r.severity}/10
                  </span>
                </li>
              ))}
            </ul>
          </Widget>
        ) : null}
      </div>
    </>
  );
}

/** Today's classes as a roster table (desktop) / stacked list (phone) with check-in progress. */
function ClassesToday({ sessions, tz }: { sessions: SessionSummary[]; tz?: string }) {
  if (!sessions.length)
    return (
      <div className="px-4 py-3">
        <WidgetEmpty>No classes scheduled today.</WidgetEmpty>
      </div>
    );
  return (
    <>
      <ul className="divide-y divide-edge sm:hidden">
        {sessions.map((s) => (
          <li key={s.id}>
            <Link href={`/schedule/sessions/${s.id}`} className="block px-4 py-3 hover:bg-surface-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{s.title}</span>
                {s.status === "cancelled" ? <StatusBadge status="cancelled" /> : null}
              </div>
              <div className="text-xs text-ink-3">
                {fmtTime(s.starts_at, tz)}–{fmtTime(s.ends_at, tz)} · {s.coach ?? "No coach"}
              </div>
              <div className="mt-1.5 flex items-center gap-2 text-xs tabular">
                <span className="w-24 shrink-0">
                  {s.checked_in}/{s.booked} checked in
                </span>
                <Meter value={s.checked_in} max={s.booked} tone="ok" />
              </div>
            </Link>
          </li>
        ))}
      </ul>
      <div className="hidden sm:block">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Today&apos;s classes with check-in counts</caption>
          <thead>
            <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-ink-2">
              <th scope="col" className="border-b border-edge px-4 py-2">Time</th>
              <th scope="col" className="border-b border-edge px-3 py-2">Class</th>
              <th scope="col" className="border-b border-edge px-3 py-2">Coach</th>
              <th scope="col" className="border-b border-edge px-3 py-2">Checked in</th>
              <th scope="col" className="border-b border-edge px-4 py-2 text-right">Booked / cap.</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} className="hover:bg-surface-2">
                <td className="whitespace-nowrap border-b border-edge/70 px-4 py-2.5 tabular text-ink-2">
                  {fmtTime(s.starts_at, tz)}
                  <span className="block text-xs text-ink-3">to {fmtTime(s.ends_at, tz)}</span>
                </td>
                <td className="border-b border-edge/70 px-3 py-2.5">
                  <Link href={`/schedule/sessions/${s.id}`} className="font-semibold hover:underline">
                    {s.title}
                  </Link>
                  {s.status === "cancelled" ? <StatusBadge status="cancelled" className="ml-2" /> : null}
                  {s.waitlisted ? (
                    <Badge variant="yellow" className="ml-2">
                      +{s.waitlisted} waitlist
                    </Badge>
                  ) : null}
                </td>
                <td className="border-b border-edge/70 px-3 py-2.5 text-ink-2">{s.coach ?? "No coach"}</td>
                <td className="w-44 border-b border-edge/70 px-3 py-2.5">
                  <div className="flex items-center gap-2 tabular">
                    <span className="w-10 shrink-0 font-semibold">
                      {s.checked_in}/{s.booked}
                    </span>
                    <Meter value={s.checked_in} max={s.booked} tone="ok" />
                  </div>
                </td>
                <td className="border-b border-edge/70 px-4 py-2.5 text-right tabular">
                  {s.booked}/{s.capacity}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
