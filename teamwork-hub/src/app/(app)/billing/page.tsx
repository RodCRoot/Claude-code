import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { isBillingStaff } from "@/lib/billing/access";
import { staffOverview } from "@/lib/billing/queries";
import { paymentExceptions } from "@/lib/billing/reconciliation";
import { todayLocal } from "@/lib/time";
import { runRenewalsAction } from "./actions";
import { KpiTile, Widget } from "@/components/profile/studio";
import { BillingTabs, Money, requireBillingViewer } from "./_components";
import { FamilyHome } from "./_family";

export const metadata = { title: "Memberships & Billing" };

export default async function BillingHome() {
  const v = await requireBillingViewer();
  return isBillingStaff(v) ? <StaffOverview orgId={v.orgId} /> : <FamilyHome v={v} />;
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
