import Link from "next/link";
import { db } from "@/db";
import type { Viewer } from "@/lib/authz/policy";
import { myClockStatus } from "@/lib/payroll/service";
import { fmt, fmtTime } from "@/lib/time";
import { clockToggleAction } from "@/app/(app)/time/actions";
import { ActionForm, SubmitButton } from "./forms";
import { Card, CardBody } from "./ui";

/** Compact clock in/out control for the signed-in staff member. */
export async function TimeClockCard({ v, tz, source = "staff", showLink = true }: { v: Viewer; tz?: string; source?: "staff" | "kiosk"; showLink?: boolean }) {
  const s = await myClockStatus(db, v);
  if (!s) return null;
  const open = s.open;
  const hoursToday = (s.closedMsToday / 3_600_000).toFixed(2);
  return (
    <Card className="mb-6">
      <CardBody className="flex flex-wrap items-center justify-between gap-3 pt-4">
        <div>
          <div className="kicker">Time clock</div>
          <p className="text-sm">
            {open ? (
              <>
                <span className="font-semibold text-ok">On shift</span> since {fmt(open.clockIn, "EEE h:mm a", tz)}
              </>
            ) : (
              <span className="text-ink-2">Not clocked in</span>
            )}
            <span className="text-ink-3"> · {hoursToday} h clocked today</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          {showLink ? (
            <Link href="/time" className="text-sm text-brand underline">
              My time
            </Link>
          ) : null}
          <ActionForm action={clockToggleAction}>
            <input type="hidden" name="source" value={source} />
            <SubmitButton variant={open ? "secondary" : "primary"} pendingText={open ? "Clocking out…" : "Clocking in…"} confirm={open ? `Clock out now (on since ${fmtTime(open.clockIn, tz)})?` : undefined}>
              {open ? "Clock out" : "Clock in"}
            </SubmitButton>
          </ActionForm>
        </div>
      </CardBody>
    </Card>
  );
}
