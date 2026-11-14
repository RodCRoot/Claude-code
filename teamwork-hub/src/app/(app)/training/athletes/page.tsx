import Link from "next/link";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { athletes, workouts } from "@/db/schema";
import { requireStaff } from "@/lib/auth/viewer";
import { accessibleAthleteIds, athleteScopeFilter } from "@/lib/authz/policy";
import { addDaysYmd, fmtDate, todayLocal } from "@/lib/time";
import { athleteNames } from "@/lib/training/common";
import { adherence } from "@/lib/training/formulas";
import { EmptyState, PageHeader, Table, Td, Th, Card } from "@/components/ui";
import { TrainingNav } from "../_components/training-nav";

export const metadata = { title: "Training athletes" };

export default async function AthletesPage() {
  const viewer = await requireStaff();
  const today = todayLocal();
  const scope = await accessibleAthleteIds(db, viewer, "training.read");
  const rows = await db
    .select({ id: athletes.id })
    .from(athletes)
    .where(and(eq(athletes.orgId, viewer.orgId), eq(athletes.active, true), athleteScopeFilter(scope, athletes.id)));
  const ids = rows.map((r) => r.id);
  const names = await athleteNames(db, viewer.orgId, ids);
  const ws = ids.length
    ? await db
        .select({ athleteId: workouts.athleteId, scheduledDate: workouts.scheduledDate, status: workouts.status })
        .from(workouts)
        .where(and(inArray(workouts.athleteId, ids), gte(workouts.scheduledDate, addDaysYmd(today, -28)), lte(workouts.scheduledDate, addDaysYmd(today, 14))))
    : [];
  const list = ids
    .map((id) => {
      const mine = ws.filter((w) => w.athleteId === id);
      const last = mine.filter((w) => w.status === "completed").sort((a, b) => (a.scheduledDate < b.scheduledDate ? 1 : -1))[0];
      const next = mine.filter((w) => w.scheduledDate >= today && w.status !== "completed").sort((a, b) => (a.scheduledDate < b.scheduledDate ? -1 : 1))[0];
      return { id, name: names.get(id) ?? "Athlete", adh: adherence(mine, today), last: last?.scheduledDate, next: next?.scheduledDate };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <PageHeader kicker="Training" title="Athletes" description={viewer.role === "coach" ? "Athletes you are assigned to coach." : "All active athletes."} />
      <TrainingNav viewer={viewer} current="athletes" />
      {list.length === 0 ? (
        <EmptyState title="No athletes in your scope" />
      ) : (
        <Card>
          <Table caption="Athletes and adherence">
            <thead>
              <tr>
                <Th>Athlete</Th>
                <Th align="right">Adherence (28 d)</Th>
                <Th>Last completed</Th>
                <Th>Next scheduled</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <Td>
                    <Link href={`/training/athletes/${a.id}`} className="font-medium text-brand hover:underline">
                      {a.name}
                    </Link>
                  </Td>
                  <Td align="right">{a.adh.pct != null ? `${a.adh.pct}% (${a.adh.completed}/${a.adh.scheduled})` : "—"}</Td>
                  <Td>{a.last ? fmtDate(a.last) : "—"}</Td>
                  <Td>{a.next ? fmtDate(a.next) : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
