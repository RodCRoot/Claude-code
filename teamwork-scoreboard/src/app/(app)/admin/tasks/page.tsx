import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireUser } from "@/lib/auth";
import { upsertTaskTemplate, deleteTaskTemplate } from "@/app/actions/admin";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  Badge,
  Button,
  Input,
  Select,
  Field,
} from "@/components/ui";

export const metadata = { title: "Task Templates" };

const DOW = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function TemplateForm({
  t,
  usersList,
}: {
  t?: Record<string, unknown> & { id?: number };
  usersList: { id: number; name: string }[];
}) {
  return (
    <form action={upsertTaskTemplate} className="mt-3 grid gap-2 rounded-lg bg-surface-3/40 p-3 sm:grid-cols-3">
      {t?.id ? <input type="hidden" name="id" value={t.id} /> : null}
      <div className="sm:col-span-2">
        <Field label="Title"><Input name="title" required defaultValue={(t?.title as string) ?? ""} /></Field>
      </div>
      <Field label="Category">
        <Select name="category" defaultValue={(t?.category as string) ?? "operations"}>
          <option value="operations">operations</option>
          <option value="cleaning">cleaning</option>
          <option value="marketing">marketing</option>
        </Select>
      </Field>
      <Field label="Section" hint="daily / opening / closing / weekly / monthly">
        <Input name="subcategory" defaultValue={(t?.subcategory as string) ?? "daily"} />
      </Field>
      <Field label="Recurrence">
        <Select name="recurrence" defaultValue={(t?.recurrence as string) ?? "daily"}>
          {["daily", "weekly", "monthly", "quarterly"].map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </Select>
      </Field>
      <Field label="Day of week (weekly)">
        <Select name="dayOfWeek" defaultValue={String(t?.dayOfWeek ?? "")}>
          <option value="">—</option>
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <option key={d} value={d}>{DOW[d]}</option>
          ))}
        </Select>
      </Field>
      <Field label="Day of month (monthly/quarterly)">
        <Input name="dayOfMonth" type="number" min="1" max="28" defaultValue={String(t?.dayOfMonth ?? "")} />
      </Field>
      <Field label="Assigned role">
        <Input name="assignedRole" placeholder="e.g. Coach" defaultValue={(t?.assignedRole as string) ?? ""} />
      </Field>
      <Field label="Assigned person">
        <Select name="assignedUserId" defaultValue={String(t?.assignedUserId ?? "")}>
          <option value="">— anyone —</option>
          {usersList.map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </Select>
      </Field>
      <div className="flex items-end gap-3">
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" name="requiresApproval" defaultChecked={t?.requiresApproval === 1} className="size-4" />
          Needs approval
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <input type="checkbox" name="requiresProof" defaultChecked={t?.requiresProof === 1} className="size-4" />
          Needs proof
        </label>
      </div>
      <div className="flex items-end gap-2 sm:col-span-3">
        <Button size="sm" type="submit">{t?.id ? "Save template" : "Add template"}</Button>
      </div>
    </form>
  );
}

export default async function AdminTasksPage() {
  await requireUser("manage_tasks");
  const templates = db.all<{
    id: number;
    title: string;
    category: string;
    subcategory: string | null;
    recurrence: string;
    dayOfWeek: number | null;
    dayOfMonth: number | null;
    assignedRole: string | null;
    assignedUserId: number | null;
    requiresApproval: number;
    requiresProof: number;
    active: number;
  }>(sql`
    SELECT id, title, category, subcategory, recurrence,
      day_of_week AS dayOfWeek, day_of_month AS dayOfMonth,
      assigned_role AS assignedRole, assigned_user_id AS assignedUserId,
      requires_approval AS requiresApproval, requires_proof AS requiresProof, active
    FROM task_templates WHERE active = 1
    ORDER BY category, recurrence, sort_order, id
  `);
  const usersList = db.all<{ id: number; name: string }>(
    sql`SELECT id, name FROM users WHERE active = 1 ORDER BY name`
  );

  const categories = ["operations", "cleaning", "marketing"];

  return (
    <>
      <PageHeader
        kicker="Admin"
        title="Recurring Task Templates"
        subtitle="Instances generate automatically each day (with 7 days of catch-up). Deactivating a template stops future instances."
      />
      {categories.map((cat) => {
        const rows = templates.filter((t) => t.category === cat);
        return (
          <Card key={cat} className="mb-4">
            <CardHeader kicker={`${rows.length} templates`} title={cat[0].toUpperCase() + cat.slice(1)} />
            <CardBody className="divide-y divide-edge/60">
              {rows.map((t) => (
                <details key={t.id} className="py-2">
                  <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{t.title}</span>
                    <span className="flex gap-1.5 text-xs">
                      <Badge variant="neutral">{t.recurrence}</Badge>
                      {t.subcategory && <Badge variant="neutral">{t.subcategory}</Badge>}
                      {t.recurrence === "weekly" && t.dayOfWeek ? (
                        <Badge variant="neutral">{DOW[t.dayOfWeek]}</Badge>
                      ) : null}
                      {t.assignedRole && <Badge variant="brand">{t.assignedRole}</Badge>}
                    </span>
                  </summary>
                  <TemplateForm t={t} usersList={usersList} />
                  <form action={deleteTaskTemplate} className="mt-1">
                    <input type="hidden" name="id" value={t.id} />
                    <Button size="sm" variant="ghost" type="submit" className="text-bad">
                      Deactivate template
                    </Button>
                  </form>
                </details>
              ))}
              <details className="py-2">
                <summary className="cursor-pointer text-sm font-semibold text-brand-600">
                  + Add {cat} template
                </summary>
                <TemplateForm usersList={usersList} />
              </details>
            </CardBody>
          </Card>
        );
      })}
    </>
  );
}
