import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardBody, CardHeader, Field, Input } from "@/components/ui";
import { SHOUTOUT_TEMPLATES } from "@/db/schema";
import { canOnAthlete, isStaff, type Viewer } from "@/lib/authz/policy";
import { displayModeAccess } from "@/lib/community/display-name";
import { SHOUTOUT_LABEL, SHOUTOUT_NOTE_MAX } from "@/lib/community/shared";
import { shoutoutsForAthlete, shoutoutsLeftToday } from "@/lib/community/shoutouts";
import { fmt } from "@/lib/time";
import { postShoutoutAction, removeShoutoutAction } from "@/app/(app)/leaderboards/actions";
import { DisplayModeForm } from "./display-mode-form";

/**
 * Staff profile → Community: post and remove coach shoutouts, and see (or, on the family's
 * request, change) how the athlete is named on boards. Staff in scope only.
 */
export async function CommunityProfileCard({ v, athleteId, tz }: { v: Viewer; athleteId: string; tz?: string }) {
  if (!isStaff(v) || !(await canOnAthlete(db, v, athleteId, "profile.read"))) return null;
  const left = await shoutoutsLeftToday(db, v);
  if (!left.enabled) return null;
  const [shoutouts, access] = [await shoutoutsForAthlete(db, v, athleteId, { limit: 8 }), await displayModeAccess(db, v, athleteId)];
  return (
    <Card id="community-profile">
      <CardHeader title="Community" kicker="Shoutouts and name on boards" action={<Badge variant={access.effective === "hidden" ? "neutral" : "blue"}>{access.preview ? `Shown as ${access.preview}` : "Hidden from boards"}</Badge>} />
      <CardBody className="grid gap-5 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold">Give a shoutout</h3>
          {left.left > 0 ? (
            <ActionForm action={postShoutoutAction} resetOnSuccess className="mt-2 space-y-3">
              <input type="hidden" name="athleteId" value={athleteId} />
              <fieldset>
                <legend className="sr-only">What is it for?</legend>
                <div className="flex flex-wrap gap-2">
                  {SHOUTOUT_TEMPLATES.map((t, i) => (
                    <label key={t} className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-edge px-3.5 text-sm font-semibold has-checked:border-brand has-checked:bg-brand has-checked:text-brand-ink has-focus-visible:outline-2 has-focus-visible:outline-brand">
                      <input type="radio" name="template" value={t} defaultChecked={i === 0} className="sr-only" required />
                      {SHOUTOUT_LABEL[t]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <Field label="Add a short note (optional)" htmlFor={`so-note-${athleteId}`} hint={`Up to ${SHOUTOUT_NOTE_MAX} characters. The athlete and their family see it, and the gym TV if their name is shown.`}>
                <Input id={`so-note-${athleteId}`} name="note" maxLength={SHOUTOUT_NOTE_MAX} autoComplete="off" />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <SubmitButton>Post shoutout</SubmitButton>
                <span className="text-xs text-ink-3">
                  {left.left} of {left.limit} left today
                </span>
              </div>
            </ActionForm>
          ) : (
            <p className="mt-2 text-sm text-ink-3">You have used today&apos;s {left.limit} shoutouts. More tomorrow.</p>
          )}
          <h3 className="mt-5 text-sm font-semibold">Recent shoutouts</h3>
          {shoutouts.length === 0 ? <p className="mt-1 text-sm text-ink-3">None yet.</p> : null}
          <ul className="mt-1 divide-y divide-edge">
            {shoutouts.map((s) => (
              <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-semibold">{s.headline}</span>
                  {s.note ? <span className="block text-ink-2">&ldquo;{s.note}&rdquo;</span> : null}
                  <span className="block text-xs text-ink-3">
                    {s.coach} · {fmt(s.createdAt, "MMM d", tz)}
                  </span>
                </span>
                {s.canRemove ? (
                  <ActionForm action={removeShoutoutAction}>
                    <input type="hidden" name="shoutoutId" value={s.id} />
                    <SubmitButton variant="secondary" size="sm" pendingText="Removing…" confirm="Remove this shoutout? It is taken off the athlete's home and the gym TV. The removal is logged.">
                      Remove<span className="sr-only">: {s.headline}</span>
                    </SubmitButton>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-sm font-semibold">Name on boards</h3>
          <div className="mt-2">
            {access.staffOnRequest ? (
              <details>
                <summary className="min-h-11 cursor-pointer py-2 text-sm">
                  Other families see: <span className="font-bold">{access.preview ?? "not shown at all"}</span>
                  {access.chosen === null ? <span className="text-ink-3"> (gym default)</span> : null}. <span className="font-semibold text-brand underline">Change on the family&apos;s request</span>
                </summary>
                <DisplayModeForm access={access} isSelf={false} />
              </details>
            ) : (
              <DisplayModeForm access={access} isSelf={false} />
            )}
          </div>
          <p className="mt-3 text-xs text-ink-3">The family chooses this. For athletes under 18 a parent or guardian decides; adults decide for themselves.</p>
        </div>
      </CardBody>
    </Card>
  );
}
