import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { Widget } from "@/components/profile/studio";
import { listCatalog } from "@/lib/billing/catalog";
import { MANUAL_METHODS } from "@/lib/billing/invoices";
import { onHandCounts } from "@/lib/billing/pos";
import { payerOptions } from "@/lib/billing/queries";
import { todayLocal } from "@/lib/time";
import { posSaleAction, stockAction } from "../actions";
import { BillingTabs, Money, requireBillingStaff } from "../_components";
import { PosTerminal } from "./_components/pos-terminal";

export const metadata = { title: "Point of sale" };

export default async function PosPage() {
  const v = await requireBillingStaff();
  const today = todayLocal();
  const [catalog, counts, payers] = await Promise.all([listCatalog(db, v.orgId, today), onHandCounts(db, v.orgId), payerOptions(db, v.orgId)]);
  const sellable = catalog.filter((c) => c.product.active && c.current && c.product.kind !== "recurring_membership");
  const retail = catalog.filter((c) => c.product.trackInventory);
  const pairs = payers.flatMap((p) => p.athletes.map((a) => ({ value: `${a.athleteId}:${p.id}`, label: `${a.first} ${a.last} — ${p.name}` })));
  const products = sellable.map((c) => ({
    id: c.product.id,
    name: c.product.name,
    priceMinor: c.current!.priceMinor,
    currency: c.current!.currency,
    kind: c.product.kind,
    onHand: c.product.trackInventory ? (counts[c.product.id] ?? 0) : null,
  }));
  return (
    <>
      <PageHeader kicker="Billing" title="Point of sale" description="Quick counter sales of retail items, packs and drop-ins. Pay offline now (staff attested) or create an invoice to pay online." />
      <BillingTabs current="pos" staff />
      <PosTerminal products={products} customers={pairs} methods={MANUAL_METHODS} saleAction={posSaleAction}>
        <Widget title="Inventory on hand" icon="documents" count={retail.length} flush>
          <Table caption="Inventory" className="[&_table]:min-w-0">
            <thead>
              <tr>
                <Th className="pl-4">Item</Th>
                <Th align="right">On hand</Th>
                <Th align="right" className="pr-4">Price</Th>
              </tr>
            </thead>
            <tbody>
              {retail.map((c) => (
                <tr key={c.product.id}>
                  <Td className="pl-4">{c.product.name}</Td>
                  <Td align="right" className={(counts[c.product.id] ?? 0) <= 2 ? "font-semibold text-warn" : ""}>
                    {counts[c.product.id] ?? 0}
                  </Td>
                  <Td align="right" className="pr-4">
                    <Money minor={c.current?.priceMinor ?? null} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <details className="border-t border-edge px-4 py-3">
            <summary className="min-h-9 cursor-pointer py-1 text-sm font-semibold text-brand">Receive / adjust stock</summary>
            <ActionForm action={stockAction} className="mt-2 grid gap-3 sm:grid-cols-2" resetOnSuccess>
              <Field label="Item" htmlFor="sp">
                <Select id="sp" name="productId" required>
                  {retail.map((c) => (
                    <option key={c.product.id} value={c.product.id}>
                      {c.product.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Change" htmlFor="sd" hint="+ receive, − shrink">
                  <Input id="sd" name="delta" type="number" required />
                </Field>
                <Field label="Reason" htmlFor="sr">
                  <Select id="sr" name="reason">
                    <option value="receive">Receive</option>
                    <option value="adjust">Adjust</option>
                    <option value="return">Return</option>
                  </Select>
                </Field>
              </div>
              <Field label="Note" htmlFor="sn" hint="Required for adjustments" className="sm:col-span-2">
                <Input id="sn" name="note" />
              </Field>
              <div>
                <SubmitButton size="sm" variant="secondary">
                  Update stock
                </SubmitButton>
              </div>
            </ActionForm>
          </details>
        </Widget>
      </PosTerminal>
    </>
  );
}
