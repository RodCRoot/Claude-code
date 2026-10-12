import { Badge, Callout, Card, CardBody, CardHeader, NotConfigured, PageHeader, Table, Td, Th } from "@/components/ui";
import { env } from "@/lib/env";
import { providerStatuses } from "@/lib/payments";
import type { Capability, ProviderCapabilities } from "@/lib/payments/provider";
import { BillingTabs, requireBillingStaff } from "../_components";

export const metadata = { title: "Payment providers" };

const ROWS: { key: keyof ProviderCapabilities; label: string }[] = [
  { key: "oneTimeCheckout", label: "One-time hosted checkout" },
  { key: "recurring", label: "Recurring memberships" },
  { key: "savedMethods", label: "Saved payment methods" },
  { key: "bankDebit", label: "Bank debit (pending → settled)" },
  { key: "refundsViaApi", label: "Refunds via API" },
  { key: "disputesViaWebhook", label: "Disputes via webhook" },
  { key: "webhookVerification", label: "Webhook verification" },
];

const EVIDENCE: Record<string, { label: string; variant: "green" | "yellow" | "red" | "neutral" }> = {
  verified_docs: { label: "verified in docs", variant: "green" },
  partially_verified: { label: "partially verified", variant: "yellow" },
  unverified: { label: "unverified", variant: "red" },
  not_supported: { label: "n/a", variant: "neutral" },
};

function Cell({ c }: { c: Capability }) {
  const mark = c.supported === true ? "Yes" : c.supported === false ? "No" : "Unknown";
  const e = EVIDENCE[c.evidence];
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`font-semibold ${c.supported === true ? "text-ok" : c.supported === false ? "text-ink-3" : "text-warn"}`}>{mark}</span>
        <Badge variant={e.variant}>{e.label}</Badge>
      </div>
      <p className="text-xs text-ink-3">{c.note}</p>
      {c.source ? <a className="text-xs underline" href={c.source} target="_blank" rel="noreferrer">source</a> : null}
    </div>
  );
}

export default async function ProvidersPage() {
  await requireBillingStaff();
  const list = providerStatuses();
  const appUrl = env().APP_URL;
  return (
    <>
      <PageHeader kicker="Billing" title="Payment providers" description="Capabilities as researched from official provider docs (evidence level shown per cell), plus this server's configuration status. Only environment variable names are shown — never values." />
      <BillingTabs current="providers" staff />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4 [&>*]:min-w-0">
        {list.map((p) => (
          <Card key={p.name}>
            <CardHeader title={p.capabilities.label} action={p.name === "manual" ? <Badge variant="green">always available</Badge> : p.configured ? <Badge variant="green">configured</Badge> : <Badge variant="yellow">not configured</Badge>} />
            <CardBody className="space-y-2 text-sm">
              <p>Currencies: {p.capabilities.currencies.join(", ")} · {p.capabilities.regions}</p>
              {p.name !== "manual" && !p.configured ? <NotConfigured provider={p.capabilities.label} envVars={p.missing}>Checkout, refunds and webhook verification are disabled. Nothing will be sent or charged.</NotConfigured> : null}
              {p.capabilities.envVars.length ? <p className="flex flex-wrap gap-1 text-xs text-ink-3">Env vars: {p.capabilities.envVars.map((e) => <code key={e} className="break-all rounded bg-surface-2 px-1">{e}</code>)}</p> : null}
            </CardBody>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader title="Capability matrix" />
        <CardBody>
          <Table caption="Provider capability matrix" className="[&_table]:min-w-[900px]">
            <thead><tr><Th>Capability</Th>{list.map((p) => <Th key={p.name}>{p.capabilities.label}</Th>)}</tr></thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.key}>
                  <Td className="align-top font-medium">{r.label}</Td>
                  {list.map((p) => <Td key={p.name} className="align-top"><Cell c={p.capabilities[r.key] as Capability} /></Td>)}
                </tr>
              ))}
            </tbody>
          </Table>
        </CardBody>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader title="Recurring memberships: what to use" />
          <CardBody className="space-y-2 text-sm">
            <p><strong>Venmo is not offered for recurring memberships.</strong> Pay with Venmo is documented for one-time checkout (US, USD, Venmo app). “Save Venmo for purchase later” is listed as not supported and Venmo is not documented for PayPal Subscriptions, so we treat recurring Venmo as unverified.</p>
            <p>Verified recurring alternatives: <strong>Stripe Billing</strong> (card or ACH Direct Debit) or <strong>PayPal Subscriptions</strong>. Until a provider subscription integration is enabled, memberships are invoiced by Teamwork Hub each period and can be paid online (one-time checkout) or offline.</p>
            <p>A personal Venmo QR code or screenshot is <em>never</em> provider verification — staff record it as an offline payment (staff attested) with a reference.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Webhook endpoints to register" />
          <CardBody className="space-y-2 text-sm">
            <p>Stripe: <code className="break-all">{appUrl}/api/webhooks/stripe</code></p>
            <p className="text-xs text-ink-3">Events: checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed, checkout.session.expired, invoice.paid, invoice.payment_failed, charge.refunded, charge.dispute.created, charge.dispute.closed, payout.paid.</p>
            <p>PayPal / Venmo: <code className="break-all">{appUrl}/api/webhooks/paypal</code></p>
            <p className="text-xs text-ink-3">Events: PAYMENT.CAPTURE.COMPLETED / PENDING / DENIED / REFUNDED, CUSTOMER.DISPUTE.CREATED / RESOLVED.</p>
            <Callout tone="info">Signed events only. Duplicates are acknowledged and ignored; out-of-order events never move a payment backwards; amount/currency mismatches are flagged and never granted.</Callout>
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Zen Planner cutover plan (no double billing)" />
          <CardBody className="text-sm">
            <ol className="list-decimal space-y-1 pl-5">
              <li>Imported memberships are <code>billing_provider = external_zenplanner</code>. Teamwork Hub never invoices, charges, renews or cancels them — Zen Planner keeps billing.</li>
              <li>Connect Stripe (and optionally PayPal) in sandbox; verify webhooks end to end with test events.</li>
              <li>Pick a cutover date per member aligned to their Zen Planner billing date. Stop the Zen Planner recurring charge first, confirm it is stopped.</li>
              <li>Then switch that membership here to Teamwork invoicing (or a provider subscription) with its next bill date = the first date Zen Planner will no longer bill.</li>
              <li>Card data cannot be exported by us; payers re-enter payment details on hosted checkout (or arrange a processor-to-processor PAN migration through Stripe’s migrations team — see docs).</li>
            </ol>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
