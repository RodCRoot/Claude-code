import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge } from "@/components/ui";
import type { ProductKind } from "@/db/schema";
import { shopBlockReason } from "@/lib/growth/shop";
import { setShopListingAction } from "@/app/(app)/_growth/actions";

/** Billing → Products: the "sellable online" flag for the Family Shop (default off). */
export function ShopListingToggle({ productId, kind, name, listing, manage }: { productId: string; kind: ProductKind; name: string; listing?: { sellableOnline: boolean; includes: string | null } | null; manage: boolean }) {
  const block = shopBlockReason(kind);
  const on = !!listing?.sellableOnline && !block;
  return (
    <div className="mt-1">
      {on ? <Badge variant="green">Sellable online</Badge> : null}
      {manage ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs">
            Family Shop<span className="sr-only"> settings for {name}</span>
          </summary>
          {block ? (
            <p className="mt-1 max-w-xs text-xs text-ink-3">{block}</p>
          ) : (
            <ActionForm action={setShopListingAction} className="mt-2 max-w-xs space-y-2 rounded-lg border border-edge p-2">
              <input type="hidden" name="productId" value={productId} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="sellableOnline" defaultChecked={on} className="size-4" /> Sellable online
              </label>
              <label className="block text-xs font-medium text-ink-2">
                What it includes (shown to families)
                <textarea name="includes" rows={2} maxLength={600} defaultValue={listing?.includes ?? ""} className="mt-1 block w-full rounded-md border border-edge bg-surface px-2 py-1 text-sm text-ink" />
              </label>
              <SubmitButton size="sm">Save</SubmitButton>
            </ActionForm>
          )}
        </details>
      ) : null}
    </div>
  );
}
