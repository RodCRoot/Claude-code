import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { refHref, scoreboardQs } from "@/components/scoreboard/shell";
import { ButtonLink, Callout, Card, CardBody, EmptyState, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { dailyMetric, metricRows } from "@/lib/scoreboard/daily";
import { fmtDate } from "@/lib/time";
import { loadScoreboard, type ScoreboardSearch } from "../../_load";

export const metadata = { title: "Scoreboard list" };

/** The rows behind one daily scoreboard number: the same query the number was counted from. */
export default async function ScoreboardListPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<ScoreboardSearch> }) {
  const { v, c, locations, programs, q } = await loadScoreboard(searchParams);
  const { key } = await params;
  if (!dailyMetric(key)) notFound();
  const res = (await metricRows(db, v, c, key))!;
  const { def, rows } = res;
  const qs = scoreboardQs(q);
  const amounts = rows.filter((r) => r.amount_minor != null);
  const total = amounts.reduce((s, r) => s + (r.amount_minor ?? 0), 0);
  const people = new Set(rows.map((r) => r.athlete_id).filter(Boolean)).size;
  const filterText = [locations.find((l) => l.id === q.location)?.name, programs.find((p) => p.id === q.program)?.name].filter(Boolean).join(" · ");
  const showGroup = rows.some((r) => r.grp);
  return (
    <>
      <PageHeader
        kicker={`Owner scoreboard · ${def.group}${filterText ? ` · Filter: ${filterText}` : ""}`}
        title={def.label}
        actions={
          <>
            <ButtonLink href={`/scoreboard${qs}`} variant="ghost">
              Back to scoreboard
            </ButtonLink>
            <ButtonLink href={`/api/scoreboard/list-${def.key}${qs}`} variant="secondary" download>
              Export CSV
            </ButtonLink>
          </>
        }
      />
      <Callout tone="info" title={`Definition (v${def.version})`} className="mb-4">
        {def.definition}
        <span className="mt-1 block text-xs">Filter: {def.filterNote}</span>
      </Callout>
      {res.na ? (
        <Callout tone="warn">{res.na}. Clear the filter to see this list.</Callout>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Rows" value={rows.length} />
            {def.people ? <Stat label="People" value={people} /> : null}
            {amounts.length ? <Stat label={def.kind === "money" ? "Total" : def.amountLabel ? `Sum, ${def.amountLabel}` : "Sum of amounts"} value={formatMoney(total)} /> : null}
          </div>
          <Card>
            <CardBody className="pt-4">
              {rows.length === 0 ? (
                <EmptyState title="No rows behind this number right now" />
              ) : (
                <Table caption={def.label}>
                  <thead>
                    <tr>
                      <Th>Name</Th>
                      <Th>Detail</Th>
                      {showGroup ? <Th>Group</Th> : null}
                      <Th>Date</Th>
                      <Th align="right">Amount</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const href = refHref(r.ref_kind, r.ref_id);
                      return (
                        <tr key={i}>
                          <Td className="font-medium">
                            {href ? (
                              <Link href={href} className="underline">
                                {r.name}
                              </Link>
                            ) : (
                              r.name
                            )}
                          </Td>
                          <Td>{r.detail}</Td>
                          {showGroup ? <Td>{r.grp}</Td> : null}
                          <Td className="whitespace-nowrap">{r.day ? fmtDate(r.day) : <span className="text-ink-3">—</span>}</Td>
                          <Td align="right">{r.amount_minor == null ? <span className="text-ink-3">—</span> : formatMoney(r.amount_minor)}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>
          <p className="mt-3 text-xs text-ink-3">
            {rows.length} rows as of now ({c.tz}). The scoreboard number is counted from exactly these rows.
          </p>
        </>
      )}
    </>
  );
}
