import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { requireStaff, getOrg } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { reportByKey, type ReportColumn } from "@/lib/reports";
import { addDaysYmd, fmt, fmtDate, todayLocal } from "@/lib/time";
import { formatMoney } from "@/lib/money";
import { ButtonLink, Callout, Card, CardBody, EmptyState, Input, PageHeader, Stat, Table, Td, Th } from "@/components/ui";

export const metadata = { title: "Report" };

function cell(v: unknown, kind: ReportColumn["kind"], tz?: string) {
  if (v == null || v === "") return <span className="text-ink-3">—</span>;
  switch (kind) {
    case "money":
      return formatMoney(Number(v));
    case "pct":
      return `${Math.round(Number(v) * 1000) / 10}%`;
    case "date":
      return fmtDate(String(v));
    case "datetime":
      return fmt(v as string, "MMM d, yyyy h:mm a", tz);
    case "int":
      return Number(v).toLocaleString();
    default:
      return String(v);
  }
}

export default async function ReportPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<{ from?: string; to?: string }> }) {
  const v = await requireStaff();
  const { key } = await params;
  const def = reportByKey(key);
  if (!def) notFound();
  if (!can(v, def.cap)) redirect("/denied");
  const org = await getOrg(v.orgId);
  const tz = org?.timezone ?? "America/Indiana/Indianapolis";
  const sp = await searchParams;
  const today = todayLocal(tz);
  const valid = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);
  const to = valid(sp.to) ?? today;
  const from = valid(sp.from) ?? addDaysYmd(to, -29);
  const result = from > to ? null : await def.run(db, v.orgId, { from, to, tz });
  return (
    <>
      <PageHeader
        kicker={`Reports · ${def.category}`}
        title={def.title}
        actions={
          <>
            <ButtonLink href="/reports" variant="ghost">
              All reports
            </ButtonLink>
            <ButtonLink href={`/api/reports/${def.key}?from=${from}&to=${to}`} variant="secondary" download>
              Export CSV
            </ButtonLink>
          </>
        }
      />
      <Callout tone="info" title="Definition" className="mb-4">
        {def.definition}
      </Callout>
      <form className="mb-5 flex flex-wrap items-end gap-3" action={`/reports/${def.key}`}>
        <div>
          <label htmlFor="from" className="block text-sm font-medium text-ink-2">
            From
          </label>
          <Input id="from" name="from" type="date" defaultValue={from} className="w-44" />
        </div>
        <div>
          <label htmlFor="to" className="block text-sm font-medium text-ink-2">
            To (inclusive)
          </label>
          <Input id="to" name="to" type="date" defaultValue={to} className="w-44" />
        </div>
        <button className="h-10 rounded-lg bg-brand px-4 text-sm font-medium text-brand-ink" type="submit">
          Apply
        </button>
        <span className="text-xs text-ink-3">Dates are {tz} local days.</span>
      </form>
      {!result ? (
        <Callout tone="bad">The start date must be on or before the end date.</Callout>
      ) : (
        <>
          {result.summary?.length ? (
            <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
              {result.summary.map((s) => (
                <Stat key={s.label} label={s.label} value={s.kind === "money" ? formatMoney(Number(s.value)) : s.value} />
              ))}
            </div>
          ) : null}
          <Card>
            <CardBody className="pt-4">
              {result.rows.length === 0 ? (
                <EmptyState title="No data for this range" />
              ) : (
                <Table caption={def.title}>
                  <thead>
                    <tr>
                      {def.columns.map((c) => (
                        <Th key={c.key} align={c.kind && c.kind !== "text" && c.kind !== "date" && c.kind !== "datetime" ? "right" : "left"}>
                          {c.label}
                        </Th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r, i) => (
                      <tr key={i}>
                        {def.columns.map((c) => (
                          <Td key={c.key} align={c.kind && c.kind !== "text" && c.kind !== "date" && c.kind !== "datetime" ? "right" : "left"}>
                            {cell(r[c.key], c.kind, tz)}
                          </Td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </CardBody>
          </Card>
          <p className="mt-3 text-xs text-ink-3">
            {result.rows.length} rows · {fmtDate(from)} – {fmtDate(to)} ·{" "}
            <Link href="/reports" className="underline">
              definitions of all reports
            </Link>
          </p>
        </>
      )}
    </>
  );
}
