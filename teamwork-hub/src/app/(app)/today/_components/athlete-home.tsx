import Link from "next/link";
import { db } from "@/db";
import { BadgeMedallion, Flame, LevelRing, WeekDots } from "@/components/engagement/medallion";
import { GoalList } from "@/components/engagement/goals";
import { Badge, ButtonLink, Card, CardBody, CardHeader, EmptyState, StatusBadge } from "@/components/ui";
import { type Viewer } from "@/lib/authz/policy";
import { familyAthletes, familyBilling, familyChildSummary, unreadThreads, type FamilyChild } from "@/lib/dashboards";
import { athleteHome, countdown, type AthleteHome } from "@/lib/engagement/home";
import { formatMoney } from "@/lib/money";
import { fmt, fmtDate, fmtTime, localToUtc, localYmd } from "@/lib/time";
import { PrBadge, ProgressBar } from "../../training/_components/tb";

/**
 * Athlete Home: the athlete and guardian view of /today. Mobile-first. Everything shown comes
 * from `athleteHome` (src/lib/engagement/home.ts), which returns null for any section the viewer
 * may not see, so a guardian without health or training access simply gets fewer cards.
 */
export async function AthleteHomeView({ v, tz, dateLabel, greeting, selected }: { v: Viewer; tz?: string; dateLabel: string; greeting: string; selected?: string }) {
  const [children, billing, unread] = await Promise.all([familyAthletes(db, v), familyBilling(db, v), unreadThreads(db, v)]);
  const child: FamilyChild | undefined = children.find((c) => c.athleteId === selected) ?? children[0];
  const isAthlete = v.role === "athlete";
  const viewerFirst = v.displayName.split(" ")[0];
  const home = child ? await db.transaction((tx) => athleteHome(tx, v, child.athleteId, { tz })) : null;
  // Family items cover every linked child, not only the selected one.
  const family = !isAthlete ? await Promise.all(children.map(async (c) => ({ child: c, summary: await familyChildSummary(db, v, c, tz) }))) : [];

  return (
    <div className="mx-auto max-w-5xl">
      <Hero v={v} tz={tz} dateLabel={dateLabel} title={isAthlete ? `${greeting}, ${home?.firstName ?? viewerFirst}` : `Hi, ${viewerFirst}`} home={home} isAthlete={isAthlete} childName={child?.name}>
        {children.length > 1 ? (
          <nav aria-label="Choose athlete" className="mt-3 flex flex-wrap gap-2">
            {children.map((c) => {
              const current = c.athleteId === child?.athleteId;
              return (
                <Link
                  key={c.athleteId}
                  href={`/today?athlete=${c.athleteId}`}
                  aria-current={current ? "true" : undefined}
                  className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-bold ${current ? "bg-[#4fc3f7] text-[#0b1a2e]" : "bg-white/10 text-white ring-1 ring-white/25 hover:bg-white/20"}`}
                >
                  {c.name.split(" ")[0]}
                </Link>
              );
            })}
          </nav>
        ) : null}
      </Hero>

      {!child || !home ? (
        <div className="space-y-4">
          <EmptyState title="No athletes linked to your account yet">Ask the front desk to link your athlete to your account.</EmptyState>
          <PaymentsCard billing={billing} />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <WorkoutCard home={home} isAthlete={isAthlete} />
            {isAthlete && home.wellness?.due && !home.wellness.done ? (
              <section className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-info/30 bg-info/5 px-4 py-3">
                <div className="min-w-0">
                  <h2 className="text-[15px] font-semibold">Today&apos;s check-in</h2>
                  <p className="text-sm text-ink-2">One minute. It helps your coach plan your day.</p>
                </div>
                <ButtonLink href="/science" variant="secondary">
                  Do check-in
                </ButtonLink>
              </section>
            ) : null}
            <NextSessionCard home={home} tz={tz} />
            <WeekCard home={home} />
            {home.goals ? (
              <Card>
                <CardHeader title="Goals" kicker={`${home.goals.length} active`} action={<Link href={`/goals?athlete=${home.athleteId}`} className="text-sm font-semibold text-brand underline">{home.goals.length ? "All goals" : "Set a goal"}</Link>} />
                <CardBody>
                  <GoalList goals={home.goals.slice(0, 4)} canWrite={false} compact empty={isAthlete ? "No goals yet. Pick one thing to work toward." : `No goals yet for ${home.firstName}.`} />
                </CardBody>
              </Card>
            ) : null}
          </div>

          <div className="space-y-4">
            {!isAthlete ? <FamilyCard family={family} billing={billing} tz={tz} /> : null}
            {home.engagement?.badges ? (
              <Card>
                <CardHeader title="Badges" kicker={`${home.engagement.badges.length} earned`} action={<Link href={`/goals?athlete=${home.athleteId}#badges`} className="text-sm font-semibold text-brand underline">See all</Link>} />
                <CardBody>
                  {home.engagement.badges.length === 0 ? (
                    <p className="text-sm text-ink-3">The first badge comes with the first session.</p>
                  ) : (
                    <ul className="grid grid-cols-3 gap-2 text-center">
                      {home.engagement.badges.slice(0, 3).map((b) => (
                        <li key={b.def.key} className="flex min-w-0 flex-col items-center gap-1">
                          <BadgeMedallion def={b.def} size={64} />
                          <span className="text-xs leading-tight font-semibold">{b.def.name}</span>
                          <span className="text-[11px] leading-none text-ink-3">{fmt(b.earnedAt, "MMM d", tz)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>
            ) : null}
            {home.prs ? (
              <Card>
                <CardHeader title="Latest PRs" action={<Link href={`/performance/${home.athleteId}`} className="text-sm font-semibold text-brand underline">Progress</Link>} />
                <CardBody>
                  {home.prs.length === 0 ? (
                    <p className="text-sm text-ink-3">New personal records will show up here.</p>
                  ) : (
                    <ul className="divide-y divide-edge">
                      {home.prs.map((p) => (
                        <li key={`${p.exercise}-${p.recordedOn}`} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                          <span className="min-w-0">
                            <span className="block truncate font-semibold">{p.exercise}</span>
                            <span className="text-xs text-ink-3">{fmtDate(p.recordedOn)}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2 text-right">
                            <span>
                              <span className="text-lg leading-none font-extrabold tabular">{p.value}</span> <span className="text-xs text-ink-2">{p.unit}</span>
                              {p.gain !== null ? <span className="block text-[11px] font-semibold text-ok tabular">+{Math.round(p.gain * 10) / 10} {p.unit}</span> : null}
                            </span>
                            <PrBadge />
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>
            ) : null}
            {home.checklist.length ? (
              <Card>
                <CardHeader title="What's next" kicker={`${home.checklist.filter((i) => i.done).length} of ${home.checklist.length} done`} />
                <CardBody>
                  <ul className="space-y-2.5">
                    {home.checklist.map((i) => (
                      <li key={i.key} className="flex items-start gap-2.5">
                        <span aria-hidden className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-extrabold ${i.done ? "bg-ok/15 text-ok" : "border-2 border-edge"}`}>
                          {i.done ? "✓" : ""}
                        </span>
                        <span className="min-w-0 text-sm">
                          <span className="sr-only">{i.done ? "Done: " : "To do: "}</span>
                          {!i.done && i.href ? (
                            <Link href={i.href} className="font-semibold text-brand underline">
                              {i.label}
                            </Link>
                          ) : (
                            <span className={i.done ? "text-ink-2" : "font-semibold"}>{i.label}</span>
                          )}
                          {!i.done && i.hint ? <span className="block text-xs text-ink-3">{i.hint}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            ) : null}
            {isAthlete ? <PaymentsCard billing={billing} /> : null}
            <Card>
              <CardBody className="flex items-center justify-between gap-3 text-sm">
                <span>{unread ? `${unread} unread conversation${unread === 1 ? "" : "s"}` : "No unread messages"}</span>
                <Link href="/messages" className="font-semibold text-brand underline">
                  Open messages
                </Link>
              </CardBody>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

function heroLine(home: AthleteHome | null, isAthlete: boolean, childName?: string): string {
  if (!home) return isAthlete ? "Welcome to Teamwork." : "Here is your family's training at a glance.";
  const s = home.engagement?.streak;
  if (!isAthlete) return `Here is how training is going for ${childName ?? home.firstName}.`;
  if (!s) return "Here is your day.";
  if (s.current > 0 && s.thisWeekActive) return `Week ${s.current} of your streak is locked in.`;
  if (s.current > 0) return `One session or workout this week keeps your ${s.current}-week streak going.`;
  return "Every week you train builds a streak. Today is a good day to start one.";
}

function Hero({ tz, dateLabel, title, home, isAthlete, childName, children }: { v: Viewer; tz?: string; dateLabel: string; title: string; home: AthleteHome | null; isAthlete: boolean; childName?: string; children?: React.ReactNode }) {
  const e = home?.engagement ?? null;
  const weeks = e?.streak.recent.map((w) => ({ ...w, label: fmt(localToUtc(w.weekStart, "12:00", tz), "MMM d", tz) })) ?? [];
  const trained = weeks.filter((w) => w.state === "active").length;
  return (
    <header className="mb-4 overflow-hidden rounded-xl bg-[#13203a] bg-[linear-gradient(135deg,#13203a_0%,#1a2d52_55%,#12456b_100%)] px-4 py-5 text-white shadow-sm sm:px-6 sm:py-6">
      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#7fd3f7]">{dateLabel}</div>
      <h1 className="mt-1 text-[26px] leading-tight font-extrabold tracking-tight sm:text-3xl">{title}</h1>
      <p className="mt-1 text-sm text-[#c9d4e5]">{heroLine(home, isAthlete, childName)}</p>
      {children}
      {e ? (
        <div className="mt-4 grid gap-2.5 sm:grid-cols-[auto_auto_1fr]">
          <div className={`grid gap-2.5 sm:contents ${e.level ? "grid-cols-2" : "grid-cols-1"}`}>
            {e.level ? (
              <div className="flex flex-col items-center gap-2 rounded-lg bg-white/[0.07] p-3 text-center ring-1 ring-white/10 sm:flex-row sm:gap-3 sm:px-4 sm:text-left">
                <LevelRing level={e.level.level} pct={e.level.pct} size={84} />
                <div className="min-w-0">
                  <p className="text-base leading-tight font-extrabold">
                    <span className="sr-only">Level {e.level.level}: </span>
                    {e.level.title}
                  </p>
                  <p className="text-xs text-[#c9d4e5] tabular">{e.level.xp} XP</p>
                  <p className="text-xs text-[#c9d4e5] tabular">
                    {e.level.toNext} XP to level {e.level.level + 1}
                  </p>
                </div>
              </div>
            ) : null}
            <div className="flex flex-col items-center justify-center gap-1 rounded-lg bg-white/[0.07] p-3 text-center ring-1 ring-white/10 sm:px-5">
              <div className="flex items-center gap-1.5">
                <Flame lit={e.streak.current > 0} className="size-9" />
                <span className="text-[44px] leading-none font-extrabold tabular">{e.streak.current}</span>
              </div>
              <p className="text-sm leading-tight font-bold">week streak</p>
              <p className="text-xs text-[#c9d4e5] tabular">Best: {e.streak.best}</p>
            </div>
          </div>
          <div className="flex flex-col justify-center rounded-lg bg-white/[0.07] p-3 ring-1 ring-white/10 sm:px-4">
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[#b9c6da]">
              Last {weeks.length} weeks · trained {trained}
            </p>
            <WeekDots weeks={weeks} />
          </div>
        </div>
      ) : null}
    </header>
  );
}

function WorkoutCard({ home, isAthlete }: { home: AthleteHome; isAthlete: boolean }) {
  if (!home.workouts) return null;
  const list = home.workouts;
  const open = list.find((w) => w.status === "in_progress") ?? list.find((w) => w.status === "scheduled");
  const allDone = list.length > 0 && list.every((w) => w.status === "completed");
  return (
    <section className="min-w-0 overflow-hidden rounded-md border border-edge border-l-4 border-l-brand bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
      <div className="px-4 py-4 sm:px-5">
        <div className="kicker">Today&apos;s workout</div>
        {list.length === 0 ? (
          <>
            <h2 className="mt-1 text-xl leading-tight font-extrabold">Nothing planned today</h2>
            <p className="mt-1 text-sm text-ink-2">{isAthlete ? "Rest is part of training. Your next workout will show up here." : "The next planned workout will show up here."}</p>
            {isAthlete ? (
              <ButtonLink href="/training" variant="secondary" className="mt-3">
                Open training
              </ButtonLink>
            ) : null}
          </>
        ) : (
          <>
            <h2 className="mt-1 text-xl leading-tight font-extrabold sm:text-2xl">{(open ?? list[0]).title}</h2>
            <p className="mt-1 text-sm text-ink-2">
              {allDone ? "Done for today. Nice work." : open?.status === "in_progress" ? "In progress. Pick up where you left off." : isAthlete ? "Ready when you are." : "Planned for today."}
            </p>
            {list.length > 1 ? (
              <ul className="mt-2 space-y-1 text-sm">
                {list.map((w) => (
                  <li key={w.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">{w.title}</span>
                    <StatusBadge status={w.status} />
                  </li>
                ))}
              </ul>
            ) : !isAthlete ? (
              <div className="mt-2">
                <StatusBadge status={list[0].status} />
              </div>
            ) : null}
            {isAthlete ? (
              <ButtonLink href="/training/today" size="lg" variant={allDone ? "secondary" : "primary"} className="mt-4 h-14! w-full text-lg! sm:w-auto sm:px-10!">
                {allDone ? "View workout" : open?.status === "in_progress" ? "Continue workout" : "Start workout"}
              </ButtonLink>
            ) : (
              <ButtonLink href={`/performance/${home.athleteId}`} variant="secondary" className="mt-3">
                See progress
              </ButtonLink>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function NextSessionCard({ home, tz }: { home: AthleteHome; tz?: string }) {
  const s = home.nextSession;
  const bookHref = `/schedule?athlete=${home.athleteId}`;
  return (
    <Card>
      <CardHeader
        title="Next session"
        action={
          home.upcomingCount > 1 ? (
            <Link href="/schedule" className="text-sm font-semibold text-brand underline">
              {home.upcomingCount - 1} more booked
            </Link>
          ) : null
        }
      />
      <CardBody>
        {s ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <div aria-hidden className="flex w-14 shrink-0 flex-col items-center overflow-hidden rounded-lg border border-edge text-center">
              <span className="w-full bg-brand py-0.5 text-[10px] font-bold uppercase tracking-wider text-brand-ink">{fmt(s.startsAt, "MMM", tz)}</span>
              <span className="py-1 text-2xl leading-none font-extrabold tabular">{fmt(s.startsAt, "d", tz)}</span>
            </div>
            <div className="min-w-0 flex-1 basis-40">
              <p className="font-bold leading-snug">{s.title}</p>
              <p className="text-sm text-ink-2">
                {fmt(s.startsAt, "EEE, MMM d", tz)} · {fmtTime(s.startsAt, tz)} to {fmtTime(s.endsAt, tz)}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                <Badge variant="brand">{cap(countdown(s.startsAt, new Date(), localYmd(s.startsAt, tz), home.today))}</Badge>
                {s.coach ? <span>with {s.coach}</span> : null}
              </p>
            </div>
            {home.canBook ? (
              <ButtonLink href={bookHref} variant="secondary" className="w-full sm:w-auto">
                Book another
              </ButtonLink>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-2">Nothing booked yet.</p>
            {home.canBook ? <ButtonLink href={bookHref}>Book a session</ButtonLink> : null}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function WeekCard({ home }: { home: AthleteHome }) {
  const w = home.week;
  const hasWorkouts = w.workoutsLogged !== null && w.workoutsPlanned !== null;
  return (
    <Card>
      <CardHeader title="This week" kicker={`Week of ${fmtDate(w.weekStart)}`} />
      <CardBody className={`grid gap-4 ${hasWorkouts ? "sm:grid-cols-2" : ""}`}>
        <div>
          <p className="kicker">Sessions attended</p>
          <p className="mt-1 leading-none">
            <span className="text-3xl font-extrabold tabular">{w.attended}</span>
            {w.weeklyCap ? <span className="text-base font-semibold text-ink-2 tabular"> of {w.weeklyCap}</span> : null}
          </p>
          {w.weeklyCap ? <ProgressBar done={w.attended} total={w.weeklyCap} size="lg" className="mt-2" /> : null}
          <p className="mt-1.5 text-xs text-ink-3">
            {w.weeklyCap ? `Your plan includes ${w.weeklyCap} a week. ` : ""}
            {w.booked ? `${w.booked} more booked this week.` : w.attended ? "" : "Nothing booked for the rest of this week yet."}
          </p>
        </div>
        {hasWorkouts ? (
          <div>
            <p className="kicker">Workouts logged</p>
            <p className="mt-1 leading-none">
              <span className="text-3xl font-extrabold tabular">{w.workoutsLogged}</span>
              {w.workoutsPlanned ? <span className="text-base font-semibold text-ink-2 tabular"> of {w.workoutsPlanned}</span> : null}
            </p>
            {w.workoutsPlanned ? <ProgressBar done={w.workoutsLogged!} total={w.workoutsPlanned} size="lg" className="mt-2" /> : null}
            <p className="mt-1.5 text-xs text-ink-3">{w.workoutsPlanned ? `${w.workoutsPlanned} planned this week.` : "No workouts planned this week."}</p>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

type Billing = Awaited<ReturnType<typeof familyBilling>>;

function InvoiceList({ billing }: { billing: Billing }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {billing.open.map((i) => (
        <li key={i.id} className="flex items-center justify-between gap-2">
          <Link href={`/billing/invoices/${i.id}`} className="font-medium text-brand underline">
            {i.number}
            {i.due_date ? `, due ${fmtDate(i.due_date)}` : ""}
          </Link>
          <span className="font-semibold tabular">{formatMoney(i.total_minor, i.currency)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Open invoices, only for viewers the billing rules already let see them. */
function PaymentsCard({ billing }: { billing: Billing }) {
  if (!billing.open.length) return null;
  return (
    <Card>
      <CardHeader title="Payments" action={<Link href="/billing" className="text-sm font-semibold text-brand underline">Billing</Link>} />
      <CardBody>
        <InvoiceList billing={billing} />
      </CardBody>
    </Card>
  );
}

function FamilyCard({ family, billing, tz }: { family: { child: FamilyChild; summary: Awaited<ReturnType<typeof familyChildSummary>> }[]; billing: Billing; tz?: string }) {
  const first = (c: FamilyChild) => c.name.split(" ")[0];
  const forms = family.flatMap((f) => f.summary.forms.map((x) => ({ ...x, who: first(f.child) })));
  const sessions = family
    .flatMap((f) => f.summary.upcoming.map((x) => ({ ...x, who: first(f.child) })))
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
    .slice(0, 5);
  const showBilling = billing.open.length > 0 || billing.canPayIds.length > 0;
  return (
    <Card>
      <CardHeader title="Family" kicker="Everyone on your account" />
      <CardBody className="space-y-4">
        <div>
          <h3 className="kicker mb-1.5">Forms to sign</h3>
          {forms.length === 0 ? (
            <p className="text-sm text-ink-3">All caught up.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {forms.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2">
                  <Link href={`/documents/requests/${f.id}`} className="min-w-0 font-medium text-brand underline">
                    {f.title} <span className="text-ink-2">for {f.who}</span>
                  </Link>
                  <StatusBadge status={f.status} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="kicker mb-1.5">Upcoming sessions</h3>
          {sessions.length === 0 ? (
            <p className="text-sm text-ink-3">Nothing booked in the next two weeks.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {sessions.map((s) => (
                <li key={s.id} className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="font-medium">{s.who}</span>: {s.title}
                    <span className="block text-xs text-ink-3">{fmt(s.starts_at, "EEE MMM d, h:mm a", tz)}</span>
                  </span>
                  {s.status !== "booked" ? <StatusBadge status={s.status} /> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        {showBilling ? (
          <div>
            <h3 className="kicker mb-1.5">Open invoices</h3>
            {billing.open.length === 0 ? <p className="text-sm text-ink-3">Nothing due.</p> : <InvoiceList billing={billing} />}
            <Link href="/billing" className="mt-1.5 inline-block text-sm font-semibold text-brand underline">
              Billing
            </Link>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
