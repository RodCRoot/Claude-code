import Link from "next/link";
import { db } from "@/db";
import { Badge, Card, CardBody, CardHeader, buttonClass } from "@/components/ui";
import type { Viewer } from "@/lib/authz/policy";
import { openCheckinAlerts, REASON_LABEL } from "@/lib/checkins/views";
import { fmt } from "@/lib/time";

/**
 * Open session check-in alerts the viewer may act on. Mounted on the follow-ups queue and on the
 * check-ins page, so there is one list of things to follow up, not two. Each alert is a row in
 * the normal tasks table. Renders nothing for a viewer with no alerts unless `showEmpty`.
 */
export async function CheckinAlertsCard({ viewer, showEmpty = false, className }: { viewer: Viewer; showEmpty?: boolean; className?: string }) {
  const alerts = await db.transaction((tx) => openCheckinAlerts(tx, viewer));
  if (!alerts.length && !showEmpty) return null;
  return (
    <Card className={className} id="checkin-alerts">
      <CardHeader title="Session check-ins to look at" kicker={`${alerts.length} open`} />
      <CardBody>
        {alerts.length === 0 ? (
          <p className="text-sm text-ink-3">Nothing open. Alerts appear here for sharp or repeated pain, soreness or readiness far from an athlete&apos;s own usual, and &quot;did not like&quot; comments.</p>
        ) : (
          <ul className="divide-y divide-edge">
            {alerts.map((a) => (
              <li key={a.taskId} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{a.athleteName}</div>
                  <div className="text-xs text-ink-3">
                    {a.sessionTitle} · {fmt(a.sessionStartsAt, "EEE MMM d, h:mm a", a.timezone)}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge variant={a.kind === "training" ? "yellow" : "blue"}>{a.kind === "training" ? "For the coach" : "For the owner / front desk"}</Badge>
                    {a.reasons.map((r) => (
                      <Badge key={r}>{REASON_LABEL[r]}</Badge>
                    ))}
                  </div>
                </div>
                <Link href={`/check-ins/responses/${a.checkinId}`} className={buttonClass("secondary", "md", "min-h-11")}>
                  Open<span className="sr-only">: {a.athleteName}, {a.sessionTitle}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-ink-3">Self-reported answers, not a diagnosis. Nothing is sent to the family.</p>
      </CardBody>
    </Card>
  );
}
