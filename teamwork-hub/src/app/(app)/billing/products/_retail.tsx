import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Field, Input } from "@/components/ui";
import { LOW_STOCK_AT, UNASSIGNED } from "@/lib/billing/pos";
import { formatRate } from "@/lib/billing/tax";
import { optionNameOf, type Variant } from "@/lib/billing/variants";
import { formatMoney } from "@/lib/money";
import { addVariantsAction, optionNameAction, productTaxableAction, updateVariantAction, variantCommandAction } from "../actions";

type RetailProduct = { id: string; name: string; taxable: boolean; trackInventory: boolean; optionName: string | null };

/**
 * Billing → Products, retail products only: the sales tax switch and the variants (sizes) with
 * their stock. Shown only for kind "retail", so a membership or a training product has no tax switch.
 */
export function RetailOptions({
  product: p,
  variants,
  stock,
  withHistory,
  priceMinor,
  currency,
  taxRateBps,
  manage,
}: {
  product: RetailProduct;
  variants: Variant[];
  stock: Record<string, number>;
  withHistory: Set<string>;
  priceMinor: number | null;
  currency: string;
  taxRateBps: number;
  manage: boolean;
}) {
  const opt = optionNameOf(p);
  const active = variants.filter((x) => x.active);
  const total = Object.values(stock).reduce((s, n) => s + n, 0);
  const unassigned = stock[UNASSIGNED] ?? 0;
  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center gap-1">
        {p.taxable ? <Badge variant="yellow">Taxable</Badge> : <span className="text-xs text-ink-3">Not taxed</span>}
        {active.length ? (
          <span className="text-xs text-ink-2">
            {opt}: {active.map((x) => x.label).join(", ")}
          </span>
        ) : null}
        {p.trackInventory ? <span className="text-xs text-ink-3">· {total} on hand</span> : null}
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs">
          Sales tax and {opt.toLowerCase()}s<span className="sr-only"> for {p.name}</span>
        </summary>
        <div className="mt-2 min-w-[min(84vw,560px)] space-y-4 rounded-lg border border-edge p-3">
          {manage ? (
            <ActionForm action={productTaxableAction} className="space-y-2">
              <input type="hidden" name="productId" value={p.id} />
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="taxable" defaultChecked={p.taxable} className="mt-0.5 size-4" />
                <span>
                  Taxable: add sales tax ({taxRateBps > 0 ? formatRate(taxRateBps) : "no rate set"}) when this item is sold
                  <span className="block text-xs text-ink-3">Physical goods (shirts, bottles, gear) are taxed. Food and drink such as ready-to-drink protein are exempt: leave this off for them. Changing this affects new bills only.</span>
                </span>
              </label>
              <SubmitButton size="sm" variant="secondary">
                Save tax setting
              </SubmitButton>
            </ActionForm>
          ) : null}

          <div>
            <p className="text-xs font-semibold">
              {opt}s{variants.length ? "" : " (none: this item is sold as one item)"}
            </p>
            {variants.length ? (
              <div className="mt-1 overflow-x-auto">
                <table className="w-full text-xs">
                  <caption className="sr-only">
                    {p.name}: {opt.toLowerCase()}s and stock
                  </caption>
                  <thead>
                    <tr className="border-b border-edge text-left text-ink-3">
                      <th scope="col" className="py-1 pr-2 font-semibold">{opt}</th>
                      <th scope="col" className="py-1 pr-2 font-semibold">SKU</th>
                      <th scope="col" className="py-1 pr-2 text-right font-semibold">Price</th>
                      {p.trackInventory ? <th scope="col" className="py-1 pr-2 text-right font-semibold">On hand</th> : null}
                      {manage ? <th scope="col" className="py-1 font-semibold">Change</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {variants.map((x, i) => {
                      const n = stock[x.id] ?? 0;
                      return (
                        <tr key={x.id} className={`border-b border-edge/60 align-top ${x.active ? "" : "text-ink-3"}`}>
                          <td className="py-1.5 pr-2 font-medium">
                            {x.label}
                            {x.active ? "" : " (inactive)"}
                          </td>
                          <td className="py-1.5 pr-2">{x.sku ?? "—"}</td>
                          <td className="py-1.5 pr-2 text-right tabular">{x.priceMinor != null ? formatMoney(x.priceMinor, currency) : <span className="text-ink-3">{priceMinor != null ? formatMoney(priceMinor, currency) : "product price"}</span>}</td>
                          {p.trackInventory ? (
                            <td className={`py-1.5 pr-2 text-right tabular ${x.active && n <= LOW_STOCK_AT ? "font-semibold text-warn" : ""}`}>
                              {n}
                              {x.active && n === 0 ? " · out" : ""}
                            </td>
                          ) : null}
                          {manage ? (
                            <td className="py-1.5">
                              <div className="flex flex-wrap items-center gap-1">
                                <ActionForm action={variantCommandAction} className="flex flex-wrap gap-1">
                                  <input type="hidden" name="variantId" value={x.id} />
                                  {i > 0 ? (
                                    <SubmitButton size="sm" variant="ghost" name="cmd" value="up">
                                      ↑<span className="sr-only"> Move {x.label} earlier</span>
                                    </SubmitButton>
                                  ) : null}
                                  {i < variants.length - 1 ? (
                                    <SubmitButton size="sm" variant="ghost" name="cmd" value="down">
                                      ↓<span className="sr-only"> Move {x.label} later</span>
                                    </SubmitButton>
                                  ) : null}
                                  <SubmitButton size="sm" variant="ghost" name="cmd" value={x.active ? "deactivate" : "activate"}>
                                    {x.active ? "Deactivate" : "Reactivate"}
                                    <span className="sr-only"> {x.label}</span>
                                  </SubmitButton>
                                  {withHistory.has(x.id) ? null : (
                                    <SubmitButton size="sm" variant="ghost" name="cmd" value="delete">
                                      Delete<span className="sr-only"> {x.label}</span>
                                    </SubmitButton>
                                  )}
                                </ActionForm>
                                <details>
                                  <summary className="cursor-pointer px-1 py-1.5">
                                    Edit<span className="sr-only"> {x.label}</span>
                                  </summary>
                                  <ActionForm action={updateVariantAction} className="mt-1 grid gap-2 rounded-md border border-edge p-2 sm:grid-cols-3">
                                    <input type="hidden" name="variantId" value={x.id} />
                                    <Field label="Label" htmlFor={`vl-${x.id}`}>
                                      <Input id={`vl-${x.id}`} name="label" defaultValue={x.label} required maxLength={40} className="h-9" />
                                    </Field>
                                    <Field label="SKU" htmlFor={`vs-${x.id}`}>
                                      <Input id={`vs-${x.id}`} name="sku" defaultValue={x.sku ?? ""} className="h-9" />
                                    </Field>
                                    <Field label="Own price ($)" htmlFor={`vp-${x.id}`} hint="Empty = product price">
                                      <Input id={`vp-${x.id}`} name="price" inputMode="decimal" defaultValue={x.priceMinor != null ? (x.priceMinor / 100).toFixed(2) : ""} className="h-9" />
                                    </Field>
                                    <div>
                                      <SubmitButton size="sm">Save</SubmitButton>
                                    </div>
                                  </ActionForm>
                                </details>
                              </div>
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                    {p.trackInventory && unassigned !== 0 ? (
                      <tr className="border-b border-edge/60">
                        <td className="py-1.5 pr-2" colSpan={3}>
                          Unassigned (counted before {opt.toLowerCase()}s were added; move it on the Point of sale tab)
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular">{unassigned}</td>
                        {manage ? <td /> : null}
                      </tr>
                    ) : null}
                    {p.trackInventory ? (
                      <tr>
                        <th scope="row" className="py-1.5 pr-2 text-left font-semibold" colSpan={3}>
                          Total
                        </th>
                        <td className="py-1.5 pr-2 text-right font-semibold tabular">{total}</td>
                        {manage ? <td /> : null}
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            ) : null}
            <p className="mt-1 text-xs text-ink-3">A {opt.toLowerCase()} that has been sold or counted is deactivated, never deleted, so past bills and stock history stay intact.</p>
          </div>

          {manage ? (
            <>
              <ActionForm action={addVariantsAction} className="grid gap-2 sm:grid-cols-3" resetOnSuccess>
                <input type="hidden" name="productId" value={p.id} />
                <Field label={`Add ${opt.toLowerCase()}s`} htmlFor={`va-${p.id}`} hint="One label, or several separated by commas: YS, YM, YL, S, M, L, XL" className="sm:col-span-3">
                  <Input id={`va-${p.id}`} name="labels" required className="h-9" />
                </Field>
                <Field label="SKU (single label only)" htmlFor={`vk-${p.id}`}>
                  <Input id={`vk-${p.id}`} name="sku" className="h-9" />
                </Field>
                <Field label="Own price ($)" htmlFor={`vpr-${p.id}`} hint="Empty = product price">
                  <Input id={`vpr-${p.id}`} name="price" inputMode="decimal" className="h-9" />
                </Field>
                <div className="self-end">
                  <SubmitButton size="sm">Add</SubmitButton>
                </div>
              </ActionForm>
              <ActionForm action={optionNameAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="productId" value={p.id} />
                <Field label="What the choice is called" htmlFor={`vo-${p.id}`}>
                  <Input id={`vo-${p.id}`} name="optionName" defaultValue={opt} maxLength={30} className="h-9 w-40" />
                </Field>
                <SubmitButton size="sm" variant="secondary">
                  Rename
                </SubmitButton>
              </ActionForm>
            </>
          ) : null}
        </div>
      </details>
    </div>
  );
}
