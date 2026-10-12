import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardBody, CardHeader, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { listCatalog } from "@/lib/billing/catalog";
import { MANUAL_METHODS } from "@/lib/billing/invoices";
import { onHandCounts } from "@/lib/billing/pos";
import { payerOptions } from "@/lib/billing/queries";
import { formatMoney } from "@/lib/money";
import { todayLocal } from "@/lib/time";
import { posSaleAction, stockAction } from "../actions";
import { BillingTabs, Money, requireBillingStaff } from "../_components";

export const metadata = { title: "Point of sale" };

export default async function PosPage() {
  const v = await requireBillingStaff();
  const today = todayLocal();
  const [catalog, counts, payers] = await Promise.all([listCatalog(db, v.orgId, today), onHandCounts(db, v.orgId), payerOptions(db, v.orgId)]);
  const sellable = catalog.filter((c) => c.product.active && c.current && c.product.kind !== "recurring_membership");
  const retail = catalog.filter((c) => c.product.trackInventory);
  const pairs = payers.flatMap((p) => p.athletes.map((a) => ({ value: `${a.athleteId}:${p.id}`, label: `${a.first} ${a.last} — ${p.name}` })));
  return (
    <>
      <PageHeader kicker="Billing" title="Point of sale" description="Quick counter sales of retail items, packs and drop-ins. Pay offline now (staff attested) or create an invoice to pay online." />
      <BillingTabs current="pos" staff />
      <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
        <Card className="lg:col-span-2">
          <CardHeader title="New sale" />
          <CardBody>
            <ActionForm action={posSaleAction} className="space-y-4" resetOnSuccess>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Customer" htmlFor="athletePayer" hint="Leave as walk-in for anonymous retail. Packs/drop-ins need an athlete (credits).">
                  <Select id="athletePayer" name="athletePayer" defaultValue="">
                    <option value="">Walk-in customer</option>
                    {pairs.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </Select>
                </Field>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold">Items</legend>
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="grid grid-cols-[1fr_6rem] gap-2">
                    <Field label={`Item ${i + 1}`} htmlFor={`item${i}`}>
                      <Select id={`item${i}`} name={`item${i}`} defaultValue="">
                        <option value="">—</option>
                        {sellable.map((c) => (
                          <option key={c.product.id} value={c.product.id}>
                            {c.product.name} — {formatMoney(c.current!.priceMinor)}{c.product.trackInventory ? ` (${counts[c.product.id] ?? 0} on hand)` : ""}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Qty" htmlFor={`qty${i}`}><Input id={`qty${i}`} name={`qty${i}`} type="number" min={0} defaultValue={i === 0 ? 1 : 0} /></Field>
                  </div>
                ))}
              </fieldset>
              <fieldset className="grid gap-3 sm:grid-cols-3">
                <legend className="mb-1 text-sm font-semibold sm:col-span-3">Payment</legend>
                <Field label="How" htmlFor="paymentKind">
                  <Select id="paymentKind" name="paymentKind" defaultValue="manual">
                    <option value="manual">Paid now, offline</option>
                    <option value="invoice">Create invoice (pay online / later)</option>
                  </Select>
                </Field>
                <Field label="Offline method" htmlFor="method">
                  <Select id="method" name="method">{MANUAL_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</Select>
                </Field>
                <Field label="Reference" htmlFor="reference" hint="Required for offline: receipt #, check #, Venmo note"><Input id="reference" name="reference" /></Field>
              </fieldset>
              <SubmitButton pendingText="Recording sale…">Complete sale</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Inventory on hand" />
          <CardBody>
            <Table caption="Inventory" className="[&_table]:min-w-0">
              <thead><tr><Th>Item</Th><Th align="right">On hand</Th><Th align="right">Price</Th></tr></thead>
              <tbody>
                {retail.map((c) => (
                  <tr key={c.product.id}>
                    <Td>{c.product.name}</Td>
                    <Td align="right" className={(counts[c.product.id] ?? 0) <= 2 ? "text-warn font-semibold" : ""}>{counts[c.product.id] ?? 0}</Td>
                    <Td align="right"><Money minor={c.current?.priceMinor ?? null} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <ActionForm action={stockAction} className="mt-4 space-y-3" resetOnSuccess>
              <p className="text-sm font-semibold">Receive / adjust stock</p>
              <Field label="Item" htmlFor="sp">
                <Select id="sp" name="productId" required>{retail.map((c) => <option key={c.product.id} value={c.product.id}>{c.product.name}</option>)}</Select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Change" htmlFor="sd" hint="+ receive, − shrink"><Input id="sd" name="delta" type="number" required /></Field>
                <Field label="Reason" htmlFor="sr">
                  <Select id="sr" name="reason"><option value="receive">Receive</option><option value="adjust">Adjust</option><option value="return">Return</option></Select>
                </Field>
              </div>
              <Field label="Note" htmlFor="sn" hint="Required for adjustments"><Input id="sn" name="note" /></Field>
              <SubmitButton size="sm" variant="secondary">Update stock</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
