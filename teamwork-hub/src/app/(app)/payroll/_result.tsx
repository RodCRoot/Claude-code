import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, Field, Input, Stat, Table, Td, Th, type BadgeVariant } from "@/components/ui";
import { bpsToPercent, fmtHundredths, type Totals } from "@/lib/payroll/calc";
import { ACKABLE, FLAG_LABEL, weekdayName, type DayRow, type EmployeeResult, type Flag, type PayrollResult } from "@/lib/payroll/engine";
import { ROUNDING_LABEL } from "@/lib/payroll/settings";
import { formatMoney } from "@/lib/money";
import { fmt, fmtDate } from "@/lib/time";
import { ackFlagAction, addEntryAction, editEntryAction, voidEntryAction } from "./actions";

const SEV: Record<Flag["severity"], BadgeVariant> = { block: "red", warn: "yellow", info: "blue" };
const dtLocal = (iso: string | null | undefined, tz: string) => (iso ? fmt(iso, "yyyy-MM-dd'T'HH:mm", tz) : "");

function FlagList({ flags }: { flags: Flag[] }) {
  if (!flags.length) return null;
  return (
    <ul className="space-y-1">
      {flags.map((f, i) => (
        <li key={i} className="text-xs">
          <Badge variant={f.acknowledged ? "green" : SEV[f.severity]}>
            {f.acknowledged ? "✓ " : ""}
            {FLAG_LABEL[f.code]}
          </Badge>{" "}
          <span className="text-ink-2">{f.message}</span>
        </li>
      ))}
    </ul>
  );
}

