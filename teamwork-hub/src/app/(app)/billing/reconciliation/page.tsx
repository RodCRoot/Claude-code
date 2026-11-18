import Link from "next/link";
import { db } from "@/db";
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, PageHeader, Stat, StatusBadge, Table, Td, Th } from "@/components/ui";
import { reconciliationData } from "@/lib/billing/reconciliation";
import { fmt, fmtDate } from "@/lib/time";
import { BillingTabs, METHOD_LABEL, Money, PROVIDER_LABEL, requireBillingStaff, VerificationBadge } from "../_components";

export const metadata = { title: "Reconciliation" };

export default async function ReconciliationPage() {
  const v = await requireBillingStaff();
  const d = await reconciliationData(db, v.orgId);
  const t = d.totals;
  return (
    <>
      <PageHeader kicker="Billing" title="Reconciliation" description="Invoices vs. ledger vs. provider events. Provider-verified money is confirmed by signed webhooks; staff-attested money was recorded by a person." />
      <BillingTabs current="reconciliation" staff />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Settled · provider verified" value={<Money minor={t.settledVerified} />} tone="ok" />
        <Stat label="Settled · staff attested" value={<Money minor={t.settledAttested} />} />
        <Stat label="Pending · not settled" value={<Money minor={t.pendingIn} />} tone={t.pendingIn ? "warn" : undefined} />
        <Stat label="Refunded" value={<Money minor={t.refunded} />} />
        <Stat label="Disputed (net)" value={<Money minor={t.disputedNet} />} tone={t.disputedNet ? "bad" : undefined} />
      </div>

      {d.mismatches.length ? (
        <Callout tone="bad" title="Invoice / ledger mismatches" className="mt-6">
          <ul className="list-disc pl-5">
            {d.mismatches.map((m) => <li key={m.id}><Link className="underline" href={`/billing/invoices/${m.id}`}>{m.number}</Link> {m.problem}</li>)}
          </ul>
        </Callout>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader title="Collections by method" />
          <CardBody>
            <Table caption="By method">
              <thead><tr><Th>Provider · method</Th><Th>Verification</Th><Th>Status</Th><Th align="right">Count</Th><Th align="right">Total</Th></tr></thead>
              <tbody>
                {d.byMethod.map((r, i) => (
                  <tr key={i}>
                    <Td>{PROVIDER_LABEL[r.provider] ?? r.provider} · {METHOD_LABEL[r.method] ?? r.method}</Td>
                    <Td><VerificationBadge verification={r.verification} /></Td>
                    <Td><StatusBadge status={r.status} /></Td>
                    <Td align="right">{r.n}</Td>
                    <Td align="right"><Money minor={r.total} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={`Pending payments (alert after ${d.pendingAlertDays} days)`} />
          <CardBody>
            {d.pending.length === 0 ? <EmptyState title="Nothing pending" /> : (
              <ul className="divide-y divide-edge text-sm">
                {d.pending.map((p) => (
                  <li key={String(p.id)} className="flex flex-wrap justify-between gap-2 py-2">
                    <span>
                      {p.invoice_id ? <Link className="underline" href={`/billing/invoices/${p.invoice_id}`}>{String(p.number)}</Link> : "—"} · {PROVIDER_LABEL[String(p.provider)]} {METHOD_LABEL[String(p.method_type)] ?? ""} · since {fmt(p.occurred_at as Date)}
                    </span>
                    <span className="flex items-center gap-2">{p.overdue ? <Badge variant="red">overdue</Badge> : <Badge variant="yellow">pending</Badge>}<Money minor={Number(p.amount_minor)} /></span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Open / failed checkout attempts" />
          <CardBody>
            {d.attempts.length === 0 ? <EmptyState title="None" /> : (
              <ul className="divide-y divide-edge text-sm">
                {d.attempts.map((a) => (
                  <li key={a.id} className="py-2">
                    <Link className="underline" href={`/billing/invoices/${a.invoiceId}`}>{PROVIDER_LABEL[a.provider]} attempt</Link> · <StatusBadge status={a.status} /> · <Money minor={a.amountMinor} currency={a.currency} />
                    {a.failureCode ? <div className="text-xs text-bad">{a.failureCode}: {a.failureMessage}</div> : null}
                    <div className="text-xs text-ink-3">updated {fmt(a.updatedAt)}</div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Provider webhook events" kicker="Unmatched / rejected / failed events need review" />
          <CardBody>
            {d.webhooks.length === 0 ? <EmptyState title="No webhook events yet">Events appear once a provider is configured and sends to /api/webhooks/stripe or /api/webhooks/paypal.</EmptyState> : (
              <ul className="divide-y divide-edge text-sm">
                {d.webhooks.map((w) => (
                  <li key={String(w.id)} className="py-2">
                    <span className="font-medium">{String(w.provider)} · {String(w.type)}</span> <StatusBadge status={String(w.status)} />
                    {!w.signature_verified ? <Badge variant="red" className="ml-1">unverified</Badge> : null}
                    {!w.org_id ? <Badge className="ml-1">unmatched</Badge> : null}
                    <div className="text-xs text-ink-3">{fmt(w.received_at as Date)} · attempts {String(w.attempts)}{w.error ? ` · ${String(w.error)}` : ""}</div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Refunds" />
          <CardBody>
            {d.refunds.length === 0 ? <EmptyState title="No refunds" /> : (
              <ul className="divide-y divide-edge text-sm">
                {d.refunds.map((r) => (
                  <li key={String(r.id)} className="py-2">
                    <Link className="underline" href={`/billing/invoices/${r.invoice_id}`}>{String(r.number)}</Link> · <Money minor={Number(r.amount_minor)} /> · <StatusBadge status={String(r.status)} />
                    <div className="text-xs text-ink-3">{String(r.reason ?? "")}</div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Disputes & payouts" />
          <CardBody className="space-y-4">
            {d.disputes.length === 0 ? <p className="text-sm text-ink-3">No disputes.</p> : (
              <ul className="space-y-1 text-sm">
                {d.disputes.map((x) => <li key={String(x.id)}>{String(x.provider)} · <Money minor={Number(x.amount_minor)} /> · {String(x.status)} · {String(x.reason ?? "")}{x.evidence_due_by ? ` · evidence due ${fmt(x.evidence_due_by as Date, "MMM d")}` : ""}</li>)}
              </ul>
            )}
            {d.payouts.length === 0 ? <p className="text-sm text-ink-3">No payouts recorded (they arrive via payout.paid webhooks once Stripe is connected).</p> : (
              <ul className="space-y-1 text-sm">
                {d.payouts.map((p) => <li key={p.id}>{p.provider} · <Money minor={p.amountMinor} currency={p.currency} /> · {p.status} · arrives {fmtDate(p.arrivalDate)}</li>)}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
