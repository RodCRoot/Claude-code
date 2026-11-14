"use client";

import { useActionState } from "react";
import { ActionForm, FormMessage, SubmitButton, type ActionState } from "@/components/forms";
import { Field, Input } from "@/components/ui";
import { beginMfaAction, confirmMfaAction } from "../actions";

export function MfaEnroll() {
  const [state, start] = useActionState(beginMfaAction as unknown as (p: ActionState, fd: FormData) => Promise<ActionState>, {} as ActionState);
  const secret = state.data?.secret as string | undefined;
  const svg = state.data?.svg as string | undefined;
  return (
    <div className="space-y-4 text-sm">
      {!secret ? (
        <form action={start}>
          <p className="mb-3 text-ink-2">Use an authenticator app (1Password, Google Authenticator, Authy, Microsoft Authenticator).</p>
          <SubmitButton>Set up two-step verification</SubmitButton>
          <FormMessage state={state} />
        </form>
      ) : (
        <>
          <ol className="list-decimal space-y-1 pl-5 text-ink-2">
            <li>Scan this QR code with your authenticator app.</li>
            <li>Or enter this key manually: <code className="break-all rounded bg-surface-2 px-1">{secret}</code></li>
            <li>Enter the 6-digit code it shows.</li>
          </ol>
          {svg ? <div className="w-48 rounded-lg bg-white p-2" aria-label="QR code for authenticator app" role="img" dangerouslySetInnerHTML={{ __html: svg }} /> : null}
          <ActionForm action={confirmMfaAction} className="space-y-3">
            <Field label="6-digit code" htmlFor="mfa-code">
              <Input id="mfa-code" name="code" inputMode="numeric" autoComplete="one-time-code" required className="w-40" />
            </Field>
            <SubmitButton>Turn on</SubmitButton>
          </ActionForm>
        </>
      )}
    </div>
  );
}
