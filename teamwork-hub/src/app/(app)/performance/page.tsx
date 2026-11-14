import Link from "next/link";
import { redirect } from "next/navigation";
import { Avatar, EmptyState } from "@/components/ui";
import { ModuleHero } from "../training/_components/tb";
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
      <ModuleHero kicker="Performance" title="Athlete progress" description="Testing results, strength, habits, attendance, and coach-reviewed progress reports. Health details appear only for people with health access." />
      {athletes.length === 0 ? (
        <EmptyState title="No athletes to show">You don’t have training access to any athlete.</EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {athletes.map((a) => (
            <Link
              key={a.id}
              href={`/performance/${a.id}`}
              className="flex min-h-11 items-center gap-3 rounded-lg border border-edge border-l-4 border-l-brand bg-surface px-4 py-3 shadow-[0_1px_3px_rgb(16_24_40/0.06)] transition-colors hover:border-brand"
            >
              <Avatar name={a.name} className="size-10! text-sm!" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base font-bold">{a.name}</span>
                <span className="block text-xs text-ink-3">Tests, strength, habits, reports</span>
              </span>
              <span aria-hidden className="text-lg font-bold text-brand">
                →
              </span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
