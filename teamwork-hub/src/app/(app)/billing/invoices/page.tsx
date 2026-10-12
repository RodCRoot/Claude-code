import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { isBillingStaff } from "@/lib/billing/access";
import { listCatalog } from "@/lib/billing/catalog";
import { listInvoices, payerOptions } from "@/lib/billing/queries";
import { formatMoney } from "@/lib/money";
import { fmtDate, todayLocal } from "@/lib/time";
import { createInvoiceAction } from "../actions";
import { BillingTabs, InvoiceStatus, Money, requireBillingViewer } from "../_components";

export const metadata = { title: "Invoices" };

const FILTERS = ["all", "open", "past_due", "paid", "draft", "void", "uncollectible"];

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const v = await requireBillingViewer();
  const { status = "all" } = await searchParams;
  const staff = isBillingStaff(v);
  const today = todayLocal();
  const rows = await listInvoices(db, v, { status });
  return (
    <>
      <PageHeader kicker="Billing" title={staff ? "Invoices" : "Invoices & receipts"} />
      <BillingTabs current="invoices" staff={staff} />
      <nav aria-label="Filter invoices" className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={f === "all" ? "/billing/invoices" : `/billing/invoices?status=${f}`}
            aria-current={status === f ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${status === f ? "border-brand bg-brand text-brand-ink" : "border-edge text-ink-2 hover:bg-surface-2"}`}
          >
            {f.replace("_", " ")}
          </Link>
        ))}
      </nav>
      <Card>
        <CardBody className="pt-4">
          {rows.length === 0 ? (
            <EmptyState title="No invoices" />
          ) : (
            <Table caption="Invoices">
              <thead>
                <tr>
                  <Th>Number</Th>
                  {staff ? <Th>Payer</Th> : null}
                  <Th>Due</Th>
                  <Th>Status</Th>
                  <Th align="right">Total</Th>
                  <Th align="right">Settled</Th>
                  <Th align="right">Pending</Th>
                  <Th align="right">Balance</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.invoice.id}>
                    <Td>
                      <Link className="font-medium hover:underline" href={`/billing/invoices/${r.invoice.id}`}>{r.invoice.number}</Link>
                      {r.invoice.isDemo ? <Badge className="ml-1" variant="yellow">DEMO</Badge> : null}
                      <div className="text-xs text-ink-3">{r.invoice.source.replaceAll("_", " ")}</div>
                    </Td>
                    {staff ? <Td>{r.payerName}</Td> : null}
                    <Td>{fmtDate(r.invoice.dueDate)}</Td>
                    <Td><InvoiceStatus status={r.invoice.status} dueDate={r.invoice.dueDate} today={today} /></Td>
                    <Td align="right"><Money minor={r.invoice.totalMinor} currency={r.invoice.currency} /></Td>
                    <Td align="right"><Money minor={r.money.settledMinor} currency={r.invoice.currency} /></Td>
                    <Td align="right">{r.money.pendingMinor ? <span className="text-warn"><Money minor={r.money.pendingMinor} /></span> : "—"}</Td>
                    <Td align="right" className="font-semibold"><Money minor={r.invoice.status === "void" ? 0 : r.money.balanceMinor} currency={r.invoice.currency} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
      {staff ? <NewInvoice orgId={v.orgId} today={today} /> : null}
    </>
  );
}

async function NewInvoice({ orgId, today }: { orgId: string; today: string }) {
  const [payers, catalog] = await Promise.all([payerOptions(db, orgId), listCatalog(db, orgId, today)]);
  const sellable = catalog.filter((c) => c.product.active && c.current && c.product.kind !== "recurring_membership");
  const athletes = payers.flatMap((p) => p.athletes.map((a) => ({ ...a, payer: p.name })));
  return (
    <Card className="mt-6" id="new">
      <CardHeader title="New manual invoice" kicker="Staff" />
      <CardBody>
        <ActionForm action={createInvoiceAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3 [&>*]:min-w-0">
            <Field label="Payer account" htmlFor="payerAccountId" required>
              <Select id="payerAccountId" name="payerAccountId" required defaultValue="">
                <option value="" disabled>Choose…</option>
                {payers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            <Field label="Due date" htmlFor="dueDate" hint="Defaults to the org's due-days setting">
              <Input id="dueDate" name="dueDate" type="date" />
            </Field>
            <Field label="Invoice discount ($)" htmlFor="discount" hint="Optional, e.g. 10.00">
              <Input id="discount" name="discount" inputMode="decimal" placeholder="0.00" />
            </Field>
          </div>
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold">Lines — pick a catalog product (price comes from its current version) or type a custom line</legend>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="grid gap-2 rounded-lg border border-edge p-3 sm:grid-cols-12">
                <Field label={`Product ${i + 1}`} htmlFor={`line${i}Product`} className="sm:col-span-3">
                  <Select id={`line${i}Product`} name={`line${i}Product`} defaultValue="">
                    <option value="">— custom line —</option>
                    {sellable.map((c) => <option key={c.product.id} value={c.product.id}>{c.product.name} ({formatMoney(c.current!.priceMinor)})</option>)}
                  </Select>
                </Field>
                <Field label="Description" htmlFor={`line${i}Desc`} className="sm:col-span-3">
                  <Input id={`line${i}Desc`} name={`line${i}Desc`} placeholder="Custom description" />
                </Field>
                <Field label="Amount ($)" htmlFor={`line${i}Amount`} className="sm:col-span-2">
                  <Input id={`line${i}Amount`} name={`line${i}Amount`} inputMode="decimal" placeholder="custom only" />
                </Field>
                <Field label="Qty" htmlFor={`line${i}Qty`} className="sm:col-span-1">
                  <Input id={`line${i}Qty`} name={`line${i}Qty`} type="number" min={1} defaultValue={1} />
                </Field>
                <Field label="Athlete (for credits)" htmlFor={`line${i}Athlete`} className="sm:col-span-3">
                  <Select id={`line${i}Athlete`} name={`line${i}Athlete`} defaultValue="">
                    <option value="">—</option>
                    {athletes.map((a) => <option key={`${a.payerAccountId}-${a.athleteId}`} value={a.athleteId}>{a.first} {a.last} ({a.payer})</option>)}
                  </Select>
                </Field>
              </div>
            ))}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <Field label="Memo" htmlFor="memo"><Input id="memo" name="memo" /></Field>
            <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" name="draft" /> Save as draft (not visible as due until issued)</label>
          </div>
          <SubmitButton pendingText="Creating…">Create invoice</SubmitButton>
        </ActionForm>
      </CardBody>
    </Card>
  );
}
