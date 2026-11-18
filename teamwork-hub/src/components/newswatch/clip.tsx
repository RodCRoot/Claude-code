import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Field, Input } from "@/components/ui";
import { fmt } from "@/lib/time";
import type { ClipView } from "@/lib/newswatch/clips";
import { CLIP_STATUS_LABEL, MATCH_LEVEL_LABEL } from "@/lib/newswatch/shared";
import { approveClipAction, rejectClipAction, removeClipAction, triageClipAction } from "@/app/(app)/wins/news-actions";

/** Headline, publication, date and a link out. Never article text, never an image. */
export function ClipFacts({ c, tz }: { c: ClipView; tz?: string }) {
  return (
    <>
      <p className="font-medium text-ink">{c.headline}</p>
      <p className="text-xs text-ink-3">
        {c.sourceName} · {c.publishedAt ? fmt(c.publishedAt, "MMM d, yyyy", tz) : `found ${fmt(c.createdAt, "MMM d, yyyy", tz)}`} ·{" "}
        <a href={c.link} target="_blank" rel="noopener noreferrer nofollow" className="font-semibold text-brand underline">
          Open the article<span className="sr-only">: {c.headline} (opens in a new tab)</span>
        </a>
      </p>
      {c.snippet ? <p className="text-sm text-ink-2">Feed summary: {c.snippet}</p> : null}
    </>
  );
}

/**
 * One news clip for staff. `mode` decides the buttons:
 *  - "triage": our athlete / not our athlete / ignore (any staff member who reviews wins);
 *  - "approve": approve / reject / not our athlete, with a tick box for the bulk approve form;
 *  - "approved": take down;
 *  - "none": read only.
 * Triage never shows a clip to anyone. Only Approve does.
 */
export function ClipCard({ c, tz, mode, bulkFormId }: { c: ClipView; tz?: string; mode: "triage" | "approve" | "approved" | "none"; bulkFormId?: string }) {
  const approvable = !c.blockedTopic && c.watched && c.shownAs !== null;
  return (
    <li className="space-y-2 py-4 first:pt-0 last:pb-0" data-clip={c.id}>
      <div className="flex flex-wrap items-center gap-2">
        {mode === "approve" && bulkFormId && approvable ? (
          <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
            <input type="checkbox" name="clipIds" value={c.id} form={bulkFormId} className="size-5 accent-brand" />
            <span className="sr-only">Select the clip about </span>
            {c.personName}
          </label>
        ) : c.personId ? (
          <Link href={`/people/${c.personId}`} className="text-sm font-semibold hover:underline">
            {c.personName}
          </Link>
        ) : (
          <span className="text-sm font-semibold">{c.personName}</span>
        )}
        <Badge variant={c.person === "alumni" ? "brand" : "neutral"}>{c.person === "alumni" ? "Alumni" : "Current athlete"}</Badge>
        {c.matchLevel ? <Badge variant={c.matchLevel === "likely" ? "green" : "yellow"}>{MATCH_LEVEL_LABEL[c.matchLevel]}</Badge> : null}
        <Badge variant={c.status === "approved" ? "green" : c.status === "confirmed" ? "blue" : "neutral"}>{CLIP_STATUS_LABEL[c.status]}</Badge>
      </div>
      {c.personDetail ? <p className="text-xs text-ink-3">{c.personDetail}</p> : null}
      <ClipFacts c={c} tz={tz} />
      {c.blockedTopic ? (
        <p role="note" className="rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
          <strong>Cannot be shared.</strong> The headline mentions {c.blockedTopic}. Health, injuries, body weight and school grades are never shown. Reject it.
        </p>
      ) : c.sensitiveNote ? (
        <p role="note" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-ink">
          <strong>Check before approving.</strong> {c.sensitiveNote}. This is a word check, so read the article first.
        </p>
      ) : null}
      {!c.watched && (mode === "triage" || mode === "approve") ? <p className="text-sm text-ink-2">This person is no longer being watched, so this clip cannot be approved.</p> : null}
      {c.watched && c.shownAs === null && mode !== "approved" ? <p className="text-sm text-ink-2">This athlete&apos;s name is hidden from other families, so this clip cannot be shown.</p> : null}
      {c.reasons.length ? (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-brand underline">
            Why it matched<span className="sr-only">: {c.headline}</span>
          </summary>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink-2">
            {c.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
            {c.shownAs ? <li>If approved, other families see the name as {c.shownAs}.</li> : null}
          </ul>
        </details>
      ) : null}

      {mode === "triage" || mode === "approve" ? (
        <div className="flex flex-wrap items-start gap-2">
          {mode === "approve" && approvable ? (
            <ActionForm action={approveClipAction}>
              <input type="hidden" name="clipId" value={c.id} />
              <SubmitButton size="sm">
                Approve<span className="sr-only">: {c.headline}</span>
              </SubmitButton>
            </ActionForm>
          ) : null}
          {mode === "triage" && c.status === "suggested" ? (
            <ActionForm action={triageClipAction}>
              <input type="hidden" name="clipId" value={c.id} />
              <input type="hidden" name="decision" value="ours" />
              <SubmitButton size="sm">
                Our athlete<span className="sr-only">: {c.headline}</span>
              </SubmitButton>
            </ActionForm>
          ) : null}
          {mode === "approve" ? (
            <ActionForm action={rejectClipAction}>
              <input type="hidden" name="clipId" value={c.id} />
              <SubmitButton size="sm" variant="secondary">
                Reject<span className="sr-only">: {c.headline}</span>
              </SubmitButton>
            </ActionForm>
          ) : (
            <ActionForm action={triageClipAction}>
              <input type="hidden" name="clipId" value={c.id} />
              <input type="hidden" name="decision" value="ignore" />
              <SubmitButton size="sm" variant="ghost">
                Ignore<span className="sr-only">: {c.headline}</span>
              </SubmitButton>
            </ActionForm>
          )}
          <details className="basis-full sm:basis-auto">
            <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-brand underline">
              Not our athlete<span className="sr-only">: {c.headline}</span>
            </summary>
            <ActionForm action={triageClipAction} className="max-w-sm space-y-2">
              <input type="hidden" name="clipId" value={c.id} />
              <input type="hidden" name="decision" value="not_ours" />
              <Field label="A word that marks the other person (optional)" htmlFor={`term-${c.id}`} hint="For example their town or school. Later headlines with this word are not suggested for this person.">
                <Input id={`term-${c.id}`} name="term" maxLength={60} autoComplete="off" />
              </Field>
              <SubmitButton size="sm" variant="secondary">
                Confirm: not our athlete
              </SubmitButton>
            </ActionForm>
          </details>
        </div>
      ) : null}
      {mode === "approved" && c.status === "approved" ? (
        <ActionForm action={removeClipAction}>
          <input type="hidden" name="clipId" value={c.id} />
          <SubmitButton size="sm" variant="secondary">
            Take down<span className="sr-only">: {c.headline}</span>
          </SubmitButton>
        </ActionForm>
      ) : null}
    </li>
  );
}
