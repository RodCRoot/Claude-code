import Link from "next/link";
import { requireStaff } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { REPORTS } from "@/lib/reports";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui";

export const metadata = { title: "Reports" };

export default async function ReportsIndex() {
  const v = await requireStaff();
  const visible = REPORTS.filter((r) => can(v, r.cap));
  const cats = [...new Set(visible.map((r) => r.category))];
  return (
    <>
      <PageHeader
        kicker="Reports"
        title="Reports"
        description="Every report states exactly what it counts. Invoiced (billed), collected (settled), pending, and scheduled recurring revenue are always separate numbers."
      />
      <div className="grid gap-5 md:grid-cols-2">
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
