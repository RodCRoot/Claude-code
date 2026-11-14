import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, Input } from "@/components/ui";
import { redeemAction } from "./actions";

export function SetPassword({ token, kind, title }: { token: string; kind: "invite" | "reset"; title: string }) {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-edge bg-surface p-6 shadow-sm">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-ink-3">At least 12 characters with letters and numbers.</p>
        <ActionForm action={redeemAction} className="mt-4 space-y-4">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="kind" value={kind} />
          <Field label="New password" htmlFor="password">
            <Input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
          </Field>
          <Field label="Confirm password" htmlFor="confirm">
            <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} required />
          </Field>
          <SubmitButton className="w-full" size="lg">
            Save password &amp; sign in
          </SubmitButton>
        </ActionForm>
      </div>
    </main>
  );
}
