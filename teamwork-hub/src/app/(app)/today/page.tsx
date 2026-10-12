import Link from "next/link";
import { db } from "@/db";
import { requireViewer, getOrg } from "@/lib/auth/viewer";
import { can, isAdmin, type Viewer } from "@/lib/authz/policy";
import {
  athleteToday,
  bodyReviewQueue,
  coachOverview,
  familyAthletes,
  familyBilling,
  familyChildSummary,
  integrationHealth,
  leadSummary,
  missingRequiredForms,
  myOpenTasks,
  paymentExceptionsSummary,
  todaysSessions,
  unreadThreads,
  type FamilyChild,
  type SessionSummary,
} from "@/lib/dashboards";
import { Badge, ButtonLink, Card, CardBody, CardHeader, EmptyState, PageHeader, Stat, StatusBadge } from "@/components/ui";
import { fmt, fmtDate, fmtTime } from "@/lib/time";
import { formatMoney } from "@/lib/money";

export const metadata = { title: "Today" };

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ athlete?: string }> }) {
  const v = await requireViewer();
  const org = await getOrg(v.orgId);
  const tz = org?.timezone;
  const sp = await searchParams;
  const hour = Number(fmt(new Date(), "H", tz));
  const greeting = `Good ${hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"}`;
  const dateLabel = fmt(new Date(), "EEEE, MMMM d", tz);

  if (v.role === "coach") return <CoachToday v={v} tz={tz} greeting={greeting} dateLabel={dateLabel} />;
  if (v.role === "guardian" || v.role === "athlete") return <FamilyToday v={v} tz={tz} dateLabel={dateLabel} selected={sp.athlete} />;
  return <StaffToday v={v} tz={tz} greeting={greeting} dateLabel={dateLabel} />;
}

