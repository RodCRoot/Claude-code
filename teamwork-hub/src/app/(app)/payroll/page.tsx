import Link from "next/link";
import { db } from "@/db";
import { UserError } from "@/lib/actions";
import { calculatePayroll, listRuns } from "@/lib/payroll/service";
import type { PayrollResult } from "@/lib/payroll/engine";
import { addDaysYmd, fmt, fmtDate, startOfWeekYmd, todayLocal } from "@/lib/time";
import { formatMoney } from "@/lib/money";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, StatusBadge, Table, Td, Th, buttonClass } from "@/components/ui";
import { createRunAction } from "./actions";
import { PayrollResultView } from "./_result";
import { PayrollTabs, requirePayroll } from "./_shared";

export const metadata = { title: "Payroll" };
export const dynamic = "force-dynamic";

const valid = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);

function presets(today: string) {
  const [y, m] = today.split("-");
  const monthStart = `${y}-${m}-01`;
  const monthEnd = addDaysYmd(`${m === "12" ? Number(y) + 1 : y}-${m === "12" ? "01" : String(Number(m) + 1).padStart(2, "0")}-01`, -1);
  const week = startOfWeekYmd(today);
  return [
    { label: "This week", from: week, to: addDaysYmd(week, 6) },
    { label: "Last 2 weeks", from: addDaysYmd(today, -13), to: today },
    { label: "1st–15th", from: monthStart, to: `${y}-${m}-15` },
    { label: "16th–end", from: `${y}-${m}-16`, to: monthEnd },
  ];
}

export default async function PayrollPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { v, tz } = await requirePayroll();
  const sp = await searchParams;
  const today = todayLocal(tz);
  const to = valid(sp.to) ?? today;
  const from = valid(sp.from) ?? addDaysYmd(to, -13);
  let result: PayrollResult | null = null;
  let error: string | null = null;
  try {
    result = await calculatePayroll(db, v, { from, to });
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    error = e.message;
  }
  const runs = await listRuns(db, v);
  return (
    <>
      <PageHeader
        kicker="Staff"
        title="Payroll"
        description="Pick any date range — entries are stitched across pay periods automatically. Review the flags, fix what's wrong, then save a run to approve and export."
      />
      <PayrollTabs current="run" />
      <Card className="mb-5">
        <CardBody className="pt-4">
          <form method="get" className="flex flex-wrap items-end gap-3">
            <Field label="From" htmlFor="from">
              <Input id="from" name="from" type="date" defaultValue={from} required />
            </Field>
            <Field label="To" htmlFor="to">
              <Input id="to" name="to" type="date" defaultValue={to} required />
            </Field>
            <button type="submit" className={buttonClass("primary")}>
              Calculate
            </button>
            <div className="flex flex-wrap gap-2 text-sm">
              {presets(today).map((p) => (
                <Link key={p.label} href={`/payroll?from=${p.from}&to=${p.to}`} className="rounded-lg border border-edge px-2 py-1 hover:bg-surface-2">
                  {p.label}
                </Link>
              ))}
            </div>
          </form>
        </CardBody>
      </Card>
      {error ? (
        <Callout tone="bad">{error}</Callout>
      ) : result ? (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-3">
              {fmtDate(from)} – {fmtDate(to)} · calculated {fmt(result.generatedAt, "MMM d h:mm a", tz)}
            </p>
            <ActionForm action={createRunAction}>
              <input type="hidden" name="from" value={from} />
              <input type="hidden" name="to" value={to} />
              <SubmitButton variant="secondary" pendingText="Saving…">
                Save as draft run
              </SubmitButton>
            </ActionForm>
          </div>
          <PayrollResultView result={result} tz={tz} editable />
        </>
      ) : null}
      <Card className="mt-6">
        <CardHeader title="Saved runs" />
        <CardBody>
          {runs.length === 0 ? (
            <p className="text-sm text-ink-3">No saved runs yet.</p>
          ) : (
            <Table caption="Saved payroll runs">
              <thead>
                <tr>
                  <Th>Range</Th>
                  <Th>Status</Th>
                  <Th align="right">Gross</Th>
                  <Th align="right">Net</Th>
                  <Th>Saved</Th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <Td>
                      <Link href={`/payroll/runs/${r.id}`} className="text-brand underline">
                        {fmtDate(r.fromDate)} – {fmtDate(r.toDate)}
                      </Link>
                    </Td>
                    <Td>
                      <StatusBadge status={r.status} />
                    </Td>
                    <Td align="right">{formatMoney(r.grossMinor)}</Td>
                    <Td align="right">{formatMoney(r.netMinor)}</Td>
                    <Td className="text-xs text-ink-3">{fmt(r.createdAt, "MMM d h:mm a", tz)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </>
  );
}
