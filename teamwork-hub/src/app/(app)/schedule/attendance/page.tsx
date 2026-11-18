import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { Badge, ButtonLink, EmptyState, PageHeader, Stat, type BadgeVariant } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { isStaff } from "@/lib/authz/policy";
import { cn } from "@/lib/cn";
import { orgTimezone } from "@/lib/scheduling/common";
import { attendanceHistory, familyAthletes } from "@/lib/scheduling/queries";
import { fmt, localYmd, todayLocal } from "@/lib/time";
import { ScheduleTabs } from "../_components/calendar";

export const metadata = { title: "My Attendance" };

const STATUS_LABEL: Record<string, string> = { booked: "reserved", late_cancelled: "late cancel", no_show: "no-show" };
const STATUS_VARIANT: Record<string, BadgeVariant> = { attended: "green", booked: "green", waitlisted: "yellow", no_show: "red", late_cancelled: "red", cancelled: "neutral" };

function shiftMonth(ym: string, n: number) {
  const m = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`;
}

/** Attendance by month for one family member at a time. */
export default async function AttendancePage({ searchParams }: { searchParams: Promise<{ athlete?: string; month?: string }> }) {
  const v = await requireViewer();
  if (isStaff(v)) redirect("/reports/attendance");
  const sp = await searchParams;
  const members = await familyAthletes(db, v);
  const tz = await orgTimezone(db, v.orgId);
  const thisMonth = todayLocal(tz).slice(0, 7);
  const month = sp.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month) ? sp.month : thisMonth;
  const selected = members.find((m) => m.id === sp.athlete) ?? members[0];
  const data = selected ? await attendanceHistory(db, v, selected.id, { limit: 1000 }) : null;
  const rows = (data?.history ?? []).filter((h) => localYmd(h.startsAt, tz).startsWith(month));
  const attended = rows.filter((h) => h.status === "attended").length;
  const href = (patch: { athlete?: string; month?: string }) => {
    const q = new URLSearchParams();
    const a = patch.athlete ?? selected?.id;
    const mo = patch.month ?? month;
    if (a) q.set("athlete", a);
    if (mo !== thisMonth) q.set("month", mo);
    const s = q.toString();
    return s ? `/schedule/attendance?${s}` : "/schedule/attendance";
  };
  const monthLabel = fmt(new Date(`${month}-15T12:00:00Z`), "MMMM yyyy", "UTC");
  const navBtn = "inline-flex size-11 shrink-0 items-center justify-center rounded-md border border-edge bg-surface text-xl leading-none text-ink-2 hover:bg-surface-2 hover:text-ink";
  return (
    <>
      <PageHeader kicker="Schedule" title="My Attendance" description="Classes attended, by month." />
      <ScheduleTabs current="attendance" staff={false} manager={false} />
      {!selected || !data ? (
        <EmptyState title="No family members linked to your account yet">Ask the front desk to link your child (or your own athlete profile) to this login.</EmptyState>
      ) : (
        <div className="space-y-4">
          {members.length > 1 ? (
            <nav aria-label="Choose family member" className="flex flex-wrap gap-2">
              {members.map((m) => (
                <Link
                  key={m.id}
                  href={href({ athlete: m.id })}
                  aria-current={m.id === selected.id ? "true" : undefined}
                  className={cn("inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold", m.id === selected.id ? "border-brand bg-brand text-brand-ink" : "border-edge bg-surface text-ink hover:bg-surface-2")}
                >
                  {m.first} {m.last}
                </Link>
              ))}
            </nav>
          ) : null}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={`Attended in ${fmt(new Date(`${month}-15T12:00:00Z`), "MMM", "UTC")}`} value={attended} tone={attended ? "ok" : undefined} />
            <Stat label="Attended all time" value={data.counts.attended} hint={data.nextMilestone ? `${data.nextMilestone - data.counts.attended} to ${data.nextMilestone}` : undefined} />
            <Stat label="Upcoming" value={data.counts.upcoming} />
            <Stat label="No-shows" value={data.counts.noShow} tone={data.counts.noShow ? "bad" : undefined} />
          </div>

          <section aria-labelledby="att-month" className="overflow-hidden rounded-md border border-edge bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.06)]">
            <div className="flex items-center gap-2 border-b border-edge px-3 py-2.5">
              <Link href={href({ month: shiftMonth(month, -1) })} className={navBtn} aria-label="Previous month">
                <span aria-hidden>‹</span>
              </Link>
              <h2 id="att-month" className="min-w-0 flex-1 text-center text-base font-bold tracking-tight sm:text-lg" aria-live="polite">
                {monthLabel}
              </h2>
              <Link href={href({ month: shiftMonth(month, 1) })} className={navBtn} aria-label="Next month">
                <span aria-hidden>›</span>
              </Link>
            </div>
            {rows.length === 0 ? (
              <div className="p-4">
                <EmptyState title={`Nothing in ${monthLabel}`}>
                  No reservations or attendance for {selected.first} this month.
                </EmptyState>
              </div>
            ) : (
              <ul className="divide-y divide-edge text-sm">
                {rows.map((h) => (
                  <li key={h.bookingId} className="flex items-start justify-between gap-3 px-3 py-2.5">
                    <div className="flex min-w-0 gap-3">
                      <div className="w-[4.75rem] shrink-0 text-xs tabular">
                        <div className="font-bold text-ink">{fmt(h.startsAt, "EEE MMM d", tz)}</div>
                        <div className="text-ink-3">{fmt(h.startsAt, "h:mm a", tz)}</div>
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium">{h.title}</div>
                        {h.coachName ? <div className="text-xs text-ink-3">{h.coachName.replace(/^Coach /, "")}</div> : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                      {h.sessionStatus === "cancelled" ? <Badge variant="red">class cancelled</Badge> : <Badge variant={STATUS_VARIANT[h.status] ?? "neutral"}>{STATUS_LABEL[h.status] ?? h.status.replaceAll("_", " ")}</Badge>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <ButtonLink href={`/schedule/athletes/${selected.id}`} variant="ghost" className="min-h-11">
            Full history and milestones for {selected.first} →
          </ButtonLink>
        </div>
      )}
    </>
  );
}
