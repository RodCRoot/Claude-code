import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Icon } from "@/components/icons";
import type { Viewer } from "@/lib/authz/policy";
import { familySuggestion } from "@/lib/growth/offers";
import { todayLocal } from "@/lib/time";
import { acceptOfferAction, dismissOfferAction } from "@/app/(app)/_growth/actions";

/**
 * At most ONE gentle suggestion for a family, inline (never a modal), with a "Not now" that hides
 * it for the configured period. Renders nothing for anyone who cannot see billing, when the org
 * has turned family suggestions off, or when nothing applies.
 */
export async function FamilySuggestion({ viewer, className }: { viewer: Viewer; className?: string }) {
  if (viewer.role !== "guardian" && viewer.role !== "athlete") return null;
  const offer = await db.transaction((tx) => familySuggestion(tx, viewer, { today: todayLocal() }));
  if (!offer) return null;
  return (
    <section aria-labelledby="family-suggestion-title" className={`rounded-md border border-edge bg-surface px-4 py-3 shadow-[0_1px_3px_rgb(16_24_40/0.06)] ${className ?? ""}`}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand">
          <Icon name="performance" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="family-suggestion-title" className="text-sm font-semibold">
            A thought for {offer.athleteName.split(" ")[0]}
          </h2>
          <p className="mt-0.5 max-w-2xl text-sm text-ink-2">{offer.familyText}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ActionForm action={acceptOfferAction}>
              <input type="hidden" name="athleteId" value={offer.athleteId} />
              <input type="hidden" name="offerKey" value={offer.key} />
              <SubmitButton size="sm" variant="secondary" pendingText="Opening…">
                {offer.familyCta.label}
              </SubmitButton>
            </ActionForm>
            <ActionForm action={dismissOfferAction}>
              <input type="hidden" name="athleteId" value={offer.athleteId} />
              <input type="hidden" name="offerKey" value={offer.key} />
              <SubmitButton size="sm" variant="ghost" pendingText="Hiding…">
                Not now
              </SubmitButton>
            </ActionForm>
          </div>
        </div>
      </div>
    </section>
  );
}
