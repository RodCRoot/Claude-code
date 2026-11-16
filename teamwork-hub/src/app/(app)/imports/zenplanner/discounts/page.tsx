import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { importBatches } from "@/db/schema";
import { requireCap } from "@/lib/auth/viewer";
import { formatMoney } from "@/lib/money";
import { fmt } from "@/lib/time";
import { discountReview, patternLabel, type DiscountRow } from "@/lib/zenplanner/discounts";
import { Badge, buttonClass, Callout, Card, CardBody, CardHeader, EmptyState, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { ImportTabs } from "../../tabs";

export const metadata = { title: "Discount review" };

const GROUPS = [
  { key: "family", title: "Matches the family discount", help: "Payment Amount equals the list price less a family rate (the household tier: percent per active household member, from Settings). The note says when it is not the rate for that household's head count." },
  { key: "in_season_rate", title: "In Season rate on another plan", help: "Paying the In Season rate while the membership is on a plan that is not an In Season plan." },
  { key: "other", title: "Other discounts and differences", help: "Any other difference from the list price, or a named discount." },
  { key: "unknown", title: "Cannot tell", help: "No Payment Amount in the export, or no list price to compare against." },
] as const;

function Rows({ rows, caption }: { rows: DiscountRow[]; caption: string }) {
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <Th>Member</Th>
          <Th>Family ID</Th>
          <Th>Plan</Th>
          <Th>Status</Th>
          <Th align="right">List price</Th>
          <Th align="right">Payment Amount</Th>
          <Th align="right">Difference</Th>
          <Th>Note</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.membershipId}>
            <Td>{r.name}</Td>
            <Td>{r.familyId ?? ""}</Td>
            <Td>{r.plan}</Td>
            <Td>{r.status.replace("_", " ")}</Td>
            <Td align="right">
              {r.listPriceMinor == null ? "not known" : formatMoney(r.listPriceMinor)}
              {r.listBasis === "highest" ? <span className="block text-xs text-ink-3">highest in import</span> : null}
            </Td>
            <Td align="right">{r.paymentMinor == null ? "not in export" : formatMoney(r.paymentMinor)}</Td>
            <Td align="right">{r.differenceMinor == null ? "" : formatMoney(r.differenceMinor)}</Td>
            <Td className="text-xs text-ink-3">
              {r.discountName ? <span className="block text-ink">Discount: {r.discountName}</span> : null}
              {r.note}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export default async function DiscountReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const v = await requireCap("imports.manage");
  const sp = await searchParams;
  const batchParam = typeof sp.batch === "string" && /^[0-9a-f-]{36}$/i.test(sp.batch) ? sp.batch : null;
  const batches = await db
    .select({ id: importBatches.id, filename: importBatches.originalFilename, committedAt: importBatches.committedAt })
    .from(importBatches)
    .where(and(eq(importBatches.orgId, v.orgId), eq(importBatches.entityType, "zenplanner.membership_grid"), eq(importBatches.status, "committed")))
    .orderBy(desc(importBatches.committedAt))
    .limit(20);
  const batch = batchParam ? (batches.find((b) => b.id === batchParam) ?? null) : null;
  const r = await db.transaction((tx) => discountReview(tx, v, { batchId: batch?.id ?? null }));
  const listed = r.groups.family.length + r.groups.in_season_rate.length + r.groups.other.length + r.groups.unknown.length;
  const exportHref = `/imports/zenplanner/discounts/export${batch ? `?batch=${batch.id}` : ""}`;

  return (
    <>
      <PageHeader
        kicker="Zen Planner import"
        title="Discount review"
        description="Every imported Zen Planner membership whose Payment Amount differs from its plan's list price, or that carries a discount, grouped by pattern. Read-only: decide for each one whether to keep it, convert it to the hub's family discount, or end it."
        actions={
          listed || r.siblingsWithoutFamilyDiscount.length || r.renewsIntoFixedTerm.length ? (
            <a className={buttonClass("outline")} href={exportHref} download>
              Download CSV
            </a>
          ) : null
        }
      />
      <ImportTabs current="zenplanner" />

      <nav aria-label="Import" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-3">Showing:</span>
        <Link className={buttonClass(batch ? "outline" : "primary", "sm")} href="/imports/zenplanner/discounts" aria-current={batch ? undefined : "page"}>
          All imported memberships
        </Link>
        {batches.map((b) => (
          <Link key={b.id} className={buttonClass(batch?.id === b.id ? "primary" : "outline", "sm")} href={`/imports/zenplanner/discounts?batch=${b.id}`} aria-current={batch?.id === b.id ? "page" : undefined}>
            {b.filename ?? "Import"} · {fmt(b.committedAt)}
          </Link>
        ))}
      </nav>

      {r.reviewed === 0 && r.endedExcluded === 0 ? (
        <EmptyState title="No Zen Planner memberships imported yet">
          Import the Membership grid with its exact preset, then come back.{" "}
          <Link className="underline" href="/imports/zenplanner">
            How to export it
          </Link>
        </EmptyState>
      ) : (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Current memberships reviewed" value={r.reviewed} hint={r.endedExcluded ? `${r.endedExcluded} cancelled or expired left out` : undefined} />
            <Stat label="At list price" value={r.fullPrice} />
            <Stat label="Family rate" value={r.groups.family.length} hint={`${formatMoney(r.totals.family)} per period`} />
            <Stat label="In Season rate" value={r.groups.in_season_rate.length} hint={`${formatMoney(r.totals.in_season_rate)} per period`} />
            <Stat label="Other" value={r.groups.other.length} hint={`${formatMoney(r.totals.other)} per period`} tone={r.groups.other.length ? "warn" : undefined} />
          </div>
          <Callout tone={r.familyCapConfirmed ? "info" : "warn"} title="Family rate: by household head count" className="mb-5">
            {r.familyRule}. A household here is a Zen Planner Family ID; members on hold do not count and get no rate while held.
            {r.familyCapConfirmed ? " " : ` The ${r.familyCapPercent}% cap is a placeholder that still needs the owner's confirmation. `}
            Change the percent per member or the cap in{" "}
            <Link className="underline" href="/settings">
              Settings
            </Link>{" "}
            and this page regroups.
          </Callout>

          {GROUPS.map((g) =>
            r.groups[g.key].length ? (
              <Card key={g.key} className="mb-5">
                <CardHeader title={g.title} action={<Badge>{`${r.groups[g.key].length}`}</Badge>} />
                <CardBody>
                  <p className="mb-3 text-sm text-ink-3">{g.help}</p>
                  <Rows rows={r.groups[g.key]} caption={g.title} />
                </CardBody>
              </Card>
            ) : null,
          )}
          {listed === 0 ? (
            <Callout tone="ok" className="mb-5">
              Every current imported membership pays its list price.
            </Callout>
          ) : null}

          <Card className="mb-5" id="siblings">
            <CardHeader title="Not on the household family rate" action={<Badge variant={r.siblingsWithoutFamilyDiscount.length ? "yellow" : "green"}>{`${r.siblingsWithoutFamilyDiscount.length}`}</Badge>} />
            <CardBody>
              <p className="mb-3 text-sm text-ink-3">
                Two or more members share a Family ID and are active (current, not on hold), so the household has a family rate, but this member pays something else: no family rate at all, or the rate for a different head count. In Zen Planner the
                sibling discount is applied by hand, which is how it gets missed or left at an old tier.
              </p>
              {r.siblingsWithoutFamilyDiscount.length ? (
                <Table caption="Not on the household family rate">
                  <thead>
                    <tr>
                      <Th>Family ID</Th>
                      <Th>Member</Th>
                      <Th>Plan</Th>
                      <Th align="right">Payment Amount</Th>
                      <Th>Currently</Th>
                      <Th align="right">Household rate</Th>
                      <Th align="right">Change per period at that rate</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.siblingsWithoutFamilyDiscount.map((s) => (
                      <tr key={`${s.familyId}-${s.name}-${s.plan}`}>
                        <Td>
                          {s.familyId} <span className="text-xs text-ink-3">({s.membersInFamily} active)</span>
                        </Td>
                        <Td>{s.name}</Td>
                        <Td>{s.plan}</Td>
                        <Td align="right">{s.paymentMinor == null ? "not in export" : formatMoney(s.paymentMinor)}</Td>
                        <Td>{s.paidPercent ? `Family rate ${s.paidPercent}%` : patternLabel(s.pattern)}</Td>
                        <Td align="right">{`${s.expectedPercent}%`}</Td>
                        <Td align="right">{s.wouldSaveMinor == null ? "" : s.wouldSaveMinor >= 0 ? `${formatMoney(s.wouldSaveMinor)} less` : `${formatMoney(-s.wouldSaveMinor)} more`}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <p className="text-sm">None found.</p>
              )}
            </CardBody>
          </Card>

          <Card className="mb-5" id="renewals">
            <CardHeader title="Set to renew into another fixed term" action={<Badge variant={r.renewsIntoFixedTerm.length ? "yellow" : "green"}>{`${r.renewsIntoFixedTerm.length}`}</Badge>} />
            <CardBody>
              <p className="mb-3 text-sm text-ink-3">
                The member agreement says a fixed-term commitment rolls to month-to-month at the committed rate when the term ends. These current memberships have Auto Renew on in Zen Planner with a Renewal Type that is not month-to-month, so Zen
                Planner will start another fixed term. Change the Renewal Type in Zen Planner; nothing here changes a membership, and Teamwork never charges or renews an imported membership.
              </p>
              {r.renewsIntoFixedTerm.length ? (
                <Table caption="Set to renew into another fixed term">
                  <thead>
                    <tr>
                      <Th>Member</Th>
                      <Th>Plan</Th>
                      <Th>Status</Th>
                      <Th align="right">Term</Th>
                      <Th>Term ends</Th>
                      <Th>Renewal Type in Zen Planner</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.renewsIntoFixedTerm.map((x) => (
                      <tr key={x.membershipId}>
                        <Td>{x.name}</Td>
                        <Td>{x.plan}</Td>
                        <Td>{x.status.replace("_", " ")}</Td>
                        <Td align="right">{`${x.months} months`}</Td>
                        <Td>{x.endDate ?? "not in export"}</Td>
                        <Td>{x.renewalType}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <p className="text-sm">None found.</p>
              )}
              {r.renewalTypeUnknown ? (
                <p className="mt-3 text-xs text-ink-3">{`${r.renewalTypeUnknown} more current fixed-term membership(s) have Auto Renew on but no Renewal Type in the export, so this page cannot tell how they renew.`}</p>
              ) : null}
            </CardBody>
          </Card>

          <ul className="list-disc space-y-1 pl-5 text-xs text-ink-3">
            {r.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
