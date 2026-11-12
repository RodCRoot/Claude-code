import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { DefinitionsDrawer, ExportLink, FilterBar, MonthsSelect, NA, ScoreboardTabs, money, pctText, scoreboardQs } from "@/components/scoreboard/shell";
import { Badge, ButtonLink, Callout, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { DEFAULT_THRESHOLDS, THRESHOLD_FIELDS } from "@/lib/scoreboard/core";
import { payrollByMonth, SLOT_WEEKS, slotUtilisation } from "@/lib/scoreboard/efficiency";
import { fmtDate } from "@/lib/time";
import { saveThresholdsAction } from "../actions";
import { loadScoreboard, type ScoreboardSearch } from "../_load";

export const metadata = { title: "Schedule and payroll efficiency" };

const WEEKDAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const time12 = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

export default async function EfficiencyPage({ searchParams }: { searchParams: Promise<ScoreboardSearch> }) {
  const { v, c, locations, programs, months, weeks, q, canManage } = await loadScoreboard(searchParams);
  const slots = await slotUtilisation(db, c, { weeks });
  const pay = await payrollByMonth(db, v, c, { months });
  const th = c.settings.thresholds;
  const qx = { ...q, months, weeks };
  const full = slots.rows.filter((r) => r.flag === "full");
  const under = slots.rows.filter((r) => r.flag === "under");
  return (
    <>
      <PageHeader
        kicker="Owner scoreboard"
        title="Schedule and payroll"
        description="Which weekly time slots are worth their coaching hours, and what payroll costs against what was collected."
        actions={
          <ButtonLink href={`/api/scoreboard/slots${scoreboardQs(qx)}`} variant="secondary" download>
            Export slots CSV
          </ButtonLink>
        }
      />
      <ScoreboardTabs current="efficiency" q={q} />
      <FilterBar action="/scoreboard/efficiency" locations={locations} programs={programs} q={q}>
        <div>
          <label htmlFor="sb-weeks" className="block text-sm font-medium text-ink-2">
            Weeks of history
          </label>
          <Select id="sb-weeks" name="weeks" defaultValue={String(weeks)} className="w-28">
            {SLOT_WEEKS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </div>
        <MonthsSelect value={months} />
      </FilterBar>

      <Card className="mb-5">
        <CardHeader
          title="Weekly time slots"
          kicker={`${fmtDate(slots.from)} to ${fmtDate(slots.to)} · ${full.length} consistently full · ${under.length} consistently under ${th.slotUnderPercent}%`}
          action={<ExportLink table="slots" q={qx} />}
        />
        <CardBody className="pt-0">
          {slots.rows.length === 0 ? (
            <EmptyState title="No group sessions ran in this period" />
          ) : (
            <Table caption="Weekly time slot utilisation">
              <thead>
                <tr>
                  <Th>Slot</Th>
                  <Th>Class</Th>
                  <Th>Location</Th>
                  <Th align="right">Sessions run</Th>
                  <Th align="right">Avg attendance</Th>
                  <Th align="right">Avg capacity</Th>
                  <Th align="right">Utilisation</Th>
                  <Th align="right">Booked</Th>
                  <Th>Flag</Th>
                </tr>
              </thead>
              <tbody>
                {slots.rows.map((r, i) => (
                  <tr key={i} data-flag={r.flag ?? undefined}>
                    <Td className="whitespace-nowrap font-medium">
                      {WEEKDAY[r.weekday]} {time12(r.startTime)}
                    </Td>
                    <Td>{r.title}</Td>
                    <Td>{r.location}</Td>
                    <Td align="right">{r.sessions}</Td>
                    <Td align="right">{r.avgAttendance.toFixed(1)}</Td>
                    <Td align="right">{(r.capacity / r.sessions).toFixed(1)}</Td>
                    <Td align="right">{pctText(r.utilisation) ?? <NA />}</Td>
                    <Td align="right">{pctText(r.fillRate) ?? <NA />}</Td>
                    <Td>
                      {r.flag ? (
                        <>
                          <Badge variant={r.flag === "full" ? "blue" : "yellow"}>{r.flag === "full" ? "Consistently full" : `Consistently under ${th.slotUnderPercent}%`}</Badge>
                          <span className="mt-0.5 block text-xs text-ink-2">{r.flagText}</span>
                        </>
                      ) : r.sessions < th.slotMinSessions ? (
                        <span className="text-xs text-ink-3">Too few sessions to flag</span>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="mt-3 text-xs text-ink-3">
            Utilisation = attended / capacity. Booked = booked / capacity (the Utilization report&apos;s fill rate). A flag is a prompt to look at the slot, not a decision: a new class, a holiday week or a capacity that was set too high can all trip it.
          </p>
        </CardBody>
      </Card>

      {canManage ? (
        <Card className="mb-5">
          <CardHeader title="Thresholds" kicker="Owner / admin" action={<Badge variant="yellow">Starting points, not norms</Badge>} />
          <CardBody className="pt-0">
            <ActionForm action={saveThresholdsAction} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 [&>*]:min-w-0">
                {THRESHOLD_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label} htmlFor={`th-${f.key}`} hint={`${f.hint ? `${f.hint} ` : ""}Starting point: ${DEFAULT_THRESHOLDS[f.key]}.`}>
                    <Input id={`th-${f.key}`} name={f.key} type="number" min={f.min} max={f.max} defaultValue={String(th[f.key])} required />
                  </Field>
                ))}
              </div>
              <SubmitButton>Save thresholds</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}

      <Card className="mb-5">
        <CardHeader title="Coaching hours and payroll cost" kicker="From the payroll module, per month" action={pay.access === "ok" ? <ExportLink table="payroll" q={qx} /> : undefined} />
        <CardBody className="pt-0">
          {pay.access === "restricted" ? (
            <Callout tone="info" title="Payroll figures are restricted">
              Payroll cost is shown to the owner, admins and operations staff who were given payroll access in Payroll, Settings.
            </Callout>
          ) : pay.access === "filtered" ? (
            <Callout tone="info" title="Not available with a filter">
              Payroll is not split by location or program. Clear the filter to see it.
            </Callout>
          ) : (
            <>
              <Table caption="Coaching hours and payroll cost by month">
                <thead>
                  <tr>
                    <Th>Month</Th>
                    <Th align="right">Coaching hours</Th>
                    <Th align="right">All staff hours</Th>
                    <Th align="right">Payroll cost (gross)</Th>
                    <Th align="right">Collected</Th>
                    <Th align="right">Payroll % of collected</Th>
                  </tr>
                </thead>
                <tbody>
                  {pay.months.map((m) => (
                    <tr key={m.month}>
                      <Td className="whitespace-nowrap font-medium">
                        {m.label}
                        {m.partial ? <span className="text-xs font-normal text-ink-3"> to date</span> : null}
                      </Td>
                      {m.status === "none" ? (
                        <>
                          <Td align="right">
                            <NA />
                          </Td>
                          <Td align="right">
                            <NA />
                          </Td>
                          <Td align="right">
                            <NA>not available: no time-clock entries</NA>
                          </Td>
                          <Td align="right">{money(m.collectedMinor)}</Td>
                          <Td align="right">
                            <NA />
                          </Td>
                        </>
                      ) : (
                        <>
                          <Td align="right">{m.coachingHours?.toFixed(2)}</Td>
                          <Td align="right">{m.totalHours?.toFixed(2)}</Td>
                          <Td align="right">
                            {money(m.grossMinor)}
                            {m.status === "incomplete" ? <span className="block text-xs text-ink-2">incomplete: some hours have no pay rate</span> : null}
                          </Td>
                          <Td align="right">{money(m.collectedMinor)}</Td>
                          <Td align="right">{pctText(m.percent) ?? <NA>not available: nothing collected</NA>}</Td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </Table>
              <p className="mt-3 text-xs text-ink-3">Gross pay for clocked hours at each person&apos;s rate on the day, before the withholding estimate. The same calculation as Payroll for the same dates.</p>
            </>
          )}
        </CardBody>
      </Card>

      <DefinitionsDrawer tab="efficiency" />
    </>
  );
}
