"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import type { ActionState } from "@/components/forms";
import { kioskPinCheckInAction } from "./actions";

type Row = { title: string; time: string; result: "checked_in" | "already_checked_in" | "not_open_yet" | "ended" | "see_front_desk" };
const RESULT: Record<Row["result"], string> = {
  checked_in: "✓ Checked in",
  already_checked_in: "✓ Already checked in",
  not_open_yet: "Check-in opens 1 hour before",
  ended: "Session has ended",
  see_front_desk: "Please see the front desk",
};
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"] as const;

/** Big-button PIN entry for the kiosk. The PIN is never shown; after a match only "First L." appears. */
export function KioskPinPad({ bare = false }: { bare?: boolean }) {
  const [state, action, pending] = useActionState(kioskPinCheckInAction, {} as ActionState);
  const [pin, setPin] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Hide the greeting after a short while so the next person in line doesn't see it.
  const [hidden, setHidden] = useState<ActionState | null>(null);
  useEffect(() => {
    if (!state.ok && !state.error) return;
    const t = setTimeout(() => setHidden(state), 12_000);
    return () => clearTimeout(t);
  }, [state]);
  const shown: ActionState = hidden === state ? {} : state;
  const rows = (shown.data?.sessions as Row[] | undefined) ?? [];
  const alerts = (shown.data?.alerts as string[] | undefined) ?? [];

  const press = (k: (typeof KEYS)[number]) => {
    if (k === "clear") setPin("");
    else if (k === "back") setPin((p) => p.slice(0, -1));
    else setPin((p) => (p.length < 6 ? p + k : p));
    inputRef.current?.focus();
  };

  return (
    <section aria-label="Check in with your PIN" className={bare ? "p-2" : "rounded-2xl border border-edge bg-surface p-4 sm:p-6"}>
      {bare ? null : <h2 className="text-xl font-bold">Check in with your PIN</h2>}
      <form
        className={bare ? "space-y-4" : "mt-4 space-y-4"}
        aria-busy={pending}
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData();
          fd.set("pin", pin);
          setPin(""); // never leave a PIN on screen after an attempt
          startTransition(() => action(fd));
        }}
      >
        <label htmlFor="kiosk-pin" className="sr-only">
          PIN
        </label>
        <input
          ref={inputRef}
          id="kiosk-pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]*"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="••••"
          className="h-16 w-full rounded-xl border border-edge bg-surface px-4 text-center text-3xl tracking-[0.5em] focus:outline-2 focus:outline-brand"
        />
        <div className="grid grid-cols-3 gap-2" role="group" aria-label="Number pad">
          {KEYS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => press(k)}
              className="h-16 rounded-xl border border-edge bg-surface-2 text-2xl font-semibold active:bg-edge"
              aria-label={k === "clear" ? "Clear" : k === "back" ? "Delete last digit" : k}
            >
              {k === "clear" ? "C" : k === "back" ? "⌫" : k}
            </button>
          ))}
        </div>
        <button type="submit" disabled={pending || pin.length < 4} className="h-16 w-full rounded-xl bg-brand text-xl font-bold text-brand-ink disabled:opacity-50">
          {pending ? "Checking…" : "Check in"}
        </button>
      </form>
      <div aria-live="polite" className="mt-4">
        {shown.error ? (
          <p role="alert" className="rounded-xl border border-bad/30 bg-bad/5 px-4 py-3 text-lg text-bad">
            {shown.error}
          </p>
        ) : shown.ok ? (
          <div className="space-y-2 rounded-xl border border-ok/30 bg-ok/5 px-4 py-3">
            <p className="text-xl font-bold text-ok">{shown.message}</p>
            {alerts.map((m, i) => (
              <p key={i} className="rounded-md bg-warn/10 px-2 py-1 text-base font-medium text-warn" role="note">
                {m}
              </p>
            ))}
            {rows.length ? (
              <ul className="space-y-1 text-base">
                {rows.map((r, i) => (
                  <li key={i} className="flex flex-wrap justify-between gap-2">
                    <span>
                      {r.title} <span className="text-ink-3">{r.time}</span>
                    </span>
                    <span className="font-semibold">{RESULT[r.result]}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
