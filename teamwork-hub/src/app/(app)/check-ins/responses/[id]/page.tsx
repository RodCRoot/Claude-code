import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, Callout, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { requireStaff } from "@/lib/auth/viewer";
import { AuthzError } from "@/lib/authz/policy";
import { FATIGUE, MOOD, RATING, READINESS, rpeWord, SLEEP_QUALITY, sorenessWord, STRESS, type ScaleOption } from "@/lib/checkins/questions";
import { checkinDetail, REASON_LABEL } from "@/lib/checkins/views";
import { fmt } from "@/lib/time";
import { closeExperienceFollowUpAction, reviewCheckinAction } from "../../actions";

export const metadata = { title: "Check-in response" };

const word = (opts: ScaleOption[], v: number | null) => (v === null ? null : (opts.find((o) => o.value === v)?.label ?? null));

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 border-b border-edge/60 py-1.5 last:border-b-0">
      <dt className="text-sm text-ink-2">{label}</dt>
      <dd className="text-sm font-semibold">{value ?? <span className="font-normal text-ink-3">no answer</span>}</dd>
    </div>
  );
}

export default async function CheckinResponsePage({ params }: { params: Promise<{ id: string }> }) {
  const v = await requireStaff();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let d: Awaited<ReturnType<typeof checkinDetail>>;
  try {
    d = await db.transaction((tx) => checkinDetail(tx, v, id));
  } catch (e) {
    if (e instanceof AuthzError) redirect("/denied");
    throw e;
  }
  const h = d.health;
  const scale = (opts: ScaleOption[], n: number | null, max: number) => (n === null ? null : `${n} of ${max} (${word(opts, n)})`);
  return (
    <>
      <PageHeader
        kicker={d.phase === "pre" ? "Ready check" : "After check"}
        title={d.athleteName ?? "Check-in response"}
        description={`${d.sessionTitle} · ${fmt(d.sessionStartsAt, "EEEE, MMM d 'at' h:mm a", d.timezone)}${d.coachName ? ` · ${d.coachName}` : ""}`}
        actions={
          <>
            {d.athleteName ? (
              <ButtonLink href={`/check-ins/athletes?id=${d.athleteId}`} variant="secondary">
                Trends
              </ButtonLink>
            ) : null}
            <ButtonLink href={`/schedule/sessions/${d.sessionId}`} variant="secondary">
              Session
            </ButtonLink>
          </>
        }
      />
      <div className="max-w-2xl space-y-4">
        <p className="text-xs text-ink-3">
          {d.via === "kiosk" ? "Answered at the kiosk." : d.via === "parent" ? "Logged by a parent / guardian." : "Answered in the app."} Question set {d.questionSetVersion}. Self-reported; not a diagnosis and not clearance to train.
        </p>
        {h ? (
          <Card>
            <CardHeader title={d.phase === "pre" ? "Before the session" : "Body"} kicker="Health answers" />
            <CardBody>
              {h.reasons.length ? (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {h.reasons.map((r) => (
                    <Badge key={r} variant="yellow">
                      {REASON_LABEL[r]}
                    </Badge>
                  ))}
                </div>
              ) : null}
              <dl>
                {d.phase === "pre" ? (
                  <>
                    <Row label="Readiness" value={scale(READINESS.options, h.readiness, 5)} />
                    <Row label="Sleep quality" value={scale(SLEEP_QUALITY.options, h.sleepQuality, 5)} />
                    <Row label="Hours slept" value={h.sleepHours} />
                    <Row label="Tiredness" value={scale(FATIGUE.options, h.fatigue, 5)} />
                    <Row label="Mood" value={scale(MOOD.options, h.mood, 5)} />
                    {h.stress !== null ? <Row label="Stress" value={scale(STRESS.options, h.stress, 5)} /> : null}
                    {h.priorSoreness !== null ? <Row label="Soreness the day after the last session" value={`${h.priorSoreness} of 10`} /> : null}
                  </>
                ) : null}
                <Row label="Soreness now" value={h.soreness === null ? null : `${h.soreness} of 10 (${sorenessWord(h.soreness)})`} />
                <Row label="Anything hurt?" value={h.hurt === null ? null : h.hurt ? "Yes" : "No"} />
                {h.hurt ? <Row label="Where" value={h.spot ? `${h.spot.label}: ${h.spot.kind === "sharp" ? "sharp pain" : "achy or tight"}, ${h.spot.severity} of 10` : "No spot marked"} /> : null}
                {h.hurt && d.phase === "post" ? <Row label="Started during this session" value={h.hurtStartedInSession === null ? null : h.hurtStartedInSession ? "Yes" : "No"} /> : null}
                {d.phase === "pre" ? <Row label="Note for the coach" value={h.note ? <span className="whitespace-pre-wrap font-normal">{h.note}</span> : null} /> : null}
              </dl>
              {h.prefilled.length ? <p className="mt-2 text-xs text-ink-3">Reused from that day&apos;s wellness check-in: {h.prefilled.join(", ").replaceAll("_", " ")}.</p> : null}
              {d.reviewTaskOpen && d.canReview ? (
                <ActionForm action={reviewCheckinAction} className="mt-3">
                  <input type="hidden" name="checkinId" value={d.id} />
                  <SubmitButton className="min-h-11" pendingText="Saving…">
                    Mark as reviewed
                  </SubmitButton>
                </ActionForm>
              ) : d.reviewedAt ? (
                <p className="mt-3 text-sm text-ok">Reviewed {fmt(d.reviewedAt, "MMM d, h:mm a", d.timezone)}.</p>
              ) : null}
            </CardBody>
          </Card>
        ) : (
          <Callout tone="info">Health answers (readiness, sleep, soreness, pain) are shown only to staff with health access for this athlete.</Callout>
        )}
        {d.effort ? (
          <Card>
            <CardHeader title="Effort" kicker="Training" />
            <CardBody>
              <dl>
                <Row label="How hard it felt (session RPE)" value={d.effort.rpe === null ? null : `${d.effort.rpe} of 10 (${rpeWord(d.effort.rpe)})`} />
                <Row label="Planned by the coach" value={d.effort.intendedRpe === null ? "not set" : `${d.effort.intendedRpe} of 10`} />
                <Row label="Session load (srpe_load_v1)" value={d.effort.load === null ? null : `${d.effort.load} AU (${d.effort.minutes} min × ${d.effort.rpe})`} />
              </dl>
            </CardBody>
          </Card>
        ) : null}
        {d.phase === "post" ? (
          d.experience ? (
            <Card>
              <CardHeader title="Experience" kicker={d.experience.tellCoach ? "Shared with the coach" : "Not shared with the coach"} />
              <CardBody>
                <dl>
                  <Row label="Overall rating" value={d.experience.rating === null ? null : `${d.experience.rating} of 5 (${word(RATING.options, d.experience.rating)})`} />
                  <Row label="Liked" value={d.experience.liked.length ? d.experience.liked.map((c) => c.label).join(", ") : null} />
                  {d.experience.likedText ? <Row label="Liked (in their words)" value={<span className="whitespace-pre-wrap font-normal">{d.experience.likedText}</span>} /> : null}
                  <Row label="Did not like" value={d.experience.nothingToChange ? "Nothing, it was good" : d.experience.disliked.length ? d.experience.disliked.map((c) => c.label).join(", ") : null} />
                  {d.experience.dislikedText ? <Row label="Did not like (in their words)" value={<span className="whitespace-pre-wrap font-normal">{d.experience.dislikedText}</span>} /> : null}
                  {d.experience.note ? <Row label="Other notes" value={<span className="whitespace-pre-wrap font-normal">{d.experience.note}</span>} /> : null}
                </dl>
                {d.experienceTaskId ? (
                  <ActionForm action={closeExperienceFollowUpAction} className="mt-3">
                    <input type="hidden" name="checkinId" value={d.id} />
                    <SubmitButton variant="secondary" className="min-h-11" pendingText="Saving…">
                      Mark follow-up done
                    </SubmitButton>
                  </ActionForm>
                ) : null}
              </CardBody>
            </Card>
          ) : (
            <Callout tone="info">Likes, dislikes and the rating are shown with a name only when the family chose to share them with the coach. Class totals are on the check-ins page.</Callout>
          )
        ) : null}
        <p className="text-xs text-ink-3">
          Nothing on this page is sent to the family. To reach out, use{" "}
          <Link href="/messages/new" className="underline">
            Messages
          </Link>
          .
        </p>
      </div>
    </>
  );
}
