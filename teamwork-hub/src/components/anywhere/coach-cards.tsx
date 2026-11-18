import Link from "next/link";
import { db } from "@/db";
import { ChartFigure } from "@/components/charts/chart-figure";
import { StackedLoadChart } from "@/components/charts/stacked-load-chart";
import { Badge, Card, CardBody, CardHeader } from "@/components/ui";
import { anywhereAccess, EVENT_KIND_LABEL, orgAnywhere } from "@/lib/anywhere/common";
import { ORIGIN_LABEL, weeklyLoadByOrigin } from "@/lib/anywhere/load-split";
import { calendarForAthlete, gamesInNext48h, seasonsForAthlete } from "@/lib/anywhere/season";
import type { Viewer } from "@/lib/authz/policy";
import type { LoadRow } from "@/lib/science/load";
import { addDaysYmd, fmt, fmtDate, fmtTime, localToUtc, todayLocal } from "@/lib/time";

/** Training overview: who in the coach's scope has a game or tournament in the next 48 hours. */
export async function GamesSoonCard({ viewer }: { viewer: Viewer }) {
  const [{ tz }, games] = await Promise.all([orgAnywhere(db, viewer.orgId), gamesInNext48h(db, viewer)]);
  return (
    <Card className="mb-6">
      <CardHeader title="Who has a game in the next 48 hours" kicker={`From My Season · ${games.length} athlete${games.length === 1 ? "" : "s"}`} />
      <CardBody>
        {games.length === 0 ? (
          <p className="text-sm text-ink-3">No games on any athlete&apos;s season calendar in the next 48 hours. Families add these under My Season.</p>
        ) : (
          <ul className="divide-y divide-edge text-sm">
            {games.map((g) => (
              <li key={`${g.athleteId}-${g.date}-${g.startsAt?.getTime() ?? "d"}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2 first:pt-0 last:pb-0">
                <span className="min-w-0">
                  <Link href={`/training/athletes/${g.athleteId}`} className="font-semibold hover:underline">
                    {g.athleteName}
                  </Link>{" "}
                  <span className="text-ink-2">
                    {EVENT_KIND_LABEL[g.kind]}
                    {g.opponent ? ` vs ${g.opponent}` : ""} · {g.teamName}
                  </span>
                </span>
                <span className="font-semibold tabular">
                  {fmt(localToUtc(g.date, "12:00", tz), "EEE MMM d", tz)}
                  {g.startsAt ? `, ${fmtTime(g.startsAt, tz)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/** Athlete page (training history): the family's season calendar, read-only, with log status. */
export async function AthleteSeasonCard({ viewer, athleteId }: { viewer: Viewer; athleteId: string }) {
  const access = await anywhereAccess(db, viewer, athleteId);
  if (!access?.canSeeSeason) return null;
  const { tz } = await orgAnywhere(db, viewer.orgId);
  const today = todayLocal(tz);
  const seasons = await seasonsForAthlete(db, viewer, athleteId);
  const season = seasons.find((s) => s.startsOn <= today && s.endsOn >= today) ?? seasons.find((s) => s.startsOn > today) ?? null;
  const items = season ? await calendarForAthlete(db, viewer, athleteId, addDaysYmd(today, -7), addDaysYmd(today, 14)) : [];
  return (
    <Card className="mb-6">
      <CardHeader title="Sport season" kicker={season ? `${season.teamName} · ${season.sport} · ${fmtDate(season.startsOn)} to ${fmtDate(season.endsOn)}` : "From the family's My Season"} />
      <CardBody>
        {!season ? (
          <p className="text-sm text-ink-3">No current or upcoming season on file. The family adds it under My Season.</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-3">Nothing on the calendar from last week through the next two weeks.</p>
        ) : (
          <ul className="divide-y divide-edge text-sm">
            {items.map((i) => (
              <li key={`${i.eventId}-${i.date}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5 first:pt-0 last:pb-0">
                <span className="min-w-0">
                  <span className="font-semibold tabular">{fmt(localToUtc(i.date, "12:00", tz), "EEE MMM d", tz)}</span>
                  {i.startsAt ? <span className="tabular">, {fmtTime(i.startsAt, tz)}</span> : null}{" "}
                  <span className="text-ink-2">
                    {i.title ?? EVENT_KIND_LABEL[i.kind]}
                    {i.opponent ? ` vs ${i.opponent}` : ""}
                    {i.location ? ` · ${i.location}` : ""}
                  </span>{" "}
                  {i.date === today ? <Badge variant="green">Today</Badge> : null}
                </span>
                {i.loggable && i.date <= today && i.log !== undefined ? (
                  i.log ? (
                    <span className="tabular text-ink-2">
                      {i.log.durationMinutes ?? "?"} min · sRPE {i.log.rpe ?? "?"}
                      {i.log.durationMinutes != null && i.log.rpe != null ? ` · ${i.log.durationMinutes * i.log.rpe} AU` : ""}
                    </span>
                  ) : (
                    <span className="text-ink-3">not logged</span>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-ink-3">Opponent and location are shown as the family typed them. Unlogged sessions are unknown load, never zero.</p>
      </CardBody>
    </Card>
  );
}

/** Load page: weekly load stacked by where it happened, with the usual text summary and data table. */
export function LoadByOriginCard({ entries, from, to }: { entries: LoadRow[]; from: string; to: string }) {
  const weeks = weeklyLoadByOrigin(entries, from, to);
  const hasOther = weeks.some((w) => w.other > 0);
  const sum = (k: "gym" | "sport" | "onYourOwn" | "other") => Math.round(weeks.reduce((s, w) => s + w[k], 0));
  const total = sum("gym") + sum("sport") + sum("onYourOwn") + sum("other");
  const pct = (n: number) => (total ? `${Math.round((n / total) * 100)}%` : "0%");
  const unknown = weeks.reduce((s, w) => s + w.unknownSessions, 0);
  const series = [
    { key: "gym", label: ORIGIN_LABEL.gym },
    { key: "sport", label: ORIGIN_LABEL.sport },
    { key: "onYourOwn", label: ORIGIN_LABEL.on_your_own },
    ...(hasOther ? [{ key: "other", label: ORIGIN_LABEL.other }] : []),
  ];
  return (
    <Card>
      <CardHeader title="Weekly load by origin" kicker="Gym, sport and on your own · ISO weeks · load_origin_v1" />
      <CardBody>
        <ChartFigure
          title="Weekly session load by origin (srpe_load_v1, split by load_origin_v1)"
          unit="AU (arbitrary units)"
          range={`${from} – ${to}`}
          summary={
            total === 0
              ? "No session with a known load in this window."
              : `Known load in this window: ${total} AU. Gym ${sum("gym")} AU (${pct(sum("gym"))}), sport ${sum("sport")} AU (${pct(sum("sport"))}), on your own ${sum("onYourOwn")} AU (${pct(sum("onYourOwn"))})${hasOther ? `, other ${sum("other")} AU (${pct(sum("other"))})` : ""}.${unknown ? ` ${unknown} session${unknown === 1 ? "" : "s"} had no minutes or RPE and add nothing here.` : ""}`
          }
          note="Sport load comes from practices and games the athlete logged under My Season (or entered by hand). Practices and games nobody logged are unknown, not zero, so a quiet sport bar can mean missing logs. ACWR, monotony and strain above use the same total as before."
          columns={["Week of", "Gym (AU)", "Sport (AU)", "On your own (AU)", ...(hasOther ? ["Other (AU)"] : []), "Total (AU)", "Sessions", "Sessions without load"]}
          rows={weeks.map((w) => [w.weekStart, Math.round(w.gym), Math.round(w.sport), Math.round(w.onYourOwn), ...(hasOther ? [Math.round(w.other)] : []), w.total === null ? null : Math.round(w.total), w.sessions, w.unknownSessions])}
        >
          <StackedLoadChart data={weeks.map((w) => ({ x: w.weekStart, gym: w.gym, sport: w.sport, onYourOwn: w.onYourOwn, other: w.other, total: w.total }))} series={series} />
        </ChartFigure>
      </CardBody>
    </Card>
  );
}
