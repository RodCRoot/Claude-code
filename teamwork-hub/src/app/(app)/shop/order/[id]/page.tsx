import { notFound } from "next/navigation";
import { db } from "@/db";
import { ButtonLink, Callout, Card, CardBody, CardHeader, PageHeader, StatusBadge } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { shopOrderView } from "@/lib/growth/shop";
import { formatMoney } from "@/lib/money";
import { fmtDate } from "@/lib/time";

export const metadata = { title: "Your order" };

export default async function ShopOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const v = await requireViewer();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const o = await shopOrderView(db, v, id);
  if (!o) notFound();
  const paid = o.invoice.status === "paid";
  const open = o.invoice.status === "open";
  return (
    <>
      <PageHeader kicker="Shop" title={paid ? "Thank you, this order is paid" : "Your order is ready for payment"} description={`Bill ${o.invoice.number}`} />
      <div className="max-w-2xl space-y-4">
        <Card>
          <CardHeader title={o.productName} kicker={`For ${o.athleteFirst}`} action={<StatusBadge status={o.invoice.status} />} />
          <CardBody className="space-y-3">
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-ink-3">Amount due</dt>
              <dd className="text-right font-semibold tabular">{formatMoney(o.money.balanceMinor, o.invoice.currency)}</dd>
              <dt className="text-ink-3">Due</dt>
              <dd className="text-right">{fmtDate(o.invoice.dueDate)}</dd>
            </dl>
            {paid ? (
              <Callout tone="ok">Payment is confirmed. Anything included with this order is now on {o.athleteFirst}&apos;s account.</Callout>
            ) : !open ? (
              <Callout tone="info">This order is no longer open. Please ask the front desk if you have questions.</Callout>
            ) : o.money.pendingMinor > 0 ? (
              <Callout tone="info">A payment is processing. We will update this order when the bank confirms it.</Callout>
            ) : !o.canPay ? (
              <Callout tone="info">You can view this order. Payment is made by another adult on the billing account.</Callout>
            ) : o.onlinePayment ? (
              <Callout tone="info">Nothing has been charged yet. Continue to the bill to pay securely with our payment provider. Sessions are added once the payment is confirmed.</Callout>
            ) : (
              <Callout tone="warn" title="Online payment is not set up yet">
                Nothing has been charged. Please pay this bill at the front desk (cash, check or card). Sessions are added to {o.athleteFirst}&apos;s account as soon as staff record the payment.
              </Callout>
            )}
            <div className="flex flex-wrap gap-2">
              {open && o.canPay && o.onlinePayment ? <ButtonLink href={`/billing/invoices/${o.invoice.id}`}>Continue to payment</ButtonLink> : <ButtonLink href={`/billing/invoices/${o.invoice.id}`} variant="secondary">View bill</ButtonLink>}
              <ButtonLink href="/shop" variant="ghost">
                Back to the shop
              </ButtonLink>
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
