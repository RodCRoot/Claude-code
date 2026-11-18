import Link from "next/link";
import { db } from "@/db";
import { CheckinAlertsCard } from "@/components/checkins/alerts-card";
import { CheckinTrends, MethodTag } from "@/components/checkins/trends";
import { Badge, ButtonLink, Callout, Card, CardBody, CardHeader, EmptyState, Input, PageHeader, Select, Table, Td, Th, buttonClass } from "@/components/ui";
import { getOrg, requireViewer } from "@/lib/auth/viewer";
import { can, isStaff, type Viewer } from "@/lib/authz/policy";
import { checkinSettings } from "@/lib/checkins/settings";
import { athleteCheckinTrends, classInsightsFor, pendingCheckins } from "@/lib/checkins/views";
import { familyAthletes } from "@/lib/dashboards";
import { scopedAthletes } from "@/lib/science/access";
import { addDaysYmd, DEFAULT_TZ, fmt, fmtDate, todayLocal } from "@/lib/time";

export const metadata = { title: "Session check-ins" };

type SP = Promise<{ athlete?: string; from?: string; to?: string }>;

export default async function CheckinsPage({ searchParams }: { searchParams: SP }) {
  const v = await requireViewer(["owner", "admin", "operations", "coach", "guardian", "athlete"]);
  const sp = await searchParams;
  const tz = (await getOrg(v.orgId))?.timezone ?? DEFAULT_TZ;
  return isStaff(v) ? <StaffView v={v} sp={sp} tz={tz} /> : <FamilyView v={v} sp={sp} />;
}

