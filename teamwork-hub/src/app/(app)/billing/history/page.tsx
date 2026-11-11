import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { Badge, EmptyState, PageHeader, type BadgeVariant } from "@/components/ui";
import { isBillingStaff } from "@/lib/billing/access";
import { listPayments } from "@/lib/billing/queries";
import { fmtDate } from "@/lib/time";
import { BillingTabs, METHOD_LABEL, Money, PROVIDER_LABEL, requireBillingViewer } from "../_components";
import { BillTable } from "../_family";

export const metadata = { title: "Payment History" };

const KIND: Record<string, string> = { charge: "Payment", manual_payment: "Payment", refund: "Refund" };
const STATUS: Record<string, [string, BadgeVariant]> = {
  settled: ["Paid", "green"],
  pending: ["Processing", "yellow"],
  failed: ["Failed", "red"],
};

/** Family payment history: every payment and refund on the accounts this person may view. */
export default async function PaymentHistoryPage() {
  const v = await requireBillingViewer();
  if (isBillingStaff(v)) redirect("/billing");
  const rows = await listPayments(db, v);
  return (
    <>
      <PageHeader kicker="My Profile" title="Payment History" description="Payments and refunds on your billing accounts, newest first." />
      <BillingTabs current="history" staff={false} />
      {rows.length === 0 ? (
        <EmptyState title="No payments yet">Payments show up here once a bill is paid online or at the front desk.</EmptyState>
      ) : (
        <section aria-label="Payment history" className="min-w-0 overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
          <BillTable
            caption="Payments and refunds"
            dateLabel="Date"
            rows={rows.map((t) => {
              const refund = t.kind === "refund";
              const [label, variant] = refund && t.status === "settled" ? (["Refunded", "blue"] as [string, BadgeVariant]) : (STATUS[t.status] ?? [t.status.replaceAll("_", " "), "neutral"]);
              const method = t.provider === "manual" ? (METHOD_LABEL[t.methodType ?? ""] ?? "Front desk") : `${PROVIDER_LABEL[t.provider] ?? t.provider}${t.methodType && METHOD_LABEL[t.methodType] ? ` · ${METHOD_LABEL[t.methodType]}` : ""}`;
              return {
                key: t.id,
                due: fmtDate(t.occurredAt),
                description: (
                  <>
                    <span className="font-medium">{KIND[t.kind] ?? t.kind.replaceAll("_", " ")}</span>
                    {t.invoiceId && t.invoiceNumber ? (
                      <>
                        {" for "}
                        <Link href={`/billing/invoices/${t.invoiceId}`} className="hover:underline">
                          bill {t.invoiceNumber}
                        </Link>
                      </>
                    ) : null}
                    <div className="text-xs text-ink-3">
                      {method}
                      {t.verification === "staff_attested" && !refund ? " · recorded by staff" : ""}
                    </div>
                  </>
                ),
                amount: <Money minor={t.amountMinor} currency={t.currency} />,
                status: <Badge variant={variant}>{label}</Badge>,
                action: t.invoiceId ? (
                  <Link href={`/billing/invoices/${t.invoiceId}/receipt`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline sm:min-h-0">
                    Receipt<span className="sr-only"> for bill {t.invoiceNumber}</span>
                  </Link>
                ) : undefined,
              };
            })}
          />
        </section>
      )}
    </>
  );
}
