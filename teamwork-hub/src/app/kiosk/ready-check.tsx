"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import type { ActionState } from "@/components/forms";
import { HURT, READINESS, SLEEP_QUALITY, SORENESS, sorenessWord } from "@/lib/checkins/questions";
import { kioskReadyCheckAction } from "./actions";

export const KIOSK_IDLE_SECONDS = 25;

/**
 * Ready check on the kiosk, right after a PIN check-in: four taps, skippable, and it goes back
 * to the PIN pad by itself after 25 seconds without a tap so it never holds up the line. It
 * starts empty every time and shows nothing about anyone's earlier answers; when it closes its
 * state is thrown away (the parent remounts it per pass).
 */
export function KioskReadyCheck({ token, name, sessionTitle, onClose }: { token: string; name: string; sessionTitle: string; onClose: () => void }) {
  const [state, action, pending] = useActionState(kioskReadyCheckAction, {} as ActionState);
  const [a, setA] = useState<{ readiness?: number; sleepQuality?: number; soreness?: number; hurt?: "yes" | "no" }>({});
  const [left, setLeft] = useState(KIOSK_IDLE_SECONDS);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  // Idle countdown; any tap resets it. After a result, close quickly.
  useEffect(() => {
    const t = setInterval(() => setLeft((n) => n - 1), 1000);
    return () => clearInterval(t);
  }, []);
  const finished = !!state.ok || !!state.error;
  useEffect(() => {
    if (left <= 0) closeRef.current();
  }, [left]);
  useEffect(() => {
    if (!finished) return;
    const t = setTimeout(() => closeRef.current(), 5000);
    return () => clearTimeout(t);
  }, [finished]);
  const set = (patch: typeof a) => {
    setA((p) => ({ ...p, ...patch }));
    setLeft(KIOSK_IDLE_SECONDS);
  };
  const ready = a.readiness !== undefined && a.soreness !== undefined;
  const btn = (on: boolean) => `min-h-16 rounded-xl border text-lg font-semibold ${on ? "border-brand bg-brand text-brand-ink" : "border-edge bg-surface-2 active:bg-edge"}`;

  if (finished) {
    return (
      <section aria-live="polite" className="rounded-2xl border border-edge bg-surface p-6 text-center">
        <p className={`text-2xl font-bold ${state.ok ? "text-ok" : "text-bad"}`}>{state.ok ? state.message : state.error}</p>
        <button type="button" onClick={onClose} className="mt-4 h-14 rounded-xl border border-edge px-6 text-lg font-semibold">
          Done
        </button>
      </section>
    );
  }
  return (
    <section aria-label="Quick ready check" className="space-y-5 rounded-2xl border border-edge bg-surface p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xl font-bold text-ok">You&apos;re checked in{name ? `, ${name}` : ""}.</p>
          <h2 className="text-lg font-semibold">Quick ready check for {sessionTitle}? Four taps.</h2>
        </div>
        <button type="button" onClick={onClose} className="h-14 rounded-xl border border-edge px-6 text-lg font-semibold">
          Skip
        </button>
      </div>
      <fieldset>
        <legend className="mb-2 text-lg font-semibold">{READINESS.question}</legend>
        <div className="grid grid-cols-5 gap-2">
          {READINESS.options.map((o) => (
            <button key={o.value} type="button" aria-pressed={a.readiness === o.value} onClick={() => set({ readiness: o.value })} className={btn(a.readiness === o.value)}>
              <span aria-hidden className="block text-2xl">
                {o.face}
              </span>
              <span className="block text-xs">{o.label}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-lg font-semibold">{SLEEP_QUALITY.question}</legend>
        <div className="grid grid-cols-5 gap-2">
          {SLEEP_QUALITY.options.map((o) => (
            <button key={o.value} type="button" aria-pressed={a.sleepQuality === o.value} onClick={() => set({ sleepQuality: o.value })} className={btn(a.sleepQuality === o.value)}>
              <span className="block text-xl">{o.value}</span>
              <span className="block text-xs">{o.label}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-lg font-semibold">
          {SORENESS.preQuestion} {a.soreness !== undefined ? <span className="text-base font-normal text-ink-2">{sorenessWord(a.soreness)}</span> : <span className="text-base font-normal text-ink-3">0 not sore, 10 worst ever</span>}
        </legend>
        <div className="grid grid-cols-6 gap-2 sm:grid-cols-11">
          {Array.from({ length: 11 }, (_, n) => (
            <button key={n} type="button" aria-pressed={a.soreness === n} aria-label={`${n} of 10`} onClick={() => set({ soreness: n })} className={btn(a.soreness === n)}>
              {n}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-lg font-semibold">{HURT.preQuestion}</legend>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" aria-pressed={a.hurt === "no"} onClick={() => set({ hurt: "no" })} className={btn(a.hurt === "no")}>
            No, all good
          </button>
          <button type="button" aria-pressed={a.hurt === "yes"} onClick={() => set({ hurt: "yes" })} className={btn(a.hurt === "yes")}>
            {HURT.preToggle}
          </button>
        </div>
        {a.hurt === "yes" ? <p className="mt-2 rounded-lg bg-warn/10 px-3 py-2 text-base font-medium">Please tell your coach before you start.</p> : null}
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-3" aria-live="off">
          Back to the PIN pad in {Math.max(left, 0)} s
        </p>
        <button
          type="button"
          disabled={!ready || pending}
          onClick={() => {
            const fd = new FormData();
            fd.set("token", token);
            fd.set("readiness", String(a.readiness));
            if (a.sleepQuality !== undefined) fd.set("sleepQuality", String(a.sleepQuality));
            fd.set("soreness", String(a.soreness));
            if (a.hurt) fd.set("hurt", a.hurt);
            startTransition(() => action(fd));
          }}
          className="h-16 min-w-40 rounded-xl bg-brand px-8 text-xl font-bold text-brand-ink disabled:opacity-50"
        >
          {pending ? "Saving…" : "Done"}
        </button>
      </div>
    </section>
  );
}
