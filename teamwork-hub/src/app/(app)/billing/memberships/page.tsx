import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Button, Callout, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select, StatusBadge, Table, Td, Th } from "@/components/ui";
import type { Viewer } from "@/lib/authz/policy";
import { isBillingStaff } from "@/lib/billing/access";
import { UserError } from "@/lib/billing/errors";
import { previewMembershipStart } from "@/lib/billing/memberships";
import { listMemberships, membershipPlanOptions, payerOptions } from "@/lib/billing/queries";
import { PRORATION_LABELS } from "@/lib/membership-policy";
import { formatMoney } from "@/lib/money";
import { fmtDate, todayLocal } from "@/lib/time";
import { createMembershipAction } from "../actions";
import { BillingTabs, Money, PROVIDER_LABEL, requireBillingViewer } from "../_components";
import { MemberAvatar, Segmented } from "@/components/profile/studio";

export const metadata = { title: "Memberships" };

const FILTERS = ["all", "active", "trialing", "pending", "past_due", "on_hold", "cancelled"];

/** Sum of list prices per currency + billing interval (never mixes intervals into one number). */
function listTotals(rows: { priceMinor: number; currency: string; interval: string }[]) {
  const by = new Map<string, { minor: number; currency: string; interval: string }>();
  for (const r of rows) {
    const k = `${r.currency}|${r.interval}`;
    const cur = by.get(k) ?? { minor: 0, currency: r.currency, interval: r.interval };
    cur.minor += r.priceMinor;
    by.set(k, cur);
  }
  return [...by.values()];
}

type Search ={ status?: string; athletePayer?: string; productVersionId?: string; startDate?: string; preview?: string };

export default async function MembershipsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const v = await requireBillingViewer();
  const staff = isBillingStaff(v);
  const sp = await searchParams;
  const status = sp.status ?? "all";
  const rows = await listMemberships(db, v, { status });
  return (
    <>
      <PageHeader kicker="Billing" title="Memberships" />
      <BillingTabs current="memberships" staff={staff} />
      <section aria-label="Membership ledger" className="min-w-0 overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge bg-th px-3 py-2.5 sm:px-4">
          <Segmented
            label="Filter memberships"
            items={FILTERS.map((f) => ({ href: f === "all" ? "/billing/memberships" : `/billing/memberships?status=${f}`, label: f.replace("_", " "), current: status === f }))}
          />
          <p className="text-xs text-ink-2">
            <strong className="tabular">{rows.length}</strong> membership{rows.length === 1 ? "" : "s"}
          </p>
        </div>
        {rows.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No memberships" />
          </div>
        ) : (
          <Table caption="Memberships" className="[&_table]:min-w-[720px]">
            <thead>
              <tr><Th className="pl-4">Member</Th><Th>Plan</Th><Th>Status</Th><Th>Billed by</Th><Th>Next bill</Th>{staff ? <Th>Payer</Th> : null}<Th align="right" className="pr-4">Price</Th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.m.id}>
                  <Td className="pl-4">
                    <Link className="flex items-center gap-2 font-semibold hover:underline" href={`/billing/memberships/${r.m.id}`}>
                      <MemberAvatar name={`${r.first} ${r.last}`} size="sm" />
                      {r.first} {r.last}
                    </Link>
                  </Td>
                  <Td>{r.productName} <span className="text-xs text-ink-3">v{r.version}</span>{r.m.kind === "in_season" ? <> <Badge variant="blue">In Season</Badge></> : null}</Td>
                  <Td><StatusBadge status={r.m.status} />{r.m.cancelAt && r.m.status !== "cancelled" ? <div className="text-xs text-ink-3">ends {fmtDate(r.m.cancelAt)}</div> : null}</Td>
                  <Td>{r.m.billingProvider === "external_zenplanner" ? <Badge title="Billed by Zen Planner until cutover — never invoiced here">Zen Planner</Badge> : PROVIDER_LABEL[r.m.billingProvider]}</Td>
                  <Td className="tabular whitespace-nowrap">{r.m.billingProvider === "external_zenplanner" ? "—" : fmtDate(r.m.nextBillDate)}</Td>
                  {staff ? <Td>{r.payerName ?? "—"}</Td> : null}
                  <Td align="right" className="pr-4 whitespace-nowrap"><Money minor={r.priceMinor} currency={r.currency} /><span className="text-xs text-ink-3">/{r.interval}</span></Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-th font-bold">
                <th scope="row" colSpan={staff ? 6 : 5} className="border-t-2 border-edge px-4 py-2 text-left text-xs uppercase tracking-wide">
                  List-price total of rows shown · {rows.length} membership{rows.length === 1 ? "" : "s"}
                </th>
                <td className="border-t-2 border-edge px-4 py-2 text-right tabular whitespace-nowrap">
                  {listTotals(rows).map((t, i) => (
                    <div key={i}>
                      <Money minor={t.minor} currency={t.currency} />
                      <span className="text-xs font-normal text-ink-3">/{t.interval}</span>
                    </div>
                  ))}
                </td>
              </tr>
            </tfoot>
          </Table>
        )}
      </section>
      {staff ? <NewMembership viewer={v} search={sp} /> : null}
    </>
  );
}