function FixForms({ row, tz, userId }: { row: DayRow; tz: string; userId: string }) {
  if (row.kind === "missing") {
    return (
      <details className="text-xs">
        <summary className="cursor-pointer text-brand underline">Add entry</summary>
        <ActionForm action={addEntryAction} className="mt-2 grid gap-2 sm:grid-cols-2">
          <input type="hidden" name="userId" value={userId} />
          <Field label="Clock in" htmlFor={`ai-${row.date}-${userId}`}>
            <Input id={`ai-${row.date}-${userId}`} name="clockIn" type="datetime-local" defaultValue={`${row.date}T09:00`} required />
          </Field>
          <Field label="Clock out" htmlFor={`ao-${row.date}-${userId}`}>
            <Input id={`ao-${row.date}-${userId}`} name="clockOut" type="datetime-local" defaultValue={`${row.date}T13:00`} required />
          </Field>
          <Field label="Reason" htmlFor={`ar-${row.date}-${userId}`} className="sm:col-span-2">
            <Input id={`ar-${row.date}-${userId}`} name="reason" required minLength={3} placeholder="e.g. Kiosk was down; confirmed with staff" />
          </Field>
          <div>
            <SubmitButton size="sm">Add entry</SubmitButton>
          </div>
        </ActionForm>
      </details>
    );
  }
  if (row.kind !== "entry" || !row.entryId) return null;
  const id = row.entryId;
  const ackable = row.flags.filter((f) => ACKABLE.includes(f.code) && !f.acknowledged);
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-brand underline">Fix</summary>
      <div className="mt-2 space-y-3">
        <ActionForm action={editEntryAction} className="grid gap-2 sm:grid-cols-2">
          <input type="hidden" name="entryId" value={id} />
          {/* Unchanged fields are not re-saved (inputs are minute precision; clock times keep their seconds). */}
          <input type="hidden" name="origClockIn" value={dtLocal(row.clockIn, tz)} />
          <input type="hidden" name="origClockOut" value={dtLocal(row.clockOut, tz)} />
          <Field label="Clock in" htmlFor={`ei-${id}`}>
            <Input id={`ei-${id}`} name="clockIn" type="datetime-local" defaultValue={dtLocal(row.clockIn, tz)} />
          </Field>
          <Field label="Real clock out" htmlFor={`eo-${id}`}>
            <Input id={`eo-${id}`} name="clockOut" type="datetime-local" defaultValue={dtLocal(row.clockOut, tz)} />
          </Field>
          <Field label="Reason (required, audited)" htmlFor={`er-${id}`} className="sm:col-span-2">
            <Input id={`er-${id}`} name="reason" required minLength={3} placeholder="e.g. Forgot to clock out; left at 7:45 per coach" />
          </Field>
          <div>
            <SubmitButton size="sm">Save correction</SubmitButton>
          </div>
        </ActionForm>
        {ackable.map((f) => (
          <ActionForm key={f.code} action={ackFlagAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="entryId" value={id} />
            <input type="hidden" name="code" value={f.code} />
            <Field label={`Confirm “${FLAG_LABEL[f.code]}” is correct`} htmlFor={`an-${id}-${f.code}`} className="min-w-48 flex-1">
              <Input id={`an-${id}-${f.code}`} name="note" required minLength={3} placeholder="Why it's right" />
            </Field>
            <SubmitButton size="sm" variant="secondary">
              {f.code === "runaway" || f.code === "orphan" ? "Confirm & count it" : "Acknowledge"}
            </SubmitButton>
          </ActionForm>
        ))}
        <ActionForm action={voidEntryAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="entryId" value={id} />
          <Field label="Void this entry" htmlFor={`vr-${id}`} className="min-w-48 flex-1">
            <Input id={`vr-${id}`} name="reason" required minLength={3} placeholder="e.g. Stray clock-out tap" />
          </Field>
          <SubmitButton size="sm" variant="danger" confirm="Void this time entry? It stays in the audit log.">
            Void
          </SubmitButton>
        </ActionForm>
      </div>
    </details>
  );
}

function TotalsRow({ label, t, bps, muted }: { label: string; t: Totals; bps: number; muted?: boolean }) {
  return (
    <tr className={muted ? "text-ink-3" : "font-semibold"}>
      <Td colSpan={3}>{label}</Td>
      <Td align="right">{fmtHundredths(t.hoursHundredths)}</Td>
      <Td />
      <Td align="right">{formatMoney(t.grossMinor)}</Td>
      <Td colSpan={2} className="text-xs font-normal">
        − {formatMoney(t.deductionMinor)} ({bpsToPercent(bps)}%) = <span className="font-semibold">{formatMoney(t.netMinor)}</span> net
      </Td>
    </tr>
  );
}

function EmployeeTable({ e, tz, bps, editable }: { e: EmployeeResult; tz: string; bps: number; editable: boolean }) {
  return (
    <Card id={`emp-${e.userId}`}>
      <CardHeader
        title={e.name}
        kicker={`Usual shift ${e.norm.medianHundredths != null ? `${fmtHundredths(e.norm.medianHundredths)} h` : "unknown"}${e.norm.usualWeekdays.length ? ` · usually ${e.norm.usualWeekdays.map(weekdayName).join("/")}` : ""}`}
        action={
          <div className="flex gap-2">
            {e.blockingOpen ? <Badge variant="red">{e.blockingOpen} to resolve</Badge> : <Badge variant="green">No blocking flags</Badge>}
            {e.incomplete ? <Badge variant="red">Missing pay rate</Badge> : null}
          </div>
        }
      />
      <CardBody>
        <Table caption={`Daily time for ${e.name}`}>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>In</Th>
              <Th>Out</Th>
              <Th align="right">Hours</Th>
              <Th align="right">Rate</Th>
              <Th align="right">Pay</Th>
              <Th>Flags</Th>
              {editable ? <Th /> : null}
            </tr>
          </thead>
          <tbody>
            {e.rows.map((r, i) => {
              const est = r.kind === "estimate";
              const dim = r.kind === "none" || (est && r.hoursHundredths === 0);
              return (
                <tr key={`${r.date}-${r.entryId ?? r.kind}-${i}`} className={dim ? "text-ink-3" : est ? "bg-info/5 italic" : !r.included && r.kind === "entry" ? "bg-bad/5" : undefined}>
                  <Td className="whitespace-nowrap">
                    {weekdayName(r.weekday)} {fmtDate(r.date).replace(/, \d{4}$/, "")}
                    {est ? (
                      <Badge variant="blue" className="ml-1 not-italic">
                        ESTIMATE
                      </Badge>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap">{r.clockIn ? fmt(r.clockIn, "h:mm a", tz) : est ? <span className="text-xs">{r.note}</span> : "—"}</Td>
                  <Td className="whitespace-nowrap">
                    {r.kind === "entry" ? (r.clockOut ? fmt(r.clockOut, "h:mm a", tz) : <Badge variant="yellow">open</Badge>) : "—"}
                    {r.plusDays ? <span className="ml-1 font-semibold text-bad">+{r.plusDays} day{r.plusDays > 1 ? "s" : ""}</span> : null}
                    {r.edited ? <span className="ml-1 text-xs text-ink-3" title="Corrected (see audit log)">edited</span> : null}
                  </Td>
                  <Td align="right">
                    {r.kind === "entry" || est ? fmtHundredths(r.hoursHundredths) : "—"}
                    {r.kind === "entry" && !r.included && r.durationMs != null ? <span className="block text-[11px] text-bad">not counted</span> : null}
                  </Td>
                  <Td align="right">{r.rateMinor != null && r.kind !== "none" && r.kind !== "missing" ? formatMoney(r.rateMinor) : "—"}</Td>
                  <Td align="right">{r.kind === "entry" || est ? formatMoney(r.payMinor) : "—"}</Td>
                  <Td className="min-w-64">
                    <FlagList flags={r.flags} />
                    {est && r.basisDates?.length ? <span className="text-[11px] text-ink-3">based on {r.basisDates.join(", ")}</span> : null}
                  </Td>
                  {editable ? (
                    <Td className="min-w-24">
                      <FixForms row={r} tz={tz} userId={e.userId} />
                    </Td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <TotalsRow label="Actual (clocked, counted)" t={e.actual} bps={bps} />
            {e.estimated.hoursHundredths ? <TotalsRow label="Estimated (not yet worked)" t={e.estimated} bps={bps} muted /> : null}
            {e.estimated.hoursHundredths ? <TotalsRow label="Projected (actual + estimate)" t={e.projected} bps={bps} /> : null}
          </tfoot>
        </Table>
      </CardBody>
    </Card>
  );
}

export function PayrollResultView({ result, tz, editable }: { result: PayrollResult; tz: string; editable: boolean }) {
  const c = result.combined;
  const bps = result.deductionBps;
  const hasEst = c.estimated.hoursHundredths > 0;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Hours (actual)" value={fmtHundredths(c.actual.hoursHundredths)} hint={hasEst ? `+ ${fmtHundredths(c.estimated.hoursHundredths)} estimated` : undefined} />
        <Stat label="Gross (actual)" value={formatMoney(c.actual.grossMinor)} hint={hasEst ? `${formatMoney(c.projected.grossMinor)} projected` : undefined} />
        <Stat label={`Deduction ${bpsToPercent(bps)}%`} value={formatMoney(c.actual.deductionMinor)} hint={hasEst ? `${formatMoney(c.projected.deductionMinor)} projected` : "estimate — confirm with your accountant"} />
        <Stat label="Net (actual)" value={formatMoney(c.actual.netMinor)} tone="ok" hint={hasEst ? `${formatMoney(c.projected.netMinor)} projected` : undefined} />
      </div>
      <Callout tone={result.blockingOpen ? "warn" : "info"} title={result.blockingOpen ? `${result.blockingOpen} flag(s) to resolve before approval` : "No blocking flags"}>
        Runaway shifts, missed clock-outs and likely stray clock-outs are <strong>not counted</strong> until you enter the real time, void the entry, or confirm it. Tiny shifts are counted but flagged.
        Estimates (blue, italic) come from the same weekday&apos;s recent shifts and are never part of the actual totals. Rounding: {ROUNDING_LABEL[result.rounding]}. The {bpsToPercent(bps)}% deduction is an
        estimate — confirm with your accountant.
      </Callout>
      {result.employees.length === 0 ? <p className="text-sm text-ink-3">No staff time in this range.</p> : null}
      {result.employees.map((e) => (
        <EmployeeTable key={e.userId} e={e} tz={tz} bps={bps} editable={editable} />
      ))}
      {result.employees.length > 1 ? (
        <Card>
          <CardHeader title="Combined summary" />
          <CardBody>
            <Table caption="Combined payroll summary">
              <thead>
                <tr>
                  <Th>Employee</Th>
                  <Th align="right">Hours</Th>
                  <Th align="right">Gross</Th>
                  <Th align="right">Deduction</Th>
                  <Th align="right">Net</Th>
                  <Th align="right">Est. hours</Th>
                  <Th align="right">Projected net</Th>
                </tr>
              </thead>
              <tbody>
                {result.employees.map((e) => (
                  <tr key={e.userId}>
                    <Td>
                      <a href={`#emp-${e.userId}`} className="underline">
                        {e.name}
                      </a>
                    </Td>
                    <Td align="right">{fmtHundredths(e.actual.hoursHundredths)}</Td>
                    <Td align="right">{formatMoney(e.actual.grossMinor)}</Td>
                    <Td align="right">{formatMoney(e.actual.deductionMinor)}</Td>
                    <Td align="right">{formatMoney(e.actual.netMinor)}</Td>
                    <Td align="right">{fmtHundredths(e.estimated.hoursHundredths)}</Td>
                    <Td align="right">{formatMoney(e.projected.netMinor)}</Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <Td>Combined</Td>
                  <Td align="right">{fmtHundredths(c.actual.hoursHundredths)}</Td>
                  <Td align="right">{formatMoney(c.actual.grossMinor)}</Td>
                  <Td align="right">{formatMoney(c.actual.deductionMinor)}</Td>
                  <Td align="right">{formatMoney(c.actual.netMinor)}</Td>
                  <Td align="right">{fmtHundredths(c.estimated.hoursHundredths)}</Td>
                  <Td align="right">{formatMoney(c.projected.netMinor)}</Td>
                </tr>
              </tfoot>
            </Table>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
