"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import type { ActionState } from "@/components/forms";
import { kioskStaffClockAction } from "../actions";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"] as const;

/** Staff PIN pad: one PIN entry toggles clock in / clock out. The PIN is never shown or kept on screen. */
export function StaffClockPad() {
  const [state, action, pending] = useActionState(kioskStaffClockAction, {} as ActionState);
  const [pin, setPin] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [hidden, setHidden] = useState<ActionState | null>(null);
  useEffect(() => {
    if (!state.ok && !state.error) return;
    const t = setTimeout(() => setHidden(state), 10_000);
    return () => clearTimeout(t);
  }, [state]);
  const shown: ActionState = hidden === state ? {} : state;
  const press = (k: (typeof KEYS)[number]) => {
    if (k === "clear") setPin("");
    else if (k === "back") setPin((p) => p.slice(0, -1));
    else setPin((p) => (p.length < 6 ? p + k : p));
    inputRef.current?.focus();
  };
  return (
    <section aria-label="Staff time clock" className="rounded-2xl border border-edge bg-surface p-4 sm:p-6">
      <form
        className="space-y-4"
        aria-busy={pending}
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData();
          fd.set("pin", pin);
          setPin("");
          startTransition(() => action(fd));
        }}
      >
        <label htmlFor="staff-pin" className="sr-only">
          Staff PIN
        </label>
        <input
          ref={inputRef}
          id="staff-pin"
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
          {pending ? "Working…" : "Clock in / out"}
        </button>
      </form>
      <div aria-live="polite" className="mt-4">
        {shown.error ? (
          <p role="alert" className="rounded-xl border border-bad/30 bg-bad/5 px-4 py-3 text-lg text-bad">
            {shown.error}
          </p>
        ) : shown.ok ? (
          <p className="rounded-xl border border-ok/30 bg-ok/5 px-4 py-3 text-xl font-bold text-ok">{shown.message}</p>
        ) : null}
      </div>
    </section>
  );
}