function SessionList({ sessions, tz, empty }: { sessions: SessionSummary[]; tz?: string; empty: string }) {
  if (!sessions.length) return <EmptyState title={empty} />;
  return (
    <ul className="divide-y divide-edge">
      {sessions.map((s) => (
        <li key={s.id}>
          <Link href={`/schedule/sessions/${s.id}`} className="flex flex-wrap items-center justify-between gap-2 py-3 hover:bg-surface-2/60">
            <div>
              <div className="font-medium">{s.title}</div>
              <div className="text-xs text-ink-3">
                {fmtTime(s.starts_at, tz)}–{fmtTime(s.ends_at, tz)} · {s.coach ?? "No coach"}
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm tabular">
              {s.status === "cancelled" ? <StatusBadge status="cancelled" /> : null}
              <span title="Checked in / booked / capacity">
                {s.checked_in}/{s.booked}/{s.capacity}
              </span>
              {s.waitlisted ? <Badge variant="yellow">+{s.waitlisted} waitlist</Badge> : null}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

async function StaffToday({ v, tz, greeting, dateLabel }: { v: Viewer; tz?: string; greeting: string; dateLabel: string }) {
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
      <PageHeader
        kicker={dateLabel}
        title={`${greeting}, ${v.displayName.split(" ")[0]}`}
        actions={
          <>
            <ButtonLink href="/kiosk" variant="secondary">
              Open check-in kiosk
            </ButtonLink>
            {can(v, "people.manage") ? <ButtonLink href="/people/new">Register athlete</ButtonLink> : null}
          </>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sessions today" value={sessions.length} hint={`${totalIn} of ${totalBooked} booked checked in`} />
        <Stat label="My open tasks" value={tasks.length} />
        <Stat label="Missing required forms" value={forms.length} tone={forms.length ? "warn" : undefined} hint="active athletes" />
        {pay ? (
          <Stat label="Past-due invoices" value={pay.past_due} tone={pay.past_due ? "bad" : undefined} hint={pay.past_due ? `${formatMoney(pay.past_due_minor)} outstanding` : "none"} />
        ) : (
          <Stat label="Unread messages" value={unread} />
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Today's sessions" kicker="Roster & check-in" action={<Link href="/schedule" className="text-sm text-brand underline">Full schedule</Link>} />
          <CardBody>
            <SessionList sessions={sessions} tz={tz} empty="No sessions scheduled today" />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="My follow-ups" action={<Link href="/people/tasks" className="text-sm text-brand underline">All tasks</Link>} />
          <CardBody>
            {tasks.length === 0 ? <p className="text-sm text-ink-3">You&apos;re all caught up.</p> : null}
            <ul className="space-y-2">
              {tasks.map((t) => (
                <li key={t.id} className="text-sm">
                  <div className="font-medium">{t.title}</div>
                  <div className="text-xs text-ink-3">
                    {t.person ? (
                      <Link href={`/people/${t.related_person_id}`} className="underline">
                        {t.person}
                      </Link>
                    ) : null}
                    {t.due_at ? ` · due ${fmt(t.due_at, "MMM d", tz)}` : ""}
                    {t.source !== "manual" ? ` · ${t.source}` : ""}
                  </div>
                </li>
              ))}
            </ul>
            {leads ? (
              <div className="mt-4 border-t border-edge pt-3 text-sm">
                <Link href="/people/leads" className="font-medium text-brand underline">
                  {leads.new_leads} new lead{leads.new_leads === 1 ? "" : "s"}
                </Link>{" "}
                · {leads.open_leads} open
                {leads.uncontacted_48h ? <Badge variant="red" className="ml-2">{leads.uncontacted_48h} waiting &gt;48h</Badge> : null}
              </div>
            ) : null}
            {unread ? (
              <div className="mt-2 text-sm">
                <Link href="/messages" className="font-medium text-brand underline">
                  {unread} unread conversation{unread === 1 ? "" : "s"}
                </Link>
              </div>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Missing forms" kicker="Required for booking" action={<Link href="/documents" className="text-sm text-brand underline">Documents</Link>} />
          <CardBody>
            {forms.length === 0 ? <p className="text-sm text-ink-3">Every active athlete has current required forms.</p> : null}
            <ul className="space-y-1 text-sm">
              {forms.map((f, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <Link href={`/people/${f.person_id}`} className="truncate hover:underline">
                    {f.name}
                  </Link>
                  <span className="shrink-0 text-xs text-ink-3">
                    {f.template} · {f.status ? f.status.replace("_", " ") : "not sent"}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>

        {pay ? (
          <Card>
            <CardHeader title="Payment exceptions" action={<Link href="/billing" className="text-sm text-brand underline">Billing</Link>} />
            <CardBody className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Past-due invoices</span>
                <span className="tabular">
                  {pay.past_due} · {formatMoney(pay.past_due_minor)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Failed payment attempts (14d)</span>
                <span className="tabular">{pay.failed_attempts}</span>
              </div>
              <div className="flex justify-between">
                <span title="Initiated but not yet settled (e.g. bank transfers)">Pending, not yet settled</span>
                <span className="tabular">
                  {pay.pending_txn} · {formatMoney(pay.pending_minor)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Webhook failures (14d)</span>
                <span className="tabular">{pay.webhook_failures}</span>
              </div>
            </CardBody>
          </Card>
        ) : null}

        <Card>
          <CardHeader title="Imports & integrations" action={isAdmin(v) ? <Link href="/settings/integrations" className="text-sm text-brand underline">Details</Link> : null} />
          <CardBody className="space-y-2 text-sm">
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
            <div className="flex justify-between">
              <span>Background jobs failing / dead</span>
              <span className="tabular">
                {health.jobs?.failing ?? 0} / {health.jobs?.dead ?? 0}
              </span>
            </div>
            {health.imports.length ? (
              <div>
                <div className="kicker mt-2">Recent imports</div>
                <ul>
                  {health.imports.map((b) => (
                    <li key={b.id} className="flex justify-between">
                      <Link href={`/imports/${b.id}`} className="hover:underline">
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
          </CardBody>
        </Card>

        {review.length ? (
          <Card>
            <CardHeader title="Body-map reviews" kicker="Self-reported — needs coach review" action={<Link href="/science/body-map" className="text-sm text-brand underline">Review queue</Link>} />
            <CardBody>
              <ul className="space-y-1 text-sm">
                {review.map((r) => (
                  <li key={r.id} className="flex justify-between">
                    <span>{r.name}</span>
                    <span className="text-xs text-ink-3">
                      {r.kind} · {r.region.replaceAll("_", " ")} ({r.side}) · {r.severity}/10
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}

async function CoachToday({ v, tz, greeting, dateLabel }: { v: Viewer; tz?: string; greeting: string; dateLabel: string }) {
  const [sessions, overview, tasks, review] = await Promise.all([todaysSessions(db, v.orgId, { coachUserId: v.userId, tz }), coachOverview(db, v, tz), myOpenTasks(db, v), bodyReviewQueue(db, v)]);
  return (
    <>
      <PageHeader
        kicker={dateLabel}
        title={`${greeting}, ${v.displayName.replace(/^Coach\s+/, "").split(" ")[0]}`}
        actions={
          <>
            <ButtonLink href="/training/weight-room" variant="secondary">
              Weight room view
            </ButtonLink>
            <ButtonLink href="/training">Programs</ButtonLink>
          </>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="My sessions today" value={sessions.length} />
        <Stat label="Assigned athletes" value={overview.athleteCount} />
        <Stat label="Wellness check-ins today" value={`${overview.wellness.answered}/${overview.wellness.total}`} hint="not answered ≠ feeling fine" />
        <Stat label="Results to review" value={overview.toReview.length} tone={overview.toReview.length ? "warn" : undefined} />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="My sessions" />
          <CardBody>
            <SessionList sessions={sessions} tz={tz} empty="No sessions assigned to you today" />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Body-map reviews" action={<Link href="/science/body-map" className="text-sm text-brand underline">Queue</Link>} />
          <CardBody>
            {review.length === 0 ? <p className="text-sm text-ink-3">No new self-reports from your athletes.</p> : null}
            <ul className="space-y-1 text-sm">
              {review.map((r) => (
                <li key={r.id} className="flex justify-between gap-2">
                  <Link href={`/people/${r.person_id}`} className="hover:underline">
                    {r.name}
                  </Link>
                  <span className="text-xs text-ink-3">
                    {r.kind} · {r.region.replaceAll("_", " ")} · {r.severity}/10
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Logged results to review" action={<Link href="/training/review" className="text-sm text-brand underline">Review feed</Link>} />
          <CardBody>
            {overview.toReview.length === 0 ? <p className="text-sm text-ink-3">Nothing waiting.</p> : null}
            <ul className="divide-y divide-edge text-sm">
              {overview.toReview.map((w) => (
                <li key={w.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <Link href={`/training/workouts/${w.id}`} className="font-medium hover:underline">
                    {w.name} — {w.title}
                  </Link>
                  <span className="text-xs text-ink-3">
                    {w.completed_at ? fmt(w.completed_at, "MMM d", tz) : ""} {w.session_rpe != null ? `· sRPE ${w.session_rpe}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Recent tests" />
          <CardBody>
            {overview.recentTests.length === 0 ? <p className="text-sm text-ink-3">No tests in the last 3 weeks.</p> : null}
            <ul className="space-y-1 text-sm">
              {overview.recentTests.map((t) => (
                <li key={t.id} className="flex justify-between gap-2">
                  <Link href={`/performance/${t.athlete_id}`} className="hover:underline">
                    {t.name}
                  </Link>
                  <span className="text-xs text-ink-3">
                    {t.test} · {fmt(t.tested_at, "MMM d", tz)} · {t.source}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="My tasks" />
          <CardBody>
            {tasks.length === 0 ? <p className="text-sm text-ink-3">No open tasks.</p> : null}
            <ul className="space-y-1 text-sm">
              {tasks.map((t) => (
                <li key={t.id}>{t.title}</li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

async function FamilyToday({ v, tz, dateLabel, selected }: { v: Viewer; tz?: string; dateLabel: string; selected?: string }) {
  const children = await familyAthletes(db, v);
  const billing = await familyBilling(db, v);
  const unread = await unreadThreads(db, v);
  const child: FamilyChild | undefined = children.find((c) => c.athleteId === selected) ?? children[0];
  const summary = child ? await familyChildSummary(db, v, child, tz) : null;
  const athleteSelf = v.role === "athlete" && child ? await athleteToday(db, child.athleteId, tz) : null;

  return (
    <>
      <PageHeader kicker={dateLabel} title={v.role === "athlete" ? `Let's go, ${v.displayName.split(" ")[0]}` : `Hi, ${v.displayName.split(" ")[0]}`} />
      {children.length > 1 ? (
        <nav aria-label="Choose athlete" className="mb-5 flex flex-wrap gap-2">
          {children.map((c) => (
            <Link
              key={c.athleteId}
              href={`/today?athlete=${c.athleteId}`}
              aria-current={c.athleteId === child?.athleteId ? "true" : undefined}
              className={`min-h-11 rounded-full border px-4 py-2.5 text-sm font-medium ${c.athleteId === child?.athleteId ? "border-brand bg-brand text-brand-ink" : "border-edge bg-surface"}`}
            >
              {c.name}
            </Link>
          ))}
        </nav>
      ) : null}
      {!child || !summary ? (
        <EmptyState title="No athletes linked to your account yet">Ask the front desk to link your child to your account.</EmptyState>
      ) : (
        <div className="grid gap-5 lg:grid-cols-3">
          {athleteSelf ? (
            <Card className="lg:col-span-2">
              <CardHeader title="Today's training" kicker={child.name} />
              <CardBody className="space-y-3">
                {athleteSelf.workouts.length === 0 ? <p className="text-sm text-ink-3">No workout scheduled today.</p> : null}
                {athleteSelf.workouts.map((w) => (
                  <div key={w.id} className="flex items-center justify-between rounded-lg border border-edge p-3">
                    <div>
                      <div className="font-medium">{w.title}</div>
                      <StatusBadge status={w.status} />
                    </div>
                    <ButtonLink href="/training/today" size="lg">
                      {w.status === "completed" ? "View" : "Start logging"}
                    </ButtonLink>
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  <ButtonLink href="/science" variant={athleteSelf.checkedIn ? "secondary" : "primary"}>
                    {athleteSelf.checkedIn ? "Wellness check-in done ✓" : "Do today's check-in"}
                  </ButtonLink>
                  <ButtonLink href="/science/body-map" variant="secondary">
                    Report soreness / pain
                  </ButtonLink>
                </div>
                {athleteSelf.habits.length ? (
                  <div>
                    <div className="kicker mb-1">Habits today</div>
                    <ul className="flex flex-wrap gap-2">
                      {athleteSelf.habits.map((h) => (
                        <li key={h.id}>
                          <Badge variant={h.status === "done" ? "green" : h.status === "missed" ? "red" : "neutral"}>
                            {h.name}: {h.status ?? "not logged"}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {athleteSelf.goals.length ? (
                  <div>
                    <div className="kicker mb-1">Goals</div>
                    <ul className="text-sm">
                      {athleteSelf.goals.map((g) => (
                        <li key={g.id}>
                          {g.title}
                          {g.due_date ? <span className="text-ink-3"> · by {fmtDate(g.due_date)}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          <Card className={athleteSelf ? "" : "lg:col-span-2"}>
            <CardHeader
              title="Upcoming sessions"
              kicker={child.name}
              action={child.caps.includes("booking.create") ? <ButtonLink href={`/schedule?athlete=${child.athleteId}`} size="sm">Book</ButtonLink> : null}
            />
            <CardBody>
              {summary.upcoming.length === 0 ? <p className="text-sm text-ink-3">Nothing booked in the next two weeks.</p> : null}
              <ul className="divide-y divide-edge text-sm">
                {summary.upcoming.map((b) => (
                  <li key={b.id} className="flex justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium">{b.title}</span>
                      <span className="block text-xs text-ink-3">{fmt(b.starts_at, "EEE MMM d, h:mm a", tz)}</span>
                    </span>
                    <StatusBadge status={b.status} />
                  </li>
                ))}
              </ul>
              <div className="mt-3 text-sm text-ink-2">
                {summary.membership ? (
                  <>
                    Membership: <span className="font-medium">{summary.membership.name}</span> <StatusBadge status={summary.membership.status} />
                  </>
                ) : (
                  "No active membership."
                )}{" "}
                · Session credits available: <span className="font-semibold tabular">{summary.credits}</span>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Forms to sign" action={<Link href="/documents" className="text-sm text-brand underline">Documents</Link>} />
            <CardBody>
              {!child.caps.includes("forms.sign") ? (
                <p className="text-sm text-ink-3">Your account isn&apos;t set up to sign forms for {child.name.split(" ")[0]}.</p>
              ) : summary.forms.length === 0 ? (
                <p className="text-sm text-ink-3">All caught up.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {summary.forms.map((f) => (
                    <li key={f.id} className="flex items-center justify-between gap-2">
                      <Link href={`/documents/requests/${f.id}`} className="font-medium text-brand underline">
                        {f.title}
                      </Link>
                      <StatusBadge status={f.status} />
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {child.caps.includes("training.read") && !athleteSelf ? (
            <Card>
              <CardHeader title="Recent training" action={<Link href={`/performance/${child.athleteId}`} className="text-sm text-brand underline">Progress</Link>} />
              <CardBody>
                {summary.workouts.length === 0 ? <p className="text-sm text-ink-3">No workouts in the last two weeks.</p> : null}
                <ul className="space-y-1 text-sm">
                  {summary.workouts.map((w) => (
                    <li key={w.id} className="flex justify-between">
                      <span>{w.title}</span>
                      <span className="flex items-center gap-2 text-xs text-ink-3">
                        {fmtDate(w.scheduled_date)} <StatusBadge status={w.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Payments" action={billing.open.length || billing.canPayIds.length ? <Link href="/billing" className="text-sm text-brand underline">Billing</Link> : null} />
            <CardBody>
              {billing.open.length === 0 ? (
                <p className="text-sm text-ink-3">No open invoices{billing.canPayIds.length ? "" : " visible to you"}.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {billing.open.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-2">
                      <Link href={`/billing/invoices/${i.id}`} className="underline">
                        {i.number}
                        {i.due_date ? ` · due ${fmtDate(i.due_date)}` : ""}
                      </Link>
                      <span className="font-medium tabular">{formatMoney(i.total_minor, i.currency)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Messages" />
            <CardBody className="text-sm">
              {unread ? `${unread} unread conversation${unread === 1 ? "" : "s"}. ` : "No unread messages. "}
              <Link href="/messages" className="font-medium text-brand underline">
                Open messages
              </Link>
            </CardBody>
          </Card>
        </div>
      )}
    </>
  );
}
