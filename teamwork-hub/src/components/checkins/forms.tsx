"use client";

import { useState } from "react";
import { ActionForm, SubmitButton, type ActionState } from "@/components/forms";
import { DISCLAIMER, DISLIKED, FATIGUE, HURT, LIKED, MOOD, POST_NOTE, PRE_NOTE, PRIOR_SORENESS, RATING, READINESS, RPE, SLEEP_HOURS, SLEEP_QUALITY, SORENESS, STRESS, TELL_COACH } from "@/lib/checkins/questions";
import { ChipPick, HurtPicker, Question, ScalePick, SorenessSlider, type SpotDefault } from "./parts";

type Action = (prev: ActionState, fd: FormData) => Promise<ActionState>;
const input = "h-12 w-full rounded-lg border border-edge bg-surface px-3 text-base";
const area = "w-full rounded-lg border border-edge bg-surface px-3 py-2 text-base";

export type ReadyFormProps = {
  action: Action;
  bookingId: string;
  editing: boolean;
  ask: { sleepHours: boolean; fatigue: boolean; mood: boolean; stress: boolean };
  /** Items already answered in today's wellness: shown as done, not asked again. */
  prefilled: { sleepQuality?: number; sleepHours?: number; fatigue?: number; mood?: number; stress?: number };
  prior: { label: string } | null;
  bodyMapAt: number;
  defaults: { readiness?: number | null; sleepQuality?: number | null; sleepHours?: number | null; soreness?: number | null; fatigue?: number | null; mood?: number | null; stress?: number | null; hurt?: boolean | null; note?: string | null };
  spot: SpotDefault;
};

function Reused({ what }: { what: string }) {
  return <p className="rounded-md bg-ok/10 px-3 py-2 text-sm text-ink-2">{what}: already answered in today&apos;s wellness check-in, so we will not ask again.</p>;
}

/** Ready check: one screen, under 30 seconds. */
export function ReadyForm(p: ReadyFormProps) {
  const [sore, setSore] = useState<number | null>(p.defaults.soreness ?? null);
  const d = p.defaults;
  const skip = p.prefilled;
  return (
    <ActionForm action={p.action} className="space-y-6">
      <input type="hidden" name="bookingId" value={p.bookingId} />
      <Question title={READINESS.question}>
        <ScalePick name="readiness" options={READINESS.options} defaultValue={d.readiness} />
      </Question>
      {skip.sleepQuality !== undefined && !p.editing ? (
        <Reused what="Sleep" />
      ) : (
        <Question title={SLEEP_QUALITY.question}>
          <ScalePick name="sleepQuality" options={SLEEP_QUALITY.options} defaultValue={d.sleepQuality} />
        </Question>
      )}
      {p.ask.sleepHours && (skip.sleepHours === undefined || p.editing) ? (
        <div>
          <label htmlFor="sleepHours" className="mb-1 block text-base font-semibold">
            {SLEEP_HOURS.question} <span className="text-sm font-normal text-ink-3">(optional)</span>
          </label>
          <input id="sleepHours" name="sleepHours" type="number" inputMode="decimal" min={0} max={24} step={0.5} defaultValue={d.sleepHours ?? ""} className={`${input} max-w-32`} />
        </div>
      ) : null}
      <Question title={SORENESS.preQuestion}>
        <SorenessSlider name="soreness" id="soreness" defaultValue={d.soreness} onChange={setSore} />
      </Question>
      <HurtPicker question={HURT.preQuestion} phase="pre" defaultHurt={d.hurt} defaultSpot={p.spot} nudge={sore !== null && sore >= p.bodyMapAt} />
      {p.ask.fatigue && (skip.fatigue === undefined || p.editing) ? (
        <Question title={FATIGUE.question}>
          <ScalePick name="fatigue" options={FATIGUE.options} defaultValue={d.fatigue} />
        </Question>
      ) : null}
      {p.ask.mood && (skip.mood === undefined || p.editing) ? (
        <Question title={MOOD.question}>
          <ScalePick name="mood" options={MOOD.options} defaultValue={d.mood} />
        </Question>
      ) : null}
      {p.ask.stress && (skip.stress === undefined || p.editing) ? (
        <Question title={STRESS.question}>
          <ScalePick name="stress" options={STRESS.options} defaultValue={d.stress} />
        </Question>
      ) : null}
      {p.prior ? (
        <Question title={PRIOR_SORENESS.question} hint={`${p.prior.label}. ${PRIOR_SORENESS.hint}`} optional>
          <SorenessSlider name="priorSoreness" id="priorSoreness" />
        </Question>
      ) : null}
      <div>
        <label htmlFor="note" className="mb-1 block text-base font-semibold">
          {PRE_NOTE.question} <span className="text-sm font-normal text-ink-3">(optional)</span>
        </label>
        <textarea id="note" name="note" rows={2} maxLength={300} defaultValue={d.note ?? ""} className={area} aria-describedby="note-hint" />
        <p id="note-hint" className="mt-1 text-xs text-ink-3">
          {PRE_NOTE.hint}
        </p>
      </div>
      <SubmitButton size="lg" className="min-h-14 w-full text-lg" pendingText="Saving…">
        {p.editing ? "Update ready check" : "I am ready"}
      </SubmitButton>
      <p className="text-xs text-ink-3">{DISCLAIMER}</p>
    </ActionForm>
  );
}

