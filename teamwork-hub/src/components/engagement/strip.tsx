import { Card, CardBody, CardHeader } from "@/components/ui";
import type { EngagementStrip as Strip } from "@/lib/engagement/home";
import { fmt } from "@/lib/time";
import { BadgeMedallion, Flame, LevelRing } from "./medallion";

/** Compact engagement summary for coaches: level, streak, badges, last activity. */
export function EngagementStripCard({ strip, tz, className }: { strip: Strip; tz?: string; className?: string }) {
  const { level, streak, badges, lastActivityAt } = strip;
  return (
    <Card className={className}>
      <CardHeader title="Engagement" kicker="Streak, level and badges" />
      <CardBody>
        <div className="grid grid-cols-1 gap-x-4 gap-y-4 min-[420px]:grid-cols-2 lg:grid-cols-4">
          {level ? (
            <div className="flex items-center gap-3">
              <LevelRing level={level.level} pct={level.pct} size={60} tone="light" />
              <div className="min-w-0">
                <p className="kicker">Level</p>
                <div className="font-bold leading-tight">
                  {level.level} · {level.title}
                </div>
                <div className="text-xs text-ink-3 tabular">
                  {level.xp} XP · {level.toNext} to next
                </div>
              </div>
            </div>
          ) : null}
          <div className="flex items-center gap-3">
            <span className="flex size-[60px] shrink-0 items-center justify-center rounded-full bg-[#13203a]">
              <Flame lit={streak.current > 0} />
            </span>
            <div className="min-w-0">
              <p className="kicker">Weekly streak</p>
              <div className="font-bold leading-tight tabular">
                {streak.current} week{streak.current === 1 ? "" : "s"}
              </div>
              <div className="text-xs text-ink-3 tabular">
                Best {streak.best} · {streak.thisWeekActive ? "trained this week" : "not yet this week"}
              </div>
            </div>
          </div>
          {badges ? (
            <div className="min-w-0">
              <p className="kicker">Badges</p>
              <div className="font-bold leading-tight tabular">{badges.length} earned</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {badges.slice(0, 5).map((b) => (
                  <BadgeMedallion key={b.def.key} def={b.def} size={30} />
                ))}
                {badges.length === 0 ? <span className="text-xs text-ink-3">None yet</span> : null}
              </div>
            </div>
          ) : null}
          <div className="min-w-0">
            <p className="kicker">Last activity</p>
            <div className="font-bold leading-tight">{lastActivityAt ? fmt(lastActivityAt, "MMM d, yyyy", tz) : "None yet"}</div>
            <div className="text-xs text-ink-3">Attended session or logged workout</div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
