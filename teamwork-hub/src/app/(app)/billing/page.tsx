import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, Callout, Card, CardBody, CardHeader, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { isBillingStaff } from "@/lib/billing/access";
import { listInvoices, listMemberships, myPayerAccounts, staffOverview } from "@/lib/billing/queries";
import { paymentExceptions } from "@/lib/billing/reconciliation";
import { fmtDate, todayLocal } from "@/lib/time";
import { runRenewalsAction } from "./actions";
import { KpiTile, Widget } from "@/components/profile/studio";
import { BillingTabs, InvoiceStatus, Money, PROVIDER_LABEL, requireBillingViewer } from "./_components";

export const metadata = { title: "Memberships & Billing" };

export default async function BillingHome() {
  const v = await requireBillingViewer();
  return isBillingStaff(v) ? <StaffOverview orgId={v.orgId} /> : <FamilyOverview />;
}

async function StaffOverview({ orgId }: { orgId: string }) {
  const today = todayLocal();
  const [o, ex] = await Promise.all([staffOverview(db, orgId, today), paymentExceptions(db, orgId, { today, limit: 15 })]);
  const byStatus = (st: string) => o.memberships.filter((m) => m.status === st && m.billing_provider !== "external_zenplanner").reduce((s, m) => s + m.n, 0);
  const external = o.memberships.filter((m) => m.billing_provider === "external_zenplanner").reduce((s, m) => s + m.n, 0);
  const STATUSES = ["active", "trialing", "pending", "past_due", "on_hold", "cancelled"] as const;
  const totalHere = STATUSES.reduce((s, st) => s + byStatus(st), 0);
  return (
    <>
      <PageHeader
        kicker="Billing"
        title="Memberships & Billing"
        description="Money in flight (pending bank payments) is shown separately and is never counted as paid. Offline payments are labelled staff attested."
        actions={
          <>
            <ButtonLink href="/billing/invoices#new" variant="secondary">New invoice</ButtonLink>
            <ButtonLink href="/billing/pos">Point of sale</ButtonLink>
          </>
        }
      />
      <BillingTabs current="overview" staff />
      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 xl:grid-cols-4">
        <KpiTile icon="billing" label="Open balance" value={<Money minor={o.openBalance} />} hint={`${o.openCount} open invoice(s)`} href="/billing/invoices?status=open" />
        <KpiTile icon="clock" label="Past due" value={<Money minor={o.pastDueTotal} />} hint={`${o.pastDueCount} invoice(s)`} tone={o.pastDueCount ? "bad" : "ok"} href="/billing/invoices?status=past_due" />
        <KpiTile icon="payroll" label="Settled · 30 days" value={<Money minor={o.settledVerified30 + o.settledAttested30} />} hint={<>Provider verified <Money minor={o.settledVerified30} /> · Staff attested <Money minor={o.settledAttested30} /></>} tone="ok" />
        <KpiTile icon="reports" label="Pending · not settled" value={<Money minor={o.pending30} />} hint="Bank payments in flight" tone={o.pending30 ? "warn" : "info"} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
        <Widget title="Payment exceptions" icon="billing" count={ex.length} href="/billing/reconciliation" linkLabel="Reconciliation" className="lg:col-span-2" flush>
          {ex.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No payment exceptions">Failed payments, long-pending bank payments, mismatches and past-due memberships appear here.</EmptyState>
            </div>
          ) : (
            <ul className="divide-y divide-edge">
              {ex.map((e, i) => (
                <li key={i} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5 hover:bg-surface-2">
                  <div className="min-w-0">
                    <Link href={e.href} className="font-semibold hover:underline">{e.title}</Link>
                    <p className="text-xs text-ink-3">{e.detail}</p>
                    {e.decline?.familyText ? (
                      <details className="mt-1 text-xs">
                        <summary className="cursor-pointer text-ink-2">Message for the family</summary>
                        <p className="mt-1 whitespace-pre-line rounded-md border border-edge bg-surface-2 p-2">{e.decline.familyText}</p>
                      </details>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {e.decline ? <Badge variant={e.decline.category === "card_needs_update" ? "red" : e.decline.category === "retryable" ? "yellow" : undefined}>{e.decline.label}</Badge> : null}
                    <Badge variant={e.severity === "high" ? "red" : "yellow"}>{e.kind.replaceAll("_", " ")}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Widget>
        <Widget title="Memberships by status" icon="people" href="/billing/memberships" linkLabel="View all" linkContext="memberships" flush>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Memberships by status</caption>
            <thead>
              <tr className="text-[11px] font-bold uppercase tracking-wide text-ink-2">
                <th scope="col" className="border-b border-edge px-4 py-2 text-left">Status</th>
                <th scope="col" className="border-b border-edge px-4 py-2 text-right">Count</th>
              </tr>
            </thead>
            <tbody>
              {STATUSES.map((st) => (
                <tr key={st} className="hover:bg-surface-2">
                  <td className="border-b border-edge/70 px-4 py-1.5">
                    <Link href={`/billing/memberships?status=${st}`} className="hover:underline">
                      <StatusBadge status={st} />
                    </Link>
                  </td>
                  <td className="border-b border-edge/70 px-4 py-1.5 text-right font-semibold tabular">{byStatus(st)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-th font-bold">
                <th scope="row" className="border-y border-edge px-4 py-2 text-left">Total billed here</th>
                <td className="border-y border-edge px-4 py-2 text-right tabular">{totalHere}</td>
              </tr>
              <tr>
                <th scope="row" className="px-4 py-2 text-left font-normal text-ink-2">Zen Planner (external)</th>
                <td className="px-4 py-2 text-right font-semibold tabular">{external}</td>
              </tr>
            </tfoot>
          </table>
          <div className="space-y-3 border-t border-edge px-4 py-3">
            <p className="text-xs text-ink-3">Zen Planner-billed memberships are shown for reference and are never invoiced here until cutover.</p>
            <ActionForm action={runRenewalsAction}>
              <SubmitButton variant="secondary" size="sm" pendingText="Running…">Run today&apos;s renewals now</SubmitButton>
              <p className="mt-1 text-xs text-ink-3">Same as the daily <code>billing.generate_renewals</code> job; safe to re-run.</p>
            </ActionForm>
          </div>
        </Widget>
      </div>
    </>
  );
}

async function FamilyOverview() {
  const v = await requireBillingViewer();
  const today = todayLocal();
  const accounts = await myPayerAccounts(db, v);
  const invs = await listInvoices(db, v, { limit: 50 });
  const ms = await listMemberships(db, v);
  return (
    <>
      <PageHeader kicker="Billing" title="Your memberships & billing" description="Invoices, receipts, memberships and session credits for the accounts you're authorized on." />
      <BillingTabs current="overview" staff={false} />
      {accounts.length === 0 ? (
        <EmptyState title="No billing accounts">You aren&apos;t listed on a billing account. If you expected to see one, please contact the front desk.</EmptyState>
      ) : null}
      <div className="grid gap-6 [&>*]:min-w-0">
        {accounts.map((a) => {
          const mine = invs.filter((r) => r.invoice.payerAccountId === a.payer.id);
          const due = mine.filter((r) => r.invoice.status === "open");
          return (
            <Card key={a.payer.id}>
              <CardHeader
                title={a.payer.name}
                kicker="Billing account"
                action={a.canPay ? <Badge variant="green">You can pay</Badge> : <Badge title="You can view invoices on this account but not pay them">View only</Badge>}
              />
              <CardBody className="space-y-5">
                {!a.canPay ? <Callout tone="info">You can view this account&apos;s invoices and receipts. Payments are made by another authorized person on the account.</Callout> : null}
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Session credits</h3>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {a.athletes.map((ath) => (
                      <li key={ath.athleteId} className="rounded-lg border border-edge px-3 py-2 text-sm">
                        <span className="font-medium">{ath.first} {ath.last}</span>
                        <span className="float-right tabular">{ath.summary.available} available{ath.summary.reserved ? ` · ${ath.summary.reserved} booked` : ""}</span>
                      </li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Amount due</h3>
                  {due.length === 0 ? (
                    <p className="text-sm text-ink-3">Nothing due. Thank you!</p>
                  ) : (
                    <ul className="divide-y divide-edge rounded-lg border border-edge">
                      {due.map((r) => (
                        <li key={r.invoice.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                          <div>
                            <Link className="font-medium hover:underline" href={`/billing/invoices/${r.invoice.id}`}>{r.invoice.number}</Link>
                            <span className="ml-2 text-xs text-ink-3">due {fmtDate(r.invoice.dueDate)}</span>
                            {r.money.pendingMinor > 0 ? <Badge variant="yellow" className="ml-2">Payment processing</Badge> : null}
                          </div>
                          <div className="flex items-center gap-3">
                            <InvoiceStatus status={r.invoice.status} dueDate={r.invoice.dueDate} today={today} />
                            <Money minor={r.money.balanceMinor} currency={r.invoice.currency} className="font-semibold" />
                            <ButtonLink size="sm" href={`/billing/invoices/${r.invoice.id}`} variant={a.canPay ? "primary" : "secondary"}>{a.canPay ? "Pay" : "View"}</ButtonLink>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Memberships</h3>
                  {ms.filter((m) => m.m.payerAccountId === a.payer.id).length === 0 ? (
                    <p className="text-sm text-ink-3">No memberships.</p>
                  ) : (
                    <ul className="space-y-2">
                      {ms
                        .filter((m) => m.m.payerAccountId === a.payer.id)
                        .map((m) => (
                          <li key={m.m.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                            <Link href={`/billing/memberships/${m.m.id}`} className="hover:underline">
                              {m.first} {m.last} — {m.productName}
                            </Link>
                            <span className="flex items-center gap-2">
                              <StatusBadge status={m.m.status} />
                              {m.m.billingProvider === "external_zenplanner" ? <Badge>{PROVIDER_LABEL.external_zenplanner}</Badge> : null}
                            </span>
                          </li>
                        ))}
                    </ul>
                  )}
                </section>
                <ButtonLink href="/billing/invoices" variant="ghost" size="sm">All invoices & receipts →</ButtonLink>
              </CardBody>
            </Card>
          );
        })}
      </div>
    </>
  );
}
