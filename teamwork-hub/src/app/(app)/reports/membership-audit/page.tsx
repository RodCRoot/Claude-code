import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { getOrg, requireStaff } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { EXCEPTION_LABELS, membershipAuditSweep, type ExceptionType } from "@/lib/member-ops/membership-audit";
import { reportByKey } from "@/lib/reports";
import { formatMoney } from "@/lib/money";
import { fmtDate, todayLocal } from "@/lib/time";
import { ButtonLink, Callout, Card, CardBody, EmptyState, Input, PageHeader, Stat, Table, Td, Th } from "@/components/ui";

export const metadata = { title: "Membership audit" };

export default async function MembershipAuditPage({ searchParams }: { searchParams: Promise<{ to?: string; type?: string }> }) {
  const v = await requireStaff();
  const def = reportByKey("membership-audit")!;
  if (!can(v, def.cap)) redirect("/denied");
  const org = await getOrg(v.orgId);
  const tz = org?.timezone ?? "America/Indiana/Indianapolis";
  const sp = await searchParams;
  const today = todayLocal(tz);
  const asOf = sp.to && /^\d{4}-\d{2}-\d{2}$/.test(sp.to) && sp.to <= today ? sp.to : today;
  const res = await membershipAuditSweep(db, v.orgId, { today: asOf });
  const type = sp.type && sp.type in EXCEPTION_LABELS ? (sp.type as ExceptionType) : undefined;
  const shown = type ? res.exceptions.filter((e) => e.type === type) : res.exceptions;
  const total = res.exceptions.reduce((s, e) => s + (e.impactMinor ?? 0), 0);
  const byType = Object.entries(
    res.exceptions.reduce<Record<string, { n: number; minor: number }>>((acc, e) => {
      acc[e.type] ??= { n: 0, minor: 0 };
      acc[e.type].n++;
      acc[e.type].minor += e.impactMinor ?? 0;
      return acc;
    }, {}),
  ).sort((a, b) => b[1].minor - a[1].minor);

  return (
    <>
      <PageHeader
        kicker="Reports · Memberships"
        title="Membership audit"
        description="Screens every membership from the records, then lists the exceptions with their dollar impact, most expensive first. Read-only — each line says what to do; staff decide."
        actions={
          <>
            <ButtonLink href="/reports" variant="ghost">
              All reports
            </ButtonLink>
            <ButtonLink href={`/api/reports/membership-audit?from=${asOf}&to=${asOf}`} variant="secondary" download>
              Export CSV
            </ButtonLink>
          </>
        }
      />
      <form className="mb-5 flex flex-wrap items-end gap-3" action="/reports/membership-audit">
        <div>
          <label htmlFor="to" className="block text-sm font-medium text-ink-2">
            As of
          </label>
          <Input id="to" name="to" type="date" max={today} defaultValue={asOf} className="w-44" />
        </div>
        <button className="h-10 rounded-lg bg-brand px-4 text-sm font-medium text-brand-ink" type="submit">
          Run
        </button>
        <span className="text-xs text-ink-3">{tz} local dates.</span>
      </form>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Exceptions" value={res.exceptions.length} tone={res.exceptions.length ? "bad" : "ok"} />
        <Stat label="$ impact (sum)" value={formatMoney(total)} hint="mix of one-time and per-month figures — see each line" />
        <Stat label="Live memberships screened" value={res.screened.live} hint={`${res.screened.memberships} total on file`} />
        <Stat label="Currently billed" value={res.screened.billed} hint={`${res.screened.requests} logged requests checked`} />
      </div>
      {byType.length ? (
        <nav aria-label="Filter by exception" className="mb-4 flex flex-wrap gap-2">
          <Link href={`/reports/membership-audit?to=${asOf}`} aria-current={!type ? "true" : undefined} className={`rounded-full border px-3 py-1.5 text-sm ${!type ? "border-brand bg-brand text-brand-ink" : "border-edge"}`}>
            All
          </Link>
          {byType.map(([k, x]) => (
            <Link
              key={k}
              href={`/reports/membership-audit?to=${asOf}&type=${k}`}
              aria-current={type === k ? "true" : undefined}
              className={`rounded-full border px-3 py-1.5 text-sm ${type === k ? "border-brand bg-brand text-brand-ink" : "border-edge"}`}
            >
              {EXCEPTION_LABELS[k as ExceptionType]} · {x.n} · {formatMoney(x.minor)}
            </Link>
          ))}
        </nav>
      ) : null}
      <Card>
        <CardBody className="pt-4">
          {shown.length === 0 ? (
            <EmptyState title="No exceptions">Every screened membership lines up with policy as of {fmtDate(asOf)}.</EmptyState>
          ) : (
            <Table caption="Membership exceptions">
              <thead>
                <tr>
                  <Th>Exception</Th>
                  <Th>Athlete(s)</Th>
                  <Th>Detail</Th>
                  <Th align="right">$ impact</Th>
                  <Th>Recommended action</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e, i) => (
                  <tr key={i} className="align-top">
                    <Td className="font-medium">{e.label}</Td>
                    <Td>
                      {e.personId ? (
                        <Link href={`/people/${e.personId}/membership-status`} className="font-medium hover:underline">
                          {e.athleteNames}
                        </Link>
                      ) : (
                        e.athleteNames
                      )}
                      {e.payerName ? <div className="text-xs text-ink-3">{e.payerName}</div> : null}
                    </Td>
                    <Td className="max-w-md text-ink-2">{e.detail}</Td>
                    <Td align="right">
                      <div className="font-semibold">{e.impactMinor == null ? "—" : formatMoney(e.impactMinor)}</div>
                      <div className="max-w-48 text-xs font-normal text-ink-3">{e.impactBasis}</div>
                    </Td>
                    <Td className="max-w-sm text-xs text-ink-2">{e.recommendation}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
      <Callout tone="info" title="What was skipped or estimated" className="mt-5">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Screened {res.screened.memberships} memberships for {res.screened.athletes} athletes, {res.screened.requests} logged requests and {res.screened.payers} payers as of {fmtDate(asOf)}.
          </li>
          {res.skipped.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </Callout>
    </>
  );
}
