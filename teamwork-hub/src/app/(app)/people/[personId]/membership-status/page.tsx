import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { requireStaff } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { BILL_AFFECTING_TYPES, channelLabel, typeLabel } from "@/lib/member-ops/common";
import { membershipStatusReport } from "@/lib/member-ops/status";
import { formatMoney } from "@/lib/money";
import { fmt, fmtDate } from "@/lib/time";
import { Badge, ButtonLink, Callout, Card, CardBody, CardHeader, EmptyState, PageHeader, Stat, StatusBadge, Table, Td, Th } from "@/components/ui";

export const metadata = { title: "Membership status" };

const per = (interval: string, count: number) => (interval === "none" ? "" : `/${count > 1 ? `${count} ` : ""}${interval}${count > 1 ? "s" : ""}`);

export default async function MembershipStatusPage({ params }: { params: Promise<{ personId: string }> }) {
  const v = await requireStaff();
  if (!can(v, "billing.view_all")) redirect("/denied");
  const { personId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(personId)) notFound();
  const r = await membershipStatusReport(db, v, personId);
  if (!r) notFound();
  const { who, correspondence: c, attendance: a, rateVsUsage: ru, current } = r;
  const total = r.flags.reduce((s, f) => s + (f.impactMinor ?? 0), 0);
  const maxMonth = Math.max(1, ...a.perMonth.map((m) => m.visits));

  return (
    <>
      <PageHeader
        kicker="Membership status · read-only report"
        title={who.athlete.name}
        description={`As of ${fmtDate(r.asOf)}. Nothing on this page changes billing — it reports what the records show and what to do next.`}
        actions={
          <>
            <ButtonLink href={`/people/${personId}`} variant="ghost">
              Profile
            </ButtonLink>
            <ButtonLink href="/billing/memberships" variant="secondary">
              Memberships & Billing
            </ButtonLink>
            {c.requestsVisible ? (
              <ButtonLink href="/people/requests" variant="secondary">
                Requests log
              </ButtonLink>
            ) : null}
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Flags" value={r.flags.length} tone={r.flags.length ? "bad" : "ok"} hint={r.flags.length ? `${formatMoney(total)} at stake` : "Nothing to fix"} />
        <Stat label="Last visit" value={a.lastVisit ? fmtDate(a.lastVisit) : "Never"} hint={a.daysSinceVisit != null ? `${a.daysSinceVisit} days ago` : undefined} tone={a.daysSinceVisit == null || a.daysSinceVisit >= r.policy.dormantAfterDays ? "warn" : undefined} />
        <Stat label="Plan" value={current ? formatMoney(current.netMinor) : "—"} hint={current ? `${current.product}${per(current.interval, current.intervalCount)}` : "No live membership"} />
        <Stat label="Open requests" value={c.openRequests.length} tone={c.openRequests.length ? "warn" : undefined} hint={c.openRequests[0] ? `oldest sent ${fmtDate(c.openRequests[0].sentOn)}` : undefined} />
      </div>

      {/* FLAGS + RECOMMENDED first: what staff act on */}
      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Flags" kicker="Most expensive first" />
          <CardBody>
            {r.flags.length === 0 ? (
              <EmptyState title="No flags">Billing, attendance and requests line up with policy.</EmptyState>
            ) : (
              <ol className="space-y-3">
                {r.flags.map((f, i) => (
                  <li key={i} className="rounded-lg border border-edge p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-semibold">{f.label}</span>
                      <span className="tabular font-semibold text-bad">{f.impactMinor == null ? "—" : formatMoney(f.impactMinor)}</span>
                    </div>
                    <p className="mt-1 text-sm text-ink-2">{f.detail}</p>
                    <p className="mt-1 text-xs text-ink-3">$: {f.impactBasis}</p>
                  </li>
                ))}
              </ol>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Recommended actions" kicker="Staff decide — nothing is automatic" />
          <CardBody>
            {r.recommended.length === 0 ? (
              <p className="text-sm text-ink-3">No action needed.</p>
            ) : (
              <ol className="list-decimal space-y-2 pl-5 text-sm">
                {r.recommended.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ol>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* WHO */}
        <Card>
          <CardHeader title="Who" kicker="Athlete, guardians, payer, siblings" />
          <CardBody className="space-y-3 text-sm">
            <div>
              <div className="kicker">Athlete</div>
              <Link href={`/people/${personId}`} className="font-medium hover:underline">
                {who.athlete.name}
              </Link>{" "}
              {!who.athlete.active ? <Badge variant="red">inactive</Badge> : null} {who.athlete.sport ? <Badge>{who.athlete.sport}</Badge> : null}
              <div className="text-xs text-ink-3">{[who.athlete.email, who.athlete.phone].filter(Boolean).join(" · ") || "no direct contact"}</div>
            </div>
            <div>
              <div className="kicker">Guardians</div>
              {who.guardians.length ? (
                <ul className="space-y-1">
                  {who.guardians.map((g) => (
                    <li key={g.person_id}>
                      <Link href={`/people/${g.person_id}`} className="font-medium hover:underline">
                        {g.name}
                      </Link>{" "}
                      <span className="text-xs text-ink-3">
                        {g.relationship} · {[g.email, g.phone].filter(Boolean).join(" · ") || "no contact on file"}
                        {!g.can_book ? " · cannot book" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-ink-3">None (adult athlete or not linked)</p>
              )}
            </div>
            <div>
              <div className="kicker">Payer</div>
              {who.payers.length ? (
                who.payers.map((p) => (
                  <p key={p.id}>
                    <span className="font-medium">{p.name}</span> <span className="text-xs text-ink-3">{[p.people, p.billing_email].filter(Boolean).join(" · ")}</span>
                  </p>
                ))
              ) : (
                <p className="text-bad">No payer account linked</p>
              )}
            </div>
            <div>
              <div className="kicker">Siblings / same family</div>
              {who.siblings.length ? (
                <ul className="space-y-1">
                  {who.siblings.map((s) => (
                    <li key={s.athlete_id}>
                      <Link href={`/people/${s.person_id}/membership-status`} className="font-medium hover:underline">
                        {s.name}
                      </Link>{" "}
                      {s.status ? <StatusBadge status={s.status} /> : <Badge>no membership</Badge>} <span className="text-xs text-ink-3">{s.plan ?? ""}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-ink-3">None on file</p>
              )}
            </div>
          </CardBody>
        </Card>

        {/* CORRESPONDENCE */}
        <Card>
          <CardHeader title="Correspondence" kicker="Last contacts & requests" />
          <CardBody className="space-y-4 text-sm">
            <p className="text-ink-3">
              Last from family: {c.lastInbound ? <Link className="text-brand hover:underline" href={`/messages/${c.lastInbound.threadId}`}>{fmt(c.lastInbound.at, "MMM d, yyyy")}</Link> : "none in the Hub"} · Last from staff:{" "}
              {c.lastOutbound ? <Link className="text-brand hover:underline" href={`/messages/${c.lastOutbound.threadId}`}>{fmt(c.lastOutbound.at, "MMM d, yyyy")}</Link> : "none in the Hub"}
            </p>
            <div>
              <div className="kicker mb-1">Open requests</div>
              {!c.requestsVisible ? (
                <p className="text-ink-3">Requests log needs people or CRM access.</p>
              ) : c.openRequests.length === 0 ? (
                <p className="text-ink-3">None open.</p>
              ) : (
                <ul className="space-y-2">
                  {c.openRequests.map((q) => (
                    <li key={q.id} className="rounded-lg border border-edge p-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="brand">{typeLabel(q.type)}</Badge>
                        <span>
                          sent <strong>{fmtDate(q.sentOn)}</strong> via {channelLabel(q.channel)} · {q.daysUnprocessed}d unprocessed
                        </span>
                        {q.suggested ? <Badge variant="yellow">unconfirmed suggestion</Badge> : null}
                        {q.asks > 1 ? <Badge variant="red">asked {q.asks}×</Badge> : null}
                        {q.reply ? <Badge variant="green">replied {fmt(q.reply.at, "MMM d")}</Badge> : <Badge variant="yellow">no reply</Badge>}
                        {BILL_AFFECTING_TYPES.includes(q.type) && q.billDatesPassed.length ? (
                          <Badge variant="red">bill date passed since: {q.billDatesPassed.map((d) => fmtDate(d)).join(", ")}</Badge>
                        ) : null}
                      </div>
                      {q.summary ? <p className="mt-1 text-xs text-ink-3">{q.summary}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="kicker mb-1">Recent messages (Hub only — phone, Messenger and forwarded email appear only if logged as requests)</div>
              {c.contacts.length === 0 ? (
                <p className="text-ink-3">No messages in the Hub.</p>
              ) : (
                <ul className="space-y-1.5">
                  {c.contacts.slice(0, 8).map((m) => (
                    <li key={m.id} className="flex gap-2">
                      <Badge variant={m.direction === "in" ? "blue" : "neutral"}>{m.direction === "in" ? "family" : "staff"}</Badge>
                      <Link href={`/messages/${m.threadId}`} className="min-w-0 flex-1 truncate hover:underline">
                        <span className="text-ink-3">{fmt(m.at, "MMM d")} · {m.sender ?? "unknown"}:</span> {m.snippet}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardBody>
        </Card>

        {/* ATTENDANCE */}
        <Card>
          <CardHeader title="Attendance" kicker="Attended visits only" />
          <CardBody className="space-y-4 text-sm">
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Last 30 days" value={a.visits30} />
              <Stat label="Last 60 days" value={a.visits60} />
              <Stat label="Avg / week" value={a.avgPerWeek == null ? "—" : a.avgPerWeek.toFixed(1)} hint={a.termStart ? `${a.termLabel} (from ${fmtDate(a.termStart)})` : "no current term"} />
            </div>
            <p className="text-xs text-ink-3">
              Not counted as visits (last 60 days): {a.notVisits60.cancelled} cancelled, {a.notVisits60.late_cancelled} late-cancelled, {a.notVisits60.no_show} no-show, {a.notVisits60.booked} booked/not yet checked in.
            </p>
            <figure>
              <figcaption className="kicker mb-1">Visits per month</figcaption>
              <div className="flex h-24 items-end gap-1" role="img" aria-label={`Visits per month: ${a.perMonth.map((m) => `${m.month} ${m.visits}`).join(", ")}`}>
                {a.perMonth.map((m) => (
                  <div key={m.month} className="flex flex-1 flex-col items-center gap-1">
                    <span className="tabular text-[10px] text-ink-3">{m.visits}</span>
                    <div className="w-full rounded-t bg-brand/70" style={{ height: `${(m.visits / maxMonth) * 64}px` }} />
                    <span className="text-[10px] text-ink-3">{m.month.slice(5)}</span>
                  </div>
                ))}
              </div>
            </figure>
            <div>
              <div className="kicker mb-1">Gaps over {r.policy.attendanceGapDays} days</div>
              {a.gaps.length === 0 ? (
                <p className="text-ink-3">None.</p>
              ) : (
                <ul className="space-y-1">
                  {a.gaps.map((g, i) => (
                    <li key={i}>
                      {fmtDate(g.from)} → {g.ongoing ? "today" : fmtDate(g.to)}: <strong>{g.days} days</strong> {g.ongoing ? <Badge variant="red">ongoing</Badge> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardBody>
        </Card>

        {/* RATE vs USAGE */}
        <Card>
          <CardHeader title="Rate vs usage" kicker="Both directions" />
          <CardBody className="space-y-2 text-sm">
            {!ru ? (
              <p className="text-ink-3">No live membership.</p>
            ) : (
              <>
                <p>
                  Paying <strong>{ru.monthlyMinor == null ? "—" : formatMoney(ru.monthlyMinor)}/month</strong> for{" "}
                  {ru.weeklyCap == null ? "an uncapped plan" : <strong>{ru.weeklyCap}/week</strong>}; attending{" "}
                  <strong>{ru.avgPerWeek == null ? "—" : ru.avgPerWeek.toFixed(1)}/week</strong> ({ru.visits30} visits in 30 days
                  {ru.costPerVisit30Minor != null ? `, ${formatMoney(ru.costPerVisit30Minor)} per visit` : ""}).
                </p>
                <Callout tone={ru.payingNotAttending ? "bad" : "ok"} title={ru.payingNotAttending ? "Paying while not attending" : "Attending while paying"}>
                  {ru.payingNotAttending
                    ? `No attended visit for ${r.policy.dormantAfterDays}+ days while billed — expect a refund or hold request.`
                    : `Visited within the last ${r.policy.dormantAfterDays} days (policy dormancy threshold).`}
                </Callout>
                <Callout tone={ru.aboveCap ? "warn" : "ok"} title={ru.aboveCap ? "Consistently above the plan's weekly cap" : "Within the plan's weekly cap"}>
                  {ru.aboveCap ? "Over the cap in most of the last 8 weeks — the plan may not match actual use." : ru.weeklyCap == null ? "Plan has no weekly cap." : "No consistent over-use in the last 8 weeks."}
                </Callout>
              </>
            )}
          </CardBody>
        </Card>
      </div>

      {/* MEMBERSHIP */}
      <Card className="mt-5">
        <CardHeader title="Membership" kicker="Plan, term, commitment, billing history" />
        <CardBody className="space-y-6">
          {r.memberships.length === 0 ? (
            <EmptyState title="No memberships on file" />
          ) : (
            r.memberships.map((m) => (
              <section key={m.id} className="space-y-2" aria-label={m.product}>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">
                    <Link href={`/billing/memberships/${m.id}`} className="hover:underline">
                      {m.product}
                    </Link>
                  </h3>
                  <StatusBadge status={m.status} />
                  {m.inSeason ? <Badge variant="blue">in-season</Badge> : null}
                  <Badge>{m.billingProvider === "external_zenplanner" ? "billed by Zen Planner" : m.billingProvider === "manual" ? "Teamwork invoices" : m.billingProvider}</Badge>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-ink-3">Rate</dt>
                    <dd>
                      {formatMoney(m.netMinor)}
                      {per(m.interval, m.intervalCount)}
                      {m.discountName ? <span className="text-xs text-ink-3"> ({formatMoney(m.priceMinor)} − {m.discountName})</span> : null}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-3">Term</dt>
                    <dd>
                      {fmtDate(m.startDate)} → {m.endDate ? fmtDate(m.endDate) : m.cancelAt ? `cancels ${fmtDate(m.cancelAt)}` : "open"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-3">Commitment</dt>
                    <dd>
                      {m.commitmentMonths ? `${m.commitmentMonths} mo · ${m.monthsServed} served · ${m.monthsRemaining} remaining` : `month-to-month · ${m.monthsServed} mo served`}
                      {m.monthToMonthSince ? <span className="text-xs text-ink-3"> (month-to-month since {fmtDate(m.monthToMonthSince)})</span> : null}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-3">Remaining contract value</dt>
                    <dd>{m.commitmentMonths ? formatMoney(m.remainingContractMinor) : "none (no commitment)"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-3">Next bill</dt>
                    <dd>{m.nextBillDate ? fmtDate(m.nextBillDate) : "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-3">Weekly cap</dt>
                    <dd>{m.unlimited ? "unlimited" : m.weeklyCap ?? "—"}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-xs text-ink-3">Holds</dt>
                    <dd>{m.holds.length ? m.holds.map((h) => `${fmtDate(h.startDate)} → ${fmtDate(h.endDate)}${h.reason ? ` (${h.reason})` : ""}`).join("; ") : "none"}</dd>
                  </div>
                </dl>
                {m.billingProvider === "external_zenplanner" ? (
                  <Callout tone="info">Billed in Zen Planner — bill history is not in the Hub. Check Zen Planner for what was charged.</Callout>
                ) : m.invoices.length === 0 ? (
                  <p className="text-sm text-ink-3">No bills yet.</p>
                ) : (
                  <Table caption={`Billing history for ${m.product}`}>
                    <thead>
                      <tr>
                        <Th>Bill date</Th>
                        <Th>Invoice</Th>
                        <Th align="right">Billed</Th>
                        <Th align="right">Paid</Th>
                        <Th>Status</Th>
                        <Th>Note</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.invoices.map((i) => (
                        <tr key={i.id} className={i.differs ? "bg-warn/5" : undefined}>
                          <Td>{fmtDate(i.periodStart)}</Td>
                          <Td>{i.number}</Td>
                          <Td align="right">{formatMoney(i.totalMinor)}</Td>
                          <Td align="right">{formatMoney(i.paidMinor)}</Td>
                          <Td>
                            <StatusBadge status={i.status} />
                          </Td>
                          <Td>{i.differs ? <Badge variant="yellow">differs from usual {formatMoney(m.usualBillMinor)}</Badge> : null}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </section>
            ))
          )}
        </CardBody>
      </Card>

      <details className="mt-5 text-xs text-ink-3">
        <summary className="cursor-pointer font-medium">What this report could not see</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {r.skipped.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </details>
    </>
  );
}
