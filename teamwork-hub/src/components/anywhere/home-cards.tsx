import { cache } from "react";
import Link from "next/link";
import { habitDoneAction } from "@/app/(app)/anywhere/actions";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, Card, CardBody, CardHeader } from "@/components/ui";
import { EVENT_KIND_LABEL } from "@/lib/anywhere/common";
import { anywhereHome, type AnywhereHome } from "@/lib/anywhere/home";
import type { CalendarItem } from "@/lib/anywhere/season";
import { requireViewer } from "@/lib/auth/viewer";
import { AuthzError } from "@/lib/authz/policy";
import { fmtDate, fmtTime } from "@/lib/time";
import { SportLogForm } from "./sport-log-form";

/**
 * Anywhere cards for Athlete Home. Two small mounts in today/_components/athlete-home.tsx:
 * <AnywhereGameDay> above the workout card and <AnywhereHomeCards> below it. Both read the same
 * cached `anywhereHome` result, which already leaves out whatever this viewer may not see.
 */
const load = cache(async (athleteId: string, tz: string | undefined): Promise<AnywhereHome | null> => {
  const v = await requireViewer();
  try {
    return await anywhereHome(db, v, athleteId, { tz });
  } catch (e) {
    if (e instanceof AuthzError) return null;
    throw e;
  }
});

type Props = { athleteId: string; tz?: string; isAthlete: boolean; multi?: boolean };

const what = (i: CalendarItem) => i.title ?? (i.opponent ? `${EVENT_KIND_LABEL[i.kind]} vs ${i.opponent}` : EVENT_KIND_LABEL[i.kind]);

export async function AnywhereGameDay({ athleteId, tz, isAthlete, multi }: Props) {
  const home = await load(athleteId, tz);
  const g = home?.gameDay;
  if (!home || !g) return null;
  const q = multi ? `?athlete=${athleteId}` : "";
  const i = g.item;
  return (
    <section aria-labelledby="gameday-h" className="min-w-0 overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
      <div className="bg-[#13203a] bg-[linear-gradient(120deg,#13203a_0%,#1a2d52_60%,#12456b_100%)] px-4 py-4 text-white sm:px-5">
        <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#7fd3f7]">Game day · {i.teamName}</div>
        <h2 id="gameday-h" className="mt-1 text-2xl leading-tight font-extrabold">
          {what(i)}
        </h2>
        <p className="mt-1 text-sm text-[#c9d4e5]">
          {i.startsAt ? fmtTime(i.startsAt, tz) : "Time not set"}
          {i.location ? ` · ${i.location}` : ""}
        </p>
      </div>
      <div className="space-y-3 px-4 py-4 sm:px-5">
        {!g.started && g.warmup ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="kicker">Before the game</p>
              <p className="font-bold leading-snug">{g.warmup.title}</p>
              <p className="text-sm text-ink-2">{g.warmup.durationMinutes} minutes to get warm and ready.</p>
            </div>
            <ButtonLink href={`/anywhere/sessions/${g.warmup.id}${q}`} size="lg" variant={isAthlete ? "primary" : "secondary"} className="w-full sm:w-auto">
              {isAthlete ? "Start warm-up" : "View warm-up"}
            </ButtonLink>
          </div>
        ) : null}
        {!g.started && !g.warmup ? <p className="text-sm text-ink-2">{isAthlete ? "Good luck today. Come back after to log how it went." : `Good luck to ${home.firstName} today.`}</p> : null}
        {g.started && i.log ? (
          <p className="text-sm font-semibold text-ok tabular">
            Logged: {i.log.durationMinutes ?? "?"} min, effort {i.log.rpe ?? "?"}. Nice work today.
          </p>
        ) : null}
        {g.started && i.log === null && home.access.canLog ? (
          <div>
            <p className="kicker">After the game</p>
            <p className="mb-2 font-bold leading-snug">How did it go? Log it so your coach can plan your week.</p>
            <SportLogForm athleteId={athleteId} eventId={i.eventId} date={i.date} defaultMinutes={i.durationMinutes} idPrefix="gd-log" submitLabel="Log it" />
          </div>
        ) : null}
        {g.started && i.log === null && !home.access.canLog ? <p className="text-sm text-ink-2">Not logged yet. {home.firstName} can log it from their own login.</p> : null}
        {!g.started && home.access.canLog ? <p className="text-xs text-ink-3">After the game, this card will ask how it went.</p> : null}
      </div>
    </section>
  );
}

