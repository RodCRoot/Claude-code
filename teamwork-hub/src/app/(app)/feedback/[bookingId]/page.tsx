import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { AuthzError } from "@/lib/authz/policy";
import { fmt } from "@/lib/time";
import { feedbackTarget, RATING_LABELS } from "@/lib/retention/feedback";
import { ActionForm, SubmitButton } from "@/components/forms";
import { ButtonLink, Callout, Card, CardBody, CardHeader, PageHeader, Textarea } from "@/components/ui";
import { RatingText } from "@/components/retention/parts";
import { submitFeedbackAction } from "../actions";

export const metadata = { title: "Session feedback" };

const CLOSED: Record<string, string> = {
  not_attended: "Feedback can be left after a session the athlete attended.",
  not_ended: "Feedback opens when the session ends.",
  closed: "The feedback window for this session has closed. You can always message the front desk.",
};

export default async function FeedbackPage({ params }: { params: Promise<{ bookingId: string }> }) {
  const v = await requireViewer(["guardian", "athlete"]);
  const { bookingId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) notFound();
  let t: Awaited<ReturnType<typeof feedbackTarget>>;
  try {
    t = await feedbackTarget(db, v, bookingId);
  } catch (e) {
    if (e instanceof AuthzError) redirect("/denied");
    throw e;
  }
  const self = v.role === "athlete";
  const when = fmt(t.session.startsAt, "EEEE, MMM d 'at' h:mm a", t.tz);
  const canWrite = t.state === "open" || t.state === "editable";
  return (
    <>
      <PageHeader
        kicker="Session feedback"
        title={self ? "How was your session?" : `How was ${t.first}'s session?`}
        description={`${t.session.title} · ${when}${t.coach ? ` · ${t.coach}` : ""}`}
        actions={
          <ButtonLink href="/schedule" variant="secondary" className="min-h-11">
            Back to schedule
          </ButtonLink>
        }
      />
      <div className="max-w-xl space-y-4">
        {t.existing && t.state === "locked" ? (
          <Card>
            <CardHeader title="Feedback received" kicker="Thank you" />
            <CardBody className="space-y-2 text-sm">
              <p>
                <RatingText rating={t.existing.rating} label={RATING_LABELS[t.existing.rating]} />
              </p>
              {t.existing.submittedByUserId === v.userId && t.existing.comment ? <p className="whitespace-pre-wrap rounded-md bg-surface-2 px-3 py-2 text-ink-2">{t.existing.comment}</p> : null}
              <p className="text-xs text-ink-3">
                {t.existing.submittedByUserId === v.userId ? "Feedback can be changed for 24 hours after it is left." : "Feedback for this session was already left by another person on the account."} One response per session.
              </p>
            </CardBody>
          </Card>
        ) : !canWrite ? (
          <Callout tone="info">{CLOSED[t.state]}</Callout>
        ) : (
          <Card>
            <CardHeader title={t.state === "editable" ? "Change your feedback" : "Rate this session"} kicker={t.state === "editable" && t.editableUntil ? `Editable until ${fmt(t.editableUntil, "MMM d, h:mm a", t.tz)}` : "Takes 10 seconds"} />
            <CardBody>
              <ActionForm action={submitFeedbackAction} className="space-y-5">
                <input type="hidden" name="bookingId" value={t.booking.id} />
                <fieldset>
                  <legend className="mb-2 text-sm font-medium text-ink-2">
                    Rating <span className="font-normal text-ink-3">(1 = poor, 5 = great)</span>
                  </legend>
                  <div className="grid grid-cols-5 gap-2">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <label
                        key={n}
                        className="flex min-h-16 cursor-pointer flex-col items-center justify-center rounded-md border border-edge bg-surface px-1 py-2 text-center hover:bg-surface-2 has-[:checked]:border-brand has-[:checked]:bg-brand/10 has-[:checked]:ring-2 has-[:checked]:ring-brand has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand"
                      >
                        <input type="radio" name="rating" value={n} required defaultChecked={t.existing?.rating === n} className="sr-only" />
                        <span className="text-xl font-bold tabular">{n}</span>
                        <span className="text-[11px] font-medium text-ink-2">{RATING_LABELS[n]}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="space-y-1">
                  <label htmlFor="comment" className="block text-sm font-medium text-ink-2">
                    Anything you want us to know? <span className="font-normal text-ink-3">(optional)</span>
                  </label>
                  <Textarea id="comment" name="comment" rows={4} maxLength={1000} defaultValue={t.existing?.comment ?? ""} aria-describedby="comment-hint" />
                  <p id="comment-hint" className="text-xs text-ink-3">
                    Read by the owner and front desk. Please do not include medical details here.
                  </p>
                </div>
                <label className="flex min-h-11 items-start gap-2 text-sm">
                  <input type="checkbox" name="tellCoach" defaultChecked={t.existing?.tellCoach ?? false} className="mt-1" />
                  <span>
                    Tell my coach
                    <span className="block text-xs text-ink-3">
                      Shares {self ? "your" : `${t.first}'s`} name, rating and comment with {t.coach ?? "the coach"}. If you leave this off, coaches only ever see class averages.
                    </span>
                  </span>
                </label>
                <SubmitButton className="min-h-11" pendingText="Saving…">
                  {t.state === "editable" ? "Update feedback" : "Send feedback"}
                </SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
