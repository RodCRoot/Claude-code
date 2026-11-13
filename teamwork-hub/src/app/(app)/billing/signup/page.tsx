import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, Callout, EmptyState, PageHeader, Select } from "@/components/ui";
import { isBillingStaff } from "@/lib/billing/access";
import { payerOptions } from "@/lib/billing/queries";
import { agreementTemplateVersion } from "@/lib/agreements/issue";
import { openSignupFlows, signupCandidates } from "@/lib/signup/flow";
import { fmtDate } from "@/lib/time";
import { BillingTabs, requireBillingViewer } from "../_components";
import { startSignupAction } from "./actions";

export const metadata = { title: "Sign up" };

/** Entry to the guided sign-up: families pick the athlete; staff start it for a family and hand over the link. */
export default async function SignupIndexPage() {
  const v = await requireBillingViewer();
  const staff = isBillingStaff(v);
  const ready = !!(await agreementTemplateVersion(db, v.orgId));
  if (staff) {
    const [open, payers] = await Promise.all([openSignupFlows(db, v.orgId), payerOptions(db, v.orgId)]);
    const pairs = payers.flatMap((p) => p.athletes.map((a) => ({ value: `${a.athleteId}|${p.id}`, label: `${a.first} ${a.last} (${p.name})` }))).sort((a, b) => a.label.localeCompare(b.label));
    return (
      <>
        <PageHeader kicker="Billing" title="Sign up a member" description="Start the guided sign-up for a family, then hand them the link or QR code so they finish on their own phone. Use it for new members and for members moving over from Zen Planner." />
        <BillingTabs current="memberships" staff />
        {!ready ? (
          <Callout tone="warn" title="No membership agreement template yet" className="mb-4">
            The sign-up flow needs a published membership agreement. Create the sample one under <Link href="/settings/payments" className="underline">Settings, Payments and agreements</Link>, then replace its text with your approved language.
          </Callout>
        ) : null}
        <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
          <section aria-label="Start a sign-up" className="rounded-md border border-edge bg-surface p-4">
            <h2 className="mb-3 text-base font-bold">Start</h2>
            <ActionForm action={startSignupAction} className="space-y-3">
              <label className="block text-sm">
                <span className="mb-1 block font-semibold">Athlete and paying account</span>
                <Select name="pair" required defaultValue="" className="min-h-11">
                  <option value="" disabled>
                    Choose an athlete
                  </option>
                  {pairs.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </label>
              <p className="text-xs text-ink-3">An athlete still billed by Zen Planner gets the conversion flow: new agreement and payment method, nothing billed here until Cut over.</p>
              <SubmitButton className="min-h-11">Start or resume sign-up</SubmitButton>
            </ActionForm>
          </section>
          <section aria-label="Sign-ups in progress" className="rounded-md border border-edge bg-surface p-4">
            <h2 className="mb-3 text-base font-bold">In progress</h2>
            {open.length === 0 ? (
              <p className="text-sm text-ink-2">No sign-ups are in progress.</p>
            ) : (
              <ul className="space-y-2">
                {open.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-edge px-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <Link href={`/billing/signup/${f.id}`} className="font-semibold hover:underline">
                        {f.first} {f.last}
                      </Link>
                      <div className="text-xs text-ink-3">
                        {f.payerName} · started {fmtDate(f.createdAt)}
                      </div>
                    </div>
                    <Badge variant={f.kind === "cutover" ? "blue" : "neutral"}>{f.kind === "cutover" ? "Zen Planner conversion" : "New member"}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </>
    );
  }
  const candidates = await signupCandidates(db, v);
  return (
    <>
      <PageHeader kicker="My Profile" title="Sign up for a membership" description="Choose a plan, sign the agreement, and choose how to pay. You can stop at any step and pick up where you left off." />
      <BillingTabs current="memberships" staff={false} />
      {candidates.length === 0 ? (
        <EmptyState title="Nothing to sign up here">Only the person who pays for an athlete&apos;s account can sign them up. If that should be you, please ask the front desk.</EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          {candidates.map((c) => (
            <li key={`${c.athleteId}-${c.payerAccountId}`} className="rounded-md border border-edge bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-bold">{c.name}</h2>
                {c.state === "member" ? <Badge variant="green">Member</Badge> : c.state === "convert" ? <Badge variant="blue">Moving to Teamwork Hub</Badge> : c.state === "resume" ? <Badge variant="yellow">In progress</Badge> : null}
              </div>
              <p className="mt-1 text-sm text-ink-2">
                {c.state === "member"
                  ? "Already has a membership. To change plans, please ask the front desk."
                  : c.state === "convert"
                    ? "Sign the new membership agreement and save a payment method here. Nothing is billed here until the front desk moves the membership over, so it is never charged twice."
                    : c.state === "resume"
                      ? "Pick up where you left off."
                      : "Choose a plan to get started."}
              </p>
              {c.state === "member" ? (
                <ButtonLink href="/billing/memberships" variant="secondary" className="mt-3 min-h-11">
                  View memberships
                </ButtonLink>
              ) : c.openFlowId ? (
                <ButtonLink href={`/billing/signup/${c.openFlowId}`} className="mt-3 min-h-11">
                  Continue
                </ButtonLink>
              ) : (
                <ActionForm action={startSignupAction} className="mt-3">
                  <input type="hidden" name="athleteId" value={c.athleteId} />
                  <input type="hidden" name="payerAccountId" value={c.payerAccountId} />
                  <SubmitButton className="min-h-11">{c.state === "convert" ? "Start" : "Choose a plan"}</SubmitButton>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
