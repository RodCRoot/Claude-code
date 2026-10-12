import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select, StatusBadge, Table, Td, Th } from "@/components/ui";
import { isBillingStaff } from "@/lib/billing/access";
import { listMemberships, membershipPlanOptions, payerOptions } from "@/lib/billing/queries";
import { formatMoney } from "@/lib/money";
import { fmtDate, todayLocal } from "@/lib/time";
import { createMembershipAction } from "../actions";
import { BillingTabs, Money, PROVIDER_LABEL, requireBillingViewer } from "../_components";

export const metadata = { title: "Memberships" };

const FILTERS = ["all", "active", "trialing", "pending", "past_due", "on_hold", "cancelled"];

export default async function MembershipsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const v = await requireBillingViewer();
  const staff = isBillingStaff(v);
  const { status = "all" } = await searchParams;
  const rows = await listMemberships(db, v, { status });
  return (
    <>
      <PageHeader kicker="Billing" title="Memberships" />
      <BillingTabs current="memberships" staff={staff} />
      <nav aria-label="Filter memberships" className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link key={f} href={f === "all" ? "/billing/memberships" : `/billing/memberships?status=${f}`} aria-current={status === f ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${status === f ? "border-brand bg-brand text-brand-ink" : "border-edge text-ink-2 hover:bg-surface-2"}`}>
            {f.replace("_", " ")}
          </Link>
        ))}
      </nav>
      <Card>
        <CardBody className="pt-4">
          {rows.length === 0 ? (
            <EmptyState title="No memberships" />
          ) : (
            <Table caption="Memberships">
              <thead>
                <tr><Th>Athlete</Th><Th>Plan</Th><Th>Status</Th><Th>Billed by</Th><Th>Next bill</Th>{staff ? <Th>Payer</Th> : null}<Th align="right">Price</Th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.m.id}>
                    <Td><Link className="font-medium hover:underline" href={`/billing/memberships/${r.m.id}`}>{r.first} {r.last}</Link></Td>
                    <Td>{r.productName} <span className="text-xs text-ink-3">v{r.version}</span></Td>
                    <Td><StatusBadge status={r.m.status} />{r.m.cancelAt && r.m.status !== "cancelled" ? <div className="text-xs text-ink-3">ends {fmtDate(r.m.cancelAt)}</div> : null}</Td>
                    <Td>{r.m.billingProvider === "external_zenplanner" ? <Badge title="Billed by Zen Planner until cutover — never invoiced here">Zen Planner</Badge> : PROVIDER_LABEL[r.m.billingProvider]}</Td>
                    <Td>{r.m.billingProvider === "external_zenplanner" ? "—" : fmtDate(r.m.nextBillDate)}</Td>
                    {staff ? <Td>{r.payerName ?? "—"}</Td> : null}
                    <Td align="right"><Money minor={r.priceMinor} currency={r.currency} />/{r.interval}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
      {staff ? <NewMembership orgId={v.orgId} /> : null}
    </>
  );
}

async function NewMembership({ orgId }: { orgId: string }) {
  const today = todayLocal();
  const [payers, plans] = await Promise.all([payerOptions(db, orgId), membershipPlanOptions(db, orgId, today)]);
  const pairs = payers.flatMap((p) => p.athletes.map((a) => ({ value: `${a.athleteId}:${p.id}`, label: `${a.first} ${a.last} — paid by ${p.name}` })));
  return (
    <Card className="mt-6" id="new">
      <CardHeader title="New membership" kicker="Staff" />
      <CardBody>
        {plans.length === 0 ? (
          <Callout tone="warn">Create a recurring membership product first (Products tab).</Callout>
        ) : (
          <ActionForm action={createMembershipAction} className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <Field label="Athlete & payer" htmlFor="athletePayer" required>
              <Select id="athletePayer" name="athletePayer" required defaultValue="">
                <option value="" disabled>Choose…</option>
                {pairs.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </Select>
            </Field>
            <Field label="Plan (version)" htmlFor="productVersionId" required>
              <Select id="productVersionId" name="productVersionId" required>
                {plans.map((p) => (
                  <option key={p.versionId} value={p.versionId}>
                    {p.name} v{p.version} — {formatMoney(p.priceMinor, p.currency)}/{p.interval} (from {p.effectiveFrom}){p.sibling?.siblingPercentOff ? ` · sibling ${p.sibling.siblingPercentOff}%` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Start date" htmlFor="startDate" required><Input id="startDate" name="startDate" type="date" required defaultValue={today} /></Field>
            <Field label="Billing anchor day" htmlFor="anchorDay" hint="Day of month renewals bill (1–31; short months clamp). Defaults to the start day."><Input id="anchorDay" name="anchorDay" type="number" min={1} max={31} /></Field>
            <Field label="Billed through" htmlFor="billingProvider" hint="Teamwork invoices can be paid online or offline. Provider subscriptions are not created automatically yet.">
              <Select id="billingProvider" name="billingProvider" defaultValue="manual">
                <option value="manual">Teamwork Hub invoices (pay online or offline)</option>
                <option value="none">Complimentary — no billing</option>
              </Select>
            </Field>
            <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" name="familyDiscount" /> Apply the plan&apos;s configured sibling discount</label>
            <div className="sm:col-span-2">
              <p className="mb-2 text-xs text-ink-3">If the plan has trial days, the first invoice is created when the trial ends. Otherwise the first period is invoiced now and the membership becomes active when it is paid.</p>
              <SubmitButton pendingText="Creating…">Create membership</SubmitButton>
            </div>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
