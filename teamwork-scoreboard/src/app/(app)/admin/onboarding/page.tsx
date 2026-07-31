import { db } from "@/db";
import { onboardingSteps } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { upsertOnboardingStep } from "@/app/actions/admin";
import {
  PageHeader,
  Card,
  CardBody,
  Badge,
  Button,
  Input,
  Field,
} from "@/components/ui";

export const metadata = { title: "Onboarding Steps" };

export default async function AdminOnboardingPage() {
  await requireUser("manage_settings");
  const steps = db.select().from(onboardingSteps).all().sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <>
      <PageHeader
        kicker="Admin"
        title="Onboarding Steps"
        subtitle="The checklist every new athlete works through. Changes apply to newly added athletes."
      />
      <Card>
        <CardBody className="divide-y divide-edge/60 pt-2">
          {steps.map((s) => (
            <details key={s.id} className="py-2">
              <summary className="flex cursor-pointer items-center justify-between gap-2">
                <span className={s.active ? "font-medium" : "font-medium text-ink-3 line-through"}>
                  {s.sortOrder}. {s.name}
                </span>
                <Badge variant="neutral">due +{s.dueOffsetDays}d</Badge>
              </summary>
              <form action={upsertOnboardingStep} className="mt-3 grid gap-2 rounded-lg bg-surface-3/40 p-3 sm:grid-cols-4">
                <input type="hidden" name="id" value={s.id} />
                <div className="sm:col-span-2">
                  <Field label="Step name"><Input name="name" defaultValue={s.name} required /></Field>
                </div>
                <Field label="Due (days after start)">
                  <Input name="dueOffsetDays" type="number" defaultValue={s.dueOffsetDays} />
                </Field>
                <Field label="Sort order">
                  <Input name="sortOrder" type="number" defaultValue={s.sortOrder} />
                </Field>
                <div className="sm:col-span-3">
                  <Field label="Description"><Input name="description" defaultValue={s.description ?? ""} /></Field>
                </div>
                <div className="flex items-end gap-2">
                  <label className="flex items-center gap-1.5 text-xs">
                    <input type="hidden" name="active" value={s.active ? "1" : "1"} />
                  </label>
                  <Button size="sm" type="submit">Save</Button>
                </div>
              </form>
            </details>
          ))}
          <details className="py-2">
            <summary className="cursor-pointer text-sm font-semibold text-brand-600">+ Add step</summary>
            <form action={upsertOnboardingStep} className="mt-3 grid gap-2 rounded-lg bg-surface-3/40 p-3 sm:grid-cols-4">
              <div className="sm:col-span-2">
                <Field label="Step name"><Input name="name" required /></Field>
              </div>
              <Field label="Due (days after start)">
                <Input name="dueOffsetDays" type="number" defaultValue="7" />
              </Field>
              <Field label="Sort order">
                <Input name="sortOrder" type="number" defaultValue={String((steps.at(-1)?.sortOrder ?? 0) + 1)} />
              </Field>
              <div className="flex items-end">
                <Button size="sm" type="submit">Add step</Button>
              </div>
            </form>
          </details>
        </CardBody>
      </Card>
    </>
  );
}
