import { db } from "@/db";
import { ChartFigure } from "@/components/charts/chart-figure";
import { fmtChartValue } from "@/components/charts/format";
import { ReportBarChart } from "@/components/charts/report-chart";
import { ActionForm, SubmitButton } from "@/components/forms";
import { DefinitionsDrawer, ExportLink, FilterBar, MonthsSelect, NA, ScoreboardTabs, money, pctText, scoreboardQs } from "@/components/scoreboard/shell";
import { ButtonLink, Callout, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select, Stat, Table, Td, Th } from "@/components/ui";
import { SCOREBOARD_EXPENSE_CATEGORIES } from "@/db/schema";
import { formatMoney } from "@/lib/money";
import { monthLabel } from "@/lib/scoreboard/core";
import { EXPENSE_LABEL, marginView, moneyView, type MoneyMonth, type Pivot } from "@/lib/scoreboard/money";
import { deleteExpenseAction, saveExpenseAction } from "../actions";
import { loadScoreboard, type ScoreboardSearch } from "../_load";

export const metadata = { title: "Money view" };

function PivotTable({ caption, first, p, months }: { caption: string; first: string; p: Pivot; months: MoneyMonth[] }) {
  if (!p.groups.length) return <EmptyState title="Nothing collected in these months" />;
  const colTotal = (m: string) => p.groups.reduce((s, g) => s + (p.byMonth[m]?.[g] ?? 0), 0);
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <Th>{first}</Th>
          {months.map((m) => (
            <Th key={m.month} align="right" className="whitespace-nowrap">
              {m.label}
              {m.partial ? "*" : ""}
            </Th>
          ))}
          <Th align="right">Total</Th>
        </tr>
      </thead>
      <tbody>
        {p.groups.map((g) => (
          <tr key={g}>
            <Td className="font-medium">{g}</Td>
            {months.map((m) => (
              <Td key={m.month} align="right">
                {formatMoney(p.byMonth[m.month]?.[g] ?? 0)}
              </Td>
            ))}
            <Td align="right" className="font-semibold">
              {formatMoney(months.reduce((s, m) => s + (p.byMonth[m.month]?.[g] ?? 0), 0))}
            </Td>
          </tr>
        ))}
        <tr className="font-semibold">
          <Td>Collected (all groups)</Td>
          {months.map((m) => (
            <Td key={m.month} align="right">
              {formatMoney(colTotal(m.month))}
            </Td>
          ))}
          <Td align="right">{formatMoney(months.reduce((s, m) => s + colTotal(m.month), 0))}</Td>
        </tr>
      </tbody>
    </Table>
  );
}

