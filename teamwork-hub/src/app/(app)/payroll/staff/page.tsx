import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { staffClockPins } from "@/db/schema";
import { payRates, staffMembers } from "@/lib/payroll/service";
import { formatMoney } from "@/lib/money";
import { addDaysYmd, fmtDate, todayLocal } from "@/lib/time";
import { ROLE_LABEL } from "@/lib/nav";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardBody, CardHeader, Field, Input, PageHeader } from "@/components/ui";
import { addEntryAction, setRateAction, setStaffPinAction } from "../actions";
import { PayrollTabs, requirePayroll } from "../_shared";

export const metadata = { title: "Payroll · Staff" };
export const dynamic = "force-dynamic";

export default async function PayrollStaffPage() {
  const { v, tz } = await requirePayroll();
  const today = todayLocal(tz);
  const staff = (await staffMembers(db, v.orgId)).filter((s) => !s.disabled);
  const rates = await payRates(db, v);
  const pins = staff.length
    ? new Set((await db.select({ u: staffClockPins.userId }).from(staffClockPins).where(and(eq(staffClockPins.orgId, v.orgId), inArray(staffClockPins.userId, staff.map((s) => s.userId))))).map((r) => r.u))
    : new Set<string>();
  return (
    <>
      <PageHeader
        kicker="Payroll"
        title="Staff, rates & PINs"
        description="Hourly rates keep their history: a new rate applies from its effective date, so past pay never changes. Sample rates in demo data are not anyone's real pay."
      />
      <PayrollTabs current="staff" />
      <div className="grid gap-5 lg:grid-cols-2">
        {staff.map((s) => {
          const hist = rates.filter((r) => r.userId === s.userId);
          const current = hist.find((r) => r.effectiveFrom <= today);
          return (
            <Card key={s.userId}>
              <CardHeader
                title={s.name}
                kicker={ROLE_LABEL[s.role as keyof typeof ROLE_LABEL]}
                action={
                  <div className="flex gap-2">
                    {current ? <Badge variant="green">{formatMoney(current.rateMinor)}/h</Badge> : <Badge variant="neutral">No rate</Badge>}
                    {pins.has(s.userId) ? <Badge variant="blue">PIN set</Badge> : <Badge>No PIN</Badge>}
                  </div>
                }
              />
              <CardBody className="space-y-4">
                {hist.length ? (
                  <ul className="text-sm">
                    {hist.map((r) => (
                      <li key={r.id} className="flex justify-between gap-2 border-b border-edge/60 py-1">
                        <span>
                          {r.label} <span className="text-ink-3">from {fmtDate(r.effectiveFrom)}</span>
                        </span>
                        <span className="tabular">{formatMoney(r.rateMinor)}/h</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-ink-3">Hourly staff need a rate before their hours can be paid.</p>
                )}
                <details>
                  <summary className="cursor-pointer text-sm text-brand underline">Set rate</summary>
                  <ActionForm action={setRateAction} className="mt-2 grid gap-2 sm:grid-cols-3">
                    <input type="hidden" name="userId" value={s.userId} />
                    <Field label="Label" htmlFor={`l-${s.userId}`}>
                      <Input id={`l-${s.userId}`} name="label" defaultValue={current?.label ?? "Hourly"} required />
                    </Field>
                    <Field label="$ / hour" htmlFor={`r-${s.userId}`}>
                      <Input id={`r-${s.userId}`} name="rate" inputMode="decimal" required placeholder="0.00" />
                    </Field>
                    <Field label="Effective from" htmlFor={`f-${s.userId}`}>
                      <Input id={`f-${s.userId}`} name="effectiveFrom" type="date" defaultValue={today} required />
                    </Field>
                    <div>
                      <SubmitButton size="sm">Save rate</SubmitButton>
                    </div>
                  </ActionForm>
                </details>
                <details>
                  <summary className="cursor-pointer text-sm text-brand underline">Kiosk time-clock PIN</summary>
                  <ActionForm action={setStaffPinAction} resetOnSuccess className="mt-2 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="userId" value={s.userId} />
                    <Field label="New PIN (4–6 digits)" htmlFor={`p-${s.userId}`}>
                      <Input id={`p-${s.userId}`} name="pin" type="password" inputMode="numeric" pattern="[0-9]{4,6}" autoComplete="off" required />
                    </Field>
                    <SubmitButton size="sm">Save PIN</SubmitButton>
                  </ActionForm>
                  {pins.has(s.userId) ? (
                    <ActionForm action={setStaffPinAction} className="mt-2">
                      <input type="hidden" name="userId" value={s.userId} />
                      <input type="hidden" name="clear" value="1" />
                      <SubmitButton size="sm" variant="ghost" confirm="Remove this PIN?">
                        Remove PIN
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                </details>
                <details>
                  <summary className="cursor-pointer text-sm text-brand underline">Add a missed shift</summary>
                  <ActionForm action={addEntryAction} className="mt-2 grid gap-2 sm:grid-cols-2">
                    <input type="hidden" name="userId" value={s.userId} />
                    <Field label="Clock in" htmlFor={`ci-${s.userId}`}>
                      <Input id={`ci-${s.userId}`} name="clockIn" type="datetime-local" defaultValue={`${addDaysYmd(today, -1)}T09:00`} required />
                    </Field>
                    <Field label="Clock out" htmlFor={`co-${s.userId}`}>
                      <Input id={`co-${s.userId}`} name="clockOut" type="datetime-local" defaultValue={`${addDaysYmd(today, -1)}T13:00`} required />
                    </Field>
                    <Field label="Reason (audited)" htmlFor={`cr-${s.userId}`} className="sm:col-span-2">
                      <Input id={`cr-${s.userId}`} name="reason" required minLength={3} />
                    </Field>
                    <div>
                      <SubmitButton size="sm">Add entry</SubmitButton>
                    </div>
                  </ActionForm>
                </details>
              </CardBody>
            </Card>
          );
        })}
      </div>
    </>
  );
}
