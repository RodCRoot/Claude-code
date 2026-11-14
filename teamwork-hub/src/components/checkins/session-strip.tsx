import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardBody, CardHeader, Input } from "@/components/ui";
import { setIntendedRpeAction } from "@/app/(app)/check-ins/actions";
import type { Viewer } from "@/lib/authz/policy";
import { READINESS, sorenessWord } from "@/lib/checkins/questions";
import { REASON_LABEL, sessionReadiness } from "@/lib/checkins/views";
import { MethodTag } from "./trends";

/**
 * Readiness strip for one session: one line per athlete on the roster so the coach can adjust on
 * the spot. Health details appear only for athletes the viewer has health access to; everyone
 * else gets "has a note for the coach" at most. Server component, mounted on the session page.
 */
export async function SessionReadinessStrip({ viewer, sessionId, names }: { viewer: Viewer; sessionId: string; names: Record<string, string> }) {
  const r = await db.transaction((tx) => sessionReadiness(tx, viewer, sessionId));
  if (!r) return null;
  const face = (n: number | null) => READINESS.options.find((o) => o.value === n);
  const vs = (value: number | null, mean: number | null) => (value === null || mean === null ? null : `usual ${mean}`);
  return (
    <Card id="readiness">
      <CardHeader title="Readiness" kicker={`Ready checks: ${r.answered} of ${r.booked}`} action={<MethodTag k="checkin_baseline_v1" />} />
      <CardBody className="space-y-3">
        {r.rows.length === 0 ? (
          <p className="text-sm text-ink-3">No one is on the roster yet.</p>
        ) : (
          <ul className="divide-y divide-edge">
            {r.rows.map((row) => {
              const h = row.health;
              const flagged = h && (h.reasons.length > 0 || h.hurt);
              return (
                <li key={row.bookingId} className={`py-2 first:pt-0 last:pb-0 ${flagged ? "-mx-2 rounded-md bg-warn/5 px-2" : ""}`} data-testid="readiness-row">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="text-sm font-semibold">{names[row.athleteId] ?? "Athlete"}</span>
                    {!row.done ? (
                      <span className="rounded border border-dashed border-edge px-2 py-0.5 text-xs text-ink-3">No ready check yet</span>
                    ) : h ? (
                      <span className="flex flex-wrap items-center gap-1.5 text-xs">
                        <Badge variant={h.readiness !== null && h.readiness <= 2 ? "yellow" : "neutral"} title={vs(h.readiness, h.readinessBaseline.mean) ?? "No baseline yet"}>
                          <span aria-hidden>{face(h.readiness)?.face} </span>
                          Ready {h.readiness ?? "-"}/5
                        </Badge>
                        <Badge title={vs(h.soreness, h.sorenessBaseline.mean) ?? "No baseline yet"}>
                          Sore {h.soreness ?? "-"}/10{h.soreness !== null ? ` · ${sorenessWord(h.soreness)}` : ""}
                        </Badge>
                        <Badge>Sleep {h.sleepQuality ?? "-"}/5</Badge>
                        {h.hurt ? <Badge variant="red">{h.spot ? `${h.spot.kind === "sharp" ? "Sharp pain" : "Achy"}: ${h.spot.label}` : "Says something hurts"}</Badge> : null}
                        <Link href={`/check-ins/responses/${h.checkinId}`} className="font-semibold text-brand underline">
                          Details<span className="sr-only"> for {names[row.athleteId] ?? "athlete"}</span>
                        </Link>
                      </span>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1.5 text-xs">
                        <Badge variant="green">Ready check done</Badge>
                        {row.hasNote ? <Badge variant="yellow">Has a note for the coach</Badge> : null}
                      </span>
                    )}
                  </div>
                  {h ? (
                    <div className="mt-1 space-y-1 text-xs text-ink-2">
                      {h.reasons.length ? <p className="font-medium text-warn">{h.reasons.map((x) => REASON_LABEL[x]).join(" · ")}</p> : null}
                      {h.readinessBaseline.mean !== null || h.sorenessBaseline.mean !== null ? (
                        <p className="text-ink-3">
                          Their usual: ready {h.readinessBaseline.mean ?? "-"}, sore {h.sorenessBaseline.mean ?? "-"} (last {h.sorenessBaseline.n} ready checks)
                        </p>
                      ) : (
                        <p className="text-ink-3">
                          Not enough data yet for a baseline ({h.sorenessBaseline.n} of {h.sorenessBaseline.needed} answers).
                        </p>
                      )}
                      {h.note ? <p className="rounded bg-surface-2 px-2 py-1 whitespace-pre-wrap">“{h.note}”</p> : null}
                      {h.via !== "app" ? <p className="text-ink-3">{h.via === "kiosk" ? "Answered at the kiosk." : "Logged by a parent."}</p> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {!r.anyHealth ? <p className="text-xs text-ink-3">Your role does not include health access, so answers are not shown here. The session&apos;s coach sees them.</p> : null}
        <div className="border-t border-edge pt-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="text-sm">
              <div className="font-semibold">Intensity</div>
              <div className="text-ink-2">
                Planned: {r.intendedRpe === null ? "not set" : `${r.intendedRpe} of 10`} · Reported: {r.reported.meanRpe === null ? "no after checks yet" : `${r.reported.meanRpe} of 10 (${r.reported.count} athlete${r.reported.count === 1 ? "" : "s"})`}
              </div>
            </div>
            {r.canSetIntended ? (
              <ActionForm action={setIntendedRpeAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="sessionId" value={sessionId} />
                <div>
                  <label htmlFor="intendedRpe" className="block text-xs font-medium text-ink-3">
                    Planned intensity (0 to 10, optional)
                  </label>
                  <Input id="intendedRpe" name="intendedRpe" type="number" min={0} max={10} step={1} defaultValue={r.intendedRpe ?? ""} className="h-11 w-24" />
                </div>
                <SubmitButton variant="secondary" className="min-h-11" pendingText="…">
                  Save
                </SubmitButton>
              </ActionForm>
            ) : null}
          </div>
        </div>
        <p className="text-xs text-ink-3">Self-reported answers; not a diagnosis and not clearance to train. No ready check means no answer, not &quot;fine&quot;.</p>
      </CardBody>
    </Card>
  );
}
