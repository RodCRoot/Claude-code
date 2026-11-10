import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { BadgeMedallion } from "@/components/engagement/medallion";
import { PrintPageButton } from "@/components/showcase/print-button";
import { Callout, Card, CardBody, CardHeader } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { AuthzError, isStaff } from "@/lib/authz/policy";
import { familyAthletes } from "@/lib/dashboards";
import { badgeDef } from "@/lib/engagement/badges";
import { formatValue, prettyDate } from "@/lib/showcase/compose";
import { isMonth, monthLabel, shiftMonth, viewRecap, type RecapView } from "@/lib/showcase/recap";
import { fmt } from "@/lib/time";
import { HeroLink, ModuleHero, PrBadge, ProgressBar } from "../../training/_components/tb";

export const metadata = { title: "Monthly recap" };

function Big({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="kicker">{label}</div>
      <div className="mt-1 text-3xl leading-none font-extrabold tracking-tight tabular">{value}</div>
      {hint ? <div className="mt-1.5 text-xs text-ink-3">{hint}</div> : null}
    </div>
  );
}

function changeText(t: NonNullable<RecapView["recap"]["training"]>["tests"][number]): { text: string; good: boolean | null } | null {
  if (t.change === null || !t.previous) return null;
  if (Number(Math.abs(t.change).toFixed(t.precision)) === 0) return { text: `Same as ${prettyDate(t.previous.date)}`, good: null };
  const good = t.higherIsBetter === null ? null : t.higherIsBetter ? t.change > 0 : t.change < 0;
  return { text: `${t.change > 0 ? "+" : "−"}${formatValue(Math.abs(t.change), t.precision)} ${t.unit} since ${prettyDate(t.previous.date)}`, good };
}

