import Link from "next/link";
import QRCode from "qrcode";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations, payerAccounts } from "@/db/schema";
import { AddMethod } from "@/components/billing/add-method";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, Callout, EmptyState, PageHeader, Select } from "@/components/ui";
import { isBillingStaff } from "@/lib/billing/access";
import { UnpaidAutopayBills } from "@/components/billing/charge-now";
import { failedAutopayNotices, unpaidAutopayBills } from "@/lib/billing/autopay";
import { listMethodViews, openSetups, setupReturnView, type MethodView } from "@/lib/billing/payment-methods";
import { listMemberships, myPayerAccounts } from "@/lib/billing/queries";
import { env } from "@/lib/env";
import { getSavedMethodProvider } from "@/lib/payments";
import { fmtDate } from "@/lib/time";
import { BillingTabs, requireBillingViewer } from "../_components";
import { removeMethodAction, setAutopayAction, setDefaultMethodAction } from "./actions";

export const metadata = { title: "Payment Methods" };

const STATUS_VARIANT = { active: "green", requires_verification: "yellow", failed: "red", removed: "neutral" } as const;
const LIVE = ["active", "trialing", "past_due", "on_hold", "pending"];

function MethodSummary({ pm }: { pm: MethodView }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="font-semibold">{pm.label}</div>
      <div className="flex flex-wrap gap-1.5">
        {pm.isDefault ? <Badge variant="brand">Default</Badge> : null}
        <Badge variant={STATUS_VARIANT[pm.status]}>{pm.statusLabel}</Badge>
      </div>
    </div>
  );
}

/**
 * Family: saved cards and bank accounts per billing account, add / set default / remove, and autopay per
 * membership. Staff (owner, admin, operations) with ?payer=<id>: summaries only, plus a link and QR code to
 * hand to the family. Card and bank numbers never appear here: they live in Stripe's vault.
 */
