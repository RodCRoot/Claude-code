import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, ButtonLink, Card, CardBody, CardHeader, Field, Input, PageHeader } from "@/components/ui";
import { getOrg, requireViewer } from "@/lib/auth/viewer";
import { AuthzError, canOnAthlete, isStaff } from "@/lib/authz/policy";
import { AttendanceHistoryPanel } from "@/lib/scheduling/components/attendance-history";
import { hasCheckInPin } from "@/lib/scheduling/kiosk-pin";
import { attendanceHistory } from "@/lib/scheduling/queries";
import { DEFAULT_TZ } from "@/lib/time";
import { setCheckInPinAction } from "../../actions";

export const metadata = { title: "Attendance history" };

export default async function AthleteAttendancePage({ params }: { params: Promise<{ athleteId: string }> }) {
  const v = await requireViewer();
  const { athleteId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(athleteId)) notFound();
  let data;
  try {
    data = await attendanceHistory(db, v, athleteId, { limit: 200 });
  } catch (e) {
    if (e instanceof AuthzError) redirect("/denied");
    throw e;
  }
  if (!data.athlete) notFound();
  const tz = (await getOrg(v.orgId))?.timezone ?? DEFAULT_TZ;
  const canSetPin = v.role !== "kiosk" && (await canOnAthlete(db, v, athleteId, "booking.create"));
  const pinSet = canSetPin ? await hasCheckInPin(db, v, athleteId) : false;
  return (
    <>
      <PageHeader
        kicker="Attendance"
        title={data.athlete.name}
        description="Every booking, check-in, no-show and cancellation, with attendance milestones."
        actions={
          <ButtonLink href={isStaff(v) ? "/schedule" : `/schedule?athlete=${athleteId}`} variant="outline" className="min-h-11">
            ← Schedule
          </ButtonLink>
        }
      />
      {canSetPin ? (
        <Card id="checkin-pin" className="mb-6 max-w-xl">
          <CardHeader title="Kiosk check-in PIN" kicker="Optional" action={pinSet ? <Badge variant="green">PIN set</Badge> : <Badge>No PIN</Badge>} />
          <CardBody className="space-y-3">
            <p className="text-sm text-ink-2">
              {`With a PIN, ${data.athlete.name.trim().split(/\s+/)[0]} can check in at the front-desk kiosk without looking for their name. Only a scrambled form of the PIN is stored; staff can’t read it back.`}
            </p>
            <ActionForm action={setCheckInPinAction} className="space-y-3" resetOnSuccess>
              <input type="hidden" name="athleteId" value={athleteId} />
              <Field label={pinSet ? "New PIN (4–6 digits)" : "PIN (4–6 digits)"} htmlFor="pin" hint="Avoid repeated digits and runs like 1234.">
                <Input id="pin" name="pin" type="password" inputMode="numeric" pattern="[0-9]{4,6}" minLength={4} maxLength={6} autoComplete="off" required className="h-11 w-40 tracking-widest" />
              </Field>
              <SubmitButton className="min-h-11" pendingText="Saving…">
                {pinSet ? "Change PIN" : "Save PIN"}
              </SubmitButton>
            </ActionForm>
            {pinSet ? (
              <ActionForm action={setCheckInPinAction}>
                <input type="hidden" name="athleteId" value={athleteId} />
                <input type="hidden" name="intent" value="clear" />
                <SubmitButton variant="ghost" className="min-h-11" pendingText="Removing…" confirm="Remove the kiosk check-in PIN?">
                  Remove PIN
                </SubmitButton>
              </ActionForm>
            ) : null}
          </CardBody>
        </Card>
      ) : null}
      <AttendanceHistoryPanel data={data} tz={tz} limit={200} />
    </>
  );
}
