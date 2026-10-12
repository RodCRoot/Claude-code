import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardBody, EmptyState, PageHeader } from "@/components/ui";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { performanceAthletes } from "@/lib/science/performance";

export const metadata = { title: "Performance" };

export default async function PerformancePage() {
  const v = await requireViewer();
  const athletes = await performanceAthletes(db, v);
  if (v.role === "athlete" && athletes.length === 1) redirect(`/performance/${athletes[0].id}`);
  return (
    <>
      <PageHeader kicker="Performance" title="Athlete progress" description="Testing results, strength, habits, attendance, and coach-reviewed progress reports. Health details appear only for people with health access." />
      {athletes.length === 0 ? (
        <EmptyState title="No athletes to show">You don’t have training access to any athlete.</EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {athletes.map((a) => (
            <Link key={a.id} href={`/performance/${a.id}`} className="block min-h-11">
              <Card className="transition-colors hover:border-brand">
                <CardBody className="pt-4">
                  <div className="font-semibold">{a.name}</div>
                  <div className="text-xs text-ink-3">View progress →</div>
                </CardBody>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
