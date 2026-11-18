import Link from "next/link";
import { db } from "@/db";
import { requireCap } from "@/lib/auth/viewer";
import { listPrograms } from "@/lib/training/programs";
import { fmtDate } from "@/lib/time";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, StatusBadge, Table, Td, Textarea, Th } from "@/components/ui";
import { TrainingNav } from "../_components/training-nav";
import { createProgramAction } from "../actions";

export const metadata = { title: "Programs" };

export default async function ProgramsPage() {
  const viewer = await requireCap("training.manage");
  const list = await listPrograms(db, viewer);
  return (
    <div>
      <PageHeader kicker="Training" title="Programs" description="Templates with phases, weeks and days. Assigning creates frozen workouts; later template edits never change them unless you choose to apply them." />
      <TrainingNav viewer={viewer} current="programs" />
      {list.length === 0 ? (
        <EmptyState title="No programs yet">Create your first program below.</EmptyState>
      ) : (
        <Card className="mb-6">
          <Table caption="Programs">
            <thead>
              <tr>
                <Th>Program</Th>
                <Th>Status</Th>
                <Th align="right">Version</Th>
                <Th align="right">Active assignments</Th>
                <Th>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <Td>
                    <Link href={`/training/programs/${p.id}`} className="font-medium text-brand hover:underline">
                      {p.name}
                    </Link>
                    {p.sport ? <Badge className="ml-2">{p.sport}</Badge> : null}
                  </Td>
                  <Td>
                    <StatusBadge status={p.status} />
                  </Td>
                  <Td align="right">v{p.currentVersion}</Td>
                  <Td align="right">{p.activeAssignments}</Td>
                  <Td>{fmtDate(p.updatedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <Card>
        <CardHeader title="New program" />
        <CardBody>
          <ActionForm action={createProgramAction} className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="np-name" required>
              <Input id="np-name" name="name" required minLength={2} maxLength={120} />
            </Field>
            <Field label="Sport (optional)" htmlFor="np-sport">
              <Input id="np-sport" name="sport" maxLength={60} />
            </Field>
            <Field label="Description" htmlFor="np-desc" className="sm:col-span-2">
              <Textarea id="np-desc" name="description" maxLength={2000} />
            </Field>
            <div className="sm:col-span-2">
              <SubmitButton>Create & open builder</SubmitButton>
            </div>
          </ActionForm>
        </CardBody>
      </Card>
    </div>
  );
}