async function FamilyView({ v, sp }: { v: Viewer; sp: Awaited<SP> }) {
  const children = await familyAthletes(db, v);
  const child = children.find((c) => c.athleteId === sp.athlete) ?? children[0];
  const self = v.role === "athlete";
  const pending = await db.transaction((tx) => pendingCheckins(tx, v, new Date(), { limit: 8 }));
  const trends = child ? await db.transaction((tx) => athleteCheckinTrends(tx, v, child.athleteId)) : null;
  const first = child?.name.split(" ")[0] ?? "";
  return (
    <>
      <PageHeader kicker="Session check-ins" title={self ? "My check-ins" : "Check-ins"} description="A quick ready check before each gym session and a quick after check when it is done. Under 30 seconds each." />
      <div className="max-w-4xl space-y-5">
        <Card>
          <CardHeader title="To do now" kicker={`${pending.filter((p) => p.state === "open").length} open`} />
          <CardBody>
            {pending.length === 0 ? (
              <p className="text-sm text-ink-3">Nothing to answer right now. The ready check opens a few hours before a booked session, and the after check opens when the session ends.</p>
            ) : (
              <ul className="divide-y divide-edge">
                {pending.map((i) => (
                  <li key={`${i.kind}-${i.bookingId}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold">{i.kind === "ready" ? "Ready check" : "After check"}</div>
                      <div className="text-xs text-ink-3">
                        {!self ? `${i.athleteFirst} · ` : ""}
                        {i.title} · {fmt(i.startsAt, "EEE MMM d, h:mm a", i.timezone)}
                      </div>
                    </div>
                    <Link href={i.href} className={buttonClass(i.state === "open" ? "primary" : "secondary", "md", "min-h-11")}>
                      {i.state === "editable" ? "Change answers" : "Start"}
                      <span className="sr-only">
                        : {i.kind === "ready" ? "ready check" : "after check"}, {!self ? `${i.athleteFirst}, ` : ""}
                        {i.title}, {fmt(i.startsAt, "MMM d", i.timezone)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        {children.length > 1 ? (
          <nav aria-label="Choose athlete" className="flex flex-wrap gap-2">
            {children.map((c) => (
              <Link key={c.athleteId} href={`/check-ins?athlete=${c.athleteId}`} aria-current={c.athleteId === child?.athleteId ? "true" : undefined} className={buttonClass(c.athleteId === child?.athleteId ? "primary" : "secondary", "md", "min-h-11")}>
                {c.name.split(" ")[0]}
              </Link>
            ))}
          </nav>
        ) : null}
        {trends ? (
          <section aria-labelledby="trends-h" className="space-y-3">
            <h2 id="trends-h" className="text-lg font-bold">
              {self ? "How I have been feeling" : `How ${first} has been feeling`}
            </h2>
            <CheckinTrends t={trends} simple firstName={first} />
          </section>
        ) : (
          <EmptyState title="No athletes linked to your account yet">Ask the front desk to link your athlete to your account.</EmptyState>
        )}
      </div>
    </>
  );
}

async function StaffView({ v, sp, tz }: { v: Viewer; sp: Awaited<SP>; tz: string }) {
  const today = todayLocal(tz);
  const valid = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);
  const to = valid(sp.to) ?? today;
  const from = valid(sp.from) ?? addDaysYmd(to, -27);
  const [settings, athletes, classes] = await Promise.all([checkinSettings(db, v.orgId), scopedAthletes(db, v, "profile.read"), from > to ? Promise.resolve([]) : db.transaction((tx) => classInsightsFor(tx, v, { from, to, tz }))]);
  const pct = (n: number | null) => (n === null ? "-" : `${Math.round(n * 100)}%`);
  return (
    <>
      <PageHeader
        kicker="Coaching"
        title="Session check-ins"
        description="What athletes said before and after sessions. The readiness strip for a class is on its session page. Health answers show only for athletes you have health access to."
        actions={
          <>
            {can(v, "feedback.report") ? (
              <ButtonLink href="/reports/session-checkins" variant="secondary">
                Report and CSV
              </ButtonLink>
            ) : null}
            {can(v, "settings.manage") ? (
              <ButtonLink href="/settings/check-ins" variant="secondary">
                Settings
              </ButtonLink>
            ) : null}
          </>
        }
      />
      {!settings.preEnabled || !settings.postEnabled ? (
        <Callout tone="warn" className="mb-4">
          {!settings.preEnabled && !settings.postEnabled ? "Ready checks and after checks are both turned off in Settings." : !settings.preEnabled ? "Ready checks are turned off in Settings." : "After checks are turned off in Settings."}
        </Callout>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-3">
        <CheckinAlertsCard viewer={v} showEmpty className="lg:col-span-2" />
        <Card>
          <CardHeader title="One athlete" kicker="Trends over time" />
          <CardBody>
            {athletes.length === 0 ? (
              <p className="text-sm text-ink-3">No athletes in your scope.</p>
            ) : (
              <form action="/check-ins/athletes" method="get" className="space-y-2">
                <label htmlFor="athlete" className="block text-sm font-medium text-ink-2">
                  Athlete
                </label>
                <Select id="athlete" name="id" defaultValue="">
                  {athletes.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
                <button type="submit" className={buttonClass("primary", "md", "min-h-11 w-full")}>
                  Open trends
                </button>
              </form>
            )}
          </CardBody>
        </Card>
      </div>

      <section aria-labelledby="classes-h" className="mt-6">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="classes-h" className="text-lg font-bold">
              {v.role === "coach" ? "My classes" : "Classes"}
            </h2>
            <p className="text-sm text-ink-3">
              {fmtDate(from)} – {fmtDate(to)} · by class slot (class, weekday, start time)
            </p>
          </div>
          <form method="get" className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="from" className="block text-xs font-medium text-ink-3">
                From
              </label>
              <Input id="from" name="from" type="date" defaultValue={from} className="w-40" />
            </div>
            <div>
              <label htmlFor="to" className="block text-xs font-medium text-ink-3">
                To
              </label>
              <Input id="to" name="to" type="date" defaultValue={to} className="w-40" />
            </div>
            <button type="submit" className={buttonClass("secondary", "md")}>
              Apply
            </button>
          </form>
        </div>
        {classes.length === 0 ? (
          <EmptyState title="No attended sessions in this range">{v.role === "coach" ? "Only sessions you coached are listed here." : null}</EmptyState>
        ) : (
          <div className="space-y-4">
            {classes.map((c) => (
              <Card key={c.key}>
                <CardHeader title={`${c.title} · ${c.slot}`} kicker={`${c.sessions} session${c.sessions === 1 ? "" : "s"} · ${c.attended} attended${c.coach ? ` · ${c.coach}` : ""}`} />
                <CardBody className="space-y-3">
                  <Table caption={`${c.title} ${c.slot} check-in summary`}>
                    <thead>
                      <tr>
                        <Th align="right">Ready checks</Th>
                        <Th align="right">After checks</Th>
                        <Th align="right">Reported RPE</Th>
                        <Th align="right">Planned RPE</Th>
                        <Th align="right">Gap</Th>
                        <Th align="right">Rating</Th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <Td align="right">
                          {c.ready} ({pct(c.readyRate)})
                        </Td>
                        <Td align="right">
                          {c.after} ({pct(c.afterRate)})
                        </Td>
                        <Td align="right">{c.meanRpe ?? "-"}</Td>
                        <Td align="right">{c.intendedRpe ?? "not set"}</Td>
                        <Td align="right">{c.gap === null ? "-" : `${c.gap > 0 ? "+" : ""}${c.gap}`}</Td>
                        <Td align="right">{c.ratingHidden ? "hidden (too few)" : c.meanRating === null ? "-" : `${c.meanRating.toFixed(1)} (${c.ratingCount})`}</Td>
                      </tr>
                    </tbody>
                  </Table>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                    <MethodTag k="checkin_completion_v1" />
                    <MethodTag k="intensity_gap_v1" />
                    <span>{c.gap === null ? "Set a planned intensity on the session page to compare." : `Athletes reported ${Math.abs(c.gap)} ${c.gap > 0 ? "harder" : c.gap < 0 ? "easier" : "off"} than planned, over ${c.gapSessions} session${c.gapSessions === 1 ? "" : "s"}.`}</span>
                  </div>
                  {c.chipsHidden ? (
                    <p className="text-sm text-ink-3">Likes and dislikes are shown once there are enough answers that no single family stands out.</p>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(
                        [
                          ["Liked", c.liked],
                          ["Did not like", c.disliked],
                        ] as const
                      ).map(([label, chips]) => (
                        <div key={label}>
                          <h3 className="mb-1 text-sm font-semibold">
                            {label}
                            {label === "Did not like" && c.nothingToChange ? <span className="ml-2 text-xs font-normal text-ink-3">{c.nothingToChange} said &quot;nothing&quot;</span> : null}
                          </h3>
                          {chips.length === 0 ? (
                            <p className="text-sm text-ink-3">Nothing tapped.</p>
                          ) : (
                            <ul className="flex flex-wrap gap-1.5">
                              {chips.map((x) => (
                                <li key={x.key}>
                                  <Badge>
                                    {x.label} × {x.count}
                                  </Badge>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {c.comments.length ? (
                    <div>
                      <h3 className="mb-1 text-sm font-semibold">Recent comments</h3>
                      <ul className="space-y-1.5">
                        {c.comments.map((m, i) => (
                          <li key={`${m.checkinId}-${m.kind}-${i}`} className="rounded-md bg-surface-2 px-3 py-2 text-sm">
                            <Badge variant={m.kind === "liked" ? "green" : "yellow"}>{m.kind === "liked" ? "Liked" : "Did not like"}</Badge> <span className="whitespace-pre-wrap">{m.text}</span>
                            <span className="block text-xs text-ink-3">
                              {m.athleteName} · {fmtDate(m.date)} ·{" "}
                              <Link href={`/check-ins/responses/${m.checkinId}`} className="underline">
                                open
                              </Link>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            ))}
          </div>
        )}
        {v.role === "coach" ? <p className="mt-3 text-xs text-ink-3">You see a named comment or rating only when the family ticked &quot;show my coach&quot;. Otherwise you see class totals.</p> : null}
      </section>
    </>
  );
}