async function NewMembership({ viewer, search }: { viewer: Viewer; search: Search }) {
  const today = todayLocal();
  const [payers, plans] = await Promise.all([payerOptions(db, viewer.orgId), membershipPlanOptions(db, viewer.orgId, today)]);
  const pairs = payers.flatMap((p) => p.athletes.map((a) => ({ value: `${a.athleteId}:${p.id}`, label: `${a.first} ${a.last} — paid by ${p.name}` })));
  const [athleteId, payerAccountId] = (search.athletePayer ?? "").split(":");
  let preview: Awaited<ReturnType<typeof previewMembershipStart>> | null = null;
  let previewError: string | null = null;
  if (search.preview && athleteId && payerAccountId && search.productVersionId && search.startDate) {
    try {
      preview = await db.transaction((tx) => previewMembershipStart(tx, viewer, { athleteId, payerAccountId, productVersionId: search.productVersionId!, startDate: search.startDate! }));
    } catch (e) {
      previewError = e instanceof UserError ? e.message : "Could not compute the first bill. Check the plan and start date.";
    }
  }
  return (
    <Card className="mt-6" id="new">
      <CardHeader title="New membership" kicker="Staff" />
      <CardBody className="space-y-4">
        {plans.length === 0 ? (
          <Callout tone="warn">Create a recurring membership product first (Products tab).</Callout>
        ) : (
          <>
            <form method="get" action="/billing/memberships#new" className="grid gap-4 sm:grid-cols-3 [&>*]:min-w-0">
              <input type="hidden" name="preview" value="1" />
              <Field label="Athlete & payer" htmlFor="athletePayer" required>
                <Select id="athletePayer" name="athletePayer" required defaultValue={search.athletePayer ?? ""}>
                  <option value="" disabled>Choose…</option>
                  {pairs.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </Select>
              </Field>
              <Field label="Plan (version)" htmlFor="productVersionId" required>
                <Select id="productVersionId" name="productVersionId" required defaultValue={search.productVersionId}>
                  {plans.map((p) => (
                    <option key={p.versionId} value={p.versionId}>
                      {p.name} v{p.version} — {formatMoney(p.priceMinor, p.currency)}/{p.interval}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Start date" htmlFor="startDate" required><Input id="startDate" name="startDate" type="date" required defaultValue={search.startDate ?? today} /></Field>
              <div className="sm:col-span-3">
                <Button type="submit" variant="secondary">Preview first bill</Button>
                <p className="mt-2 text-xs text-ink-3">Monthly plans bill on the policy billing day (the 1st). A mid-month start gets a first partial-month (stub) invoice through the end of the month; you will see the computation before anything is created.</p>
              </div>
            </form>
            {previewError ? <Callout tone="bad">{previewError}</Callout> : null}
            {preview ? (
              <div className="rounded-xl border border-edge p-4">
                <h3 className="mb-2 font-semibold">First bill for {preview.productName}</h3>
                <dl className="grid grid-cols-2 gap-y-1.5 text-sm sm:grid-cols-4">
                  {preview.stub ? (
                    <>
                      <dt className="text-ink-3">Stub period</dt><dd>{fmtDate(preview.stub.periodStart)} – {fmtDate(preview.stub.periodEnd)} ({preview.stub.coveredDays} of {preview.stub.periodDays} days)</dd>
                      <dt className="text-ink-3">Rule</dt><dd>{PRORATION_LABELS[preview.prorationMethod]}: {preview.stub.rule}</dd>
                      <dt className="text-ink-3">Stub amount</dt><dd><Money minor={preview.stub.grossMinor} />{preview.stub.discountMinor ? <> − <Money minor={preview.stub.discountMinor} /> family = <strong><Money minor={preview.stub.netMinor} /></strong></> : null}</dd>
                    </>
                  ) : (
                    <><dt className="text-ink-3">Stub</dt><dd>None (starts on the billing day{preview.version.interval === "week" ? " or bills weekly" : ""})</dd></>
                  )}
                  <dt className="text-ink-3">Regular billing</dt><dd>from {fmtDate(preview.firstRegularBillDate)}{preview.anchorDay ? `, every month on day ${preview.anchorDay}` : `, every ${preview.version.interval}`}</dd>
                  <dt className="text-ink-3">Regular amount</dt><dd><Money minor={preview.regular.netMinor} />{preview.discountPercent ? ` (after ${preview.discountPercent}% family discount)` : ""}</dd>
                  <dt className="text-ink-3">Commitment</dt><dd>{preview.commitment ? `${preview.commitment.months} months, ${fmtDate(preview.commitment.startsOn)} – ${fmtDate(preview.commitment.endsOn)}, then month-to-month at the same rate` : "None (month-to-month)"}</dd>
                  <dt className="text-ink-3">Weekly classes</dt><dd>{preview.version.classesPerWeek ? `${preview.version.classesPerWeek} per week` : preview.version.unlimited ? "Unlimited" : "—"}</dd>
                </dl>
                <ActionForm action={createMembershipAction} className="mt-4 grid gap-4 sm:grid-cols-3 [&>*]:min-w-0">
                  <input type="hidden" name="athletePayer" value={search.athletePayer} />
                  <input type="hidden" name="productVersionId" value={search.productVersionId} />
                  <input type="hidden" name="startDate" value={search.startDate} />
                  <Field label="Billed through" htmlFor="billingProvider">
                    <Select id="billingProvider" name="billingProvider" defaultValue="manual">
                      <option value="manual">Teamwork Hub invoices (pay online or offline)</option>
                      <option value="none">Complimentary — no billing</option>
                    </Select>
                  </Field>
                  {preview.stub ? (
                    <>
                      <Field label="Override stub amount ($)" htmlFor="stubOverride" hint="Leave empty to use the policy amount."><Input id="stubOverride" name="stubOverride" inputMode="decimal" /></Field>
                      <Field label="Override reason" htmlFor="stubOverrideReason" hint="Required with an override (audited)."><Input id="stubOverrideReason" name="stubOverrideReason" /></Field>
                    </>
                  ) : null}
                  <div className="sm:col-span-3">
                    <SubmitButton pendingText="Creating…" confirm="Create this membership and its first invoice?">Confirm and create membership</SubmitButton>
                  </div>
                </ActionForm>
              </div>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}
