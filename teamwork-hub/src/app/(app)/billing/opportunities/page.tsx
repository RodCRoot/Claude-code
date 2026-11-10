import Link from "next/link";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { KpiTile } from "@/components/profile/studio";
import { Badge, ButtonLink, Callout, Card, CardBody, EmptyState, PageHeader } from "@/components/ui";
import { OFFER_LABEL, staffOpportunities, type Offer } from "@/lib/growth/offers";
import { growthSettings } from "@/lib/growth/settings";
import { formatMoney } from "@/lib/money";
import { todayLocal } from "@/lib/time";
import { createOfferTaskAction } from "../../_growth/actions";
import { BillingTabs, requireBillingStaff } from "../_components";

export const metadata = { title: "Opportunities" };

function Estimate({ o }: { o: Offer }) {
  if (o.estMonthlyMinor != null) return <span className="font-semibold tabular">{formatMoney(o.estMonthlyMinor, o.currency)}/mo</span>;
  if (o.estOneTimeMinor != null) return <span className="font-semibold tabular">{formatMoney(o.estOneTimeMinor, o.currency)} once</span>;
  return <span className="text-ink-3">No figure</span>;
}

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<{ rule?: string }> }) {
  const v = await requireBillingStaff();
  const { rule } = await searchParams;
  const [all, settings] = await Promise.all([staffOpportunities(db, v, { today: todayLocal() }), growthSettings(db, v.orgId)]);
  const offers = rule ? all.filter((o) => o.key === rule) : all;
  const monthly = all.reduce((s, o) => s + (o.estMonthlyMinor ?? 0), 0);
  const once = all.reduce((s, o) => s + (o.estOneTimeMinor ?? 0), 0);
  const keys = [...new Set(all.map((o) => o.key))];
  return (
    <>
      <PageHeader
        kicker="Billing"
        title="Opportunities"
        description="Rule-based suggestions with the evidence behind each one. Figures are estimates from catalog list prices, not forecasts and not money collected."
      />
      <BillingTabs current="opportunities" staff />
      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-3">
        <KpiTile icon="people" label="Open opportunities" value={all.length} hint={`${new Set(all.map((o) => o.athleteId)).size} athlete(s)`} />
        <KpiTile icon="billing" label="Estimated monthly value" value={formatMoney(monthly)} hint="Estimate: sum of catalog price differences" tone="info" />
        <KpiTile icon="reports" label="Estimated one-time value" value={formatMoney(once)} hint="Estimate: catalog price of packs and assessments" tone="info" />
      </div>
      <Callout tone="info" className="mt-4">
        Families see at most one of these at a time, worded gently, on their Shop and billing pages{settings.offers.familyFacing ? "" : " (currently turned off in Settings → Growth)"}. Staff see all of them here. Nothing on this page contacts a family or changes a membership.
      </Callout>

      {keys.length > 1 ? (
        <nav aria-label="Filter by rule" className="mt-4 flex flex-wrap gap-2">
          <ButtonLink href="/billing/opportunities" size="sm" variant={!rule ? "primary" : "secondary"} aria-current={!rule ? "page" : undefined}>
            All ({all.length})
          </ButtonLink>
          {keys.map((k) => (
            <ButtonLink key={k} href={`/billing/opportunities?rule=${k}`} size="sm" variant={rule === k ? "primary" : "secondary"} aria-current={rule === k ? "page" : undefined}>
              {OFFER_LABEL[k]} ({all.filter((o) => o.key === k).length})
            </ButtonLink>
          ))}
        </nav>
      ) : null}

      <div className="mt-4 space-y-3">
        {offers.length === 0 ? (
          <EmptyState title="No opportunities right now">Suggestions appear when a rule is met, for example an athlete reaching their weekly class limit most weeks, or a session pack running low.</EmptyState>
        ) : (
          offers.map((o) => (
            <Card key={`${o.athleteId}-${o.key}`}>
              <CardBody className="grid gap-3 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/people/${o.personId}`} className="font-semibold hover:underline">
                      {o.athleteName}
                    </Link>
                    <Badge variant="brand">{OFFER_LABEL[o.key]}</Badge>
                    {!o.familyVisible ? <Badge title="Depends on a policy value an owner has not confirmed">Staff only</Badge> : null}
                  </div>
                  <p className="mt-1 text-sm">{o.title}</p>
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-ink-2">
                    {o.evidence.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </div>
                <div className="flex flex-col gap-2 md:items-end">
                  <div className="text-sm md:text-right">
                    <div>
                      <span className="mr-1 text-[11px] font-bold uppercase tracking-wide text-ink-3">Estimate</span>
                      <Estimate o={o} />
                    </div>
                    <div className="max-w-64 text-xs text-ink-3">{o.estBasis}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <ActionForm action={createOfferTaskAction}>
                      <input type="hidden" name="athleteId" value={o.athleteId} />
                      <input type="hidden" name="offerKey" value={o.key} />
                      <SubmitButton size="sm" variant="secondary" pendingText="Creating…">
                        Create task<span className="sr-only"> for {o.athleteName}: {OFFER_LABEL[o.key]}</span>
                      </SubmitButton>
                    </ActionForm>
                    <ButtonLink href={o.staffAction.href} size="sm" variant="outline">
                      {o.staffAction.label}
                      <span className="sr-only"> for {o.athleteName}</span>
                    </ButtonLink>
                  </div>
                </div>
              </CardBody>
            </Card>
          ))
        )}
      </div>
    </>
  );
}
