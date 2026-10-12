import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, StatusBadge, Table, Td, Th } from "@/components/ui";
import { can } from "@/lib/authz/policy";
import { isBillingStaff } from "@/lib/billing/access";
import { earliestCancelDate } from "@/lib/billing/memberships";
import { membershipDetail, membershipPlanOptions } from "@/lib/billing/queries";
import { formatMoney } from "@/lib/money";
import { fmt, fmtDate, todayLocal } from "@/lib/time";
import { addHoldAction, cancelMembershipAction, changePlanAction, cutoverAction, removeHoldAction } from "../../actions";
import { BillingTabs, InvoiceStatus, Money, PROVIDER_LABEL, requireBillingViewer } from "../../_components";

export const metadata = { title: "Membership" };

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
              <dt className="text-ink-3">Includes</dt><dd>{d.version.unlimited ? "Unlimited sessions" : d.version.creditsPerPeriod ? `${d.version.creditsPerPeriod} credits/period` : "—"}</dd>
              <dt className="text-ink-3">Start</dt><dd>{fmtDate(d.m.startDate)}</dd>
              <dt className="text-ink-3">Anchor day</dt><dd>{d.m.billingAnchorDay ?? "—"}</dd>
              <dt className="text-ink-3">Next bill</dt><dd>{ext ? "Zen Planner" : fmtDate(d.m.nextBillDate)}</dd>
              <dt className="text-ink-3">Commitment</dt><dd>{d.version.commitmentMonths ? `${d.version.commitmentMonths} months` : "None"}</dd>
              <dt className="text-ink-3">Notice</dt><dd>{d.version.cancellationNoticeDays} days</dd>
              <dt className="text-ink-3">Discount</dt><dd>{d.m.discountId ? `Sibling ${d.version.familyDiscount?.siblingPercentOff ?? "?"}%` : "—"}</dd>
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
                {d.credits.buckets.map((b) => <li key={b.id}>{b.available}/{b.granted} · {b.sourceKind.replace("_", " ")} · expires {b.expiresAt ? fmt(b.expiresAt, "MMM d, yyyy") : "never"}</li>)}
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
                    <span>{fmtDate(h.startDate)} – {fmtDate(h.endDate)} <span className="text-ink-3">· {h.reason}</span></span>
                    {manage && !ext && h.endDate >= today ? (
                      <ActionForm action={removeHoldAction}>
                        <input type="hidden" name="holdId" value={h.id} />
                        <SubmitButton size="sm" variant="ghost" confirm="End/remove this hold?">{h.startDate <= today ? "End now" : "Remove"}</SubmitButton>
                      </ActionForm>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-ink-3">Holds pause renewals and credit grants; the next period starts the day after the hold.</p>
          </CardBody>
        </Card>
      </div>

      {manage && !ext && live ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
          <Card>
            <CardHeader title="Add hold / freeze" />
            <CardBody>
              <ActionForm action={addHoldAction} className="space-y-3" resetOnSuccess>
                <input type="hidden" name="membershipId" value={d.m.id} />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="From" htmlFor="hs" required><Input id="hs" name="startDate" type="date" required /></Field>
                  <Field label="Through" htmlFor="he" required><Input id="he" name="endDate" type="date" required /></Field>
                </div>
                <Field label="Reason" htmlFor="hr" required><Input id="hr" name="reason" required /></Field>
                <Field label="Requested on" htmlFor="hq" hint="Date the family asked (for records)"><Input id="hq" name="requestedOn" type="date" /></Field>
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
              <p className="mb-2 text-sm">Earliest end under the terms if requested today: <strong>{fmtDate(earliestCancelDate(d.m, d.version, today))}</strong></p>
              <ActionForm action={cancelMembershipAction} className="space-y-3">
                <input type="hidden" name="membershipId" value={d.m.id} />
                <Field label="Requested on" htmlFor="cr"><Input id="cr" name="requestedOn" type="date" defaultValue={today} /></Field>
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

      <div className="mt-6 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader title="Invoices" />
          <CardBody>
            {d.invoices.length === 0 ? <p className="text-sm text-ink-3">{ext ? "Invoiced by Zen Planner." : "No invoices yet."}</p> : (
              <Table caption="Membership invoices">
                <thead><tr><Th>Number</Th><Th>Period</Th><Th>Status</Th><Th align="right">Balance</Th></tr></thead>
                <tbody>
                  {d.invoices.map(({ invoice: i, money }) => (
                    <tr key={i.id}>
                      <Td><Link href={`/billing/invoices/${i.id}`} className="hover:underline">{i.number}</Link></Td>
                      <Td>{fmtDate(i.periodStart)} – {fmtDate(i.periodEnd)}</Td>
                      <Td><InvoiceStatus status={i.status} dueDate={i.dueDate} today={today} /></Td>
                      <Td align="right"><Money minor={money.balanceMinor} currency={i.currency} /></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
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
