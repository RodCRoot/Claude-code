"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ActionForm, SubmitButton, type ActionState } from "@/components/forms";
import { Field, Input, Select } from "@/components/ui";
import { formatMoney } from "@/lib/money";

export type PosProduct = { id: string; name: string; priceMinor: number; currency: string; kind: string; onHand: number | null };

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
  children,
}: {
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
              {products.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => add(p)}
                    className="flex h-full min-h-24 w-full flex-col justify-between rounded-md border border-edge bg-surface p-3 text-left transition-colors hover:border-brand hover:bg-brand/5"
                  >
                    <span className="text-sm leading-snug font-semibold">
                      <span className="sr-only">Add </span>
                      {p.name}
                    </span>
                    <span className="mt-2 flex items-end justify-between gap-2">
                      <span className="text-base font-bold tabular">{formatMoney(p.priceMinor, p.currency)}</span>
                      <span className={`text-[11px] ${p.onHand != null && p.onHand <= 2 ? "font-semibold text-warn" : "text-ink-3"}`}>
                        {p.onHand != null ? `${p.onHand} on hand` : p.kind.replaceAll("_", " ")}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
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
                        <option key={c.id} value={c.id}>
                          {c.name} — {formatMoney(c.priceMinor, c.currency)}
                          {c.onHand != null ? ` (${c.onHand} on hand)` : ""}
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
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-semibold">Subtotal</span>
                <span className="text-lg font-bold tabular">{formatMoney(subtotal, currency)}</span>
              </div>
              <p className="text-[11px] text-ink-3">At list price. The sale records the final amount (including any discounts) on its invoice/receipt.</p>
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
