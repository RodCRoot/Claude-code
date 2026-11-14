import { db } from "@/db";
import { getOrg, requireStaff } from "@/lib/auth/viewer";
import { canManagePayroll, hasStaffClockPin, listEntries } from "@/lib/payroll/service";
import { addDaysYmd, DEFAULT_TZ, fmt, todayLocal } from "@/lib/time";
import { TimeClockCard } from "@/components/time-clock-card";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Table, Td, Th } from "@/components/ui";
import { setMyClockPinAction } from "./actions";

export const metadata = { title: "My time" };

export default async function MyTimePage() {
  const v = await requireStaff();
  const tz = (await getOrg(v.orgId))?.timezone ?? DEFAULT_TZ;
  const today = todayLocal(tz);
  const from = addDaysYmd(today, -30);
  const [entries, hasPin, manager] = [await listEntries(db, v, { from, to: today, includeVoided: true }), await hasStaffClockPin(db, v, v.userId), await canManagePayroll(db, v)];
  const totalMs = entries.filter((e) => e.clockOut && !e.voidedAt).reduce((a, e) => a + (e.clockOut!.getTime() - e.clockIn.getTime()), 0);
  return (
    <>
      <PageHeader
        kicker="Staff"
        title="My time"
        description="Your own clock-in/out history. Only you and payroll managers can see it. Ask an owner to correct a mistake — corrections are recorded with a reason."
        actions={manager ? <ButtonLink href="/payroll">Payroll</ButtonLink> : null}
      />
      <TimeClockCard v={v} tz={tz} showLink={false} />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Last 30 days" kicker={`${(totalMs / 3_600_000).toFixed(2)} h clocked`} />
          <CardBody>
            {entries.length === 0 ? (
              <EmptyState title="No time entries yet" />
            ) : (
              <Table caption="My time entries">
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>In</Th>
                    <Th>Out</Th>
                    <Th align="right">Hours</Th>
                    <Th>Notes</Th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id} className={e.voidedAt ? "text-ink-3 line-through" : undefined}>
                      <Td>{fmt(e.clockIn, "EEE MMM d", tz)}</Td>
                      <Td>{fmt(e.clockIn, "h:mm a", tz)}</Td>
                      <Td>{e.clockOut ? fmt(e.clockOut, "EEE h:mm a", tz) : <Badge variant="yellow">open</Badge>}</Td>
                      <Td align="right" className="tabular">
                        {e.clockOut ? ((e.clockOut.getTime() - e.clockIn.getTime()) / 3_600_000).toFixed(2) : "—"}
                      </Td>
                      <Td className="text-xs text-ink-3">
                        {e.voidedAt ? `Voided: ${e.voidReason}` : e.editedAt ? `Corrected: ${e.editReason}` : e.source}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Kiosk time-clock PIN" kicker={hasPin ? "Set" : "Not set"} />
          <CardBody>
            <p className="mb-3 text-sm text-ink-3">Use it at the front-desk kiosk (Staff time clock) to clock in or out. 4–6 digits; it&apos;s stored only as a keyed hash.</p>
            <ActionForm action={setMyClockPinAction} resetOnSuccess className="space-y-3">
              <Field label="New PIN" htmlFor="pin">
                <Input id="pin" name="pin" type="password" inputMode="numeric" pattern="[0-9]{4,6}" autoComplete="off" required />
              </Field>
              <SubmitButton>Save PIN</SubmitButton>
            </ActionForm>
            {hasPin ? (
              <ActionForm action={setMyClockPinAction} className="mt-3">
                <input type="hidden" name="clear" value="1" />
                <SubmitButton variant="ghost" size="sm" confirm="Remove your time-clock PIN?">
                  Remove PIN
                </SubmitButton>
              </ActionForm>
            ) : null}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
