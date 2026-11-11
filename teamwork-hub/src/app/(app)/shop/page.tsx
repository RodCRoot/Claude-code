import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { FamilySuggestion } from "@/components/growth/family-suggestion";
import { Badge, Callout, EmptyState, PageHeader, Select } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { payerAccountIdsFor } from "@/lib/authz/policy";
import { familyName, onlinePaymentAvailable, shopAthletes, shopItems } from "@/lib/growth/shop";
import { formatMoney } from "@/lib/money";
import { todayLocal } from "@/lib/time";
import { shopCheckoutAction } from "../_growth/actions";

export const metadata = { title: "Shop" };

export default async function ShopPage() {
  const v = await requireViewer();
  if (v.role !== "guardian" && v.role !== "athlete") redirect("/billing/products");
  const [items, buyFor, viewable] = await Promise.all([shopItems(db, v.orgId, todayLocal()), shopAthletes(db, v), payerAccountIdsFor(db, v, "view")]);
  const online = onlinePaymentAvailable();
  const viewOnly = buyFor.length === 0 && viewable.length > 0;
  return (
    <>
      <PageHeader kicker="Shop" title="Shop" description="Session packs, assessments and add-ons you can order for your athletes. Prices come straight from our current price list." />
      <FamilySuggestion viewer={v} className="mb-5" />
      {buyFor.length === 0 ? (
        <Callout tone="info" className="mb-5" title={viewOnly ? "You can browse, and another adult on the account places orders" : "Ordering is not set up for your login"}>
          {viewOnly
            ? "Your login can view this billing account but not pay on it. The account holder can order here, or the front desk can help."
            : "Orders are placed by the adult who pays on the billing account. The front desk is happy to help with anything you see here."}
        </Callout>
      ) : !online ? (
        <Callout tone="info" className="mb-5" title="Pay at the front desk for now">
          Online payment is not set up yet. You can still place an order here. It creates a bill, and you can pay it at the front desk. Sessions are added to your athlete once payment is recorded.
        </Callout>
      ) : null}
      {items.length === 0 ? (
        <EmptyState title="Nothing in the shop yet">We have not added items for online ordering. The front desk can help with session packs and assessments.</EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((it) => (
            <li key={it.productId} id={`item-${it.productId}`} className="flex min-w-0 scroll-mt-24 flex-col rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)] target:ring-2 target:ring-brand">
              <div className="flex-1 space-y-2 px-4 pt-4">
                <Badge variant="brand">{it.kindLabel}</Badge>
                <h2 className="text-base font-semibold leading-snug">{it.name}</h2>
                <p className="text-[26px] font-bold leading-none tabular">{formatMoney(it.priceMinor, it.currency)}</p>
                {it.includes ? <p className="text-sm text-ink-2">{it.includes}</p> : it.description ? <p className="text-sm text-ink-2">{familyName(it.description)}</p> : null}
                {it.facts.length ? (
                  <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink-2">
                    {it.facts.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <div className="mt-4 border-t border-edge bg-th px-4 py-3">
                {buyFor.length ? (
                  <ActionForm action={shopCheckoutAction} className="space-y-2">
                    <input type="hidden" name="productId" value={it.productId} />
                    <input type="hidden" name="key" value={randomUUID()} />
                    {buyFor.length === 1 ? (
                      <>
                        <input type="hidden" name="athleteId" value={buyFor[0].athleteId} />
                        <p className="text-sm text-ink-2">
                          For <span className="font-semibold text-ink">{buyFor[0].name}</span>
                        </p>
                      </>
                    ) : (
                      <div>
                        <label htmlFor={`for-${it.productId}`} className="block text-xs font-semibold text-ink-2">
                          Who is it for?
                        </label>
                        <Select id={`for-${it.productId}`} name="athleteId" required defaultValue="" className="mt-1">
                          <option value="" disabled>
                            Choose an athlete
                          </option>
                          {buyFor.map((a) => (
                            <option key={a.athleteId} value={a.athleteId}>
                              {a.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                    <SubmitButton className="w-full" pendingText="Creating your order…">
                      {online ? "Order and pay" : "Place order"}
                    </SubmitButton>
                  </ActionForm>
                ) : (
                  <p className="text-sm text-ink-3">Available at the front desk.</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-5 max-w-3xl text-xs text-ink-3">
        Ordering creates a bill on your billing account. Nothing is charged on this page. Sessions and credits are added only after your payment is confirmed. Camps, clinics and memberships are arranged with the front desk.
      </p>
    </>
  );
}
