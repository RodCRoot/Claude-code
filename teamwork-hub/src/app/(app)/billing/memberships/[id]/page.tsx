import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, StatusBadge, Table, Td, Th } from "@/components/ui";
import { can } from "@/lib/authz/policy";
import { isBillingStaff } from "@/lib/billing/access";
import { REQUEST_CHANNELS } from "@/db/schema";
import { cancellationPreview, commitmentStatus, earliestCancelDate, periodPrice } from "@/lib/billing/memberships";
import { membershipDetail, membershipPlanOptions } from "@/lib/billing/queries";
import { addMonthsYmd } from "@/lib/billing/util";
import { effectiveNoticeDays, membershipPolicy } from "@/lib/membership-policy";
import { formatMoney } from "@/lib/money";
import { addDaysYmd, fmt, fmtDate, todayLocal } from "@/lib/time";
import { billingMethodView } from "@/lib/billing/subscriptions";
import { addHoldAction, cancelMembershipAction, cancelSubscriptionAction, changePlanAction, cutoverAction, removeHoldAction, startInSeasonAction } from "../../actions";
import { BillingTabs, InvoiceStatus, Money, PROVIDER_LABEL, requireBillingViewer } from "../../_components";
import { BillingMethodCard } from "./_billing-method";

export const metadata = { title: "Membership" };

const CHANNEL_LABELS: Record<(typeof REQUEST_CHANNELS)[number], string> = {
  email: "Email",
  forwarded_email: "Forwarded email",
  sms: "Text message (SMS)",
  messenger: "Messenger",
  phone: "Phone call",
  voice_agent_recap: "Voice agent recap",
  website_form: "Website form",
  in_person: "In person",
};

