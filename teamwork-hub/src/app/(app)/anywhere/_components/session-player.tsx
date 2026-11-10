"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { buttonClass } from "@/components/ui";
import { enqueueCompletion, flushAnywhere, newClientKey, useAnywhereQueue } from "./anywhere-queue";

export type PlayerStep = { id: string; name: string; prescription: string; cue: string | null; notes: string | null; videoUrl: string | null };

const PROGRESS_KEY = "tw.anywhere.progress.v1";
const RPE_HINT: Record<number, string> = { 0: "Rest", 2: "Easy", 4: "Moderate", 6: "Hard", 8: "Very hard", 10: "Max" };

function readProgress(sessionId: string): string[] {
  try {
    const all = JSON.parse(window.localStorage.getItem(PROGRESS_KEY) ?? "{}") as Record<string, unknown>;
    const v = all[sessionId];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function writeProgress(sessionId: string, ids: string[] | null) {
  try {
    const all = JSON.parse(window.localStorage.getItem(PROGRESS_KEY) ?? "{}") as Record<string, string[]>;
    if (ids && ids.length) all[sessionId] = ids;
    else delete all[sessionId];
    window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch {
    /* ticks still work for this visit */
  }
}

/**
 * The session in progress: tick each step, then finish with optional minutes and effort.
 * Ticks are kept on the device (step ids only) so a reload or a dropped connection loses nothing.
 * Finishing is saved on the device first and sent with an idempotency key (see anywhere-queue.ts).
 */
export function SessionPlayer({ athleteId, sessionId, plannedMinutes, steps, canLog, backHref }: { athleteId: string; sessionId: string; plannedMinutes: number; steps: PlayerStep[]; canLog: boolean; backHref: string }) {
  const router = useRouter();
  const queue = useAnywhereQueue();
  const [done, setDone] = useState<string[]>([]);
  const [minutes, setMinutes] = useState("");
  const [rpe, setRpe] = useState<number | null>(null);
  const [finishedKey, setFinishedKey] = useState<string | null>(null);

  useEffect(() => {
    // Restore ticks saved on this device, and send anything still waiting from an earlier visit.
    const valid = new Set(steps.map((s) => s.id));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after mount
    setDone(readProgress(sessionId).filter((id) => valid.has(id)));
    void flushAnywhere();
  }, [sessionId, steps]);

  const saved = finishedKey !== null && queue.saved.includes(finishedKey);
  const rejected = finishedKey !== null ? queue.rejected.find((r) => r.clientKey === finishedKey) : undefined;
  const waiting = finishedKey !== null && !saved && !rejected;

  useEffect(() => {
    if (saved) router.refresh();
  }, [saved, router]);

  function toggle(id: string) {
    setDone((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      writeProgress(sessionId, next);
      return next;
    });
  }

  function finish() {
    const key = newClientKey();
    const m = Number(minutes);
    setFinishedKey(key);
    writeProgress(sessionId, null);
    void enqueueCompletion({ clientKey: key, athleteId, sessionId, stepsDone: done.length, durationMinutes: minutes.trim() && Number.isInteger(m) && m >= 1 && m <= 240 ? m : null, rpe, completedAt: new Date().toISOString() });
  }

  const total = steps.length;
  const pct = total ? Math.round((done.length / total) * 100) : 0;

  if (finishedKey) {
    return (
      <section aria-live="polite" className="rounded-md border border-edge border-l-4 border-l-ok bg-surface px-4 py-5 shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
        <h2 className="text-xl leading-tight font-extrabold">{rejected ? "That did not save" : "Nice work. Session done."}</h2>
        <p className="mt-1 text-sm text-ink-2">
          {rejected
            ? rejected.error
            : saved
              ? "Saved. It counts toward your weekly streak, and your coach can see it."
              : queue.lastError ?? "Saving..."}
        </p>
        {waiting && queue.lastError ? <p className="mt-1 text-xs text-ink-3">You can close this page. It will send the next time you open On Your Own with a connection.</p> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={backHref} className={buttonClass("primary", "lg", "w-full sm:w-auto")}>
            Back to On Your Own
          </Link>
          {waiting && queue.lastError ? (
            <button type="button" onClick={() => void flushAnywhere()} className={buttonClass("secondary", "lg", "w-full sm:w-auto")}>
              Try again now
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section aria-labelledby="steps-h" className="rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
        <div className="border-b border-edge px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="steps-h" className="text-[15px] font-semibold">
              Steps
            </h2>
            <span className="text-sm font-semibold tabular text-ink-2">
              {done.length} of {total} done
            </span>
          </div>
          <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="Steps done" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done.length}>
            <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <ol className="divide-y divide-edge">
          {steps.map((s, i) => {
            const checked = done.includes(s.id);
            return (
              <li key={s.id} className={checked ? "bg-ok/5" : undefined}>
                <label className="flex min-h-16 cursor-pointer items-start gap-3 px-4 py-3">
                  <input type="checkbox" className="mt-0.5 size-7 shrink-0 accent-brand" checked={checked} disabled={!canLog} onChange={() => toggle(s.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-base leading-snug font-bold">
                      <span className="text-ink-3 tabular">{i + 1}.</span> {s.name}
                    </span>
                    <span className="block text-[15px] font-semibold text-brand">{s.prescription}</span>
                    {s.cue ? <span className="mt-0.5 block text-sm text-ink-2">{s.cue}</span> : null}
                    {s.notes ? <span className="mt-0.5 block text-sm text-ink-3">{s.notes}</span> : null}
                  </span>
                </label>
                {s.videoUrl ? (
                  <a href={s.videoUrl} target="_blank" rel="noopener noreferrer" className="mb-2 ml-14 inline-flex min-h-11 items-center text-sm font-semibold text-brand underline">
                    Watch the demo for {s.name} (opens in a new tab)
                  </a>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>

      {canLog ? (
        <section aria-labelledby="finish-h" className="rounded-md border border-edge bg-surface px-4 py-4 shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
          <h2 id="finish-h" className="text-[15px] font-semibold">
            Finish
          </h2>
          <p className="mt-0.5 text-sm text-ink-2">Both questions are optional. Answer both and it counts in your training load.</p>
          <div className="mt-3">
            <label htmlFor="own-min" className="block text-sm font-medium text-ink-2">
              How many minutes did it take?
            </label>
            <input
              id="own-min"
              type="number"
              inputMode="numeric"
              min={1}
              max={240}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              placeholder={`Planned: ${plannedMinutes}`}
              className="mt-1 h-12 w-40 rounded-md border border-edge bg-surface px-3 text-base text-ink placeholder:text-ink-3 focus:outline-2 focus:outline-offset-1 focus:outline-brand"
            />
          </div>
          <fieldset className="mt-4">
            <legend className="text-sm font-medium text-ink-2">How hard did it feel? (0 is rest, 10 is all out)</legend>
            <div className="mt-2 grid grid-cols-6 gap-1.5 sm:grid-cols-11">
              {Array.from({ length: 11 }, (_, n) => (
                <label key={n} className={`flex min-h-12 cursor-pointer flex-col items-center justify-center rounded-md border text-base font-bold tabular focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-brand ${rpe === n ? "border-brand bg-brand text-brand-ink" : "border-edge bg-surface text-ink hover:bg-surface-2"}`}>
                  <input type="radio" name="own-rpe" value={n} checked={rpe === n} onChange={() => setRpe(n)} className="sr-only" />
                  {n}
                  <span className="sr-only">{RPE_HINT[n] ? `, ${RPE_HINT[n]}` : ""}</span>
                </label>
              ))}
            </div>
            {rpe !== null ? (
              <button type="button" onClick={() => setRpe(null)} className="mt-1 inline-flex min-h-11 items-center text-sm font-semibold text-brand underline">
                Clear effort
              </button>
            ) : null}
          </fieldset>
          <button type="button" onClick={finish} disabled={done.length === 0} className={buttonClass("primary", "lg", "mt-4 h-14! w-full text-lg!")}>
            Finish session
          </button>
          {done.length === 0 ? <p className="mt-1.5 text-center text-xs text-ink-3">Tick at least one step to finish.</p> : null}
        </section>
      ) : (
        <p className="rounded-md border border-edge bg-surface-2 px-4 py-3 text-sm text-ink-2">Athletes tick steps and finish sessions from their own login.</p>
      )}
    </div>
  );
}

/** Sends anything still saved on the device, and says so while it is waiting. Mounted on the library page. */
export function AnywherePending() {
  const q = useAnywhereQueue();
  const router = useRouter();
  const savedCount = q.saved.length;
  useEffect(() => {
    void flushAnywhere();
  }, []);
  useEffect(() => {
    if (savedCount) router.refresh();
  }, [savedCount, router]);
  if (!q.items.length) return null;
  return (
    <div role="status" className="mb-4 rounded-md border border-warn/30 bg-warn/5 px-4 py-3 text-sm text-ink-2">
      <span className="font-semibold text-ink">
        {q.items.length} finished session{q.items.length === 1 ? " is" : "s are"} saved on this device and not sent yet.
      </span>{" "}
      {q.syncing ? "Sending now." : "It will send when you are back online."}{" "}
      <button type="button" onClick={() => void flushAnywhere()} className="inline-flex min-h-11 items-center font-semibold text-brand underline">
        Try now
      </button>
    </div>
  );
}
