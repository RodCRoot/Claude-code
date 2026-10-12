import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, Callout, Card, CardBody, CardHeader, Field, Input, NotConfigured, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { can } from "@/lib/authz/policy";
import { MANUAL_METHODS } from "@/lib/billing/invoices";
import { invoiceDetail } from "@/lib/billing/queries";
import { formatMoney } from "@/lib/money";
import { providerStatuses } from "@/lib/payments";
import { fmt, fmtDate, todayLocal } from "@/lib/time";
import { issueInvoiceAction, recordPaymentAction, refundAction, startCheckoutAction, uncollectibleAction, voidInvoiceAction } from "../../actions";
import { BillingTabs, InvoiceStatus, METHOD_LABEL, Money, PROVIDER_LABEL, requireBillingViewer, TxnStatus, VerificationBadge } from "../../_components";

export const metadata = { title: "Invoice" };

export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ checkout?: string; attempt?: string }> }) {
  const v = await requireBillingViewer();
  const { id } = await params;
  const sp = await searchParams;
  const d = await invoiceDetail(db, v, id).catch(() => null);
  if (!d || (!d.staff && d.invoice.status === "draft")) notFound();
  const { invoice: inv, money } = d;
  const today = todayLocal();
  const providers = providerStatuses().filter((p) => p.name !== "manual");
  const latest = d.attempts[0];
  const returned = sp.checkout === "returned";
  const canPayOnline = d.canPay && inv.status === "open" && money.balanceMinor > 0 && money.pendingMinor === 0;
  return (
    <>
      <PageHeader
        kicker={`Invoice · ${d.payer.name}`}
        title={inv.number}
        description={inv.memo ?? undefined}
        actions={
          <>
            <InvoiceStatus status={inv.status} dueDate={inv.dueDate} today={today} />
            <ButtonLink href={`/billing/invoices/${inv.id}/receipt`} variant="secondary" size="sm">{inv.status === "paid" ? "Receipt" : "Printable invoice"}</ButtonLink>
          </>
        }
      />
      <BillingTabs current="invoices" staff={d.staff} />

      {returned && inv.status !== "paid" ? (
        <Callout tone="info" title="We're confirming your payment" className="mb-4">
          {latest?.status === "processing" || money.pendingMinor > 0
            ? "Your bank payment is processing. Bank (ACH) payments can take a few business days; we'll mark this invoice paid when the provider confirms it."
            : latest?.status === "failed"
              ? "The provider reported a problem with this payment. Nothing was charged by us; please try again or contact the front desk."
              : "Thanks! We update this invoice only after the payment provider confirms the payment to us directly. This usually takes a moment — refresh to check."}
        </Callout>
      ) : null}
      {returned && inv.status === "paid" ? <Callout tone="ok" title="Payment confirmed" className="mb-4">The provider confirmed your payment. A receipt is available.</Callout> : null}
      {sp.checkout === "cancelled" ? <Callout tone="warn" className="mb-4">Checkout was cancelled. Nothing was charged.</Callout> : null}

      <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
        <Card className="lg:col-span-2">
          <CardHeader title="Lines" />
          <CardBody>
            <Table caption="Invoice lines">
              <thead><tr><Th>Description</Th><Th>Athlete</Th><Th align="right">Qty</Th><Th align="right">Unit</Th><Th align="right">Amount</Th></tr></thead>
              <tbody>
                {d.lines.map(({ line, athleteFirst, athleteLast }) => (
                  <tr key={line.id}>
                    <Td>
                      {line.description}
                      {line.entitlement?.credits ? <div className="text-xs text-ink-3">Grants {line.entitlement.credits * line.quantity} credit(s) when paid</div> : null}
                      {line.entitlement?.unlimitedUntil ? <div className="text-xs text-ink-3">Unlimited through {fmtDate(line.entitlement.unlimitedUntil)}</div> : null}
                    </Td>
                    <Td>{athleteFirst ? `${athleteFirst} ${athleteLast}` : "—"}</Td>
                    <Td align="right">{line.quantity}</Td>
                    <Td align="right"><Money minor={line.unitAmountMinor} currency={inv.currency} /></Td>
                    <Td align="right"><Money minor={line.amountMinor} currency={inv.currency} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <dl className="ml-auto mt-3 grid max-w-xs grid-cols-2 gap-y-1 text-sm">
              <dt className="text-ink-3">Subtotal</dt><dd className="text-right"><Money minor={inv.subtotalMinor} currency={inv.currency} /></dd>
              {inv.discountMinor ? (<><dt className="text-ink-3">Discount</dt><dd className="text-right">−<Money minor={inv.discountMinor} currency={inv.currency} /></dd></>) : null}
              <dt className="font-semibold">Total</dt><dd className="text-right font-semibold"><Money minor={inv.totalMinor} currency={inv.currency} /></dd>
              <dt className="text-ink-3">Paid (settled)</dt><dd className="text-right text-ok"><Money minor={money.settledMinor} currency={inv.currency} /></dd>
              {money.pendingMinor ? (<><dt className="text-ink-3">Pending (not settled)</dt><dd className="text-right text-warn"><Money minor={money.pendingMinor} currency={inv.currency} /></dd></>) : null}
              {money.refundedMinor ? (<><dt className="text-ink-3">Refunded</dt><dd className="text-right"><Money minor={money.refundedMinor} currency={inv.currency} /></dd></>) : null}
              <dt className="font-semibold">Balance due</dt><dd className="text-right font-semibold"><Money minor={inv.status === "void" ? 0 : money.balanceMinor} currency={inv.currency} /></dd>
            </dl>
            <p className="mt-2 text-xs text-ink-3">
              Issued {fmt(inv.issuedAt)} · Due {fmtDate(inv.dueDate)}
              {inv.periodStart ? ` · Period ${fmtDate(inv.periodStart)} – ${fmtDate(inv.periodEnd)}` : ""}
              {inv.membershipId ? <> · <Link className="underline" href={`/billing/memberships/${inv.membershipId}`}>membership</Link></> : null}
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Pay" />
          <CardBody className="space-y-3">
            {inv.status !== "open" ? (
              <p className="text-sm text-ink-3">This invoice is {inv.status}. Nothing to pay.</p>
            ) : !d.canPay ? (
              <Callout tone="info">You can view this invoice but you are not authorized to pay it.</Callout>
            ) : money.pendingMinor > 0 ? (
              <Callout tone="info" title="Payment processing">A payment of {formatMoney(money.pendingMinor)} is in flight. We&apos;ll update this invoice when the provider confirms it.</Callout>
            ) : canPayOnline ? (
              <>
                <p className="text-sm">Pay <strong><Money minor={money.balanceMinor} currency={inv.currency} /></strong> securely on the provider&apos;s hosted page. We never see your card or bank numbers.</p>
                {providers.map((p) =>
                  p.configured && p.name === "venmo" ? (
                    inv.currency === "USD" ? (
                      <div key={p.name}>
                        <ButtonLink href={`/billing/invoices/${inv.id}/venmo`} variant="secondary" className="w-full">Pay with Venmo</ButtonLink>
                        <p className="mt-1 text-xs text-ink-3">Venmo: US buyers, USD, Venmo app required. One-time payments only.</p>
                      </div>
                    ) : null
                  ) : p.configured ? (
                    <ActionForm key={p.name} action={startCheckoutAction}>
                      <input type="hidden" name="invoiceId" value={inv.id} />
                      <input type="hidden" name="provider" value={p.name} />
                      <SubmitButton className="w-full" variant={p.name === "stripe" ? "primary" : "secondary"} pendingText="Opening checkout…">
                        Pay with {PROVIDER_LABEL[p.name]}
                      </SubmitButton>
                      {p.name === "venmo" ? <p className="mt-1 text-xs text-ink-3">Venmo: US buyers, USD, Venmo app required. One-time payments only.</p> : null}
                    </ActionForm>
                  ) : null,
                )}
                {providers.some((p) => !p.configured) ? (
                  <NotConfigured provider={providers.filter((p) => !p.configured).map((p) => PROVIDER_LABEL[p.name]).join(", ")} envVars={[...new Set(providers.filter((p) => !p.configured).flatMap((p) => p.missing))]}>
                    Online payment through these providers isn&apos;t available yet. You can still pay at the front desk (cash, check, or other offline methods recorded by staff).
                  </NotConfigured>
                ) : null}
              </>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Payments & refunds" />
        <CardBody>
          {d.transactions.length === 0 ? (
            <p className="text-sm text-ink-3">No payments recorded.</p>
          ) : (
            <Table caption="Payments">
              <thead><tr><Th>When</Th><Th>Kind</Th><Th>Method</Th><Th>Status</Th><Th>Verification</Th>{d.staff ? <Th>Reference / recorded by</Th> : null}<Th align="right">Amount</Th></tr></thead>
              <tbody>
                {d.transactions.map(({ t, recorder }) => (
                  <tr key={t.id}>
                    <Td>{fmt(t.occurredAt)}</Td>
                    <Td>{t.kind.replaceAll("_", " ")}</Td>
                    <Td>{PROVIDER_LABEL[t.provider]} · {METHOD_LABEL[t.methodType ?? ""] ?? t.methodType ?? "—"}</Td>
                    <Td><TxnStatus status={t.status} /></Td>
                    <Td><VerificationBadge verification={t.verification} /></Td>
                    {d.staff ? <Td className="text-xs">{t.manualReference ?? t.providerTxnId ?? "—"}{recorder ? ` · ${recorder}` : ""}</Td> : null}
                    <Td align="right"><Money minor={t.amountMinor} currency={t.currency} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {d.refunds.length ? (
            <ul className="mt-4 space-y-1 text-sm">
              {d.refunds.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <Badge variant={r.status === "succeeded" ? "green" : r.status === "blocked_config" || r.status === "failed" ? "red" : "yellow"}>refund {r.status.replace("_", " ")}</Badge>
                  <Money minor={r.amountMinor} currency={r.currency} />
                  <span className="text-xs text-ink-3">{r.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {d.staff && d.attempts.length ? (
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer font-medium">Checkout attempts ({d.attempts.length})</summary>
              <ul className="mt-2 space-y-1">
                {d.attempts.map((a) => (
                  <li key={a.id} className="text-xs">
                    {fmt(a.createdAt)} · {PROVIDER_LABEL[a.provider]} · {a.status} · {formatMoney(a.amountMinor)} {a.failureCode ? `· ${a.failureCode}: ${a.failureMessage ?? ""}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </CardBody>
      </Card>

      {d.staff ? <StaffTools d={d} canManage={can(v, "billing.manage")} canRefund={can(v, "billing.refund")} /> : null}
    </>
  );
}

function StaffTools({ d, canManage, canRefund }: { d: NonNullable<Awaited<ReturnType<typeof invoiceDetail>>>; canManage: boolean; canRefund: boolean }) {
  const inv = d.invoice;
  const refundable = d.transactions.filter(({ t }) => (t.kind === "charge" || t.kind === "manual_payment") && t.status === "settled");
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
      {canManage && inv.status === "open" && d.money.balanceMinor > 0 && d.money.pendingMinor === 0 ? (
        <Card>
          <CardHeader title="Record offline payment" kicker="Staff attested" />
          <CardBody>
            <ActionForm action={recordPaymentAction} className="space-y-3" resetOnSuccess>
              <input type="hidden" name="invoiceId" value={inv.id} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Amount ($)" htmlFor="amount" required><Input id="amount" name="amount" inputMode="decimal" required defaultValue={(d.money.balanceMinor / 100).toFixed(2)} /></Field>
                <Field label="Method" htmlFor="method" required>
                  <Select id="method" name="method" required>{MANUAL_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</Select>
                </Field>
              </div>
              <Field label="Reference" htmlFor="reference" required hint="Check #, receipt #, or Venmo/Zelle note. A screenshot or QR code is never provider verification.">
                <Input id="reference" name="reference" required />
              </Field>
              <Field label="Notes" htmlFor="notes"><Input id="notes" name="notes" /></Field>
              <SubmitButton pendingText="Recording…">Record payment</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}
      {canRefund && refundable.length ? (
        <Card>
          <CardHeader title="Refund" kicker="Owner/admin" />
          <CardBody>
            <ActionForm action={refundAction} className="space-y-3">
              <Field label="Payment" htmlFor="transactionId" required>
                <Select id="transactionId" name="transactionId" required>
                  {refundable.map(({ t }) => <option key={t.id} value={t.id}>{PROVIDER_LABEL[t.provider]} {formatMoney(t.amountMinor)} · {fmtDate(t.occurredAt.toISOString().slice(0, 10))}</option>)}
                </Select>
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Amount ($)" htmlFor="ramount" required><Input id="ramount" name="amount" inputMode="decimal" required /></Field>
                <Field label="Reason" htmlFor="reason" required><Input id="reason" name="reason" required /></Field>
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="offline" /> Refunded offline (cash/check) — record as staff attested</label>
              <Field label="Offline reference" htmlFor="rref" hint="Required for offline refunds"><Input id="rref" name="reference" /></Field>
              <p className="text-xs text-ink-3">Provider refunds are sent with an idempotency key; if the provider isn&apos;t configured the refund is recorded as blocked and nothing is sent. Credits are not auto-revoked — a review task is created.</p>
              <SubmitButton variant="danger" pendingText="Submitting…" confirm="Submit this refund?">Refund</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}
      {canManage && inv.status !== "paid" && inv.status !== "void" ? (
        <Card>
          <CardHeader title="Invoice actions" />
          <CardBody className="space-y-4">
            {inv.status === "draft" ? (
              <ActionForm action={issueInvoiceAction}>
                <input type="hidden" name="invoiceId" value={inv.id} />
                <SubmitButton>Issue invoice</SubmitButton>
              </ActionForm>
            ) : null}
            <ActionForm action={voidInvoiceAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="invoiceId" value={inv.id} />
              <Field label="Void reason" htmlFor="voidReason" className="min-w-48 flex-1"><Input id="voidReason" name="reason" required /></Field>
              <SubmitButton variant="outline" confirm="Void this invoice?">Void</SubmitButton>
            </ActionForm>
            {inv.status === "open" ? (
              <ActionForm action={uncollectibleAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="invoiceId" value={inv.id} />
                <Field label="Uncollectible reason" htmlFor="ucReason" className="min-w-48 flex-1"><Input id="ucReason" name="reason" required /></Field>
                <SubmitButton variant="outline">Mark uncollectible</SubmitButton>
              </ActionForm>
            ) : null}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
