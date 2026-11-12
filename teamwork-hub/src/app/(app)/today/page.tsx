import Link from "next/link";
import { db } from "@/db";
import { requireViewer, getOrg } from "@/lib/auth/viewer";
import { type Viewer } from "@/lib/authz/policy";
import {
  bodyReviewQueue,
  coachOverview,
  myOpenTasks,
  todaysSessions,
  type SessionSummary,
} from "@/lib/dashboards";
import { StaffToday } from "./_components/staff-dashboard";
import { AthleteHomeView } from "./_components/athlete-home";
import { Badge, ButtonLink, Card, CardBody, CardHeader, EmptyState, PageHeader, Stat, StatusBadge } from "@/components/ui";
import { fmt, fmtTime } from "@/lib/time";
import { TimeClockCard } from "@/components/time-clock-card";
import { CompetingThisWeekCard } from "@/components/wins/staff";

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
  if (v.role === "guardian" || v.role === "athlete") return <AthleteHomeView v={v} tz={tz} dateLabel={dateLabel} greeting={greeting} selected={sp.athlete} />;
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
      <TimeClockCard v={v} tz={tz} />
      <CompetingThisWeekCard v={v} tz={tz} className="mb-5" />
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
