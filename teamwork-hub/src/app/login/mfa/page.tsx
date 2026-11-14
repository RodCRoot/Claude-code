import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, Input } from "@/components/ui";
import { mfaAction } from "@/lib/auth/actions";
import { getPendingMfaUser } from "@/lib/auth/viewer";

export const metadata = { title: "Verify sign-in" };

export default async function MfaPage() {
  const user = await getPendingMfaUser();
  if (!user) redirect("/login");
  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-edge bg-surface p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Two-step verification</h1>
        <p className="mt-1 text-sm text-ink-3">Enter the 6-digit code from your authenticator app.</p>
        <ActionForm action={mfaAction} className="mt-4 space-y-4">
          <Field label="Code" htmlFor="code">
            <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required autoFocus />
          </Field>
          <SubmitButton className="w-full" size="lg" pendingText="Verifying…">
            Verify
          </SubmitButton>
        </ActionForm>
      </div>
    </main>
  );
}