export default async function MoneyPage({ searchParams }: { searchParams: Promise<ScoreboardSearch> }) {
  const { v, c, locations, programs, months, q, canManage } = await loadScoreboard(searchParams);
  const mv = await moneyView(db, c, { months });
  const mg = await marginView(db, v, c, { months });
  const qm = { ...q, months };
  const cur = mv.months[mv.months.length - 1];
  const prev = mv.months.length > 1 ? mv.months[mv.months.length - 2] : null;
  const chart = mv.months.map((m) => ({ x: m.month, label: m.partial ? `${m.label}*` : m.label, collected: m.collectedMinor, billed: m.billedMinor }));
  return (
    <>
      <PageHeader
        kicker="Owner scoreboard"
        title="Money view"
        description="Collected, billed and still owed by month, where the revenue came from, and a simple margin from the expenses you enter."
        actions={
          <ButtonLink href={`/api/scoreboard/money${scoreboardQs(qm)}`} variant="secondary" download>
            Export CSV
          </ButtonLink>
        }
      />
      <ScoreboardTabs current="money" q={q} />
      <FilterBar action="/scoreboard/money" locations={locations} programs={programs} q={q}>
        <MonthsSelect value={months} />
      </FilterBar>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={`Collected, ${cur.label} to date`} value={formatMoney(cur.collectedMinor)} hint={`Billed ${formatMoney(cur.billedMinor)}`} />
        {prev ? <Stat label={`Collected, ${prev.label}`} value={formatMoney(prev.collectedMinor)} hint={`Refunds ${formatMoney(prev.refundsMinor)}`} /> : null}
        <Stat label="Outstanding now" value={formatMoney(mv.outstandingNowMinor)} hint="Unpaid balance of all open invoices" />
        {prev ? <Stat label={`Camps and clinics, ${prev.label}`} value={prev.eventsMinor == null ? <NA>n/a with filter</NA> : formatMoney(prev.eventsMinor)} hint="Part of collected" /> : null}
      </div>

      <Card className="mb-5">
        <CardHeader title="Collected, billed and outstanding" action={<ExportLink table="money" q={qm} />} />
        <CardBody className="pt-0">
          <Table caption="Collected, billed and outstanding by month">
            <thead>
              <tr>
                <Th>Month</Th>
                <Th align="right">Collected</Th>
                <Th align="right">Refunds</Th>
                <Th align="right">Net collected</Th>
                <Th align="right">Billed</Th>
                <Th align="right">Outstanding today</Th>
                <Th align="right">Account credits issued</Th>
                <Th align="right">Camps and clinics</Th>
              </tr>
            </thead>
            <tbody>
              {mv.months.map((m) => (
                <tr key={m.month}>
                  <Td className="whitespace-nowrap font-medium">
                    {m.label}
                    {m.partial ? <span className="text-xs font-normal text-ink-3"> to date</span> : null}
                  </Td>
                  <Td align="right">{formatMoney(m.collectedMinor)}</Td>
                  <Td align="right">{formatMoney(m.refundsMinor)}</Td>
                  <Td align="right">{formatMoney(m.netMinor)}</Td>
                  <Td align="right">{formatMoney(m.billedMinor)}</Td>
                  <Td align="right">{formatMoney(m.outstandingMinor)}</Td>
                  <Td align="right">{m.creditsMinor == null ? <NA>n/a with filter</NA> : formatMoney(m.creditsMinor)}</Td>
                  <Td align="right">{m.eventsMinor == null ? <NA>n/a with filter</NA> : formatMoney(m.eventsMinor)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-3 text-xs text-ink-3">Outstanding is today&apos;s unpaid balance on invoices issued in that month. Account credits are referral rewards: not money received. Camp and clinic revenue is part of Collected.</p>
        </CardBody>
      </Card>

      <Card className="mb-5">
        <CardBody className="pt-4">
          <ChartFigure
            title="Collected and billed by month"
            unit="US dollars"
            range={`${mv.months[0].label} to ${cur.label}`}
            summary={`Collected ${formatMoney(mv.months.reduce((s, m) => s + m.collectedMinor, 0))} against ${formatMoney(mv.months.reduce((s, m) => s + m.billedMinor, 0))} billed over these ${mv.months.length} months.`}
            note={`* ${cur.label} is month to date. Collected counts money by the day it settled; billed counts invoices by the day they were issued, so a month's two bars are not the same invoices.`}
            legend={[
              { label: "Collected", slot: 0, kind: "rect" },
              { label: "Billed", slot: 1, kind: "rect" },
            ]}
            columns={["Month", "Collected", "Billed"]}
            rows={chart.map((d) => [d.label, fmtChartValue(d.collected, "usd_minor"), fmtChartValue(d.billed, "usd_minor")])}
          >
            <ReportBarChart
              data={chart}
              series={[
                { key: "collected", label: "Collected" },
                { key: "billed", label: "Billed" },
              ]}
              unit="usd_minor"
              layout="grouped"
            />
          </ChartFigure>
        </CardBody>
      </Card>

      <Card className="mb-5">
        <CardHeader title="Collected by membership option" kicker="Groups add up to Collected" action={<ExportLink table="money-options" q={qm} />} />
        <CardBody className="pt-0">
          <PivotTable caption="Collected by membership option" first="Option" p={mv.byOption} months={mv.months} />
        </CardBody>
      </Card>

      <Card className="mb-5">
        <CardHeader title="Collected by location" kicker="Groups add up to Collected" action={<ExportLink table="money-locations" q={qm} />} />
        <CardBody className="pt-0">
          <PivotTable caption="Collected by location" first="Location" p={mv.byLocation} months={mv.months} />
        </CardBody>
      </Card>

      <Card className="mb-5" id="margin">
        <CardHeader title="Operating margin" kicker="Management estimate, not accounting" action={mg.access === "ok" ? <ExportLink table="margin" q={qm} /> : undefined} />
        <CardBody className="space-y-4 pt-0">
          <Callout tone="warn" title="A management estimate, not accounting">
            Cash collected minus the costs typed in here, marketing spend and payroll. No accruals, taxes, depreciation or owner pay. Nothing is sent to or read from an accounting system. Do not use it for filings.
          </Callout>
          {mg.access === "restricted" ? (
            <Callout tone="info" title="Restricted">
              The margin includes payroll cost, so it is shown to the owner, admins and operations staff who were given payroll access.
            </Callout>
          ) : mg.access === "filtered" ? (
            <Callout tone="info" title="Not available with a filter">
              Expenses are not split by location or program. Clear the filter to see the margin.
            </Callout>
          ) : (
            <>
              <Table caption="Operating margin by month (management estimate)">
                <thead>
                  <tr>
                    <Th>Month</Th>
                    <Th align="right">Net collected</Th>
                    <Th align="right">Rent</Th>
                    <Th align="right">Software</Th>
                    <Th align="right">Marketing</Th>
                    <Th align="right">Other</Th>
                    <Th align="right">Payroll</Th>
                    <Th align="right">Before payroll</Th>
                    <Th align="right">Margin (estimate)</Th>
                  </tr>
                </thead>
                <tbody>
                  {mg.months.map((m) => (
                    <tr key={m.month}>
                      <Td className="whitespace-nowrap font-medium">
                        {m.label}
                        {m.partial ? <span className="text-xs font-normal text-ink-3"> to date</span> : null}
                      </Td>
                      <Td align="right">{formatMoney(m.netCollectedMinor)}</Td>
                      <Td align="right">{m.rentMinor == null ? <NA>none entered</NA> : formatMoney(m.rentMinor)}</Td>
                      <Td align="right">{m.softwareMinor == null ? <NA>none entered</NA> : formatMoney(m.softwareMinor)}</Td>
                      <Td align="right">{m.marketingMinor == null ? <NA>none entered</NA> : formatMoney(m.marketingMinor)}</Td>
                      <Td align="right">{m.otherMinor == null ? <NA>none entered</NA> : formatMoney(m.otherMinor)}</Td>
                      <Td align="right">
                        {money(m.payrollMinor)}
                        <span className="block text-xs text-ink-3">{m.payrollSource}</span>
                      </Td>
                      <Td align="right">{formatMoney(m.beforePayrollMinor)}</Td>
                      <Td align="right" className="font-semibold">
                        {m.marginMinor == null ? (
                          <NA>not available: payroll {m.payrollMinor == null ? "missing" : "incomplete"}</NA>
                        ) : (
                          <>
                            {formatMoney(m.marginMinor)}
                            {m.marginPercent != null ? <span className="block text-xs font-normal text-ink-3">{pctText(m.marginPercent)} of net collected</span> : null}
                          </>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {canManage ? (
                <ActionForm action={saveExpenseAction} resetOnSuccess className="space-y-3">
                  <h3 className="text-sm font-semibold">Add or replace a monthly expense</h3>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0">
                    <Field label="Month" htmlFor="ex-month" required>
                      <Input id="ex-month" name="month" type="month" defaultValue={c.today.slice(0, 7)} required />
                    </Field>
                    <Field label="Category" htmlFor="ex-category" hint="Marketing comes from the Marketing tab; payroll from Payroll." required>
                      <Select id="ex-category" name="category" defaultValue="rent">
                        {SCOREBOARD_EXPENSE_CATEGORIES.map((k) => (
                          <option key={k} value={k}>
                            {EXPENSE_LABEL[k]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Label (optional)" htmlFor="ex-label">
                      <Input id="ex-label" name="label" maxLength={60} />
                    </Field>
                    <Field label="Amount (USD)" htmlFor="ex-amount" required>
                      <Input id="ex-amount" name="amount" inputMode="decimal" placeholder="0.00" required />
                    </Field>
                  </div>
                  <SubmitButton>Save expense</SubmitButton>
                  <p className="text-xs text-ink-3">Payroll entered by hand is only used for a month with no time-clock data. Saving the same month, category and label again replaces the amount. Every change is audited.</p>
                </ActionForm>
              ) : null}
              {mg.entries.length ? (
                <details>
                  <summary className="cursor-pointer text-sm font-medium">Expense entries ({mg.entries.length})</summary>
                  <div className="mt-2">
                    <div className="mb-1 text-right">
                      <ExportLink table="expenses" q={qm} />
                    </div>
                    <Table caption="Expense entries">
                      <thead>
                        <tr>
                          <Th>Month</Th>
                          <Th>Category</Th>
                          <Th>Label</Th>
                          <Th align="right">Amount</Th>
                          {canManage ? <Th /> : null}
                        </tr>
                      </thead>
                      <tbody>
                        {mg.entries.map((e) => (
                          <tr key={e.id}>
                            <Td className="whitespace-nowrap">{monthLabel(e.month)}</Td>
                            <Td>{EXPENSE_LABEL[e.category]}</Td>
                            <Td>{e.label}</Td>
                            <Td align="right">{formatMoney(e.amountMinor)}</Td>
                            {canManage ? (
                              <Td align="right">
                                <ActionForm action={deleteExpenseAction}>
                                  <input type="hidden" name="id" value={e.id} />
                                  <SubmitButton variant="ghost" size="sm" confirm={`Remove ${EXPENSE_LABEL[e.category]} for ${monthLabel(e.month)}?`}>
                                    Remove<span className="sr-only"> {EXPENSE_LABEL[e.category]} {e.label} {monthLabel(e.month)}</span>
                                  </SubmitButton>
                                </ActionForm>
                              </Td>
                            ) : null}
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                </details>
              ) : null}
            </>
          )}
        </CardBody>
      </Card>

      <DefinitionsDrawer tab="money" />
    </>
  );
}
