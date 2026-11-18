"use client";

import { useActionState } from "react";
import { FormMessage, SubmitButton, type ActionState } from "@/components/forms";

type Action = (prev: ActionState, fd: FormData) => Promise<ActionState>;

/** Form that shows a one-time link returned by the action (invite / password reset). */
export function OneTimeLinkForm({ action, children, submitLabel, size = "md" }: { action: Action; children?: React.ReactNode; submitLabel: string; size?: "sm" | "md" }) {
  const [state, formAction] = useActionState(action, {} as ActionState);
  const link = state.data?.link as string | undefined;
  return (
    <form action={formAction} className="space-y-3">
      {children}
      <SubmitButton size={size}>{submitLabel}</SubmitButton>
      <FormMessage state={state} />
      {link ? (
        <div className="rounded-lg border border-edge bg-surface-2 p-2">
          <label className="sr-only" htmlFor="one-time-link">
            One-time link
          </label>
          <input id="one-time-link" readOnly value={link} className="w-full bg-transparent font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        </div>
      ) : null}
    </form>
  );
}
