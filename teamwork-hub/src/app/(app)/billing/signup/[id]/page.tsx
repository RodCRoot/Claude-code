import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { AddMethod } from "@/components/billing/add-method";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, Callout, Field, Input, PageHeader, Select } from "@/components/ui";
import { setupReturnView } from "@/lib/billing/payment-methods";
import { env } from "@/lib/env";
import { formatMoney } from "@/lib/money";
import { planPricePreview, signupView } from "@/lib/signup/flow";
import { fmtDate, todayLocal } from "@/lib/time";
import { BillingTabs, requireBillingViewer } from "../../_components";
import { choosePaymentAction, choosePlanAction, completeSignupAction } from "../actions";

export const metadata = { title: "Sign up" };

const STEPS = [
  { key: "plan", label: "Plan" },
  { key: "documents", label: "Sign" },
  { key: "payment", label: "Pay" },
  { key: "confirm", label: "Confirm" },
] as const;

const per = (interval: string, n: number) => (interval === "month" ? (n === 1 ? "month" : `${n} months`) : interval === "week" ? (n === 1 ? "week" : `${n} weeks`) : interval);
const panel = "min-w-0 rounded-md border border-edge bg-surface p-4 shadow-[0_1px_3px_rgb(16_24_40/0.06)]";

export default async function SignupFlowPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ setup?: string; setup_cancelled?: string }> }) {
  const v = await requireBillingViewer();
  const { id } = await params;
  const sp = await searchParams;
  const today = todayLocal();
  const view = await signupView(db, v, id, today).catch(() => null);
  if (!view) notFound();
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, v.orgId));
  const orgName = org?.name ?? "Teamwork";
  const returned = sp.setup ? await setupReturnView(db, v, sp.setup) : null;
  const link = `${env().APP_URL}/billing/signup/${view.flow.id}`;
  const qr = view.viewerIsStaff && view.current !== "done" ? await QRCode.toDataURL(link, { margin: 1, width: 440, errorCorrectionLevel: "M" }) : null;
  const order = ["plan", "documents", "payment", "confirm", "done"];
  const at = order.indexOf(view.current);
  const cutover = view.flow.kind === "cutover";
  const t = view.terms;
  return (
    <>
      <PageHeader
        kicker={cutover ? "Moving to Teamwork Hub" : "Sign up"}
        title={`${view.athleteName}${t ? ` · ${t.planName}` : ""}`}
        description={cutover ? "Sign the new membership agreement and choose how to pay. Nothing is billed here until the front desk moves the membership over." : "Four short steps. You can stop and come back at any time; nothing is lost."}
      />
      <BillingTabs current="memberships" staff={view.viewerIsStaff} />
      <ol aria-label="Sign-up steps" className="mb-5 grid grid-cols-4 gap-1 text-center text-xs font-semibold sm:text-sm">
        {STEPS.map((s, i) => {
          const done = at > i;
          const current = at === i;
          return (
            <li key={s.key} aria-current={current ? "step" : undefined} className={`rounded-md border px-1 py-2 ${current ? "border-brand bg-brand text-white" : done ? "border-edge bg-surface-2 text-ink" : "border-edge bg-surface text-ink-2"}`}>
              <span className="block">{i + 1}. {s.label}</span>
              <span className="block text-[11px] font-normal">{done ? "Done" : current ? "Now" : "Next"}</span>
            </li>
          );
        })}
      </ol>

      {qr ? (
        <section aria-label="Hand over to the family" className={`${panel} mb-5`}>
          <h2 className="mb-2 text-base font-bold">Hand over to the family</h2>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="QR code that opens this sign-up" width={160} height={160} className="size-40 shrink-0 self-center rounded-md border border-edge bg-white p-2 sm:self-start" />
            <div className="min-w-0 text-sm">
              <p className="text-ink-2">The person who pays for {view.payerName} scans this, signs in, and continues from the same step on their own phone. Card and bank details are only ever entered by them.</p>
              <code className="mt-2 block break-all rounded bg-surface-2 px-2 py-1 text-xs">{link}</code>
            </div>
          </div>
        </section>
      ) : null}

      {returned ? (
        <Callout tone={returned.state === "failed" ? "bad" : returned.state === "active" ? "ok" : "info"} title={returned.state === "active" ? "Payment method saved" : returned.state === "failed" ? "The payment method was not saved" : returned.state === "verification" ? "One more step: verify your bank account" : "We are confirming your payment method"} className="mb-4">
          {returned.state === "active" ? "Choose it below to finish." : returned.state === "failed" ? "Nothing was saved. You can try again below." : returned.state === "verification" ? "Your bank will show two small deposits in 1 to 2 business days. Stripe emails you a link to confirm them. You can finish signing up now and pay each bill yourself until then." : "This usually takes a few seconds. Refresh this page. Nothing has been charged."}
        </Callout>
      ) : null}
      {sp.setup_cancelled ? <Callout tone="info" className="mb-4">You left the secure page before finishing. Nothing was saved.</Callout> : null}

      <div className="grid gap-5 lg:grid-cols-3 [&>*]:min-w-0">
        <div className="space-y-5 lg:col-span-2">
          {/* Step 1 */}
          {!cutover ? (
            <section aria-labelledby="s-plan" className={panel}>
              <h2 id="s-plan" className="mb-3 text-base font-bold">1. Choose a plan</h2>
              {!view.agreementAvailable ? (
                <Callout tone="warn" title="Sign-up is not open yet">The gym has not published its membership agreement. Please ask the front desk.</Callout>
              ) : view.steps.documents || view.current === "done" ? (
                <p className="text-sm text-ink-2">
                  {t?.planName}, starting {fmtDate(view.flow.startDate)}. The agreement for this plan is signed.
                </p>
              ) : view.plans.length === 0 ? (
                <p className="text-sm text-ink-2">No plans are available to choose online right now. Please ask the front desk.</p>
              ) : (
                <ActionForm action={choosePlanAction} className="space-y-4">
                  <input type="hidden" name="flowId" value={view.flow.id} />
                  <fieldset className="space-y-2">
                    <legend className="mb-1 text-sm font-semibold">Plan</legend>
                    {view.plans.map((p) => {
                      const price = planPricePreview(p.priceMinor, view.familyDiscountPercent);
                      return (
                        <label key={p.versionId} className="flex cursor-pointer items-start gap-3 rounded-md border border-edge p-3 text-sm has-[:checked]:border-brand has-[:checked]:bg-surface-2">
                          <input type="radio" name="productVersionId" value={p.versionId} defaultChecked={view.flow.productVersionId === p.versionId} required className="mt-1 size-4" />
                          <span className="min-w-0 flex-1">
                            <span className="block font-semibold">{p.name}</span>
                            <span className="block text-ink-2">
                              {p.unlimited ? "Unlimited sessions" : p.sessionsPerWeek ? `${p.sessionsPerWeek} session${p.sessionsPerWeek === 1 ? "" : "s"} per week` : "See plan details"}
                              {p.commitmentMonths ? ` · ${p.commitmentMonths} month commitment` : " · month to month"}
                              {p.trialDays ? ` · ${p.trialDays} day trial` : ""}
                            </span>
                            <span className="mt-1 block tabular">
                              <span className="font-semibold">{formatMoney(price.netMinor, p.currency)}</span> per {per(p.interval, p.intervalCount)}
                              {price.discountMinor ? <span className="text-ink-2"> (regular {formatMoney(p.priceMinor, p.currency)}, family discount {view.familyDiscountPercent}%)</span> : null}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
                  {view.referralDiscountMinor > 0 ? (
                    <Callout tone="ok" title="New family referral discount">
                      {formatMoney(view.referralDiscountMinor)} comes off your first bill (up to the amount of that bill).
                    </Callout>
                  ) : null}
                  <Field label="Start date" htmlFor="su-start" hint="Bills are issued on the gym's billing day. If you start mid-month, the first bill is a partial month.">
                    <Input id="su-start" name="startDate" type="date" required min={today} defaultValue={view.flow.startDate ?? today} className="min-h-11 sm:max-w-xs" />
                  </Field>
                  <SubmitButton className="min-h-11">{view.steps.plan ? "Update plan" : "Continue"}</SubmitButton>
                </ActionForm>
              )}
            </section>
          ) : null}

          {/* Step 2 */}
          {view.steps.plan ? (
            <section aria-labelledby="s-docs" className={panel}>
              <h2 id="s-docs" className="mb-3 text-base font-bold">2. Review and sign</h2>
              {t && (t.paymentMethodType === "us_bank_account" || !view.steps.documents) && view.documents.some((d) => d.isAgreement && !d.signed) && view.autopay ? (
                <Callout tone="info" className="mb-3">Because bills will be paid from a bank account, the agreement now includes the bank debit authorization. Please sign this updated copy.</Callout>
              ) : null}
              <ul className="space-y-2">
                {view.documents.map((d) => (
                  <li key={d.requestId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-edge px-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <div className="font-semibold">{d.title}</div>
                      <div className="text-xs text-ink-3">{d.isAgreement ? "Membership agreement for this plan" : "Required form"}</div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {d.signed ? <Badge variant="green">Signed</Badge> : <Badge variant="yellow">{d.status === "partially_signed" ? "Partly signed" : "To sign"}</Badge>}
                      <ButtonLink href={`/documents/requests/${d.requestId}?from=signup-${view.flow.id}`} variant={d.signed ? "secondary" : "primary"} size="sm" className="min-h-11">
                        {d.signed ? "View" : "Review and sign"}
                      </ButtonLink>
                    </div>
                  </li>
                ))}
              </ul>
              {view.documents.length === 0 ? <p className="text-sm text-ink-2">Nothing to sign yet.</p> : null}
              <p className="mt-3 text-xs text-ink-3">After signing, come back to this page (Memberships, then Sign up) to continue. The front desk can also witness your signature in person.</p>
            </section>
          ) : null}

          {/* Step 3 */}
          {view.steps.documents || (view.steps.plan && view.flow.paymentChoice) ? (
            <section aria-labelledby="s-pay" className={panel}>
              <h2 id="s-pay" className="mb-3 text-base font-bold">3. How you will pay</h2>
              {view.current === "done" ? (
                <p className="text-sm text-ink-2">{view.autopay && view.autopayMethodLabel ? `Automatic payments with ${view.autopayMethodLabel}.` : "You pay each bill yourself (Pay Now under Bills, or at the front desk)."}</p>
              ) : (
                <div className="space-y-4">
                  {view.autopay && view.autopayMethodLabel ? (
                    <Callout tone="ok" title="Automatic payments are set up">Each bill will be charged to {view.autopayMethodLabel} on its due date.</Callout>
                  ) : null}
                  {view.methods.length ? (
                    <ActionForm action={choosePaymentAction} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="flowId" value={view.flow.id} />
                      <input type="hidden" name="choice" value="autopay" />
                      <label className="text-sm">
                        <span className="mb-1 block font-semibold">Pay automatically with</span>
                        <Select name="methodId" defaultValue={view.methods[0].id} className="min-h-11">
                          {view.methods.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <SubmitButton className="min-h-11">Use for automatic payments</SubmitButton>
                    </ActionForm>
                  ) : null}
                  {view.viewerIsStaff ? (
                    !view.providerConfigured ? (
                      <Callout tone="warn" title="Stripe is not configured">
                        Families cannot save a card or bank account until Stripe keys are set on the server ({view.missingEnv.join(", ")}). Nothing is charged automatically. Choose &quot;pay each bill&quot; below and record payments at the front desk.
                      </Callout>
                    ) : (
                      <Callout tone="info">The family adds their card or bank account on their own phone (use the QR code above). Staff never enter it for them.</Callout>
                    )
                  ) : (
                    <AddMethod payerAccountId={view.flow.payerAccountId} orgName={orgName} configured={view.providerConfigured} signupFlowId={view.flow.id} idPrefix="su" />
                  )}
                  <ActionForm action={choosePaymentAction} className="rounded-md border border-edge p-3">
                    <input type="hidden" name="flowId" value={view.flow.id} />
                    <input type="hidden" name="choice" value="manual" />
                    <h3 className="text-sm font-bold">Pay each bill yourself</h3>
                    <p className="mt-1 text-sm text-ink-2">No payment method is saved. Each bill appears under Bills and is paid there or at the front desk.</p>
                    <SubmitButton variant="secondary" className="mt-3 min-h-11">
                      {view.flow.paymentChoice === "manual" ? "Chosen: pay each bill myself" : "I will pay each bill myself"}
                    </SubmitButton>
                  </ActionForm>
                </div>
              )}
            </section>
          ) : null}

          {/* Step 4 */}
          {view.current === "confirm" ? (
            <section aria-labelledby="s-confirm" className={panel}>
              <h2 id="s-confirm" className="mb-3 text-base font-bold">4. Confirm</h2>
              {cutover ? (
                <p className="text-sm text-ink-2">Finishing tells the front desk everything is ready. Your membership keeps being billed where it is today until they move it over. It is never billed in both places.</p>
              ) : view.firstBill ? (
                <p className="text-sm text-ink-2">
                  Your first bill is <span className="font-semibold tabular text-ink">{formatMoney(view.firstBill.amountMinor, view.firstBill.currency)}</span> on <span className="font-semibold text-ink">{fmtDate(view.firstBill.date)}</span>
                  {view.firstBill.note ? ` (${view.firstBill.note})` : ""}. {view.autopay && view.autopayMethodLabel ? (view.firstBill.date <= today ? `It will be charged to ${view.autopayMethodLabel} today.` : `It will be charged to ${view.autopayMethodLabel} on that date.`) : "Nothing is charged automatically: you pay it under Bills or at the front desk."}
                </p>
              ) : null}
              <ActionForm action={completeSignupAction} className="mt-3">
                <input type="hidden" name="flowId" value={view.flow.id} />
                <SubmitButton className="min-h-11">Finish sign-up</SubmitButton>
              </ActionForm>
            </section>
          ) : null}

          {view.current === "done" ? (
            <section aria-labelledby="s-done" className={panel}>
              <h2 id="s-done" className="mb-2 text-base font-bold">{cutover ? "Ready to move over" : `Welcome, ${view.athleteName.split(" ")[0]}!`}</h2>
              {cutover ? (
                <p className="text-sm text-ink-2">The front desk has been told. They will stop the old charge and then start billing here. You do not need to do anything else.</p>
              ) : (
                <>
                  {view.firstBill ? (
                    <p className="text-sm text-ink-2">
                      First bill: <span className="font-semibold tabular text-ink">{formatMoney(view.firstBill.amountMinor, view.firstBill.currency)}</span> on <span className="font-semibold text-ink">{fmtDate(view.firstBill.date)}</span>
                      {view.firstBill.note ? ` (${view.firstBill.note})` : ""}. {view.autopay && view.autopayMethodLabel ? `Paid automatically with ${view.autopayMethodLabel}. A bank payment shows as pending for a few business days.` : "Pay it under Bills or at the front desk."}
                    </p>
                  ) : null}
                  <h3 className="mt-3 text-sm font-bold">Next steps</h3>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-2">
                    <li>Reserve the first class on the schedule.</li>
                    <li>Bills, payment methods and signed documents are under My Profile.</li>
                  </ul>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <ButtonLink href="/schedule" className="min-h-11">Reserve a class</ButtonLink>
                    <ButtonLink href="/billing/invoices" variant="secondary" className="min-h-11">View bills</ButtonLink>
                  </div>
                </>
              )}
            </section>
          ) : null}
        </div>

        <aside aria-label="Summary" className={`${panel} h-fit`}>
          <h2 className="mb-2 text-base font-bold">Summary</h2>
          {t ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-ink-3">Member</dt>
              <dd>{t.memberName}</dd>
              <dt className="text-ink-3">Plan</dt>
              <dd>{t.planName}</dd>
              <dt className="text-ink-3">Price</dt>
              <dd className="tabular">
                {formatMoney(t.netPriceMinor, t.currency)} per {per(t.interval, t.intervalCount)}
                {t.discountPercent ? ` (family discount ${t.discountPercent}%)` : ""}
              </dd>
              <dt className="text-ink-3">Start</dt>
              <dd>{fmtDate(t.startDate)}</dd>
              {!cutover && t.firstPartial ? (
                <>
                  <dt className="text-ink-3">Partial first month</dt>
                  <dd className="tabular">
                    {formatMoney(t.firstPartial.netAmountMinor, t.currency)} on {fmtDate(t.firstPartial.billDate)}
                  </dd>
                </>
              ) : null}
              {!cutover ? (
                <>
                  <dt className="text-ink-3">Regular bills from</dt>
                  <dd>{fmtDate(t.firstRegularBillDate)}</dd>
                </>
              ) : null}
              <dt className="text-ink-3">Commitment</dt>
              <dd>{t.commitmentMonths ? `${t.commitmentMonths} months, through ${fmtDate(t.commitmentEndsOn)}` : "Month to month"}</dd>
              <dt className="text-ink-3">Cancellation notice</dt>
              <dd>{t.noticeDays} days</dd>
            </dl>
          ) : (
            <p className="text-sm text-ink-2">Choose a plan to see the price, first bill and terms.</p>
          )}
          {view.cutover ? (
            <div className="mt-3 border-t border-edge pt-3 text-sm">
              <div className="font-semibold">Needed before the front desk can move it over</div>
              <ul className="mt-1 space-y-1">
                <li>{view.cutover.agreementSigned ? "✓" : "○"} Membership agreement signed</li>
                <li>{view.cutover.methodOnFile ? "✓" : "○"} Payment method saved</li>
              </ul>
            </div>
          ) : null}
          <p className="mt-3 text-xs text-ink-3">
            <Link href="/billing/signup" className="underline">All sign-ups</Link>
          </p>
        </aside>
      </div>
    </>
  );
}
