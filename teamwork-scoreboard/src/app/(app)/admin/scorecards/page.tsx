import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireUser } from "@/lib/auth";
import { upsertScorecardMetric, addScorecardTemplate } from "@/app/actions/admin";
import { METRIC_CATALOG } from "@/lib/metric-catalog";
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

export const metadata = { title: "Scorecard Templates" };

export default async function AdminScorecardsPage() {
  await requireUser("manage_metrics");
  const templates = db.all<{ id: number; role_name: string }>(
    sql`SELECT id, role_name FROM scorecard_templates WHERE active = 1 ORDER BY sort_order, id`
  );
  const metricsRows = db.all<{
    id: number;
    template_id: number;
    name: string;
    unit: string;
    weekly_goal: number;
    direction: string;
    auto_key: string | null;
    sort_order: number;
    active: number;
  }>(sql`SELECT * FROM scorecard_metrics ORDER BY sort_order, id`);

  const autoKeys = METRIC_CATALOG.filter((m) => m.autoCompute).map((m) => m.key);

  return (
    <>
      <PageHeader
        kicker="Admin"
        title="Scorecard Templates"
        subtitle="Role scorecards and their weekly measurables. Link a measurable to a dictionary metric key to prefill automatic values."
      />
      {templates.map((t) => {
        const rows = metricsRows.filter((m) => m.template_id === t.id && m.active === 1);
        return (
          <Card key={t.id} className="mb-4">
            <CardHeader kicker={`${rows.length} measurables`} title={`${t.role_name} Scorecard`} />
            <CardBody className="divide-y divide-edge/60">
              {rows.map((m) => (
                <details key={m.id} className="py-2">
                  <summary className="flex cursor-pointer items-center justify-between gap-2">
                    <span className="font-medium">{m.name}</span>
                    <span className="flex gap-1.5 text-xs">
                      <Badge variant="neutral">
                        goal {m.weekly_goal}
                        {m.unit === "percent" ? "%" : ""}/wk
                      </Badge>
                      {m.auto_key && <Badge variant="green">auto: {m.auto_key}</Badge>}
                    </span>
                  </summary>
                  <form action={upsertScorecardMetric} className="mt-3 grid gap-2 rounded-lg bg-surface-3/40 p-3 sm:grid-cols-4">
                    <input type="hidden" name="id" value={m.id} />
                    <div className="sm:col-span-2">
                      <Field label="Measurable"><Input name="name" defaultValue={m.name} required /></Field>
                    </div>
                    <Field label="Weekly goal">
                      <Input name="weeklyGoal" type="number" step="any" defaultValue={m.weekly_goal} />
                    </Field>
                    <Field label="Unit">
                      <Select name="unit" defaultValue={m.unit}>
                        <option value="count">count</option>
                        <option value="percent">percent</option>
                      </Select>
                    </Field>
                    <Field label="Direction">
                      <Select name="direction" defaultValue={m.direction}>
                        <option value="up">higher is better</option>
                        <option value="down">lower is better</option>
                      </Select>
                    </Field>
                    <Field label="Auto metric key (optional)">
                      <Select name="autoKey" defaultValue={m.auto_key ?? ""}>
                        <option value="">— manual entry —</option>
                        {autoKeys.map((k) => (
                          <option key={k} value={k}>{k}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Sort order">
                      <Input name="sortOrder" type="number" defaultValue={m.sort_order} />
                    </Field>
                    <Field label="Active">
                      <Select name="active" defaultValue="1">
                        <option value="1">active</option>
                        <option value="0">removed</option>
                      </Select>
                    </Field>
                    <div className="flex items-end sm:col-span-4">
                      <Button size="sm" type="submit">Save measurable</Button>
                    </div>
                  </form>
                </details>
              ))}
              <details className="py-2">
                <summary className="cursor-pointer text-sm font-semibold text-brand-600">
                  + Add measurable
                </summary>
                <form action={upsertScorecardMetric} className="mt-3 grid gap-2 rounded-lg bg-surface-3/40 p-3 sm:grid-cols-4">
                  <input type="hidden" name="templateId" value={t.id} />
                  <div className="sm:col-span-2">
                    <Field label="Measurable"><Input name="name" required /></Field>
                  </div>
                  <Field label="Weekly goal">
                    <Input name="weeklyGoal" type="number" step="any" defaultValue="1" />
                  </Field>
                  <Field label="Unit">
                    <Select name="unit">
                      <option value="count">count</option>
                      <option value="percent">percent</option>
                    </Select>
                  </Field>
                  <div className="flex items-end">
                    <Button size="sm" type="submit">Add</Button>
                  </div>
                </form>
              </details>
            </CardBody>
          </Card>
        );
      })}
      <Card>
        <CardHeader kicker="New role scorecard" title="Add a scorecard template" />
        <CardBody>
          <form action={addScorecardTemplate} className="flex items-end gap-2">
            <Field label="Role name">
              <Input name="roleName" required placeholder="e.g. Front Desk" />
            </Field>
            <Button size="sm" type="submit">Create template</Button>
          </form>
        </CardBody>
      </Card>
    </>
  );
}
