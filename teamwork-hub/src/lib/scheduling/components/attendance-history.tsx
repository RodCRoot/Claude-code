import { Badge, Card, CardBody, CardHeader, EmptyState, Stat, StatusBadge } from "@/components/ui";
import type { AttendanceHistory } from "@/lib/scheduling/queries";
import { DEFAULT_TZ, fmt } from "@/lib/time";

/**
 * Attendance history + milestones for one athlete. Server component; pass the result of
 * `attendanceHistory(tx, viewer, athleteId)` (which enforces profile.read on the athlete).
 * Exported for the People module's athlete profile.
 */
export function AttendanceHistoryPanel({ data, tz = DEFAULT_TZ, limit = 50 }: { data: AttendanceHistory; tz?: string; limit?: number }) {
  const { counts, milestones, nextMilestone } = data;
  const reached = milestones.filter((m) => m.reachedAt);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Attended" value={counts.attended} tone={counts.attended ? "ok" : undefined} hint={nextMilestone ? `${nextMilestone - counts.attended} to ${nextMilestone}` : undefined} />
        <Stat label="Upcoming" value={counts.upcoming} />
        <Stat label="No-shows" value={counts.noShow} tone={counts.noShow ? "bad" : undefined} />
        <Stat label="Attendance rate" value={data.attendanceRate == null ? "—" : `${Math.round(data.attendanceRate * 100)}%`} hint="attended ÷ (attended + no-shows + late cancels)" />
      </div>

      <Card>
        <CardHeader title="Milestones" kicker="Sessions attended" />
        <CardBody>
          <ol className="flex flex-wrap gap-2" aria-label="Attendance milestones">
            {milestones.map((m) => (
              <li key={m.count}>
                {m.reachedAt ? (
                  <Badge variant="green" title={`Reached ${fmt(m.reachedAt, "MMM d, yyyy", tz)}`}>
                    ★ {m.count} · {fmt(m.reachedAt, "MMM d, yyyy", tz)}
                  </Badge>
                ) : (
                  <Badge>{m.count}</Badge>
                )}
              </li>
            ))}
          </ol>
          {reached.length === 0 ? <p className="mt-2 text-sm text-ink-3">First milestone at 10 sessions attended.</p> : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="History" kicker={`Latest ${Math.min(limit, data.history.length)}`} />
        <CardBody>
          {data.history.length === 0 ? (
            <EmptyState title="No sessions yet" />
          ) : (
            <ul className="divide-y divide-edge text-sm">
              {data.history.slice(0, limit).map((h) => (
                <li key={h.bookingId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <div className="font-medium">{h.title}</div>
                    <div className="text-xs text-ink-3">
                      {fmt(h.startsAt, "EEE MMM d, yyyy · h:mm a", tz)}
                      {h.coachName ? ` · ${h.coachName}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {h.sessionStatus === "cancelled" ? <Badge variant="red">session cancelled</Badge> : null}
                    <StatusBadge status={h.status} />
                    {h.checkInMethod === "kiosk" ? <Badge>kiosk</Badge> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
