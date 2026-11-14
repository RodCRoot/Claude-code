import Link from "next/link";
import { db } from "@/db";
import { requireStaff } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { EXERCISE_CATEGORIES, listExercises, MOVEMENT_PATTERNS } from "@/lib/training/exercises";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { TrainingNav } from "../_components/training-nav";
import { ExerciseForm } from "../_components/exercise-form";
import { sp } from "../_lib/helpers";

export const metadata = { title: "Exercise library" };

export default async function ExercisesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireStaff();
  const q = await searchParams;
  const filters = { q: sp(q.q).slice(0, 80), category: sp(q.category), pattern: sp(q.pattern), includeInactive: sp(q.inactive) === "1" };
  const list = await listExercises(db, viewer, filters);
  const all = await listExercises(db, viewer, { includeInactive: true });
  const byId = new Map(all.map((e) => [e.id, e.name]));
  const canEdit = can(viewer, "training.manage");

  return (
    <div>
      <PageHeader kicker="Training" title="Exercise library" description={`${all.length} exercises. Video links point to media you own or are licensed to share; nothing is copied.`} />
      <TrainingNav viewer={viewer} current="exercises" />
      <form method="get" className="mb-4 grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto_auto] sm:items-end" role="search">
        <Field label="Search" htmlFor="ex-q">
          <Input id="ex-q" name="q" defaultValue={filters.q} placeholder="Name or coaching note" />
        </Field>
        <Field label="Category" htmlFor="ex-cat">
          <Select id="ex-cat" name="category" defaultValue={filters.category}>
            <option value="">All</option>
            {EXERCISE_CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
        <Field label="Pattern" htmlFor="ex-pat">
          <Select id="ex-pat" name="pattern" defaultValue={filters.pattern}>
            <option value="">All</option>
            {MOVEMENT_PATTERNS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="inactive" value="1" defaultChecked={filters.includeInactive} className="size-5" /> Show inactive
        </label>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
      </form>

      {list.length === 0 ? (
        <EmptyState title="No exercises match">Try a different search or clear the filters.</EmptyState>
      ) : (
        <Card className="mb-6">
          <Table caption="Exercises">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Category</Th>
                <Th>Pattern</Th>
                <Th>Tracking</Th>
                <Th>Max source</Th>
                <Th>Substitutions</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id}>
                  <Td>
                    {canEdit ? (
                      <Link href={`/training/exercises/${e.id}`} className="font-medium text-brand hover:underline">
                        {e.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{e.name}</span>
                    )}
                    {e.isUnilateral ? <Badge className="ml-2">unilateral</Badge> : null}
                    {!e.active ? <Badge variant="red" className="ml-2">inactive</Badge> : null}
                    {e.videoUrl ? (
                      <a href={e.videoUrl} target="_blank" rel="noopener noreferrer" className="ml-2 text-xs text-brand underline">
                        video ↗
                      </a>
                    ) : null}
                  </Td>
                  <Td>{e.category}</Td>
                  <Td>{e.movementPattern ?? "—"}</Td>
                  <Td>
                    {e.trackingType.replace("_", " ")} ({e.defaultUnit})
                  </Td>
                  <Td>{e.maxSourceExerciseId ? byId.get(e.maxSourceExerciseId) : "own max"}</Td>
                  <Td className="text-xs">{e.substitutionIds.map((s) => byId.get(s)).filter(Boolean).join(", ") || "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {canEdit ? (
        <Card>
          <CardHeader title="Add exercise" />
          <CardBody>
            <ExerciseForm all={all} />
          </CardBody>
        </Card>
      ) : (
        <p className="text-sm text-ink-3">Editing the library requires a coach, admin, or owner role.</p>
      )}
    </div>
  );
}
