import Link from "next/link";
import { redirect } from "next/navigation";
import { getOrg, requireViewer } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { DEFAULT_TZ, fmt } from "@/lib/time";

export const metadata = { title: "Check-in" };

/**
 * Restricted, full-screen check-in shell. No app navigation; leaving kiosk mode requires staff
 * credentials (/kiosk/exit). The (app) layout already bounces kiosk logins here.
 */
export default async function KioskLayout({ children }: { children: React.ReactNode }) {
  const v = await requireViewer();
  if (!can(v, "schedule.checkin")) redirect("/denied");
  const org = await getOrg(v.orgId);
  const tz = org?.timezone ?? DEFAULT_TZ;
  const brand = org?.branding?.primaryColor;
  return (
    <div className="flex min-h-screen flex-col" style={brand ? ({ ["--brand" as string]: brand } as React.CSSProperties) : undefined}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-edge bg-surface px-4 py-3 sm:px-8">
        <div>
          <div className="text-xl font-bold tracking-tight">
            {org?.branding?.displayName ?? "Teamwork"} <span className="text-brand">Check-in</span>
          </div>
          <div className="text-sm text-ink-3">{fmt(new Date(), "EEEE, MMMM d", tz)}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/kiosk/clock" className="inline-flex min-h-11 items-center rounded-lg border border-edge px-3 text-sm font-medium">
            Staff time clock
          </Link>
          {v.role === "kiosk" ? (
            <Link href="/kiosk/exit" className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm text-ink-3 hover:bg-surface-2">
              Staff exit
            </Link>
          ) : (
            <Link href="/schedule" className="inline-flex min-h-11 items-center rounded-lg border border-edge px-3 text-sm font-medium">
              Back to schedule
            </Link>
          )}
        </div>
      </header>
      <main id="main" className="flex-1 px-4 py-6 sm:px-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