export default async function RecapPage({ params, searchParams }: { params: Promise<{ month: string }>; searchParams: Promise<{ athlete?: string }> }) {
  const v = await requireViewer();
  const { month } = await params;
  const sp = await searchParams;
  if (!isMonth(month)) notFound();
  const staff = isStaff(v);
  // Families: only linked athletes are selectable. Staff: the id is checked by the lib (coach scope).
  let athleteId = sp.athlete ?? "";
  if (!staff) {
    const children = await familyAthletes(db, v);
    const child = children.find((c) => c.athleteId === sp.athlete) ?? children[0];
    if (!child) redirect("/recap");
    athleteId = child.athleteId;
  } else if (!/^[0-9a-f-]{36}$/i.test(athleteId)) notFound();

  let view: RecapView | null;
  try {
    view = await db.transaction((tx) => viewRecap(tx, v, athleteId, month));
  } catch (e) {
    if (e instanceof AuthzError) notFound();
    throw e;
  }
  if (!view) notFound();
  const r = view.recap;
  const tz = view.access.tz;
  const name = r.athleteFirstName;
  const s = r.sessions;
  const t = r.training;
  const isAthlete = v.role === "athlete";
  const prev = shiftMonth(month, -1);
  const back = staff ? `/training/recaps?month=${month}` : `/recap?athlete=${athleteId}`;

  return (
    <div className="mx-auto max-w-4xl">
      <ModuleHero
        kicker={`Monthly recap · ${view.state === "final" ? "final" : view.state === "in_progress" ? "in progress" : "closing soon"}`}
        title={`${isAthlete ? "Your" : `${name}'s`} ${monthLabel(month)}`}
        description={
          view.state === "final"
            ? `These numbers were set on ${fmt(view.finalizedAt, "MMM d, yyyy", tz)} and do not change.`
            : view.state === "in_progress"
              ? `The month is still going. Numbers run through ${prettyDate(r.asOf)} and update as you train.`
              : `The month has ended. Numbers are final on ${prettyDate(view.finalOn)}.`
        }
        actions={
          <>
            <HeroLink href={back}>All months</HeroLink>
            <PrintPageButton />
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="Sessions" />
          <CardBody className="space-y-3">
            <Big label="Attended" value={s.planned !== null ? <>{s.attended}<span className="text-lg font-bold text-ink-2"> of {s.planned}</span></> : s.attended} hint={s.planned !== null ? `Your plan covers about ${s.planned} sessions a month (${s.planPerWeek} a week).` : "Your plan has no weekly limit."} />
            {s.planned !== null ? <ProgressBar done={Math.min(s.attended, s.planned)} total={s.planned} complete={s.attended >= s.planned} /> : null}
            {view.state === "in_progress" && s.stillBooked > 0 ? <p className="text-sm text-ink-2">{s.stillBooked} more booked this month.</p> : null}
          </CardBody>
        </Card>

        {t ? (
          <Card>
            <CardHeader title="Training" />
            <CardBody className="grid grid-cols-2 gap-4">
              <Big label="Workouts logged" value={t.workoutsPlanned ? <>{t.workoutsCompleted}<span className="text-lg font-bold text-ink-2"> of {t.workoutsPlanned}</span></> : t.workoutsCompleted} />
              <Big label="Weekly streak" value={<>{t.streak.current}<span className="text-lg font-bold text-ink-2"> wk</span></>} hint={`Best so far: ${t.streak.best}`} />
            </CardBody>
          </Card>
        ) : (
          <Callout>Workouts, personal records, badges and test results are not shown because your account does not have training access for {name}.</Callout>
        )}

        {t ? (
          <Card>
            <CardHeader title="New personal records" kicker={`${t.prs.length} this month`} />
            <CardBody>
              {t.prs.length ? (
                <ul className="divide-y divide-edge">
                  {t.prs.map((p) => (
                    <li key={`${p.exercise}-${p.date}-${p.value}`} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{p.exercise}</span>
                        <span className="text-xs text-ink-3">
                          {prettyDate(p.date)} · {p.basis === "estimated" ? "estimated" : "measured"}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-right">
                        <span>
                          <span className="text-lg leading-none font-extrabold tabular">{p.value}</span> <span className="text-xs text-ink-2">{p.unit}</span>
                          {p.gain !== null ? <span className="block text-[11px] font-semibold text-ok tabular">+{p.gain} {p.unit}</span> : null}
                        </span>
                        <PrBadge />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-3">No new records this month. They come in bunches.</p>
              )}
            </CardBody>
          </Card>
        ) : null}

        {t ? (
          <Card>
            <CardHeader title="Badges earned" kicker={`${t.badges.length} this month`} />
            <CardBody>
              {t.badges.length ? (
                <ul className="grid grid-cols-3 gap-2 text-center">
                  {t.badges.map((b) => {
                    const def = badgeDef(b.key);
                    return (
                      <li key={b.key} className="flex min-w-0 flex-col items-center gap-1">
                        {def ? <BadgeMedallion def={def} size={60} /> : null}
                        <span className="text-xs leading-tight font-semibold">{b.name}</span>
                        <span className="text-[11px] leading-none text-ink-3">{prettyDate(b.earnedOn)}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-ink-3">No new badges this month.</p>
              )}
            </CardBody>
          </Card>
        ) : null}

        {t ? (
          <Card className="md:col-span-2">
            <CardHeader title="Tests taken" kicker={`${t.tests.length} result${t.tests.length === 1 ? "" : "s"}`} />
            <CardBody>
              {t.tests.length ? (
                <ul className="grid gap-x-8 sm:grid-cols-2">
                  {t.tests.map((x) => {
                    const c = changeText(x);
                    return (
                      <li key={`${x.metric}-${x.date}`} className="flex items-center justify-between gap-3 border-b border-edge py-2.5">
                        <span className="min-w-0">
                          <span className="block font-semibold">{x.metric}</span>
                          <span className="block text-xs text-ink-3">
                            {x.testName} · {prettyDate(x.date)}
                          </span>
                          <span className={`block text-xs font-semibold ${c?.good ? "text-ok" : "text-ink-2"}`}>{c ? c.text : "First result measured this way"}</span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="text-xl leading-none font-extrabold tabular">{formatValue(x.value, x.precision)}</span> <span className="text-xs text-ink-2">{x.unit}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-ink-3">No testing this month.</p>
              )}
              {t.tests.some((x) => x.notCompared > 0) ? <p className="mt-2 text-xs text-ink-3">Changes compare only results measured the same way (same test, protocol and device). Results measured another way are left out.</p> : null}
            </CardBody>
          </Card>
        ) : null}

        <Card className="md:col-span-2">
          <CardHeader title="Goals" kicker={`${r.goals.length} this month`} action={!staff ? <Link href={`/goals?athlete=${athleteId}`} className="no-print text-sm font-semibold text-brand underline">All goals</Link> : undefined} />
          <CardBody>
            {r.goals.length ? (
              <ul className="divide-y divide-edge">
                {r.goals.map((g, i) => (
                  <li key={`${g.title}-${i}`} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <span className="font-semibold">{g.title}</span>
                      <span className="shrink-0 text-sm font-bold">{g.achievedInMonth ? <span className="text-ok">Reached</span> : g.measured?.pct != null ? <span className="tabular">{Math.round(g.measured.pct)}%</span> : null}</span>
                    </div>
                    {g.measured ? (
                      <p className="text-xs text-ink-3">
                        {g.measured.label} · target {g.measured.target}
                        {g.measured.current ? ` · now ${g.measured.current}` : ""}
                      </p>
                    ) : null}
                    {g.measured?.pct != null && !g.achievedInMonth ? <ProgressBar done={Math.round(g.measured.pct)} total={100} size="sm" className="mt-1.5" /> : null}
                    {g.targetDate && !g.achievedInMonth ? <p className="mt-1 text-xs text-ink-3">By {prettyDate(g.targetDate)}</p> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-3">No goals set this month.</p>
            )}
          </CardBody>
        </Card>

        {view.coachNote ? (
          <Card className="border-l-4 border-l-brand md:col-span-2">
            <CardHeader title="From your coach" kicker={view.coachNote.by ?? undefined} />
            <CardBody>
              <p className="text-[15px] leading-relaxed whitespace-pre-line">{view.coachNote.text}</p>
            </CardBody>
          </Card>
        ) : null}

        <Card className="md:col-span-2">
          <CardHeader title={`Next up: ${monthLabel(r.next.month)}`} />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="kicker mb-1">Booked sessions</div>
              {r.next.bookings.length ? (
                <ul className="space-y-1 text-sm">
                  {r.next.bookings.map((b) => (
                    <li key={`${b.title}-${b.startsAt}`}>
                      <span className="font-semibold">{fmt(b.startsAt, "EEE, MMM d · h:mm a", tz)}</span> <span className="text-ink-2">{b.title}</span>
                    </li>
                  ))}
                  {r.next.bookedCount > r.next.bookings.length ? <li className="text-ink-3">and {r.next.bookedCount - r.next.bookings.length} more</li> : null}
                </ul>
              ) : (
                <p className="text-sm text-ink-3">Nothing booked yet.</p>
              )}
            </div>
            <div>
              <div className="kicker mb-1">Goals due</div>
              {r.next.goalsDue.length ? (
                <ul className="space-y-1 text-sm">
                  {r.next.goalsDue.map((g) => (
                    <li key={g.title}>
                      <span className="font-semibold">{g.title}</span> <span className="text-ink-3">by {prettyDate(g.targetDate)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-3">No goal dates next month.</p>
              )}
            </div>
          </CardBody>
        </Card>
      </div>

      <p className="mt-4 text-xs text-ink-3">
        Wellness check-ins and health details are never part of a recap. Calculation {view.calcKey}.{" "}
        {view.access.firstMonth && prev >= view.access.firstMonth ? (
          <Link href={`/recap/${prev}?athlete=${athleteId}`} className="no-print font-semibold text-brand underline">
            See {monthLabel(prev)}
          </Link>
        ) : null}
      </p>
    </div>
  );
}