export type AfterFormProps = {
  action: Action;
  bookingId: string;
  show: { effort: boolean; body: boolean; experience: boolean; rating: boolean };
  editing: boolean;
  minutes: number;
  likedChips: { key: string; label: string }[];
  dislikedChips: { key: string; label: string }[];
  coachName: string | null;
  defaults: { rpe?: number | null; soreness?: number | null; hurt?: boolean | null; hurtStartedInSession?: boolean | null; liked: string[]; likedText?: string | null; disliked: string[]; dislikedText?: string | null; nothingToChange?: boolean | null; rating?: number | null; note?: string | null; tellCoach: boolean };
  spot: SpotDefault;
};

/** After check: one screen. Only the parts this person may answer are shown. */
export function AfterForm(p: AfterFormProps) {
  const d = p.defaults;
  const [nothing, setNothing] = useState(d.nothingToChange === true);
  return (
    <ActionForm action={p.action} className="space-y-6">
      <input type="hidden" name="bookingId" value={p.bookingId} />
      {p.show.effort ? (
        <Question title={RPE.question} hint={`0 is rest, 10 is the hardest you could go. The session was ${p.minutes} minutes.`}>
          <ScalePick name="rpe" options={RPE.options} defaultValue={d.rpe} cols="grid-cols-4 sm:grid-cols-6" />
        </Question>
      ) : null}
      {p.show.experience ? (
        <>
          <Question title={LIKED.question} hint={LIKED.hint} optional>
            <ChipPick name="liked" chips={p.likedChips} selected={d.liked} />
            <label htmlFor="likedText" className="sr-only">
              {LIKED.textLabel}
            </label>
            <input id="likedText" name="likedText" maxLength={300} defaultValue={d.likedText ?? ""} placeholder={LIKED.textLabel} className={`${input} mt-2`} />
          </Question>
          <Question title={DISLIKED.question} hint={DISLIKED.hint} optional>
            <label className="mb-2 flex min-h-12 cursor-pointer items-center gap-2 rounded-lg border border-edge bg-surface px-4 text-sm font-semibold has-[:checked]:border-ok has-[:checked]:bg-ok/10">
              <input type="checkbox" name="nothingToChange" checked={nothing} onChange={(e) => setNothing(e.target.checked)} className="size-5" />
              {DISLIKED.nothing}
            </label>
            {nothing ? null : (
              <>
                <ChipPick name="disliked" chips={p.dislikedChips} selected={d.disliked} />
                <label htmlFor="dislikedText" className="sr-only">
                  {DISLIKED.textLabel}
                </label>
                <textarea id="dislikedText" name="dislikedText" rows={2} maxLength={500} defaultValue={d.dislikedText ?? ""} placeholder={DISLIKED.textLabel} className={`${area} mt-2`} />
              </>
            )}
          </Question>
        </>
      ) : null}
      {p.show.body ? (
        <>
          <HurtPicker question={HURT.postQuestion} phase="post" defaultHurt={d.hurt} defaultSpot={p.spot} defaultStarted={d.hurtStartedInSession} />
          <Question title={SORENESS.postQuestion} optional>
            <SorenessSlider name="soreness" id="soreness" defaultValue={d.soreness} />
          </Question>
        </>
      ) : null}
      {p.show.rating ? (
        <Question title={RATING.question} optional>
          <ScalePick name="rating" options={RATING.options} defaultValue={d.rating} />
        </Question>
      ) : null}
      {p.show.experience ? (
        <>
          <div>
            <label htmlFor="note" className="mb-1 block text-base font-semibold">
              {POST_NOTE.question} <span className="text-sm font-normal text-ink-3">(optional)</span>
            </label>
            <textarea id="note" name="note" rows={2} maxLength={1000} defaultValue={d.note ?? ""} className={area} aria-describedby="note-hint" />
            <p id="note-hint" className="mt-1 text-xs text-ink-3">
              {POST_NOTE.hint}
            </p>
          </div>
          <label className="flex min-h-11 items-start gap-2 text-sm">
            <input type="checkbox" name="tellCoach" defaultChecked={d.tellCoach} className="mt-1 size-5" />
            <span>
              {TELL_COACH.label}
              {p.coachName ? ` (${p.coachName})` : ""}
              <span className="block text-xs text-ink-3">{TELL_COACH.hint}</span>
            </span>
          </label>
        </>
      ) : null}
      <SubmitButton size="lg" className="min-h-14 w-full text-lg" pendingText="Saving…">
        {p.editing ? "Update my answers" : "Send"}
      </SubmitButton>
      {p.show.body ? <p className="text-xs text-ink-3">{DISCLAIMER}</p> : null}
    </ActionForm>
  );
}