function ChannelSelect({ id }: { id: string }) {
  return (
    <Select id={id} name="requestChannel" defaultValue="email">
      {REQUEST_CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
    </Select>
  );
}

export default async function MembershipPage({ params }: { params: Promise<{ id: string }> }) {
  const v = await requireBillingViewer();
  const { id } = await params;
  const d = await membershipDetail(db, v, id).catch(() => null);
  if (!d) notFound();
  const staff = isBillingStaff(v);
  const manage = can(v, "billing.manage");
  const today = todayLocal();
  const ext = d.m.billingProvider === "external_zenplanner";
  const live = ["pending", "trialing", "active", "on_hold", "past_due"].includes(d.m.status);
  const plans = manage ? await membershipPlanOptions(db, v.orgId, today) : [];
  const method = manage ? await db.transaction((tx) => billingMethodView(tx, v, d.m.id)) : null;
  const providerBilled = d.m.billingProvider === "stripe" || d.m.billingProvider === "paypal";
  const policy = await membershipPolicy(db, v.orgId);
  const net = await periodPrice(db, d.m, d.version);
  const commitment = commitmentStatus(d.m, d.version, today, net.net);
  const cancelPreview = staff && live && !ext ? await cancellationPreview(db, v.orgId, d.m.id, today) : null;
  const inSeasonPlans = plans.filter((p) => /in.?season/i.test(p.name));
  const suggestedRestart = addMonthsYmd(today, policy.defaultHoldMonths);
  return (
    <>
      <PageHeader
        kicker={`Membership · ${d.payerName ?? "no payer"}`}
        title={`${d.first} ${d.last} — ${d.productName}`}
        actions={<><StatusBadge status={d.m.status} /><Badge>{PROVIDER_LABEL[d.m.billingProvider]}</Badge></>}
      />
      <BillingTabs current="memberships" staff={staff} />
      {ext ? (
        <Callout tone="warn" title="Billed by Zen Planner until cutover" className="mb-4">
          This membership was imported. Zen Planner still charges it, so Teamwork Hub never invoices or charges it (prevents double billing). Changes, holds and cancellations must be made in Zen Planner until the cutover date.
          {manage ? (
            <ActionForm action={cutoverAction} className="mt-3 flex flex-wrap items-end gap-3">
              <input type="hidden" name="membershipId" value={d.m.id} />
              <Field label="First Teamwork bill date" htmlFor="fbd"><Input id="fbd" name="firstBillDate" type="date" required /></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="zpStopped" /> I confirmed the Zen Planner recurring charge is stopped</label>
              <SubmitButton size="sm" variant="secondary" confirm="Switch this membership to Teamwork Hub invoicing?">Cut over</SubmitButton>
            </ActionForm>
          ) : null}
        </Callout>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
        <Card>
          <CardHeader title="Plan & terms" />
          <CardBody>
            <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
              <dt className="text-ink-3">Price</dt><dd><Money minor={d.version.priceMinor} currency={d.version.currency} />/{d.version.interval} (v{d.version.version})</dd>
              <dt className="text-ink-3">Includes</dt><dd>{d.version.classesPerWeek ? `${d.version.classesPerWeek} classes per week` : d.version.unlimited ? "Unlimited sessions" : d.version.creditsPerPeriod ? `${d.version.creditsPerPeriod} credits/period` : "—"}</dd>
              <dt className="text-ink-3">Type</dt><dd>{d.m.kind === "in_season" ? <Badge variant="blue">In Season (fixed term, never renews)</Badge> : "Regular"}</dd>
              <dt className="text-ink-3">Start</dt><dd>{fmtDate(d.m.startDate)}</dd>
              <dt className="text-ink-3">Anchor day</dt><dd>{d.m.billingAnchorDay ?? "—"}</dd>
              <dt className="text-ink-3">Next bill</dt><dd>{ext ? "Zen Planner" : providerBilled ? `${PROVIDER_LABEL[d.m.billingProvider]} subscription` : fmtDate(d.m.nextBillDate)}</dd>
              <dt className="text-ink-3">Commitment</dt><dd>{d.version.commitmentMonths ? `${d.version.commitmentMonths} months` : "None (month-to-month)"}</dd>
              <dt className="text-ink-3">Notice</dt><dd>{effectiveNoticeDays(d.version.cancellationNoticeDays, policy)} days</dd>
              <dt className="text-ink-3">Discount</dt><dd>{net.discount ? <>−<Money minor={net.discount} currency={d.version.currency} /> (family)</> : "—"}</dd>
              <dt className="text-ink-3">Net per period</dt><dd><Money minor={net.net} currency={d.version.currency} /></dd>
              {d.m.cancelAt ? (<><dt className="text-ink-3">Ends</dt><dd>{fmtDate(d.m.cancelAt)}</dd></>) : null}
            </dl>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Session credits" />
          <CardBody>
            <p className="text-3xl font-bold tabular">{d.version.unlimited ? "Unlimited" : d.credits.available}</p>
            <p className="text-sm text-ink-3">{d.version.unlimited ? "while active and paid" : `available · ${d.credits.reserved} reserved for bookings`}</p>
            {d.credits.buckets.length ? (
              <ul className="mt-3 space-y-1 text-xs">
                {d.credits.buckets.map((b) => (
                  <li key={b.id}>
                    {b.available}/{b.granted} · {b.sourceKind === "hold_makeup" ? "punch card (needs an active membership)" : b.sourceKind.replace("_", " ")}
                    {b.sourceKind === "hold_makeup" && b.periodStart ? ` · usable from ${fmtDate(b.periodStart)}` : ""} · expires {b.expiresAt ? fmt(b.expiresAt, "MMM d, yyyy") : "never"}
                  </li>
                ))}
              </ul>
            ) : null}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Holds" />
          <CardBody>
            {d.holds.length === 0 ? <p className="text-sm text-ink-3">No holds.</p> : (
              <ul className="space-y-2 text-sm">
                {d.holds.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {h.kind === "in_season" ? <Badge variant="blue">In season</Badge> : null} {fmtDate(h.startDate)} – {fmtDate(h.endDate)}, restarts {fmtDate(addDaysYmd(h.endDate, 1))}
                      <span className="block text-xs text-ink-3">
                        {h.reason}
                        {h.requestedOn ? ` · requested ${fmtDate(h.requestedOn)}${h.requestChannel ? ` by ${h.requestChannel.replaceAll("_", " ")}` : ""}` : ""}
                        {h.overrideReason ? ` · cap overridden: ${h.overrideReason}` : ""}
                        {h.makeupBucketId ? " · punch card granted" : ""}
                      </span>
                    </span>
                    {manage && !ext && !providerBilled && h.endDate >= today ? (
                      <ActionForm action={removeHoldAction}>
                        <input type="hidden" name="holdId" value={h.id} />
                        <SubmitButton size="sm" variant="ghost" confirm="End/remove this hold?">{h.startDate <= today ? "End now" : "Remove"}</SubmitButton>
                      </ActionForm>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-ink-3">A hold pauses billing (it is never a cancellation); billing resumes on the restart date. Cap: {policy.holdMaxMonthsPerMembershipYear} months per membership year.</p>
          </CardBody>
        </Card>
      </div>

      {commitment || cancelPreview ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          {commitment ? (
            <Card>
              <CardHeader title="Commitment" action={commitment.ended ? <Badge variant="green">Completed: month-to-month</Badge> : <Badge variant="yellow">In term</Badge>} />
              <CardBody>
                <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
                  <dt className="text-ink-3">Term</dt><dd>{commitment.months} months, {fmtDate(commitment.startsOn)} – {fmtDate(commitment.endsOn)}</dd>
                  <dt className="text-ink-3">Months served</dt><dd>{commitment.served}</dd>
                  <dt className="text-ink-3">Months remaining</dt><dd>{commitment.remaining}</dd>
                  <dt className="text-ink-3">Remaining contract value</dt><dd><Money minor={commitment.remainingValueMinor} currency={d.version.currency} /></dd>
                </dl>
                <p className="mt-2 text-xs text-ink-3">After the term the membership continues month-to-month at the committed rate. It never starts a new commitment on its own.</p>
              </CardBody>
            </Card>
          ) : null}
          {cancelPreview ? (
            <Card>
              <CardHeader title="If the family cancels today" />
              <CardBody>
                <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
                  <dt className="text-ink-3">Notice</dt><dd>{cancelPreview.noticeDays} days written notice (any channel)</dd>
                  <dt className="text-ink-3">Effective</dt><dd>{fmtDate(cancelPreview.effectiveOn)}</dd>
                  <dt className="text-ink-3">Last bill date</dt><dd>{fmtDate(cancelPreview.lastBillDate)}</dd>
                  <dt className="text-ink-3">Still to bill</dt><dd>{cancelPreview.remaining.length} period(s), <Money minor={cancelPreview.remainingTotalMinor} currency={d.version.currency} /></dd>
                  <dt className="text-ink-3">Open balance</dt><dd><Money minor={cancelPreview.openBalanceMinor} currency={d.version.currency} /></dd>
                </dl>
              </CardBody>
            </Card>
          ) : null}
        </div>
      ) : null}

      {method && !ext && live ? <BillingMethodCard view={method} /> : null}

      {manage && providerBilled && live ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          <Card>
            <CardHeader title="Cancel subscription at period end" />
            <CardBody>
              <p className="mb-2 text-sm">
                The {PROVIDER_LABEL[d.m.billingProvider]} subscription stops billing; the membership ends when the paid period ends. Terms still apply — earliest end if requested today: <strong>{fmtDate(earliestCancelDate(d.m, { ...d.version, cancellationNoticeDays: effectiveNoticeDays(d.version.cancellationNoticeDays, policy) }, today))}</strong>.
              </p>
              <ActionForm action={cancelSubscriptionAction} className="space-y-3">
                <input type="hidden" name="membershipId" value={d.m.id} />
                <Field label="Requested on" htmlFor="pcr"><Input id="pcr" name="requestedOn" type="date" defaultValue={today} /></Field>
                <Field label="Reason" htmlFor="pcre" required><Input id="pcre" name="reason" required /></Field>
                <Field label="Override terms (reason)" htmlFor="pcor" hint="Only if the notice/commitment would end later than the paid period"><Input id="pcor" name="overrideReason" /></Field>
                <SubmitButton variant="danger" confirm="Cancel the provider subscription at the end of the paid period?">Cancel at period end</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Holds & plan changes" />
            <CardBody>
              <p className="text-sm">Holds and plan changes aren&apos;t available while a provider subscription bills this membership — they would not change what {PROVIDER_LABEL[d.m.billingProvider]} charges. Switch back to Teamwork invoices first.</p>
            </CardBody>
          </Card>
        </div>
      ) : null}

      {manage && !ext && !providerBilled && live ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
          <Card>
            <CardHeader title="Add hold" />
            <CardBody>
              <ActionForm action={addHoldAction} className="space-y-3" resetOnSuccess>
                <input type="hidden" name="membershipId" value={d.m.id} />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Request sent on" htmlFor="hq" required hint="The hold can be backdated to this date"><Input id="hq" name="requestedOn" type="date" required defaultValue={today} /></Field>
                  <Field label="Sent by" htmlFor="hc" required><ChannelSelect id="hc" /></Field>
                  <Field label="Hold starts" htmlFor="hs" required><Input id="hs" name="startDate" type="date" required defaultValue={today} /></Field>
                  <Field label="Firm restart date" htmlFor="hrd" required hint={`Default ${policy.defaultHoldMonths} months`}><Input id="hrd" name="restartDate" type="date" required defaultValue={suggestedRestart} /></Field>
                </div>
                <Field label="Reason" htmlFor="hr" required><Input id="hr" name="reason" required /></Field>
                <details className="text-sm">
                  <summary className="cursor-pointer">Cap override and punch card options</summary>
                  <div className="mt-2 space-y-2">
                    <Field label="Hold cap override reason" htmlFor="hor" hint={`Only if this goes past ${policy.holdMaxMonthsPerMembershipYear} months in the membership year`}><Input id="hor" name="overrideReason" /></Field>
                    <Field label="Unused paid sessions (if the period was already paid)" htmlFor="hus" hint="Leave empty to count from bookings and the weekly limit"><Input id="hus" name="unusedSessions" type="number" min={0} /></Field>
                    <Field label="Reason for that count" htmlFor="husr"><Input id="husr" name="unusedSessionsReason" /></Field>
                    <Field label="Grant a punch card anyway (staff decision, reason)" htmlFor="hgm" hint={`Automatic only for ${policy.holdCreditEligibleCommitmentMonths}-month commitments that are active`}><Input id="hgm" name="grantMakeupReason" /></Field>
                  </div>
                </details>
                <SubmitButton>Save hold</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Upgrade / downgrade" />
            <CardBody>
              <ActionForm action={changePlanAction} className="space-y-3">
                <input type="hidden" name="membershipId" value={d.m.id} />
                <Field label="New plan version" htmlFor="tv" required>
                  <Select id="tv" name="toVersionId" required>
                    {plans.filter((p) => p.versionId !== d.m.productVersionId).map((p) => <option key={p.versionId} value={p.versionId}>{p.name} v{p.version} — {formatMoney(p.priceMinor)}/{p.interval}</option>)}
                  </Select>
                </Field>
                <Field label="Effective" htmlFor="eo" required hint="Today = immediately; future = applied at the first renewal on/after this date"><Input id="eo" name="effectiveOn" type="date" required defaultValue={today} /></Field>
                <Field label="Note" htmlFor="pn"><Input id="pn" name="note" /></Field>
                <SubmitButton>Change plan</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Cancel" />
            <CardBody>
              <p className="mb-2 text-sm">Earliest end under the terms if requested today: <strong>{fmtDate(earliestCancelDate(d.m, { ...d.version, cancellationNoticeDays: effectiveNoticeDays(d.version.cancellationNoticeDays, policy) }, today))}</strong></p>
              <ActionForm action={cancelMembershipAction} className="space-y-3">
                <input type="hidden" name="membershipId" value={d.m.id} />
                <Field label="Request sent on" htmlFor="cr"><Input id="cr" name="requestedOn" type="date" defaultValue={today} /></Field>
                <Field label="Sent by" htmlFor="cch"><ChannelSelect id="cch" /></Field>
                <Field label="Reason" htmlFor="cre" required><Input id="cre" name="reason" required /></Field>
                <details className="text-sm">
                  <summary className="cursor-pointer">Override terms (requires reason)</summary>
                  <div className="mt-2 space-y-2">
                    <Field label="End date" htmlFor="oc"><Input id="oc" name="overrideCancelAt" type="date" /></Field>
                    <Field label="Override reason" htmlFor="or"><Input id="or" name="overrideReason" /></Field>
                  </div>
                </details>
                <SubmitButton variant="danger" confirm="Schedule cancellation?">Schedule cancellation</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
        </div>
      ) : null}

      {manage && !ext && !providerBilled && live && d.m.kind === "regular" ? (
        <Card className="mt-6">
          <CardHeader title="Switch to In Season" kicker={d.version.commitmentMonths >= 12 ? `Cap: ${policy.inSeasonMaxMonthsPer365Days} months per rolling 365 days` : undefined} />
          <CardBody>
            {plans.length === 0 ? <p className="text-sm text-ink-3">Create an In Season membership product first.</p> : (
              <ActionForm action={startInSeasonAction} className="grid gap-3 sm:grid-cols-3 [&>*]:min-w-0" resetOnSuccess>
                <input type="hidden" name="membershipId" value={d.m.id} />
                <Field label="In Season plan" htmlFor="isv" required>
                  <Select id="isv" name="inSeasonVersionId" required>
                    {(inSeasonPlans.length ? inSeasonPlans : plans).map((p) => <option key={p.versionId} value={p.versionId}>{p.name} v{p.version} — {formatMoney(p.priceMinor)}/{p.interval}</option>)}
                  </Select>
                </Field>
                <Field label="Starts" htmlFor="iss" required><Input id="iss" name="startDate" type="date" required defaultValue={today} /></Field>
                <Field label="Ends (last day)" htmlFor="ise" required><Input id="ise" name="endDate" type="date" required /></Field>
                <Field label="Request sent on" htmlFor="isq"><Input id="isq" name="requestedOn" type="date" defaultValue={today} /></Field>
                <Field label="Sent by" htmlFor="isc"><ChannelSelect id="isc" /></Field>
                <Field label="Sport / reason" htmlFor="isr" required><Input id="isr" name="reason" required /></Field>
                <Field label="Cap override reason" htmlFor="iso" hint="Only when over the in-season cap"><Input id="iso" name="overrideReason" /></Field>
                <div className="self-end sm:col-span-2">
                  <SubmitButton confirm="Pause the regular membership and add the In Season membership for these dates?">Start In Season term</SubmitButton>
                </div>
                <p className="text-xs text-ink-3 sm:col-span-3">The regular membership is paused (not cancelled) for these dates and resumes the day after the end date; its commitment carries over. The In Season membership ends on its end date and never auto-renews.</p>
              </ActionForm>
            )}
          </CardBody>
        </Card>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
        <Card className="lg:col-span-2">
          <CardHeader title="Billing ledger" kicker={`${d.invoices.length} invoice${d.invoices.length === 1 ? "" : "s"}`} />
          {d.invoices.length === 0 ? (
            <CardBody>
              <p className="text-sm text-ink-3">{ext ? "Invoiced by Zen Planner." : "No invoices yet."}</p>
            </CardBody>
          ) : (
            <Table caption="Membership invoices" className="[&_table]:min-w-[600px]">
              <thead>
                <tr>
                  <Th className="pl-4">Number</Th>
                  <Th>Period</Th>
                  <Th>Status</Th>
                  <Th align="right">Amount</Th>
                  <Th align="right">Paid</Th>
                  <Th align="right" className="pr-4">Balance</Th>
                </tr>
              </thead>
              <tbody>
                {d.invoices.map(({ invoice: i, money }) => (
                  <tr key={i.id}>
                    <Td className="pl-4"><Link href={`/billing/invoices/${i.id}`} className="font-medium hover:underline">{i.number}</Link></Td>
                    <Td className="whitespace-nowrap">{fmtDate(i.periodStart)} – {fmtDate(i.periodEnd)}</Td>
                    <Td><InvoiceStatus status={i.status} dueDate={i.dueDate} today={today} /></Td>
                    <Td align="right"><Money minor={i.totalMinor} currency={i.currency} /></Td>
                    <Td align="right"><Money minor={money.settledMinor} currency={i.currency} /></Td>
                    <Td align="right" className="pr-4 font-semibold"><Money minor={money.balanceMinor} currency={i.currency} /></Td>
                  </tr>
                ))}
              </tbody>
              {new Set(d.invoices.map((x) => x.invoice.currency)).size === 1 ? (
                <tfoot>
                  <tr className="bg-th font-bold">
                    <th scope="row" colSpan={3} className="border-t-2 border-edge px-4 py-2 text-left text-xs uppercase tracking-wide">Totals (void excluded)</th>
                    {[
                      d.invoices.reduce((s, x) => s + (x.invoice.status === "void" ? 0 : x.invoice.totalMinor), 0),
                      d.invoices.reduce((s, x) => s + (x.invoice.status === "void" ? 0 : x.money.settledMinor), 0),
                      d.invoices.reduce((s, x) => s + (x.invoice.status === "void" ? 0 : x.money.balanceMinor), 0),
                    ].map((m, k) => (
                      <td key={k} className={`border-t-2 border-edge px-3 py-2 text-right whitespace-nowrap ${k === 2 ? "pr-4" : ""}`}>
                        <Money minor={m} currency={d.invoices[0].invoice.currency} />
                      </td>
                    ))}
                  </tr>
                </tfoot>
              ) : null}
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader title="History" />
          <CardBody>
            <ol className="space-y-2 text-sm">
              {d.events.map(({ e, actor }) => (
                <li key={e.id} className="border-l-2 border-edge pl-3">
                  <div className="font-medium">{e.type.replaceAll("_", " ")}{e.effectiveOn ? <span className="font-normal text-ink-3"> · effective {fmtDate(e.effectiveOn)}</span> : null}</div>
                  <div className="text-xs text-ink-3">{fmt(e.createdAt)}{actor ? ` · ${actor}` : " · system"}</div>
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
