import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { Callout, Card, CardBody, CardHeader, NotConfigured, PageHeader } from "@/components/ui";
import { invoiceDetail } from "@/lib/billing/queries";
import { venmoButtonConfig } from "@/lib/billing/venmo";
import { getProvider } from "@/lib/payments";
import { Money, requireBillingViewer } from "../../../_components";
import { VenmoButton } from "./_venmo-button";

export const metadata = { title: "Pay with Venmo" };

export default async function VenmoPayPage({ params }: { params: Promise<{ id: string }> }) {
  const v = await requireBillingViewer();
  const { id } = await params;
  const d = await invoiceDetail(db, v, id).catch(() => null);
  if (!d || d.invoice.status === "draft") notFound();
  const { invoice: inv, money } = d;
  const config = venmoButtonConfig();
  const payable = d.canPay && inv.status === "open" && money.balanceMinor > 0 && money.pendingMinor === 0;
  return (
    <>
      <PageHeader kicker={`Invoice ${inv.number}`} title="Pay with Venmo" description="One-time payment through PayPal's Venmo button." />
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader title="Payment" />
          <CardBody className="space-y-3">
            {!config ? (
              <NotConfigured provider="Venmo (via PayPal)" envVars={getProvider("venmo").missingEnv()}>
                Venmo checkout isn&apos;t available yet. Nothing can be charged here. Pay another way from the invoice or at the front desk.
              </NotConfigured>
            ) : inv.status !== "open" ? (
              <p className="text-sm">This invoice is {inv.status}. Nothing to pay.</p>
            ) : !d.canPay ? (
              <Callout tone="info">You can view this invoice but you are not authorized to pay it.</Callout>
            ) : inv.currency !== "USD" ? (
              <Callout tone="info">Venmo is available for USD invoices only.</Callout>
            ) : money.pendingMinor > 0 ? (
              <Callout tone="info" title="Payment processing">A payment is already in flight for this invoice.</Callout>
            ) : payable ? (
              <>
                <p className="text-sm">
                  Amount due: <strong><Money minor={money.balanceMinor} currency={inv.currency} /></strong>
                </p>
                <VenmoButton clientId={config.clientId} sandbox={config.sandbox} invoiceId={inv.id} />
              </>
            ) : (
              <p className="text-sm">Nothing is due on this invoice.</p>
            )}
            <p className="text-sm">
              <Link href={`/billing/invoices/${inv.id}`} className="underline">Back to the invoice</Link>
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Before you pay" />
          <CardBody>
            <ul className="list-disc space-y-1.5 pl-5 text-sm">
              <li>Venmo through PayPal works for <strong>US</strong> Venmo accounts paying in <strong>USD</strong>.</li>
              <li>It is a mobile experience: you need the Venmo app (iPhone Safari or Android Chrome). On a computer, PayPal shows a QR code to scan with the app.</li>
              <li>This is a <strong>one-time</strong> payment for this invoice. Recurring memberships are not billed through Venmo — PayPal does not document Venmo for subscriptions.</li>
              <li>The invoice is marked paid only after our server confirms the payment with PayPal. If PayPal reports it as pending, it isn&apos;t counted as paid until it completes.</li>
              <li>Sending money to a personal Venmo handle is different: staff record it by hand and it is never provider-verified.</li>
            </ul>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