export async function AnywhereHomeCards({ athleteId, tz, isAthlete, multi }: Props) {
  const home = await load(athleteId, tz);
  if (!home) return null;
  const q = multi ? `?athlete=${athleteId}` : "";
  const first = home.toLog?.[0];
  const open = home.assignments?.filter((a) => !a.complete) ?? [];
  const closed = home.assignments?.filter((a) => a.complete) ?? [];
  return (
    <>
      {first ? (
        <Card className="border-l-4 border-l-info">
          <CardHeader
            title={`How was ${first.kind === "practice" ? "practice" : `the ${EVENT_KIND_LABEL[first.kind].toLowerCase()}`}?`}
            kicker={`${first.date === home.today ? "Today" : "Yesterday"} · ${first.teamName}`}
            action={
              home.toLog!.length > 1 ? (
                <Link href={`/anywhere/season${q}`} className="text-sm font-semibold text-brand underline">
                  {home.toLog!.length - 1} more to log
                </Link>
              ) : null
            }
          />
          <CardBody>
            <SportLogForm athleteId={athleteId} eventId={first.eventId} date={first.date} defaultMinutes={first.durationMinutes} idPrefix="hp-log" submitLabel="Log it" />
          </CardBody>
        </Card>
      ) : null}

      {home.assignments && home.assignments.length ? (
        <Card>
          <CardHeader
            title="On your own this week"
            kicker={`${closed.length} of ${home.assignments.length} done`}
            action={
              <Link href={`/anywhere${q}`} className="text-sm font-semibold text-brand underline">
                All sessions
              </Link>
            }
          />
          <CardBody>
            <ul className="divide-y divide-edge">
              {[...open, ...closed].map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2.5 first:pt-0 last:pb-0">
                  <span className="min-w-0">
                    <span className="block font-semibold leading-snug">{a.title}</span>
                    <span className="text-sm text-ink-2 tabular">
                      {a.done} of {a.target} done · by {fmtDate(a.endDate)}
                    </span>
                  </span>
                  {a.complete ? (
                    <Badge variant="green">Done</Badge>
                  ) : (
                    <ButtonLink href={a.sessionId ? `/anywhere/sessions/${a.sessionId}${q}` : `/anywhere?cat=${a.category}${multi ? `&athlete=${athleteId}` : ""}`} variant={isAthlete ? "primary" : "secondary"} className="h-11! w-full sm:w-auto">
                      {isAthlete ? (a.sessionId ? "Start" : "Pick one") : "View"}
                      <span className="sr-only">: {a.title}</span>
                    </ButtonLink>
                  )}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {home.daily3 && home.daily3.length ? (
        <Card>
          <CardHeader
            title="Daily 3"
            kicker={`${home.daily3.filter((h) => h.status === "done").length} of ${home.daily3.length} done today`}
            action={
              <Link href="/science/habits" className="text-sm font-semibold text-brand underline">
                All habits
              </Link>
            }
          />
          <CardBody>
            <ul className="space-y-2">
              {home.daily3.map((h) => (
                <li key={h.habitId} className="flex min-h-12 items-center justify-between gap-3 rounded-md border border-edge px-3 py-1.5">
                  <span className="min-w-0">
                    <span className="block font-semibold leading-snug">{h.name}</span>
                    <span className="text-xs text-ink-3 tabular">
                      {h.target ? `Goal ${h.target}` : h.weekly ? "This week" : "Today"}
                      {h.streak > 1 ? ` · ${h.streak} in a row` : ""}
                    </span>
                  </span>
                  {h.status === "done" ? (
                    <span className="inline-flex items-center gap-1 text-sm font-bold text-ok">
                      <span aria-hidden>✓</span> Done
                    </span>
                  ) : home.access.canLog ? (
                    <ActionForm action={habitDoneAction}>
                      <input type="hidden" name="habitId" value={h.habitId} />
                      <input type="hidden" name="athleteId" value={athleteId} />
                      <SubmitButton variant="secondary" className="h-11! min-w-20" pendingText="...">
                        Done<span className="sr-only">: {h.name}</span>
                      </SubmitButton>
                    </ActionForm>
                  ) : (
                    <span className="text-sm text-ink-3">{h.status === "partial" ? "Partly" : h.status === "missed" ? "Missed" : "Not yet"}</span>
                  )}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {home.inSeason ? (
        <Card>
          <CardBody className="text-sm">
            <p className="font-semibold">In season with {home.inSeason.teamName}?</p>
            <p className="text-ink-2">Teamwork has an In Season membership option for busy stretches.</p>
            <Link href={`/messages/new?athlete=${athleteId}`} className="inline-flex min-h-11 items-center font-semibold text-brand underline">
              Ask the front desk about In Season
            </Link>
            <p className="text-xs text-ink-3">This only starts a conversation. Nothing about your membership changes on its own.</p>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
