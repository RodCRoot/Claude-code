import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { Badge, ButtonLink, Callout, EmptyState, PageHeader } from "@/components/ui";
import { isBillingStaff } from "@/lib/billing/access";
import { listMemberships, listPaymentMethods, myPayerAccounts } from "@/lib/billing/queries";
import { providerStatuses } from "@/lib/payments";
import { BillingTabs, PROVIDER_LABEL, requireBillingViewer } from "../_components";

export const metadata = { title: "Payment Methods" };

const TYPE: Record<string, string> = { card: "Card", us_bank_account: "Bank account", paypal: "PayPal account" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Card or bank account on file per billing account: brand and last four only (tokenised by the payment
 * provider; no numbers are stored here), and which memberships it is charged for automatically.
 */
export default async function PaymentMethodsPage() {
  const v = await requireBillingViewer();
  if (isBillingStaff(v)) redirect("/billing");
  const [accounts, methods, ms] = await Promise.all([myPayerAccounts(db, v), listPaymentMethods(db, v), listMemberships(db, v)]);
  const onlineReady = providerStatuses().some((p) => p.name !== "manual" && p.configured);
  return (
    <>
      <PageHeader kicker="My Profile" title="Payment Methods" description="The card or bank account on file for each billing account." />
      <BillingTabs current="methods" staff={false} />
      {accounts.length === 0 ? (
        <EmptyState title="No billing accounts">You aren&apos;t listed on a billing account. If you expected to see one, please contact the front desk.</EmptyState>
      ) : (
        <div className="grid gap-5 [&>*]:min-w-0">
          {accounts.map((a) => {
            const mine = methods.filter((m) => m.payerAccountId === a.payer.id);
            const live = ms.filter((m) => m.m.payerAccountId === a.payer.id && ["active", "trialing", "past_due", "on_hold", "pending"].includes(m.m.status));
            return (
              <section key={a.payer.id} aria-label={a.payer.name} className="overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge bg-th px-3 py-2.5 sm:px-4">
                  <div>
                    <div className="kicker">Billing account</div>
                    <h2 className="text-base font-bold">{a.payer.name}</h2>
                  </div>
                  {a.canPay ? <Badge variant="green">You can pay</Badge> : <Badge title="You can view this account but not pay or change how it is paid">View only</Badge>}
                </div>
                <div className="space-y-4 px-3 py-3 sm:px-4">
                  {mine.length === 0 ? (
                    <p className="text-sm text-ink-2">
                      No card or bank account is on file. {onlineReady ? "When you pay a bill online, you enter your payment details on the payment provider's secure page." : "Bills on this account are paid at the front desk."}
                    </p>
                  ) : (
                    <ul className="space-y-3">
                      {mine.map((pm) => {
                        const auto = live.filter((m) => m.m.billingProvider === pm.provider);
                        return (
                          <li key={pm.id} className="rounded-md border border-edge px-3 py-2.5 text-sm">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="font-semibold">
                                {pm.brand ? cap(pm.brand) : (TYPE[pm.type] ?? "Payment method")} ending in <span className="tabular">{pm.last4 ?? "····"}</span>
                              </div>
                              {pm.isDefault ? <Badge variant="brand">Default</Badge> : null}
                            </div>
                            <div className="mt-0.5 text-xs text-ink-3">
                              {TYPE[pm.type] ?? pm.type}
                              {pm.expMonth && pm.expYear ? ` · expires ${String(pm.expMonth).padStart(2, "0")}/${pm.expYear}` : ""} · saved with {PROVIDER_LABEL[pm.provider] ?? pm.provider}
                            </div>
                            <div className="mt-2 text-xs">
                              <span className="font-semibold text-ink-2">Pays for: </span>
                              {auto.length ? (
                                auto.map((m, i) => (
                                  <span key={m.m.id}>
                                    {i ? ", " : ""}
                                    <Link href={`/billing/memberships/${m.m.id}`} className="hover:underline">
                                      {m.productName} ({m.first})
                                    </Link>
                                  </span>
                                ))
                              ) : (
                                <span className="text-ink-3">No membership is charged to it automatically. Each bill is paid with Pay Now.</span>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {a.canPay ? (
                    <Callout tone="info" title="Update a payment method">
                      Changing the card or bank account on file online isn&apos;t available here yet. Please contact the front desk and we&apos;ll update it with you. Card and bank numbers are held by the payment provider. Only the type and last four digits are shown here.
                    </Callout>
                  ) : (
                    <Callout tone="info">You can view this account, but payment methods are managed by another authorized person on the account.</Callout>
                  )}
                  <ButtonLink href="/billing/invoices" variant="secondary" className="min-h-11">
                    View bills
                  </ButtonLink>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
