import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { AfterForm } from "@/components/checkins/forms";
import { ButtonLink, Callout, Card, CardBody, PageHeader } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { AuthzError } from "@/lib/authz/policy";
import { AFTER_STATE_TEXT, afterTarget } from "@/lib/checkins/core";
import { RATING } from "@/lib/checkins/questions";
import type { BodyView } from "@/lib/science/body-regions";
import { fmt } from "@/lib/time";
import { submitAfterAction } from "../../actions";

export const metadata = { title: "After check" };

export default async function AfterCheckPage({ params }: { params: Promise<{ bookingId: string }> }) {
  const v = await requireViewer(["guardian", "athlete"]);
  const { bookingId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) notFound();
  let t: Awaited<ReturnType<typeof afterTarget>>;
  try {
    t = await db.transaction((tx) => afterTarget(tx, v, bookingId));
  } catch (e) {
    if (e instanceof AuthzError) redirect("/denied");
    throw e;
  }
  const tz = t.session.timezone;
  const when = fmt(t.session.startsAt, "EEEE, MMM d 'at' h:mm a", tz);
  const can = (s: "effort" | "body" | "experience") => t.sections[s] === "open" || t.sections[s] === "editable";
  const show = { effort: can("effort"), body: can("body"), experience: can("experience"), rating: t.rating === "open" || t.rating === "editable" };
  const e = t.existing;
  const editing = Object.values(t.sections).some((s) => s === "editable") || t.rating === "editable";
  const lockedByOther = Object.values(t.sections).some((s) => s === "locked");
  const ratingLabel = t.feedback ? RATING.options.find((o) => o.value === t.feedback!.rating)?.label : null;
  return (
    <>
      <PageHeader
        kicker="After check"
        title={t.self ? "How was your session?" : `How was ${t.firstName}'s session?`}
        description={`${t.session.title} · ${when}${t.coach ? ` · ${t.coach}` : ""}`}
        actions={
          <ButtonLink href="/check-ins" variant="secondary" className="min-h-11">
            All check-ins
          </ButtonLink>
        }
      />
      <div className="max-w-xl space-y-4">
        {t.feedback && t.rating === "locked" ? (
          <Callout tone="ok" title="Rating received">
            {t.feedback.rating} of 5 ({ratingLabel}). {t.feedback.mine ? "A rating can be changed for 24 hours after it is left." : "It was left by another person on the account."} One rating per session.
          </Callout>
        ) : null}
        {t.state !== "open" ? (
          <Callout tone="info">{AFTER_STATE_TEXT[t.state]}</Callout>
        ) : (
          <Card>
            <CardBody className="pt-4">
              <p className="mb-4 text-sm text-ink-2">
                {t.self
                  ? "Takes about 30 seconds. Your coach sees how hard it felt and anything that hurt."
                  : show.effort
                    ? `You are answering for ${t.firstName}. Ask them and use their words. It is saved as logged by a parent.`
                    : `You can tell us how the session went for ${t.firstName}. The effort and body questions are answered by ${t.firstName}.`}
                {lockedByOther ? " Some questions were already answered by someone else on the account and are not shown." : ""}
              </p>
              <AfterForm
                action={submitAfterAction}
                bookingId={bookingId}
                show={show}
                editing={editing}
                minutes={t.durationMinutes}
                likedChips={[...t.settings.likedChips, ...(e?.likedChips ?? []).filter((c) => !t.settings.likedChips.some((x) => x.key === c.key))]}
                dislikedChips={[...t.settings.dislikedChips, ...(e?.dislikedChips ?? []).filter((c) => !t.settings.dislikedChips.some((x) => x.key === c.key))]}
                coachName={t.coach}
                defaults={{
                  rpe: e?.rpe,
                  soreness: e?.soreness,
                  hurt: e?.hurt,
                  hurtStartedInSession: e?.hurtStartedInSession,
                  liked: show.experience ? (e?.likedChips ?? []).map((c) => c.key) : [],
                  likedText: show.experience ? e?.likedText : null,
                  disliked: show.experience ? (e?.dislikedChips ?? []).map((c) => c.key) : [],
                  dislikedText: show.experience ? e?.dislikedText : null,
                  nothingToChange: show.experience ? e?.nothingToChange : null,
                  rating: t.rating === "editable" ? t.feedback?.rating : null,
                  note: show.experience ? e?.note : null,
                  tellCoach: e?.tellCoach ?? t.feedback?.tellCoach ?? false,
                }}
                spot={t.spot ? { view: t.spot.view as BodyView, region: t.spot.region, side: t.spot.side, type: t.spot.kind === "pain" ? "sharp" : "ache", level: t.spot.severity } : null}
              />
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
