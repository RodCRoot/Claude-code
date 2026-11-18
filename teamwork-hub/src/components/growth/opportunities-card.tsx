import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardBody, CardHeader } from "@/components/ui";
import { can, type Viewer } from "@/lib/authz/policy";
import { OFFER_LABEL, staffOpportunities } from "@/lib/growth/offers";
import { formatMoney } from "@/lib/money";
import { todayLocal } from "@/lib/time";
import { createOfferTaskAction } from "@/app/(app)/_growth/actions";

/** Member profile: small "Opportunities" card for billing staff. Renders nothing when there are none. */
export async function OpportunitiesCard({ viewer, athleteId }: { viewer: Viewer; athleteId: string }) {
  if (!can(viewer, "billing.view_all")) return null;
  const offers = await staffOpportunities(db, viewer, { today: todayLocal(), athleteId });
  if (!offers.length) return null;
  return (
    <Card>
      <CardHeader
        title="Opportunities"
        kicker="Rule-based, with the evidence"
        action={
          <Link href="/billing/opportunities" className="text-xs font-semibold text-brand hover:underline">
            View all<span className="sr-only"> opportunities</span> ›
          </Link>
        }
      />
      <CardBody>
        <ul className="divide-y divide-edge">
          {offers.map((o) => (
            <li key={o.key} className="space-y-1 py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="brand">{OFFER_LABEL[o.key]}</Badge>
                <span className="text-xs text-ink-3">
                  Estimate: {o.estMonthlyMinor != null ? `${formatMoney(o.estMonthlyMinor, o.currency)}/mo` : o.estOneTimeMinor != null ? `${formatMoney(o.estOneTimeMinor, o.currency)} once` : "no figure"}
                </span>
              </div>
              <ul className="list-disc pl-5 text-xs text-ink-2">
                {o.evidence.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-3 pt-0.5">
                <ActionForm action={createOfferTaskAction}>
                  <input type="hidden" name="athleteId" value={o.athleteId} />
                  <input type="hidden" name="offerKey" value={o.key} />
                  <SubmitButton size="sm" variant="secondary" pendingText="Creating…">
                    Create task<span className="sr-only">: {OFFER_LABEL[o.key]}</span>
                  </SubmitButton>
                </ActionForm>
                {o.staffAction.href.startsWith("/billing/") ? (
                  <Link href={o.staffAction.href} className="text-xs font-semibold text-brand hover:underline">
                    {o.staffAction.label}
                    <span className="sr-only">: {OFFER_LABEL[o.key]}</span> ›
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
