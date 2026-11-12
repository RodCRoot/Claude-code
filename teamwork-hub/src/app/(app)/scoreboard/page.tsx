import Link from "next/link";
import { db } from "@/db";
import { ExportButton, DefinitionsDrawer, ExportLink, FilterBar, ScoreboardTabs, refHref, scoreboardQs } from "@/components/scoreboard/shell";
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { dailyScoreboard, type MetricGroup, type MetricValue } from "@/lib/scoreboard/daily";
import { fmt, fmtTime } from "@/lib/time";
import { loadScoreboard, type ScoreboardSearch } from "./_load";

export const metadata = { title: "Owner scoreboard" };

const GROUPS: MetricGroup[] = ["Members", "Leads and sales", "Attendance", "Money owed", "Revenue", "Holds and risk", "Membership checks"];

const show = (m: MetricValue, n: number) => (m.kind === "money" ? formatMoney(n) : n.toLocaleString("en-US"));
const signed = (m: MetricValue, n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${m.kind === "money" ? formatMoney(Math.abs(n)) : Math.abs(n).toLocaleString("en-US")}`;

function Tile({ m, qs }: { m: MetricValue; qs: string }) {
  const href = `/scoreboard/list/${m.key}${qs}`;
  return (
    <div className="flex min-w-0 flex-col rounded-md border border-l-4 border-edge border-l-brand bg-surface px-4 py-3 shadow-[0_1px_3px_rgb(16_24_40/0.06)]" data-metric={m.key}>
      <div className="kicker">{m.label}</div>
      {m.na ? (
        <>
          <div className="mt-1 text-[22px] leading-none font-bold text-ink-3">n/a</div>
          <div className="mt-1.5 text-xs text-ink-3">{m.na}. See Definitions.</div>
        </>
      ) : (
        <>
          <div className="mt-1 text-[26px] leading-none font-bold tabular">
            <Link href={href} className="underline decoration-edge underline-offset-4 hover:decoration-brand" aria-label={`${m.label}: ${show(m, m.value ?? 0)}. Open the list behind this number.`}>
              {show(m, m.value ?? 0)}
            </Link>
          </div>
          <div className="mt-1.5 text-xs text-ink-2">
            {m.kind === "money"
              ? `${m.rowCount} ${m.rowCount === 1 ? "row" : "rows"}`
              : [m.key === "active_members" ? `${m.people} people, ${m.rowCount} memberships` : null, m.amountLabel && m.amountMinor ? `${formatMoney(m.amountMinor)} ${m.amountLabel}` : null].filter(Boolean).join(" · ")}
          </div>
          <div className="mt-1 text-xs text-ink-3">{m.change != null ? <span><span className="font-semibold text-ink-2 tabular">{signed(m, m.change)}</span> {m.changeLabel}</span> : m.changeLabel}</div>
          {m.breakdown.length ? (
            <ul className="mt-2 space-y-0.5 border-t border-edge pt-2 text-xs text-ink-2">
              {m.breakdown.map((b) => (
                <li key={b.label} className="flex justify-between gap-3">
                  <span className="min-w-0 truncate">{b.label}</span>
                  <span className="tabular">{m.kind === "money" ? formatMoney(b.amountMinor ?? 0) : b.count}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

export default async function ScoreboardPage({ searchParams }: { searchParams: Promise<ScoreboardSearch> }) {
  const { v, c, locations, programs, q } = await loadScoreboard(searchParams);
  const d = await dailyScoreboard(db, v, c);
  const qs = scoreboardQs(q);
  const decisions = d.metrics.decisions;
  return (
    <>
      <PageHeader
        kicker={fmt(c.now, "EEEE, MMMM d, yyyy", c.tz)}
        title="Owner scoreboard"
        description="One page for the morning check. Every number is defined once (see Definitions at the bottom) and opens the list of rows behind it."
        actions={
          <ExportButton table="daily" q={q}>Export CSV</ExportButton>
        }
      />
      <ScoreboardTabs current="daily" q={q} />
      <FilterBar action="/scoreboard" locations={locations} programs={programs} q={q} />

      {GROUPS.map((g) => (
        <section key={g} aria-labelledby={`sb-${g.replace(/\W+/g, "-")}`} className="mb-6">
          <h2 id={`sb-${g.replace(/\W+/g, "-")}`} className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-2">
            {g}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {d.order
              .map((k) => d.metrics[k])
              .filter((m) => m.group === g)
              .map((m) => (
                <Tile key={m.key} m={m} qs={qs} />
              ))}
          </div>
          {g === "Members" && d.byLocation.length ? (
            <Card className="mt-3">
              <CardHeader title="Active members by where the membership is valid" kicker="Memberships add up to the total above" />
              <CardBody className="pt-0">
                <Table caption="Active members by location">
                  <thead>
                    <tr>
                      <Th>Valid at</Th>
                      <Th align="right">People</Th>
                      <Th align="right">Memberships</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.byLocation.map((l) => (
                      <tr key={l.name}>
                        <Td>{l.name}</Td>
                        <Td align="right">{l.people}</Td>
                        <Td align="right">{l.memberships}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </CardBody>
            </Card>
          ) : null}
          {g === "Attendance" ? (
            <Card className="mt-3">
              <CardHeader title="Today's classes against capacity" kicker={`${d.classes.length} sessions`} />
              <CardBody className="pt-0">
                {d.classes.length === 0 ? (
                  <EmptyState title="No sessions today" />
                ) : (
                  <Table caption="Today's classes against capacity">
                    <thead>
                      <tr>
                        <Th>Time</Th>
                        <Th>Class</Th>
                        <Th>Location</Th>
                        <Th align="right">Booked</Th>
                        <Th align="right">Capacity</Th>
                        <Th align="right">Fill</Th>
                        <Th align="right">Waitlist</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.classes.map((s) => (
                        <tr key={s.id}>
                          <Td className="whitespace-nowrap">{fmtTime(s.startsAt, c.tz)}</Td>
                          <Td>
                            <Link href={`/schedule/sessions/${s.id}`} className="font-medium underline">
                              {s.title}
                            </Link>
                            {s.coach ? <span className="block text-xs text-ink-3">{s.coach}</span> : null}
                          </Td>
                          <Td>{s.location ?? "No location"}</Td>
                          <Td align="right">{s.booked}</Td>
                          <Td align="right">{s.capacity}</Td>
                          <Td align="right">{s.capacity ? `${Math.round((s.booked / s.capacity) * 100)}%` : "n/a"}</Td>
                          <Td align="right">{s.waitlisted}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </CardBody>
            </Card>
          ) : null}
        </section>
      ))}

      <section aria-labelledby="sb-decisions" className="mb-6">
        <h2 id="sb-decisions" className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-2">
          Needs a decision
        </h2>
        <Card>
          <CardHeader
            title={
              <Link href={`/scoreboard/list/decisions${qs}`} className="underline" data-metric="decisions">
                {decisions.value ?? 0} open items
              </Link>
            }
            kicker={decisions.breakdown.map((b) => `${b.count} ${b.label.toLowerCase()}`).join(" · ") || "Nothing waiting"}
            action={<ExportLink table="list-decisions" q={q} />}
          />
          <CardBody className="pt-0">
            {d.decisions.length === 0 ? (
              <EmptyState title="Nothing is waiting on a decision" />
            ) : (
              <ul className="divide-y divide-edge">
                {d.decisions.slice(0, 12).map((r, i) => {
                  const href = refHref(r.ref_kind, r.ref_id);
                  return (
                    <li key={i} className="py-2 text-sm">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="font-medium">{href ? <Link href={href} className="underline">{r.name}</Link> : r.name}</span>
                        <span className="text-xs text-ink-3">{r.grp}</span>
                      </div>
                      {r.detail ? <div className="text-xs text-ink-2">{r.detail}</div> : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {d.decisions.length > 12 ? (
              <p className="mt-2 text-xs text-ink-3">
                Showing 12 of {d.decisions.length}.{" "}
                <Link href={`/scoreboard/list/decisions${qs}`} className="underline">
                  See all
                </Link>
              </p>
            ) : null}
          </CardBody>
        </Card>
      </section>

      <DefinitionsDrawer tab="daily" />
      <p className="mt-3 text-xs text-ink-3">
        Computed in {d.tookMs} ms at {fmt(c.now, "h:mm a", c.tz)} facility time. Nothing on this page is stored: reload for current numbers.
      </p>
    </>
  );
}
