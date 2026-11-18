import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, Input } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { kioskExitAction } from "../actions";

export default async function KioskExitPage() {
  const v = await requireViewer();
  if (v.role !== "kiosk") redirect("/schedule");
  return (
    <div className="mx-auto max-w-sm rounded-2xl border border-edge bg-surface p-6">
      <h1 className="text-lg font-semibold">Exit kiosk mode</h1>
      <p className="mt-1 text-sm text-ink-3">A staff member must sign in to close the kiosk. This signs the kiosk out on this device.</p>
      <ActionForm action={kioskExitAction} className="mt-4 space-y-4">
        <Field label="Staff email" htmlFor="ke-email">
          <Input id="ke-email" name="email" type="email" autoComplete="off" required className="h-12" />
        </Field>
        <Field label="Password" htmlFor="ke-pw">
          <Input id="ke-pw" name="password" type="password" autoComplete="off" required className="h-12" />
        </Field>
        <SubmitButton size="lg" className="w-full" pendingText="Checking…">
          Exit kiosk
        </SubmitButton>
      </ActionForm>
      <Link href="/kiosk" className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-brand">
        ← Back to check-in
      </Link>
    </div>
  );
}
