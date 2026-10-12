import Link from "next/link";
import { requireStaff } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { REPORTS } from "@/lib/reports";
import { db } from "@/db";
import { canManagePayroll } from "@/lib/payroll/service";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui";

export const metadata = { title: "Reports" };

export default async function ReportsIndex() {
  const v = await requireStaff();
  const visible = REPORTS.filter((r) => can(v, r.cap));
  const cats = [...new Set(visible.map((r) => r.category))];
  const payroll = await canManagePayroll(db, v);
  return (
    <>
      <PageHeader
        kicker="Reports"
        title="Reports"
        description="Every report states exactly what it counts. Invoiced (billed), collected (settled), pending, and scheduled recurring revenue are always separate numbers."
      />
      <div className="grid gap-5 md:grid-cols-2">
        <Card>
          <CardHeader title="Staff time & payroll" />
          <CardBody>
            <ul className="space-y-3">
              {payroll ? (
                <li>
                  <Link href="/payroll" className="font-medium text-brand underline-offset-2 hover:underline">
                    Payroll
                  </Link>
                  <p className="line-clamp-2 text-xs text-ink-3">Hours × rate for any date range, with runaway/missed clock-out flags, weekday estimates, the deduction estimate, approval and CSV export.</p>
                </li>
              ) : null}
              <li>
                <Link href="/time" className="font-medium text-brand underline-offset-2 hover:underline">
                  My time
                </Link>
                <p className="line-clamp-2 text-xs text-ink-3">Your own clock-in/out history and kiosk time-clock PIN.</p>
              </li>
            </ul>
          </CardBody>
        </Card>
        {cats.map((c) => (
          <Card key={c}>
            <CardHeader title={c} />
            <CardBody>
              <ul className="space-y-3">
                {visible
                  .filter((r) => r.category === c)
                  .map((r) => (
                    <li key={r.key}>
                      <Link href={`/reports/${r.key}`} className="font-medium text-brand underline-offset-2 hover:underline">
                        {r.title}
                      </Link>
                      <p className="line-clamp-2 text-xs text-ink-3">{r.definition}</p>
                    </li>
                  ))}
              </ul>
            </CardBody>
          </Card>
        ))}
      </div>
    </>
  );
}
