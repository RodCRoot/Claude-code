import { notFound } from "next/navigation";
import { db } from "@/db";
import { ButtonLink } from "@/components/ui";
import { getOrg } from "@/lib/auth/viewer";
import { invoiceDetail } from "@/lib/billing/queries";
import { fmt, fmtDate } from "@/lib/time";
import { METHOD_LABEL, Money, PROVIDER_LABEL, requireBillingViewer } from "../../../_components";
import { PrintButton } from "../../../_print-button";

export const metadata = { title: "Receipt" };

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const v = await requireBillingViewer();
  const { id } = await params;
  const d = await invoiceDetail(db, v, id).catch(() => null);
  if (!d || (!d.staff && d.invoice.status === "draft")) notFound();
  const org = await getOrg(v.orgId);
  const inv = d.invoice;
  const paid = inv.status === "paid";
  return (
    <article className="mx-auto max-w-2xl rounded-xl border border-edge bg-surface p-6 print:border-0 print:p-0">
      <div className="no-print mb-4 flex gap-2">
        <ButtonLink href={`/billing/invoices/${inv.id}`} variant="ghost">← Back</ButtonLink>
        <PrintButton />
      </div>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-edge pb-4">
        <div>
          <h1 className="text-xl font-bold">{org?.branding?.displayName ?? org?.name ?? "Teamwork"}</h1>
          {org?.isDemo ? <p className="text-xs font-semibold text-warn">DEMO DATA — not a real receipt</p> : null}
        </div>
        <div className="text-right text-sm">
          <div className="text-lg font-semibold">{paid ? "Receipt" : "Invoice"} {inv.number}</div>
          <div>Issued {fmtDate(inv.issuedAt ? inv.issuedAt.toISOString().slice(0, 10) : null)}</div>
          {paid ? <div>Paid {fmt(inv.paidAt)}</div> : <div>Due {fmtDate(inv.dueDate)}</div>}
        </div>
      </header>
      <p className="mt-4 text-sm">Billed to: <strong>{d.payer.name}</strong></p>
      <table className="mt-4 w-full text-sm">
        <thead><tr className="border-b border-edge text-left"><th className="py-1">Item</th><th className="py-1 text-right">Qty</th><th className="py-1 text-right">Amount</th></tr></thead>
        <tbody>
          {d.lines.map(({ line, athleteFirst, athleteLast }) => (
            <tr key={line.id} className="border-b border-edge/60">
              <td className="py-1.5">{line.description}{athleteFirst ? <span className="text-ink-3"> — {athleteFirst} {athleteLast}</span> : null}</td>
              <td className="py-1.5 text-right">{line.quantity}</td>
              <td className="py-1.5 text-right"><Money minor={line.amountMinor} currency={inv.currency} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="ml-auto mt-3 grid max-w-xs grid-cols-2 gap-y-1 text-sm">
        {inv.discountMinor ? (<><dt>Discount</dt><dd className="text-right">−<Money minor={inv.discountMinor} currency={inv.currency} /></dd></>) : null}
        <dt className="font-semibold">Total</dt><dd className="text-right font-semibold"><Money minor={inv.totalMinor} currency={inv.currency} /></dd>
        <dt>Paid</dt><dd className="text-right"><Money minor={d.money.settledMinor} currency={inv.currency} /></dd>
        {d.money.refundedMinor ? (<><dt>Refunded</dt><dd className="text-right"><Money minor={d.money.refundedMinor} currency={inv.currency} /></dd></>) : null}
        <dt className="font-semibold">Balance</dt><dd className="text-right font-semibold"><Money minor={d.money.balanceMinor} currency={inv.currency} /></dd>
      </dl>
      <section className="mt-6 text-sm">
        <h2 className="font-semibold">Payments</h2>
        <ul className="mt-1 space-y-1">
          {d.transactions.filter(({ t }) => t.status !== "failed").map(({ t }) => (
            <li key={t.id}>
              {fmt(t.occurredAt)} — {t.kind.replaceAll("_", " ")} via {PROVIDER_LABEL[t.provider]} ({METHOD_LABEL[t.methodType ?? ""] ?? t.methodType ?? "—"}) —{" "}
              <Money minor={t.amountMinor} currency={t.currency} /> · {t.status === "pending" ? "PENDING (not settled)" : t.verification === "staff_attested" ? "recorded by staff" : "confirmed by provider"}
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
