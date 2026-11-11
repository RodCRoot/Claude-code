import { Badge, Card, CardBody, CardHeader } from "@/components/ui";
import { cn } from "@/lib/cn";
import { CHALLENGE_METRIC_LABEL, CHALLENGE_METRIC_UNIT, ordinal, plural, type Board, type BoardRow, type ChallengeView, type YouLine } from "@/lib/community/shared";
import { fmtDate } from "@/lib/time";

/**
 * Community cards shared by /leaderboards and Athlete Home. Server components, display names
 * only: everything rendered here was already resolved by src/lib/community (no ids, no last names).
 */

const MEDAL = ["bg-[#fbbf24] text-[#3b2a00]", "bg-[#d3dae3] text-[#27313d]", "bg-[#e2a36b] text-[#4a2508]"];

function RankDot({ n }: { n: number }) {
  return (
    <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-extrabold tabular", MEDAL[n - 1] ?? "bg-surface-2 text-ink-2 ring-1 ring-edge")}>
      <span className="sr-only">Rank </span>
      {n}
    </span>
  );
}

export function RankRows({ rows, empty, isAthlete }: { rows: BoardRow[]; empty: string; isAthlete: boolean }) {
  if (!rows.length) return <p className="text-sm text-ink-3">{empty}</p>;
  return (
    <ol className="divide-y divide-edge">
      {rows.map((r, i) => (
        <li key={i} className={cn("flex items-center gap-3 py-2 first:pt-0 last:pb-0", r.you && "-mx-2 rounded-md bg-brand/5 px-2")}>
          <RankDot n={r.rank} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">
              {r.name}
              {r.you ? <span className="ml-1.5 text-xs font-bold text-brand">{isAthlete ? "You" : "Yours"}</span> : null}
            </span>
            {r.detail ? <span className="block truncate text-xs text-ink-3">{r.detail}</span> : null}
          </span>
          {r.value ? <span className="shrink-0 text-right font-extrabold tabular">{r.value}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** "You: 4th of 12, hidden from the board": the viewer's own athlete, shown even when hidden. */
export function youText(y: YouLine, isAthlete: boolean): string {
  const who = isAthlete ? "You" : y.firstName;
  const place = `${ordinal(y.rank)}${y.of ? ` of ${y.of}` : ""}`;
  return `${who}: ${place}${y.value ? ` (${y.value})` : ""}${y.hidden ? ", hidden from the board" : ""}`;
}

export function LeaderboardCard({ board, isAthlete }: { board: Board; isAthlete: boolean }) {
  return (
    <Card>
      <CardHeader title={board.title} kicker={board.kind === "max" ? "Strength" : board.kind === "relative" ? "Pound for pound" : board.kind === "improved" ? "Progress" : "Showing up"} action={<Badge variant="neutral">{board.band === "Adult" ? "Adults" : board.band}</Badge>} />
      <CardBody>
        <RankRows rows={board.rows} isAthlete={isAthlete} empty="No names on this board yet." />
        {board.you.length ? (
          <ul className="mt-3 space-y-1 rounded-md border border-brand/30 bg-brand/5 px-3 py-2 text-sm font-semibold">
            {board.you.map((y) => (
              <li key={y.athleteId}>{youText(y, isAthlete)}</li>
            ))}
          </ul>
        ) : null}
        <p className="mt-3 text-xs text-ink-3">
          {board.label}.{board.small ? " Small group: totals are not shown." : board.total ? ` ${board.total} athletes on this board.` : ""}
        </p>
      </CardBody>
    </Card>
  );
}

export function ChallengeProgress({ c, isAthlete, compact = false }: { c: ChallengeView; isAthlete: boolean; compact?: boolean }) {
  const unit = CHALLENGE_METRIC_UNIT[c.metric];
  const when = c.ended ? `Ended ${fmtDate(c.endsOn)}` : c.daysLeft === 1 ? "Last day" : `${c.daysLeft} days left`;
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-bold leading-snug">{c.title}</p>
          <p className="text-xs text-ink-3">
            {c.mode === "group_total" ? `${CHALLENGE_METRIC_LABEL[c.metric]}, all together` : `${plural(c.target, unit)} each`} · {c.groupName ?? "Everyone at the gym"}
          </p>
        </div>
        <Badge variant={c.ended ? "neutral" : "yellow"}>{when}</Badge>
      </div>
      {c.mode === "group_total" ? (
        <div className="mt-3">
          <p className="leading-none">
            <span className="text-3xl font-extrabold tabular">{c.total}</span> <span className="text-sm font-semibold text-ink-2 tabular">of {c.target}</span>
          </p>
          <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`${c.pct} percent of the team target`}>
            <div className={cn("h-full rounded-full", c.pct === 100 ? "bg-ok" : "bg-brand")} style={{ width: `${Math.max(2, c.pct ?? 0)}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-ink-3">{c.pct === 100 ? "Target reached. Great work, everyone." : `${c.pct}% of the way there, together.`}</p>
        </div>
      ) : null}
      {c.you.length ? (
        <ul className="mt-3 space-y-2">
          {c.you.map((y) => {
            const pct = Math.min(100, Math.floor((y.value / c.target) * 100));
            return (
              <li key={y.athleteId} className="rounded-md border border-brand/30 bg-brand/5 px-3 py-2">
                <p className="flex flex-wrap items-center justify-between gap-2 text-sm font-semibold">
                  <span>
                    {isAthlete ? "You" : y.firstName}: {c.mode === "individual" ? `${y.value} of ${c.target}` : `${plural(y.value, unit)} added`}
                  </span>
                  {y.done ? <Badge variant="green">Done</Badge> : null}
                </p>
                {c.mode === "individual" ? (
                  <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`${pct} percent of the target`}>
                    <div className={cn("h-full rounded-full", y.done ? "bg-ok" : "bg-brand")} style={{ width: `${Math.max(2, pct)}%` }} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {!compact ? (
        <div className="mt-3">
          <RankRows rows={c.leaders} isAthlete={isAthlete} empty="Nobody is on the board yet. The first session gets it started." />
          <p className="mt-2 text-xs text-ink-3">
            {c.mode === "individual" && c.finishers > 0 ? `${c.finishers} finished so far. ` : ""}Counted from check-ins and logged workouts. Finishing earns the Challenge Finisher badge.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function ChallengeCard({ c, isAthlete }: { c: ChallengeView; isAthlete: boolean }) {
  return (
    <Card>
      <CardHeader title="Team challenge" kicker={c.mode === "group_total" ? "Team total" : "Everyone for themselves, together"} />
      <CardBody>
        <ChallengeProgress c={c} isAthlete={isAthlete} />
      </CardBody>
    </Card>
  );
}
