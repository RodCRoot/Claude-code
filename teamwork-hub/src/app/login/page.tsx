import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, Input } from "@/components/ui";
import { loginAction } from "@/lib/auth/actions";
import { getViewer } from "@/lib/auth/viewer";
import { isDemoMode } from "@/lib/env";
import { TrainingOfflinePurge } from "@/components/training-offline";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getViewer()) redirect("/today");
  const demo = isDemoMode() && process.env.NODE_ENV !== "production";
  return (
    <main id="main" className="flex min-h-screen items-center justify-center px-4 py-10">
      {/* Signed out: no saved training data or training service worker may remain on this device. */}
      <TrainingOfflinePurge />
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-6 block text-center text-2xl font-bold tracking-tight">
          Teamwork <span className="text-brand">Hub</span>
        </Link>
        <div className="rounded-2xl border border-edge bg-surface p-6 shadow-sm">
          <h1 className="mb-4 text-lg font-semibold">Sign in</h1>
          <ActionForm action={loginAction} className="space-y-4">
            <Field label="Email" htmlFor="email">
              <Input id="email" name="email" type="email" autoComplete="username" required />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input id="password" name="password" type="password" autoComplete="current-password" required />
            </Field>
            <SubmitButton className="w-full" size="lg" pendingText="Signing in…">
              Sign in
            </SubmitButton>
          </ActionForm>
          <p className="mt-4 text-center text-xs text-ink-3">
            Forgot your password? Ask the front desk to send a reset link.
          </p>
        </div>
        {demo ? (
          <p className="mt-4 text-center text-sm">
            <Link href="/dev/switch" className="font-medium text-brand underline">
              Demo mode: sign in as a sample user
            </Link>
          </p>
        ) : null}
      </div>
    </main>
  );
}
