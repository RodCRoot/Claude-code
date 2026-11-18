import { db } from "@/db";
import { can } from "@/lib/authz/policy";
import { bpsToPercent } from "@/lib/payroll/calc";
import { payrollConfig, staffMembers } from "@/lib/payroll/service";
import { ROUNDING_LABEL, type PayrollThresholds } from "@/lib/payroll/settings";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { saveSettingsAction } from "../actions";
import { PayrollTabs, requirePayroll } from "../_shared";

export const metadata = { title: "Payroll · Settings" };
export const dynamic = "force-dynamic";

const THRESHOLD_FIELDS: { key: keyof PayrollThresholds; label: string; hint: string; step?: string }[] = [
  { key: "runawayMaxHours", label: "Runaway: any shift longer than (h)", hint: "Excluded until fixed or confirmed.", step: "0.5" },
  { key: "runawayCrossDayMinHours", label: "Runaway: clock-out on a later day and at least (h)", hint: "Zen Planner shows these as “+N days”.", step: "0.5" },
  { key: "runawayNormFactor", label: "Runaway: longer than × usual shift", hint: "And at least 2 h above it.", step: "0.1" },
  { key: "tinyHours", label: "Tiny shift: shorter than (h)", hint: "Counted, but flagged.", step: "0.05" },
  { key: "tinyNormMinHours", label: "…when the usual shift is at least (h)", hint: "", step: "0.5" },
  { key: "offPatternMinutes", label: "Off-pattern start: more than (min) from usual", hint: "Per weekday, needs 3+ past shifts." },
  { key: "orphanMaxHours", label: "Stray clock-out: shorter than (h) the day after a runaway", hint: "", step: "0.25" },
  { key: "lookbackWeeks", label: "History window (weeks)", hint: "For usual shifts, usual weekdays and estimates." },
  { key: "expectedWeekdayMinWeeks", label: "Usual weekday: worked in at least N of those weeks", hint: "" },
  { key: "estimateSampleDays", label: "Estimates average the last N same-weekday shifts", hint: "" },
  { key: "minSamplesForNorm", label: "Shifts needed before “usual shift” is trusted", hint: "" },
];

const MAPPING_FIELDS = [
  ["dateCol", "Date"],
  ["rateLabelCol", "Pay-rate label"],
  ["rateCol", "Rate ($ / hour)"],
  ["timeInCol", "Time In"],
  ["timeOutCol", "Time Out"],
  ["hoursCol", "Hours"],
  ["amountCol", "Amount"],
] as const;

export default async function PayrollSettingsPage() {
  const { v } = await requirePayroll();
  const cfg = await payrollConfig(db, v.orgId);
  const editable = can(v, "payroll.manage");
  const ops = (await staffMembers(db, v.orgId)).filter((s) => s.role === "operations" && !s.disabled);
  return (
    <>
      <PageHeader kicker="Payroll" title="Payroll settings" description="Changes are audited and apply to new calculations; approved runs keep the settings they were calculated with." />
      <PayrollTabs current="settings" />
      {!editable ? <Callout className="mb-5">Only an owner or admin can change payroll settings.</Callout> : null}
      <ActionForm action={saveSettingsAction} className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Pay calculation" />
          <CardBody className="space-y-3">
            <Field label="Deduction / withholding estimate (%)" htmlFor="deductionPercent" hint="Teamwork currently uses 17%. This is an estimate — confirm with your accountant.">
              <Input id="deductionPercent" name="deductionPercent" defaultValue={bpsToPercent(cfg.deductionBps)} inputMode="decimal" required className="w-32" />
            </Field>
            <Field label="Hours rounding" htmlFor="rounding" hint="Zen Planner truncates each shift's fractional hours to 2 decimals before multiplying by the rate.">
              <Select id="rounding" name="rounding" defaultValue={cfg.rounding}>
                {Object.entries(ROUNDING_LABEL).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Who can run payroll" kicker="Owners and admins always can" />
          <CardBody className="space-y-2">
            {ops.length === 0 ? <p className="text-sm text-ink-3">No operations staff.</p> : null}
            {ops.map((o) => (
              <label key={o.userId} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" name="accessUserIds" value={o.userId} defaultChecked={cfg.accessUserIds.includes(o.userId)} />
                {o.name} (operations)
              </label>
            ))}
            <p className="text-xs text-ink-3">Coaches never get payroll access; they see only their own time.</p>
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Abnormality rules" />
          <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {THRESHOLD_FIELDS.map((f) => (
              <Field key={f.key} label={f.label} htmlFor={f.key} hint={f.hint || undefined}>
                <Input id={f.key} name={f.key} type="number" step={f.step ?? "1"} min={0} defaultValue={cfg.thresholds[f.key]} required />
              </Field>
            ))}
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Zen Planner import columns" kicker="Unverified mapping — adjust to match your export" />
          <CardBody className="grid gap-3 sm:grid-cols-4">
            {MAPPING_FIELDS.map(([k, label]) => (
              <Field key={k} label={`${label} column #`} htmlFor={k} hint="0 = first column">
                <Input id={k} name={k} type="number" min={0} max={30} defaultValue={cfg.importMapping[k]} required />
              </Field>
            ))}
            <Field label="“No entry” marker" htmlFor="noEntryMarker" hint="Last cell of an empty day">
              <Input id="noEntryMarker" name="noEntryMarker" defaultValue={cfg.importMapping.noEntryMarker} required />
            </Field>
          </CardBody>
        </Card>
        {editable ? (
          <div className="lg:col-span-2">
            <SubmitButton size="lg">Save payroll settings</SubmitButton>
          </div>
        ) : null}
      </ActionForm>
    </>
  );
}
