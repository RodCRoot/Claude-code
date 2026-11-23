import { Fragment } from "react";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { Widget } from "@/components/profile/studio";
import { listCatalog } from "@/lib/billing/catalog";
import { MANUAL_METHODS } from "@/lib/billing/invoices";
import { LOW_STOCK_AT, stockByVariant, UNASSIGNED } from "@/lib/billing/pos";
import { payerOptions } from "@/lib/billing/queries";
import { salesTaxSettings } from "@/lib/billing/sales-tax";
import { optionNameOf, variantLineDescription, variantsByProduct } from "@/lib/billing/variants";
import { todayLocal } from "@/lib/time";
import { moveStockAction, posSaleAction, stockAction } from "../actions";
import { BillingTabs, Money, requireBillingStaff } from "../_components";
import { PosTerminal, type PosProduct } from "./_components/pos-terminal";

export const metadata = { title: "Point of sale" };

export default async function PosPage() {
  const v = await requireBillingStaff();
  const today = todayLocal();
  const [catalog, stock, payers, variants, tax] = await Promise.all([listCatalog(db, v.orgId, today), stockByVariant(db, v.orgId), payerOptions(db, v.orgId), variantsByProduct(db, v.orgId), salesTaxSettings(db, v.orgId)]);
  const sellable = catalog.filter((c) => c.product.active && c.current && c.product.kind !== "recurring_membership");
  const retail = catalog.filter((c) => c.product.trackInventory);
  const pairs = payers.flatMap((p) => p.athletes.map((a) => ({ value: `${a.athleteId}:${p.id}`, label: `${a.first} ${a.last} — ${p.name}` })));
  const count = (productId: string, variantId: string) => stock[productId]?.[variantId] ?? 0;
  const total = (productId: string) => Object.values(stock[productId] ?? {}).reduce((s, n) => s + n, 0);
  // One cart entry per thing that can be rung up: a product, or each active variant of a product that has them.
  const products: PosProduct[] = sellable.flatMap((c): PosProduct[] => {
    const p = c.product;
    const base = { productId: p.id, productName: p.name, currency: c.current!.currency, kind: p.kind, taxable: p.kind === "retail" && p.taxable };
    const active = (variants.get(p.id) ?? []).filter((x) => x.active);
    if (!active.length) return [{ ...base, id: p.id, name: p.name, variantLabel: null, optionName: null, priceMinor: c.current!.priceMinor, onHand: p.trackInventory ? count(p.id, UNASSIGNED) : null }];
    const opt = optionNameOf(p);
    return active.map((x) => ({ ...base, id: `${p.id}:${x.id}`, name: variantLineDescription(p.name, opt, x.label), variantLabel: x.label, optionName: opt, priceMinor: x.priceMinor ?? c.current!.priceMinor, onHand: p.trackInventory ? count(p.id, x.id) : null }));
  });
  // Stock form: a product's own count, or one entry per variant (plus its unassigned stock when there is any).
  const stockTargets = retail.flatMap((c) => {
    const vs = variants.get(c.product.id) ?? [];
    if (!vs.length) return [{ value: c.product.id, label: c.product.name }];
    const opt = optionNameOf(c.product);
    return [
      ...vs.map((x) => ({ value: `${c.product.id}:${x.id}`, label: `${variantLineDescription(c.product.name, opt, x.label)}${x.active ? "" : " (inactive)"}` })),
      ...(count(c.product.id, UNASSIGNED) !== 0 ? [{ value: `${c.product.id}:`, label: `${c.product.name}, unassigned (adjust only)` }] : []),
    ];
  });
  const unassigned = retail.filter((c) => (variants.get(c.product.id) ?? []).length && count(c.product.id, UNASSIGNED) > 0);
  const low = (n: number) => (n <= LOW_STOCK_AT ? "font-semibold text-warn" : "");
  return (
    <>
      <PageHeader kicker="Billing" title="Point of sale" description="Quick counter sales of retail items, packs and drop-ins. Pay offline now (staff attested) or create an invoice to pay online." />
      <BillingTabs current="pos" staff />
      <PosTerminal products={products} customers={pairs} methods={MANUAL_METHODS} saleAction={posSaleAction} taxRateBps={tax.rateBps} taxLabel={tax.label}>
        <Widget title="Inventory on hand" icon="documents" count={retail.length} flush>
          <Table caption="Inventory by item and variant" className="[&_table]:min-w-0">
            <thead>
              <tr>
                <Th className="pl-4">Item</Th>
                <Th align="right">On hand</Th>
                <Th align="right" className="pr-4">Price</Th>
              </tr>
            </thead>
            <tbody>
              {retail.map((c) => {
                const vs = variants.get(c.product.id) ?? [];
                const opt = optionNameOf(c.product);
                return (
                  <Fragment key={c.product.id}>
                    <tr>
                      <Td className="pl-4 font-medium">
                        {c.product.name}
                        {vs.length ? <span className="font-normal text-ink-3"> · total</span> : null}
                      </Td>
                      <Td align="right" className={vs.length ? "font-semibold" : low(total(c.product.id))}>
                        {total(c.product.id)}
                      </Td>
                      <Td align="right" className="pr-4">
                        <Money minor={c.current?.priceMinor ?? null} />
                      </Td>
                    </tr>
                    {vs.map((x) => (
                      <tr key={x.id} className={x.active ? "" : "text-ink-3"}>
                        <Td className="pl-8">
                          {opt} {x.label}
                          {x.active ? "" : " (inactive)"}
                        </Td>
                        <Td align="right" className={x.active ? low(count(c.product.id, x.id)) : ""}>
                          {count(c.product.id, x.id)}
                          {x.active && count(c.product.id, x.id) === 0 ? <span className="ml-1 text-[11px] font-semibold">out of stock</span> : null}
                        </Td>
                        <Td align="right" className="pr-4">
                          {x.priceMinor != null ? <Money minor={x.priceMinor} /> : <span className="text-ink-3">same</span>}
                        </Td>
                      </tr>
                    ))}
                    {vs.length && count(c.product.id, UNASSIGNED) !== 0 ? (
                      <tr>
                        <Td className="pl-8">Unassigned (counted before {opt.toLowerCase()}s were added)</Td>
                        <Td align="right">{count(c.product.id, UNASSIGNED)}</Td>
                        <Td align="right" className="pr-4 text-ink-3">
                          not sellable
                        </Td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
          <p className="border-t border-edge px-4 py-2 text-xs text-ink-3">
            Counts at {LOW_STOCK_AT} or fewer are highlighted. An item at zero cannot be sold until stock is received.
          </p>
          <details className="border-t border-edge px-4 py-3">
            <summary className="min-h-9 cursor-pointer py-1 text-sm font-semibold text-brand">Receive / adjust stock</summary>
            <ActionForm action={stockAction} className="mt-2 grid gap-3 sm:grid-cols-2" resetOnSuccess>
              <Field label="Item" htmlFor="sp">
                <Select id="sp" name="productId" required>
                  {stockTargets.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
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
          {unassigned.map((c) => {
            const vs = variants.get(c.product.id) ?? [];
            const opt = optionNameOf(c.product).toLowerCase();
            return (
              <details key={c.product.id} className="border-t border-edge px-4 py-3">
                <summary className="min-h-9 cursor-pointer py-1 text-sm font-semibold text-brand">
                  Assign {count(c.product.id, UNASSIGNED)} unassigned {c.product.name} to a {opt}
                </summary>
                <p className="mt-1 text-xs text-ink-3">These were counted before the item had {opt}s. Count the shelf and move them yourself. Nothing is assigned automatically.</p>
                <ActionForm action={moveStockAction} className="mt-2 grid gap-3 sm:grid-cols-3" resetOnSuccess>
                  <input type="hidden" name="productId" value={c.product.id} />
                  <Field label={`To ${opt}`} htmlFor={`mv-to-${c.product.id}`}>
                    <Select id={`mv-to-${c.product.id}`} name="toVariantId" required>
                      {vs.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Quantity" htmlFor={`mv-q-${c.product.id}`}>
                    <Input id={`mv-q-${c.product.id}`} name="quantity" type="number" min={1} max={count(c.product.id, UNASSIGNED)} required />
                  </Field>
                  <Field label="Note" htmlFor={`mv-n-${c.product.id}`} hint="Required">
                    <Input id={`mv-n-${c.product.id}`} name="note" required />
                  </Field>
                  <div>
                    <SubmitButton size="sm" variant="secondary">
                      Move stock
                    </SubmitButton>
                  </div>
                </ActionForm>
              </details>
            );
          })}
        </Widget>
      </PosTerminal>
    </>
  );
}
