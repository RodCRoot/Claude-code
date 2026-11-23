"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ActionForm, SubmitButton, type ActionState } from "@/components/forms";
import { Field, Input, Select } from "@/components/ui";
import { computeTax, formatRate } from "@/lib/billing/tax";
import { formatMoney } from "@/lib/money";

/**
 * One thing that can be rung up. `id` is the cart field value: the product id, or
 * "productId:variantId" for a product sold by variant (then `name` already carries the variant).
 */
export type PosProduct = {
  id: string;
  productId: string;
  productName: string;
  name: string;
  variantLabel: string | null;
  optionName: string | null;
  priceMinor: number;
  currency: string;
  kind: string;
  onHand: number | null;
  taxable: boolean;
};

const LINES = [0, 1, 2, 3, 4];

/**
 * Checkout layout for the point of sale: catalog tiles on the left, the cart (the same
 * five item/qty fields the sale action has always read) on the right. Tiles only fill
 * the cart's fields; the server action prices and validates the sale.
 */
export function PosTerminal({
  products,
  customers,
  methods,
  saleAction,
  taxRateBps,
  taxLabel,
  children,
}: {
  /** Organization sales tax rate in basis points (0 = none). Preview only: the server computes the bill. */
  taxRateBps: number;
  taxLabel: string;
  products: PosProduct[];
  customers: { value: string; label: string }[];
  methods: readonly { value: string; label: string }[];
  saleAction: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  children?: React.ReactNode;
}) {
  const cartRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ id: string; qty: number }[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const byId = new Map(products.map((p) => [p.id, p]));

  const read = useCallback(() => {
    const root = cartRef.current;
    if (!root) return;
    const out: { id: string; qty: number }[] = [];
    for (const i of LINES) {
      const sel = root.querySelector<HTMLSelectElement>(`#item${i}`);
      const qty = root.querySelector<HTMLInputElement>(`#qty${i}`);
      if (sel?.value) out.push({ id: sel.value, qty: Math.max(0, Number(qty?.value || 0)) });
    }
    setLines(out);
  }, []);

  useEffect(() => {
    const root = cartRef.current;
    if (!root) return;
    // `reset` doesn't bubble; listen in the capture phase so a successful sale clears the summary.
    const onReset = () => setTimeout(read, 0);
    root.addEventListener("reset", onReset, true);
    return () => root.removeEventListener("reset", onReset, true);
  }, [read]);

  function add(p: PosProduct) {
    const root = cartRef.current;
    if (!root) return;
    if (p.onHand === 0) {
      setNote(`${p.name} is out of stock.`);
      return;
    }
    let target = -1;
    for (const i of LINES) {
      const sel = root.querySelector<HTMLSelectElement>(`#item${i}`);
      if (sel?.value === p.id) {
        target = i;
        break;
      }
    }
    if (target === -1) target = LINES.find((i) => !root.querySelector<HTMLSelectElement>(`#item${i}`)?.value) ?? -1;
    if (target === -1) {
      setNote("The cart holds five different items per sale. Complete this sale first.");
      return;
    }
    const sel = root.querySelector<HTMLSelectElement>(`#item${target}`)!;
    const qty = root.querySelector<HTMLInputElement>(`#qty${target}`)!;
    const wasSame = sel.value === p.id;
    sel.value = p.id;
    qty.value = String(wasSame ? Math.max(0, Number(qty.value || 0)) + 1 : Math.max(1, Number(qty.value || 0) || 1));
    setNote(`Added ${p.name}.`);
    read();
  }

  const subtotal = lines.reduce((s, l) => s + (byId.get(l.id)?.priceMinor ?? 0) * l.qty, 0);
  const tax = computeTax(
    lines.map((l) => ({ amountMinor: (byId.get(l.id)?.priceMinor ?? 0) * l.qty, taxable: !!byId.get(l.id)?.taxable })),
    0,
    taxRateBps,
  );
  // Tiles: one per product; a product sold by variant gets one button per variant inside its tile.
  const groups: { productId: string; items: PosProduct[] }[] = [];
  for (const p of products) {
    const g = groups.find((x) => x.productId === p.productId);
    if (g) g.items.push(p);
    else groups.push({ productId: p.productId, items: [p] });
  }
  const itemCount = lines.reduce((s, l) => s + l.qty, 0);
  const currency = products[0]?.currency ?? "USD";

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)] [&>*]:min-w-0">
      <div className="space-y-4">
        <section aria-labelledby="pos-catalog" className="overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
          <h2 id="pos-catalog" className="border-b border-edge bg-th px-4 py-2 text-[13px] font-bold uppercase tracking-wide text-ink-2">
            Items
          </h2>
          {products.length === 0 ? (
            <p className="px-4 py-6 text-sm text-ink-3">No sellable products yet. Add retail items, packs or drop-ins on the Products tab.</p>
          ) : (
            <ul className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 xl:grid-cols-4">
              {groups.map(({ items }) => {
                const p = items[0];
                if (p.variantLabel != null) {
                  return (
                    <li key={p.productId} className="col-span-2 rounded-md border border-edge bg-surface p-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm leading-snug font-semibold">{p.productName}</span>
                        <span className="text-[11px] text-ink-3">choose a {p.optionName?.toLowerCase()}{p.taxable ? " · taxable" : ""}</span>
                      </div>
                      <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={`${p.productName}: ${p.optionName}`}>
                        {items.map((x) => (
                          <li key={x.id}>
                            <button
                              type="button"
                              onClick={() => add(x)}
                              disabled={x.onHand === 0}
                              className="min-h-11 min-w-14 rounded-md border border-edge bg-surface px-2 py-1 text-left transition-colors hover:border-brand hover:bg-brand/5 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-3"
                            >
                              <span className="block text-sm font-bold">
                                <span className="sr-only">Add {p.productName}, {p.optionName} </span>
                                {x.variantLabel}
                              </span>
                              <span className="block text-[11px] tabular">{formatMoney(x.priceMinor, x.currency)}</span>
                              <span className={`block text-[11px] ${x.onHand != null && x.onHand <= 2 ? "font-semibold text-warn" : "text-ink-3"}`}>
                                {x.onHand == null ? "" : x.onHand === 0 ? "out of stock" : `${x.onHand} on hand`}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </li>
                  );
                }
                return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => add(p)}
                    disabled={p.onHand === 0}
                    className="disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-3 flex h-full min-h-24 w-full flex-col justify-between rounded-md border border-edge bg-surface p-3 text-left transition-colors hover:border-brand hover:bg-brand/5"
                  >
                    <span className="text-sm leading-snug font-semibold">
                      <span className="sr-only">Add </span>
                      {p.name}
                    </span>
                    <span className="mt-2 flex items-end justify-between gap-2">
                      <span className="text-base font-bold tabular">{formatMoney(p.priceMinor, p.currency)}</span>
                      <span className={`text-[11px] ${p.onHand != null && p.onHand <= 2 ? "font-semibold text-warn" : "text-ink-3"}`}>
                        {p.onHand != null ? (p.onHand === 0 ? "out of stock" : `${p.onHand} on hand`) : p.kind.replaceAll("_", " ")}
                        {p.taxable ? " · taxable" : ""}
                      </span>
                    </span>
                  </button>
                </li>
                );
              })}
            </ul>
          )}
        </section>
        {children}
      </div>

      <section aria-labelledby="pos-cart" className="self-start overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)] lg:sticky lg:top-[4.5rem]">
        <h2 id="pos-cart" className="flex items-center justify-between border-b border-edge bg-nav-bg px-4 py-2.5 text-[13px] font-bold uppercase tracking-wide text-white">
          <span>Current sale</span>
          <span className="tabular normal-case">
            {itemCount} item{itemCount === 1 ? "" : "s"}
          </span>
        </h2>
        <div ref={cartRef} onChange={read} onInput={read}>
          <ActionForm action={saleAction} id="pos-sale" className="space-y-4 p-4" resetOnSuccess>
            <Field label="Customer" htmlFor="athletePayer" hint="Leave as walk-in for anonymous retail. Packs/drop-ins need an athlete (credits).">
              <Select id="athletePayer" name="athletePayer" defaultValue="">
                <option value="">Walk-in customer</option>
                {customers.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-semibold">Cart</legend>
              {LINES.map((i) => (
                <div key={i} className="grid grid-cols-[1fr_4.5rem] gap-2">
                  <Field label={`Item ${i + 1}`} htmlFor={`item${i}`}>
                    <Select id={`item${i}`} name={`item${i}`} defaultValue="" className="h-9">
                      <option value="">—</option>
                      {products.map((c) => (
                        <option key={c.id} value={c.id} disabled={c.onHand === 0}>
                          {c.name} — {formatMoney(c.priceMinor, c.currency)}
                          {c.onHand != null ? (c.onHand === 0 ? " (out of stock)" : ` (${c.onHand} on hand)`) : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Qty" htmlFor={`qty${i}`}>
                    <Input id={`qty${i}`} name={`qty${i}`} type="number" min={0} defaultValue={i === 0 ? 1 : 0} className="h-9" />
                  </Field>
                </div>
              ))}
              <p className="min-h-4 text-xs text-ink-3" role="status">
                {note}
              </p>
            </fieldset>
            <div className="rounded-md border border-edge bg-th px-3 py-2">
              <dl className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-0.5 text-sm" data-testid="pos-totals">
                <dt>Subtotal</dt>
                <dd className="text-right tabular" data-testid="pos-subtotal">{formatMoney(subtotal, currency)}</dd>
                <dt>
                  {taxLabel} ({formatRate(taxRateBps)}){tax.taxableMinor > 0 ? <span className="text-ink-3"> on {formatMoney(tax.taxableMinor, currency)}</span> : null}
                </dt>
                <dd className="text-right tabular" data-testid="pos-tax">{formatMoney(tax.taxMinor, currency)}</dd>
                <dt className="font-semibold">Total</dt>
                <dd className="text-right text-lg font-bold tabular" data-testid="pos-total">{formatMoney(subtotal + tax.taxMinor, currency)}</dd>
              </dl>
              <p className="mt-1 text-[11px] text-ink-3">
                {taxRateBps > 0 ? "Sales tax applies only to items marked taxable." : "No sales tax rate is set."} The sale records the final amounts on its invoice and receipt.
              </p>
            </div>
            <fieldset className="grid gap-3">
              <legend className="mb-1 text-sm font-semibold">Payment</legend>
              <Field label="How" htmlFor="paymentKind">
                <Select id="paymentKind" name="paymentKind" defaultValue="manual">
                  <option value="manual">Paid now, offline</option>
                  <option value="invoice">Create invoice (pay online / later)</option>
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Offline method" htmlFor="method">
                  <Select id="method" name="method">
                    {methods.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Reference" htmlFor="reference">
                  <Input id="reference" name="reference" aria-describedby="reference-hint" />
                </Field>
              </div>
              <p id="reference-hint" className="-mt-1 text-xs text-ink-3">
                Required for offline: receipt #, check #, Venmo note
              </p>
            </fieldset>
            <SubmitButton pendingText="Recording sale…" className="w-full" size="lg">
              Complete sale
            </SubmitButton>
          </ActionForm>
        </div>
      </section>
    </div>
  );
}
