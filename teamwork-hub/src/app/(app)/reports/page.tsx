import Link from "next/link";
import { requireStaff } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { REPORTS } from "@/lib/reports";
import { db } from "@/db";
import { canManagePayroll } from "@/lib/payroll/service";
import { PageHeader } from "@/components/ui";
import { Widget } from "@/components/profile/studio";
import type { IconName } from "@/components/icons";

export const metadata = { title: "Reports" };

function iconFor(category: string): IconName {
  const c = category.toLowerCase();
  if (/financ|revenue|billing|money|payment/.test(c)) return "billing";
  if (/attend|schedul|class|session/.test(c)) return "schedule";
  if (/member|people|crm|lead|retention/.test(c)) return "people";
  if (/train|perform|science/.test(c)) return "training";
  return "reports";
}

function ReportRow({ href, title, definition }: { href: string; title: string; definition: string }) {
  return (
    <li>
      <Link href={href} className="group flex items-start gap-3 px-4 py-2.5 hover:bg-surface-2">
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-brand group-hover:underline">{title}</span>
          <span className="line-clamp-2 block text-xs text-ink-3">{definition}</span>
        </span>
        <span aria-hidden className="pt-0.5 text-ink-3 group-hover:text-brand">
          ›
        </span>
      </Link>
    </li>
  );
}

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
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cats.map((c) => {
          const items = visible.filter((r) => r.category === c);
          return (
            <Widget key={c} title={c} icon={iconFor(c)} count={items.length} flush>
              <ul className="divide-y divide-edge">
                {items.map((r) => (
                  <ReportRow key={r.key} href={`/reports/${r.key}`} title={r.title} definition={r.definition} />
                ))}
              </ul>
            </Widget>
          );
        })}
        <Widget title="Staff time & payroll" icon="clock" flush>
          <ul className="divide-y divide-edge">
            {payroll ? (
              <ReportRow
                href="/payroll"
                title="Payroll"
                definition="Hours × rate for any date range, with runaway/missed clock-out flags, weekday estimates, the deduction estimate, approval and CSV export."
              />
            ) : null}
            <ReportRow href="/time" title="My time" definition="Your own clock-in/out history and kiosk time-clock PIN." />
          </ul>
        </Widget>
      </div>
    </>
  );
}
