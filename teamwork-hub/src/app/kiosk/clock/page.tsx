import Link from "next/link";
import { getOrg, requireViewer } from "@/lib/auth/viewer";
import { isStaff } from "@/lib/authz/policy";
import { DEFAULT_TZ } from "@/lib/time";
import { TimeClockCard } from "@/components/time-clock-card";
import { StaffClockPad } from "./staff-clock-pad";

export const dynamic = "force-dynamic";
export const metadata = { title: "Staff time clock" };

/**
 * Kiosk staff time clock. On the kiosk login, staff enter their personal time-clock PIN; a staff
 * member signed in with their own session gets a one-tap clock in/out for themselves.
 */
export default async function KioskClockPage() {
  const v = await requireViewer();
  const tz = (await getOrg(v.orgId))?.timezone ?? DEFAULT_TZ;
  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Staff time clock</h1>
        <Link href="/kiosk" className="inline-flex min-h-11 items-center rounded-lg border border-edge px-3 text-sm">
          Athlete check-in
        </Link>
      </div>
      {v.role === "kiosk" ? (
        <>
          <p className="text-ink-3">Enter your staff PIN to clock in or out.</p>
          <StaffClockPad />
          <p className="text-center text-sm text-ink-3">No PIN? Set one under My time in the Hub, or ask an owner.</p>
        </>
      ) : isStaff(v) ? (
        <TimeClockCard v={v} tz={tz} source="kiosk" showLink={false} />
      ) : (
        <p className="text-ink-3">The time clock is for staff.</p>
      )}
    </div>
  );
}
