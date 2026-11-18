import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { Badge, Callout, Card, CardBody, CardHeader, EmptyState } from "@/components/ui";
import { requireViewer } from "@/lib/auth/viewer";
import { isStaff } from "@/lib/authz/policy";
import { familyAthletes } from "@/lib/dashboards";
import { listRecapMonths, recapAccess } from "@/lib/showcase/recap";
import { ModuleHero } from "../training/_components/tb";

export const metadata = { title: "Monthly recaps" };

export default async function RecapListPage({ searchParams }: { searchParams: Promise<{ athlete?: string }> }) {
  const v = await requireViewer();
  if (isStaff(v)) redirect("/training/recaps");
  const sp = await searchParams;
  const children = await familyAthletes(db, v);
  const child = children.find((c) => c.athleteId === sp.athlete) ?? children[0];
  const isAthlete = v.role === "athlete";
  const first = child?.name.split(" ")[0];
  const access = child ? await recapAccess(db, v, child.athleteId) : null;
  const months = child && access?.canView ? await listRecapMonths(db, v, child.athleteId) : [];

  return (
    <div className="mx-auto max-w-3xl">
      <ModuleHero kicker="Monthly recap" title={isAthlete ? "Your monthly recaps" : first ? `${first}'s monthly recaps` : "Monthly recaps"} description="One page a month: sessions, new personal records and badges, goals, tests, and what is coming next.">
        {children.length > 1 ? (
          <nav aria-label="Choose athlete" className="flex flex-wrap gap-2">
            {children.map((c) => {
              const current = c.athleteId === child?.athleteId;
              return (
                <Link
                  key={c.athleteId}
                  href={`/recap?athlete=${c.athleteId}`}
                  aria-current={current ? "true" : undefined}
                  className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-bold ${current ? "bg-[#4fc3f7] text-[#0b1a2e]" : "bg-white/10 text-white ring-1 ring-white/25 hover:bg-white/20"}`}
                >
                  {c.name.split(" ")[0]}
                </Link>
              );
            })}
          </nav>
        ) : null}
      </ModuleHero>

      {!child ? (
        <EmptyState title="No athletes linked to your account yet">Ask the front desk to link your athlete to your account.</EmptyState>
      ) : !access?.canView ? (
        <Callout tone="info" title="Monthly recaps are turned off">
          Teamwork is not publishing monthly recaps right now.
        </Callout>
      ) : (
        <Card>
          <CardHeader title="Months" kicker={`${months.length} available`} />
          <CardBody className="p-0">
            <ul className="divide-y divide-edge">
              {months.map((m) => (
                <li key={m.month}>
                  <Link href={`/recap/${m.month}?athlete=${child.athleteId}`} className="flex min-h-14 items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2">
                    <span className="text-[15px] font-semibold">{m.label}</span>
                    <span className="flex items-center gap-2">
                      {m.isNew ? <Badge variant="brand">New</Badge> : null}
                      {m.state === "final" ? <Badge variant="green">Final</Badge> : m.state === "in_progress" ? <Badge variant="blue">In progress</Badge> : <Badge variant="yellow">Closing soon</Badge>}
                      <span aria-hidden className="text-ink-3">
                        ›
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
