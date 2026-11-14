"use client";

import { createContext, startTransition, useActionState, useContext, useEffect, useRef } from "react";
import { FormMessage, type ActionState } from "@/components/forms";
import { buttonClass, type ButtonSize, type ButtonVariant } from "@/components/ui";
import { cn } from "@/lib/cn";

type ServerAction = (prev: ActionState, fd: FormData) => Promise<ActionState>;

const PendingCtx = createContext(false);

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * Like <ActionForm>, but submits via onSubmit + startTransition so React does NOT
 * auto-reset the form after the action returns — a validation error keeps everything
 * the person typed. Optionally carries a client mutation id (`withMutationId`) that is
 * regenerated after each completed attempt, so double-submits are deduped server-side.
 */
export function StableForm({
  action,
  children,
  className,
  resetOnSuccess = false,
  withMutationId = false,
}: {
  action: ServerAction;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  withMutationId?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {} as ActionState);
  const ref = useRef<HTMLFormElement>(null);
  const idRef = useRef<HTMLInputElement>(null);
  const handled = useRef<ActionState | null>(null);

  useEffect(() => {
    if (idRef.current && !idRef.current.value) idRef.current.value = newId();
  }, []);
  useEffect(() => {
    if (handled.current === state) return;
    handled.current = state;
    const form = ref.current;
    if (!form) return;
    if (state.ok && resetOnSuccess) form.reset();
    if (idRef.current) idRef.current.value = newId();
    form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
    for (const name of Object.keys(state.fieldErrors ?? {})) form.querySelector(`[name="${CSS.escape(name)}"]`)?.setAttribute("aria-invalid", "true");
  }, [state, resetOnSuccess]);

  return (
    <form
      ref={ref}
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        if (pending) return;
        const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
        startTransition(() => formAction(fd));
      }}
    >
      {withMutationId ? <input ref={idRef} type="hidden" name="clientMutationId" defaultValue="" /> : null}
      <PendingCtx.Provider value={pending}>{children}</PendingCtx.Provider>
      <FormMessage state={state} />
    </form>
  );
}

export function StableSubmit({
  children,
  pendingText = "Saving…",
  variant = "primary",
  size = "md",
  className,
  confirm,
}: {
  children: React.ReactNode;
  pendingText?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  confirm?: string;
}) {
  const pending = useContext(PendingCtx);
  return (
    <button
      type="submit"
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
