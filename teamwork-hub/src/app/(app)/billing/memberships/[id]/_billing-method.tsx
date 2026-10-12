import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, Field, Input, NotConfigured } from "@/components/ui";
import type { billingMethodView } from "@/lib/billing/subscriptions";
import { formatMoney } from "@/lib/money";
import { fmtDate } from "@/lib/time";
import { startSubscriptionAction, switchToTeamworkAction } from "../../actions";

type View = Awaited<ReturnType<typeof billingMethodView>>;

const LABEL = { manual: "Teamwork invoices", stripe: "Stripe subscription", paypal: "PayPal subscription" } as const;

/**
 * Staff choose how a membership is billed. Exactly one system bills it at a time: switching to a provider
 * only takes effect when the provider's verified webhook confirms the subscription, and the first provider
 * charge is scheduled for the next Teamwork bill date.
 */
export function BillingMethodCard({ view }: { view: View }) {
  const { m, open, switchScheduled, providers, checklist } = view;
  const current = m.billingProvider === "stripe" || m.billingProvider === "paypal" ? m.billingProvider : "manual";
  const providerBilled = current !== "manual";
  return (
    <Card className="mt-6">
      <CardHeader title="Billing method" />
      <CardBody className="space-y-4">
        <p className="text-sm text-ink-3">Who charges this membership each period. Only one system can bill it at a time.</p>
        <p className="text-sm">
          Currently: <Badge variant="brand">{LABEL[current]}</Badge>
          {providerBilled && m.providerSubscriptionId ? <span className="ml-2 text-xs text-ink-3">subscription {m.providerSubscriptionId}</span> : null}
        </p>

        {open ? (
          <Callout tone="info" title={`${open.details.provider === "stripe" ? "Stripe" : "PayPal"} subscription waiting for the payer`}>
            <p>
              {formatMoney(open.details.amountMinor, open.details.currency)} per period, first provider charge {fmtDate(open.details.firstChargeDate)}. Nothing changes here until {open.details.provider === "stripe" ? "Stripe" : "PayPal"} confirms the subscription through a verified webhook; until then Teamwork keeps invoicing.
            </p>
            {open.details.approvalUrl ? (
              <p className="mt-2 break-all">
                Payer approval link: <a href={open.details.approvalUrl} className="underline" target="_blank" rel="noreferrer">{open.details.approvalUrl}</a>
              </p>
            ) : (
              <p className="mt-2">The approval link is still being created.</p>
            )}
          </Callout>
        ) : null}
        {switchScheduled ? (
          <Callout tone="info" title="Switching back to Teamwork invoices">
            The provider subscription stops at the end of its paid period. Teamwork invoices resume from {fmtDate(switchScheduled)} once the provider confirms the subscription ended.
          </Callout>
        ) : null}

        <div className="grid gap-4 md:grid-cols-3 [&>*]:min-w-0">
          <div className="rounded-lg border border-edge p-3">
            <h3 className="font-medium">Teamwork invoices</h3>
            <p className="mt-1 text-xs text-ink-3">Teamwork issues an invoice each period; the payer pays online (card/bank via Stripe, PayPal, Venmo one-time) or offline at the desk.</p>
            {current === "manual" && !open ? <p className="mt-2 text-sm">In use.</p> : null}
            {(providerBilled && !switchScheduled) || (open && !providerBilled) ? (
              <ActionForm action={switchToTeamworkAction} className="mt-2 space-y-2">
                <input type="hidden" name="membershipId" value={m.id} />
                <Field label="Reason" htmlFor="swr"><Input id="swr" name="reason" placeholder="e.g. family prefers invoices" /></Field>
                <SubmitButton size="sm" variant="secondary" confirm={open && !providerBilled ? "Withdraw the open subscription request?" : "Stop the provider subscription at period end and resume Teamwork invoices?"}>
                  {open && !providerBilled ? "Withdraw request" : "Switch to Teamwork invoices"}
                </SubmitButton>
              </ActionForm>
            ) : null}
          </div>
          {providers.map((p) => (
            <div key={p.name} className="rounded-lg border border-edge p-3">
              <h3 className="font-medium">{p.label}</h3>
              <p className="mt-1 text-xs text-ink-3">
                {p.name === "stripe"
                  ? "Stripe Billing charges the saved card or US bank account (ACH) each period via a hosted Checkout page."
                  : "PayPal Subscriptions charges the payer's PayPal account (or card through PayPal) each period after they approve it on PayPal."}
              </p>
              {current === p.name ? (
                <p className="mt-2 text-sm">In use.</p>
              ) : !p.configured ? (
                <div className="mt-2">
                  <NotConfigured provider={p.label} envVars={p.missing}>Not available yet. Nothing can be created or charged.</NotConfigured>
                </div>
              ) : providerBilled || open ? null : (
                <ActionForm action={startSubscriptionAction} className="mt-2">
                  <input type="hidden" name="membershipId" value={m.id} />
                  <input type="hidden" name="provider" value={p.name} />
                  <SubmitButton size="sm" pendingText="Creating approval link…" confirm={`Create a ${p.label} approval link for the payer? Teamwork stops invoicing only after the provider confirms it.`}>
                    Create approval link
                  </SubmitButton>
                </ActionForm>
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-ink-3">Venmo is offered for one-time invoice payments only. Recurring Venmo is not offered: PayPal does not document Venmo for subscriptions.</p>

        <details className="text-sm" open={!providerBilled && !open}>
          <summary className="cursor-pointer font-medium">Cutover checklist</summary>
          <ol className="mt-2 space-y-1.5">
            {checklist.map((c) => (
              <li key={c.label} className="flex gap-2">
                <span aria-hidden className="w-4 shrink-0">{c.ok === true ? "✓" : c.ok === false ? "✗" : "?"}</span>
                <span>
                  <span className="sr-only">{c.ok === true ? "Done: " : c.ok === false ? "Not done: " : "Check manually: "}</span>
                  {c.label}
                  {c.detail ? <span className="block text-xs text-ink-3">{c.detail}</span> : null}
                </span>
              </li>
            ))}
            <li className="flex gap-2"><span aria-hidden className="w-4 shrink-0">?</span><span>Send the approval link to the payer; confirm the membership shows the provider as “In use” (set by the verified webhook) before telling the family they are switched.</span></li>
            <li className="flex gap-2"><span aria-hidden className="w-4 shrink-0">?</span><span>After the first provider charge, confirm one paid invoice and one credit grant appear here for that period (Reconciliation shows any mismatch).</span></li>
          </ol>
        </details>
      </CardBody>
    </Card>
  );
}
