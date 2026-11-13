import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { ReadyForm } from "@/components/checkins/forms";
import { ButtonLink, Callout, Card, CardBody, PageHeader } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { AuthzError } from "@/lib/authz/policy";
import { READY_STATE_TEXT, readyTarget } from "@/lib/checkins/core";
import { fmt } from "@/lib/time";
import type { BodyView } from "@/lib/science/body-regions";
import { submitReadyAction } from "../../actions";

export const metadata = { title: "Ready check" };

export default async function ReadyCheckPage({ params }: { params: Promise<{ bookingId: string }> }) {
  const v = await requireViewer(["guardian", "athlete"]);
  const { bookingId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(bookingId)) notFound();
  let t: Awaited<ReturnType<typeof readyTarget>>;
  try {
    t = await db.transaction((tx) => readyTarget(tx, v, bookingId));
  } catch (e) {
    if (e instanceof AuthzError) redirect("/denied");
    throw e;
  }
  const tz = t.session.timezone;
  const when = fmt(t.session.startsAt, "EEEE, MMM d 'at' h:mm a", tz);
  const e = t.existing;
  return (
    <>
      <PageHeader
        kicker="Ready check"
        title={t.self ? "Before your session" : `Before ${t.firstName}'s session`}
        description={`${t.session.title} · ${when}${t.coach ? ` · ${t.coach}` : ""}`}
        actions={
          <ButtonLink href="/check-ins" variant="secondary" className="min-h-11">
            All check-ins
          </ButtonLink>
        }
      />
      <div className="max-w-xl space-y-4">
        {!t.canWrite ? (
          <Callout tone={t.state === "done" ? "ok" : "info"} title={t.state === "done" ? "Ready check done" : undefined}>
            {t.state === "not_open_yet" ? `The ready check opens ${fmt(t.window.opensAt, "EEE h:mm a", tz)}, a few hours before the session.` : READY_STATE_TEXT[t.state as keyof typeof READY_STATE_TEXT]}
          </Callout>
        ) : (
          <Card>
            <CardBody className="pt-4">
              <p className="mb-4 text-sm text-ink-2">
                {t.self ? "Takes about 20 seconds. Your coach sees your answers before you start." : `You are answering for ${t.firstName}. Ask them and use their words. It is saved as logged by a parent.`}
                {t.state === "editable" ? ` You can change your answers until ${fmt(t.window.closesAt, "h:mm a", tz)}.` : ""}
              </p>
              <ReadyForm
                action={submitReadyAction}
                bookingId={bookingId}
                editing={t.state === "editable"}
                ask={{ sleepHours: t.settings.askSleepHours, fatigue: t.settings.askFatigue, mood: t.settings.askMood, stress: t.settings.askStress }}
                prefilled={{ sleepQuality: t.prefill.sleep_quality, sleepHours: t.prefill.sleep_hours, fatigue: t.prefill.fatigue, mood: t.prefill.mood, stress: t.prefill.stress }}
                prior={t.prior ? { label: `${t.prior.title}, ${fmt(t.prior.startsAt, "EEE MMM d", tz)}` } : null}
                bodyMapAt={t.settings.bodyMapSorenessAt}
                defaults={e ? { readiness: e.readiness, sleepQuality: e.sleepQuality, sleepHours: e.sleepHours, soreness: e.soreness, fatigue: e.fatigue, mood: e.mood, stress: e.stress, hurt: e.hurt, note: e.note } : {}}
                spot={t.spot ? { view: t.spot.view as BodyView, region: t.spot.region, side: t.spot.side, type: t.spot.kind === "pain" ? "sharp" : "ache", level: t.spot.severity } : null}
              />
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
