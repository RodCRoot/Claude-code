import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { ButtonLink, PageHeader } from "@/components/ui";
import { getOrg, requireViewer } from "@/lib/auth/viewer";
import { AuthzError, isStaff } from "@/lib/authz/policy";
import { AttendanceHistoryPanel } from "@/lib/scheduling/components/attendance-history";
import { attendanceHistory } from "@/lib/scheduling/queries";
import { DEFAULT_TZ } from "@/lib/time";

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
      <AttendanceHistoryPanel data={data} tz={tz} limit={200} />
    </>
  );
}