export default async function PaymentMethodsPage({ searchParams }: { searchParams: Promise<{ payer?: string; setup?: string; setup_cancelled?: string }> }) {
  const v = await requireBillingViewer();
  const sp = await searchParams;
  const adapter = getSavedMethodProvider();
  const configured = adapter.isConfigured();
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, v.orgId));
  const orgName = org?.name ?? "Teamwork";

  if (isBillingStaff(v)) {
    const payerId = /^[0-9a-f-]{36}$/i.test(sp.payer ?? "") ? sp.payer! : null;
    const [payer] = payerId ? await db.select().from(payerAccounts).where(eq(payerAccounts.id, payerId)) : [];
    if (!payer || payer.orgId !== v.orgId) {
      return (
        <>
          <PageHeader kicker="Billing" title="Payment methods" description="Saved cards and bank accounts are managed by each family on their own device." />
          <BillingTabs current="memberships" staff />
          <EmptyState title="Choose a membership first">
            Open a membership under <Link href="/billing/memberships" className="underline">Memberships</Link> and use &quot;Payment methods on file&quot; to see a family&apos;s saved methods or hand them a link.
          </EmptyState>
        </>
      );
    }
    const methods = await listMethodViews(db, v, { payerAccountId: payer.id });
    const link = `${env().APP_URL}/billing/payment-methods`;
    const qr = await QRCode.toDataURL(link, { margin: 1, width: 440, errorCorrectionLevel: "M" });
    return (
      <>
        <PageHeader kicker="Billing" title={`Payment methods · ${payer.name}`} description="Summaries only. Card and bank numbers are held by Stripe and are never shown or stored here." />
        <BillingTabs current="memberships" staff />
        <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
          <section aria-label="Methods on file" className="rounded-md border border-edge bg-surface p-4">
            <h2 className="mb-3 text-base font-bold">On file</h2>
            {methods.length === 0 ? (
              <p className="text-sm text-ink-2">No card or bank account is saved for this account.</p>
            ) : (
              <ul className="space-y-3">
                {methods.map((pm) => (
                  <li key={pm.id} className="rounded-md border border-edge px-3 py-2.5 text-sm">
                    <MethodSummary pm={pm} />
                    <div className="mt-1 text-xs text-ink-3">
                      {pm.paysFor.length ? `Autopay for: ${pm.paysFor.map((p) => p.label).join("; ")}` : "Not used for autopay"}
                      {pm.mandateAcceptedAt ? ` · bank debit authorization ${pm.mandateTextVersion} accepted ${fmtDate(new Date(pm.mandateAcceptedAt))}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Hand over a link" className="rounded-md border border-edge bg-surface p-4">
            <h2 className="mb-2 text-base font-bold">Save a payment method link</h2>
            {!configured ? (
              <Callout tone="warn" title="Stripe is not configured">
                Families cannot save a card or bank account until Stripe keys are set on the server ({adapter.missingEnv().join(", ")}). Nothing is charged automatically; record payments at the front desk as usual.
              </Callout>
            ) : null}
            <p className="mt-2 text-sm text-ink-2">The person who pays for this account signs in on their own phone and adds the card or bank account there. Staff never enter it for them.</p>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr} alt="QR code that opens the Payment Methods page" width={160} height={160} className="size-40 shrink-0 self-center rounded-md border border-edge bg-white p-2 sm:self-start" />
              <div className="min-w-0 text-sm">
                <div className="font-semibold">Link</div>
                <code className="mt-1 block break-all rounded bg-surface-2 px-2 py-1 text-xs">{link}</code>
                <p className="mt-2 text-xs text-ink-3">They must be signed in as a person allowed to pay this account. A view-only guardian will see the methods but cannot add or remove them.</p>
              </div>
            </div>
          </section>
        </div>
      </>
    );
  }

  const [accounts, methods, ms, setups] = await Promise.all([myPayerAccounts(db, v), listMethodViews(db, v), listMemberships(db, v), openSetups(db, v)]);
  const returned = sp.setup ? await setupReturnView(db, v, sp.setup) : null;
  const notices = await failedAutopayNotices(db, v.orgId, accounts.filter((a) => a.canPay).map((a) => a.payer.id));
  // Bills that already existed when autopay was switched on: listed under the membership with a way to charge each now.
  const unpaid = new Map<string, Awaited<ReturnType<typeof unpaidAutopayBills>>>();
  for (const m of ms) if (m.m.autopay && m.m.billingProvider === "manual") unpaid.set(m.m.id, await unpaidAutopayBills(db, v, m.m.id));
  return (
    <>
      <PageHeader kicker="My Profile" title="Payment Methods" description="Cards and bank accounts saved for each billing account, and which memberships they pay for automatically." />
      <BillingTabs current="methods" staff={false} />
      {returned ? (
        <Callout tone={returned.state === "failed" ? "bad" : returned.state === "active" ? "ok" : "info"} title={returned.state === "active" ? "Payment method saved" : returned.state === "failed" ? "The payment method was not saved" : returned.state === "verification" ? "One more step: verify your bank account" : "We are confirming your payment method"} className="mb-4">
          {returned.state === "active"
            ? "It is ready to use."
            : returned.state === "failed"
              ? "Nothing was saved. You can try again below."
              : returned.state === "verification"
                ? "Your bank will show two small deposits in 1 to 2 business days. Stripe emails you a link to confirm them. The account can be used after that."
                : "This usually takes a few seconds. Refresh this page to see it. Nothing has been charged."}
        </Callout>
      ) : null}
      {sp.setup_cancelled ? (
        <Callout tone="info" className="mb-4">
          You left the secure page before finishing. Nothing was saved.
        </Callout>
      ) : null}
      {notices.map((n) => (
        <Callout key={n.invoiceId} tone="bad" title={`Automatic payment for bill ${n.number} did not go through`} className="mb-4">
          {n.text}{" "}
          <Link href={`/billing/invoices/${n.invoiceId}`} className="font-semibold underline">
            Open the bill
          </Link>
        </Callout>
      ))}
      {accounts.length === 0 ? (
        <EmptyState title="No billing accounts">You aren&apos;t listed on a billing account. If you expected to see one, please contact the front desk.</EmptyState>
      ) : (
        <div className="grid gap-5 [&>*]:min-w-0">
          {accounts.map((a) => {
            const mine = methods.filter((m) => m.payerAccountId === a.payer.id);
            const active = mine.filter((m) => m.status === "active");
            const live = ms.filter((m) => m.m.payerAccountId === a.payer.id && LIVE.includes(m.m.status) && (m.m.billingProvider === "manual" || m.m.billingProvider === "external_zenplanner"));
            const pendingSetups = setups.filter((s) => s.payerAccountId === a.payer.id && s.status === "requires_verification");
            return (
              <section key={a.payer.id} aria-label={a.payer.name} className="overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge bg-th px-3 py-2.5 sm:px-4">
                  <div>
                    <div className="kicker">Billing account</div>
                    <h2 className="text-base font-bold">{a.payer.name}</h2>
                  </div>
                  {a.canPay ? <Badge variant="green">You can pay</Badge> : <Badge title="You can view this account but not pay or change how it is paid">View only</Badge>}
                </div>
                <div className="space-y-5 px-3 py-3 sm:px-4">
                  {mine.length === 0 ? (
                    <p className="text-sm text-ink-2">No card or bank account is saved.</p>
                  ) : (
                    <ul className="space-y-3">
                      {mine.map((pm) => {
                        const others = active.filter((o) => o.id !== pm.id);
                        return (
                          <li key={pm.id} className="rounded-md border border-edge px-3 py-2.5 text-sm">
                            <MethodSummary pm={pm} />
                            {pm.status === "failed" ? <p className="mt-1 text-sm text-bad">This payment method can no longer be charged. Please add a new one and remove this one.</p> : null}
                            {pm.status === "requires_verification" ? <p className="mt-1 text-sm text-ink-2">Waiting for confirmation from Stripe. A bank account needs its two small deposits confirmed first (Stripe emails you the link).</p> : null}
                            <div className="mt-2 text-xs">
                              <span className="font-semibold text-ink-2">Pays for: </span>
                              {pm.paysFor.length ? (
                                pm.paysFor.map((m, i) => (
                                  <span key={m.membershipId}>
                                    {i ? "; " : ""}
                                    <Link href={`/billing/memberships/${m.membershipId}`} className="hover:underline">
                                      {m.label}
                                    </Link>
                                  </span>
                                ))
                              ) : (
                                <span className="text-ink-3">No membership is charged to it automatically.</span>
                              )}
                            </div>
                            {a.canPay ? (
                              <div className="mt-3 flex flex-wrap items-end gap-2">
                                {pm.status === "active" && !pm.isDefault ? (
                                  <ActionForm action={setDefaultMethodAction}>
                                    <input type="hidden" name="methodId" value={pm.id} />
                                    <SubmitButton size="sm" variant="secondary" className="min-h-11">
                                      Make default
                                    </SubmitButton>
                                  </ActionForm>
                                ) : null}
                                <ActionForm action={removeMethodAction} className="flex flex-wrap items-end gap-2">
                                  <input type="hidden" name="methodId" value={pm.id} />
                                  {pm.paysFor.length && others.length > 1 ? (
                                    <label className="text-xs">
                                      <span className="mb-1 block font-semibold text-ink-2">Autopay moves to</span>
                                      <Select name="replacementMethodId" defaultValue="" className="min-h-11">
                                        <option value="" disabled>
                                          Choose a payment method
                                        </option>
                                        {others.map((o) => (
                                          <option key={o.id} value={o.id}>
                                            {o.label}
                                          </option>
                                        ))}
                                      </Select>
                                    </label>
                                  ) : null}
                                  <SubmitButton size="sm" variant="secondary" className="min-h-11" confirm={`Remove ${pm.label}?`}>
                                    Remove
                                  </SubmitButton>
                                </ActionForm>
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {pendingSetups.map((s) => (
                    <Callout key={s.id} tone="info" title="Bank account waiting for verification">
                      Two small deposits are on their way to your bank (1 to 2 business days). Stripe emails you a link to confirm them.
                      {s.verificationUrl && a.canPay ? (
                        <>
                          {" "}
                          <a href={s.verificationUrl} className="font-semibold underline" rel="noreferrer">
                            Verify on Stripe&apos;s secure page
                          </a>
                        </>
                      ) : null}
                    </Callout>
                  ))}
                  {live.length ? (
                    <div>
                      <h3 className="mb-2 text-sm font-bold">Autopay</h3>
                      <ul className="space-y-2">
                        {live.map((m) => {
                          const using = active.find((x) => x.paysFor.some((p) => p.membershipId === m.m.id));
                          return (
                            <li key={m.m.id} className="rounded-md border border-edge px-3 py-2.5 text-sm">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <Link href={`/billing/memberships/${m.m.id}`} className="font-semibold hover:underline">
                                  {m.productName} ({m.first})
                                </Link>
                                {m.m.autopay && using ? <Badge variant="green">Autopay on</Badge> : m.m.autopay ? <Badge variant="red">Autopay on, no working method</Badge> : <Badge>Autopay off</Badge>}
                              </div>
                              <p className="mt-1 text-xs text-ink-3">
                                {m.m.billingProvider === "external_zenplanner"
                                  ? "Still billed in the previous system. Autopay here starts only after the front desk moves it over."
                                  : m.m.autopay && using
                                    ? `Each bill is charged to ${using.label} on its due date.`
                                    : "Each bill is paid with Pay Now under Bills, or at the front desk."}
                              </p>
                              {a.canPay && m.m.autopay ? <UnpaidAutopayBills bills={unpaid.get(m.m.id) ?? []} staff={false} className="mt-2" /> : null}
                              {a.canPay && (active.length || m.m.autopay) ? (
                                <ActionForm action={setAutopayAction} className="mt-2 flex flex-wrap items-end gap-2">
                                  <input type="hidden" name="membershipId" value={m.m.id} />
                                  {m.m.autopay ? (
                                    <SubmitButton size="sm" variant="secondary" className="min-h-11" name="autopay" value="off">
                                      Turn autopay off
                                    </SubmitButton>
                                  ) : (
                                    <>
                                      <label className="text-xs">
                                        <span className="mb-1 block font-semibold text-ink-2">Pay with</span>
                                        <Select name="methodId" defaultValue={active.find((x) => x.isDefault)?.id ?? active[0]?.id} className="min-h-11">
                                          {active.map((o) => (
                                            <option key={o.id} value={o.id}>
                                              {o.label}
                                            </option>
                                          ))}
                                        </Select>
                                      </label>
                                      <SubmitButton size="sm" className="min-h-11" name="autopay" value="on">
                                        Turn autopay on
                                      </SubmitButton>
                                    </>
                                  )}
                                </ActionForm>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                  {a.canPay ? (
                    <div>
                      <h3 className="mb-2 text-sm font-bold">Add a payment method</h3>
                      <AddMethod payerAccountId={a.payer.id} orgName={orgName} configured={configured} idPrefix={`pm-${a.payer.id.slice(0, 8)}`} />
                    </div>
                  ) : (
                    <Callout tone="info">You can view this account, but payment methods are managed by the person who pays for it.</Callout>
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
