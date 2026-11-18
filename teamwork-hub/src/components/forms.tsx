"use client";

import { createContext, useActionState, useContext, useEffect, useRef, startTransition } from "react";
import { useFormStatus } from "react-dom";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./ui";
import { cn } from "@/lib/cn";

export type ActionState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  data?: Record<string, unknown>;
};

type ServerAction = (prev: ActionState, fd: FormData) => Promise<ActionState>;

const PendingContext = createContext(false);

/**
 * Form bound to a server action. Shows pending state, success message, and errors
 * (including field errors via data-field attributes on inputs).
 */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
  successMessage,
  id,
}: {
  action: ServerAction;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  successMessage?: string;
  id?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {} as ActionState);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok && resetOnSuccess) ref.current?.reset();
    // Mark invalid fields for screen readers and styling.
    const form = ref.current;
    if (!form) return;
    form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
    for (const name of Object.keys(state.fieldErrors ?? {})) {
      form.querySelector(`[name="${CSS.escape(name)}"]`)?.setAttribute("aria-invalid", "true");
    }
  }, [state, resetOnSuccess]);
  return (
    // Submit through a transition instead of the form `action` prop so React does not
    // reset the user's input when the server returns a validation error.
    <form
      ref={ref}
      className={className}
      id={id}
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
        startTransition(() => formAction(fd));
      }}
    >
      <PendingContext.Provider value={pending}>{children}</PendingContext.Provider>
      <FormMessage state={state} successMessage={successMessage} />
    </form>
  );
}

export function FormMessage({ state, successMessage }: { state: ActionState; successMessage?: string }) {
  if (state.error) {
    return (
      <div role="alert" className="mt-3 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
        {state.error}
        {state.fieldErrors && Object.keys(state.fieldErrors).length ? (
          <ul className="mt-1 list-disc pl-5 text-xs">
            {Object.entries(state.fieldErrors).map(([k, v]) => (
              <li key={k}>
                <span className="font-medium">{k}</span>: {v}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  if (state.ok && (state.message || successMessage)) {
    return (
      <div role="status" className="mt-3 rounded-lg border border-ok/30 bg-ok/5 px-3 py-2 text-sm text-ok">
        {state.message ?? successMessage}
      </div>
    );
  }
  return null;
}

export function SubmitButton({
  children,
  pendingText = "Saving…",
  variant = "primary",
  size = "md",
  className,
  name,
  value,
  confirm,
}: {
  children: React.ReactNode;
  pendingText?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  name?: string;
  value?: string;
  confirm?: string;
}) {
  const status = useFormStatus();
  const ctxPending = useContext(PendingContext);
  const pending = status.pending || ctxPending;
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      aria-busy={pending}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className={cn(buttonClass(variant, size), className)}
    >
      {pending ? pendingText : children}
    </button>
  );
}
