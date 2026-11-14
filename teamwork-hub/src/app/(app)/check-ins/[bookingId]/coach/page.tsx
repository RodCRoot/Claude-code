import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { AfterForm, ReadyForm } from "@/components/checkins/forms";
import { Badge, ButtonLink, Callout, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { requireStaff } from "@/lib/auth/viewer";
import { AuthzError } from "@/lib/authz/policy";
import { coachEntryTarget, entryName, type CoachSectionState } from "@/lib/checkins/coach-entry";
import type { BodyView } from "@/lib/science/body-regions";
import { fmt } from "@/lib/time";
import { coachSubmitAfterAction, coachSubmitReadyAction } from "../../actions";

export const metadata = { title: "Enter a check-in for an athlete" };

const writable = (s: CoachSectionState) => s === "open" || s === "editable" || s === "answered";

/**
 * A coach types in the ready check or the after check for an athlete who told them the answers.
 * Reached from the Readiness card on the session page. Every rule is enforced in coach-entry.ts;
 * this page only shows what that module says is possible.
 */
export default async function CoachEntryPage({ params }: { params: Promise<{ bookingId: string }> }) {
  const v = await requireStaff();
  const { bookingId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) notFound();
  let t: Awaited<ReturnType<typeof coachEntryTarget>>;
  try {
    t = await db.transaction((tx) => coachEntryTarget(tx, v, bookingId));
  } catch (e) {
    if (e instanceof AuthzError) redirect("/denied");
    throw e;
  }
  const s = t.row.session;
  const tz = s.timezone;
  const pre = t.pre;
  const post = t.post;
  const show = { effort: writable(t.after.effort), body: writable(t.after.body), experience: t.after.experience === "open" || t.after.experience === "editable", rating: false };
  const afterReplaces = [t.after.effort === "answered" ? t.afterBy.effort?.label : null, t.after.body === "answered" ? t.afterBy.body?.label : null].filter(Boolean)[0] ?? null;
  const anyAfter = show.effort || show.body || show.experience;
  const exp = post?.experience ?? null;
  return (
    <>
      <PageHeader
        kicker="Coach entry"
        title={`Check-in for ${t.athleteName}`}
        description={`${s.title} · ${fmt(s.startsAt, "EEEE, MMM d 'at' h:mm a", tz)}`}
        actions={
          <ButtonLink href={`/schedule/sessions/${s.id}#readiness`} variant="secondary" className="min-h-11">
            Back to the session
          </ButtonLink>
        }
      />
      <div className="max-w-xl space-y-5">
        <Callout tone="info" title="You are entering this for the athlete">
          Ask {t.firstName} and use their answers. It is saved as entered by coach {entryName(v)} and shown that way to {t.firstName}, the family and other staff. It never replaces an answer {t.firstName} or a parent already gave unless you say so, and the earlier answer stays on the record.
        </Callout>

        <Card id="ready">
          <CardHeader title="Ready check" kicker="Before the session" action={t.readyBy ? <Badge variant={t.ready === "answered" ? "yellow" : "green"}>Answered by {t.readyBy.label}</Badge> : <Badge>Not answered</Badge>} />
          <CardBody>
            {writable(t.ready) ? (
              <ReadyForm
                action={coachSubmitReadyAction}
                entry={{ athleteFirst: t.firstName, replaces: t.ready === "answered" ? (t.readyBy?.label ?? "the athlete") : null }}
                bookingId={bookingId}
                editing={!!pre}
                ask={{ sleepHours: t.settings.askSleepHours, fatigue: t.settings.askFatigue, mood: t.settings.askMood, stress: t.settings.askStress }}
                prefilled={{ sleepQuality: t.prefill.sleep_quality, sleepHours: t.prefill.sleep_hours, fatigue: t.prefill.fatigue, mood: t.prefill.mood, stress: t.prefill.stress }}
                prior={null}
                bodyMapAt={t.settings.bodyMapSorenessAt}
                defaults={pre ? { readiness: pre.readiness, sleepQuality: pre.sleepQuality, sleepHours: pre.sleepHours, soreness: pre.soreness, fatigue: pre.fatigue, mood: pre.mood, stress: pre.stress, hurt: pre.hurt, note: pre.note } : {}}
                spot={t.readySpot ? { view: t.readySpot.view as BodyView, region: t.readySpot.region, side: t.readySpot.side, type: t.readySpot.kind === "pain" ? "sharp" : "ache", level: t.readySpot.severity } : null}
              />
            ) : (
              <p className="text-sm text-ink-2" data-testid="coach-ready-closed">
                {t.readyWhy ?? "The ready check cannot be entered right now."}
              </p>
            )}
          </CardBody>
        </Card>

        <Card id="after">
          <CardHeader title="After check" kicker="Once the session has ended" />
          <CardBody className="space-y-3">
            {t.afterWhy ? (
              <p className="text-sm text-ink-2" data-testid="coach-after-closed">
                {t.afterWhy}
              </p>
            ) : (
              <>
                <ul className="space-y-1 text-xs text-ink-2">
                  {(["effort", "body", "experience"] as const).map((k) => (
                    <li key={k}>
                      <span className="font-semibold">{k === "effort" ? "How hard it was" : k === "body" ? "Body questions" : "Likes and dislikes"}:</span>{" "}
                      {t.after[k] === "not_allowed"
                        ? "needs health access for this athlete"
                        : t.after[k] === "closed"
                          ? "the window has closed"
                          : t.after[k] === "family"
                            ? `answered by ${t.afterBy[k]?.label ?? "the family"}; these are their own words and cannot be replaced`
                            : t.afterBy[k]
                              ? `answered by ${t.afterBy[k]!.label}`
                              : "not answered yet"}
                    </li>
                  ))}
                  <li>
                    <span className="font-semibold">The 1 to 5 rating</span> is left to {t.firstName} or a parent.
                  </li>
                </ul>
                {anyAfter ? (
                  <AfterForm
                    action={coachSubmitAfterAction}
                    entry={{ athleteFirst: t.firstName, replaces: afterReplaces }}
                    bookingId={bookingId}
                    show={show}
                    editing={!!post}
                    minutes={t.durationMinutes}
                    likedChips={[...t.settings.likedChips, ...(exp?.liked ?? []).filter((c) => !t.settings.likedChips.some((x) => x.key === c.key))]}
                    dislikedChips={[...t.settings.dislikedChips, ...(exp?.disliked ?? []).filter((c) => !t.settings.dislikedChips.some((x) => x.key === c.key))]}
                    coachName={null}
                    defaults={{
                      rpe: post?.rpe,
                      soreness: post?.soreness,
                      hurt: post?.hurt,
                      hurtStartedInSession: post?.hurtStartedInSession,
                      liked: (exp?.liked ?? []).map((c) => c.key),
                      likedText: exp?.likedText,
                      disliked: (exp?.disliked ?? []).map((c) => c.key),
                      dislikedText: exp?.dislikedText,
                      nothingToChange: exp?.nothingToChange,
                      note: exp?.note,
                      tellCoach: false,
                    }}
                    spot={null}
                  />
                ) : (
                  <p className="text-sm text-ink-2">Nothing in this after check can be entered by you right now.</p>
                )}
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
