import { requireUser } from "@/lib/auth";
import { db } from "@/db";
import { metrics } from "@/db/schema";
import { GROUP_LABELS } from "@/lib/metric-catalog";
import { updateMetric } from "@/app/actions/admin";
import {
  PageHeader,
  Card,
  CardBody,
  Badge,
  Button,
  Input,
  Textarea,
  Select,
  Field,
} from "@/components/ui";

export const metadata = { title: "Metric Dictionary" };

export default async function AdminMetricsPage() {
  await requireUser("manage_metrics");
  const all = db.select().from(metrics).all();

  return (
    <>
      <PageHeader
        kicker="Admin"
        title="Metric Dictionary"
        subtitle="One canonical definition per metric, used everywhere in the app. Edit definitions when Teamwork's process differs."
      />
      {Object.entries(GROUP_LABELS).map(([groupKey, label]) => {
        const rows = all
          .filter((m) => m.groupKey === groupKey)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
        if (rows.length === 0) return null;
        return (
          <section key={groupKey} className="mb-6">
            <h2 className="mb-2 text-lg font-bold">{label}</h2>
            <Card>
              <CardBody className="divide-y divide-edge/60 pt-2">
                {rows.map((m) => (
                  <details key={m.id} className="py-2">
                    <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">
                        {m.name}
                        <code className="ml-2 rounded bg-surface-3 px-1 py-0.5 text-[10px] text-ink-3">
                          {m.key}
                        </code>
                      </span>
                      <span className="flex items-center gap-1.5 text-xs text-ink-3">
                        Goal: {m.goal ?? "—"} {m.unit === "percent" ? "%" : ""} /{" "}
                        {m.frequency}
                        {m.autoCompute ? <Badge variant="green">auto</Badge> : <Badge variant="neutral">manual</Badge>}
                        {m.sensitive ? <Badge variant="brand">financial</Badge> : null}
                        {!m.active ? <Badge variant="red">inactive</Badge> : null}
                      </span>
                    </summary>
                    <form action={updateMetric} className="mt-3 grid gap-3 rounded-lg bg-surface-3/40 p-3 sm:grid-cols-3">
                      <input type="hidden" name="id" value={m.id} />
                      <Field label="Name">
                        <Input name="name" defaultValue={m.name} />
                      </Field>
                      <Field label="Goal">
                        <Input name="goal" type="number" step="any" defaultValue={m.goal ?? ""} />
                      </Field>
                      <Field label="Goal period">
                        <Select name="frequency" defaultValue={m.frequency}>
                          <option value="weekly">weekly</option>
                          <option value="monthly">monthly</option>
                        </Select>
                      </Field>
                      <Field label="Red below (% of goal)">
                        <Input name="redBelowPct" type="number" step="any" defaultValue={m.redBelowPct} />
                      </Field>
                      <Field label="Yellow below (% of goal)">
                        <Input name="yellowBelowPct" type="number" step="any" defaultValue={m.yellowBelowPct} />
                      </Field>
                      <Field label="Direction">
                        <Select name="direction" defaultValue={m.direction}>
                          <option value="up">higher is better</option>
                          <option value="down">lower is better</option>
                        </Select>
                      </Field>
                      <Field label="Unit">
                        <Select name="unit" defaultValue={m.unit}>
                          {["count", "percent", "currency", "minutes", "days"].map((u) => (
                            <option key={u} value={u}>{u}</option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Source system">
                        <Input name="sourceSystem" defaultValue={m.sourceSystem ?? ""} />
                      </Field>
                      <Field label="Data owner">
                        <Input name="dataOwner" defaultValue={m.dataOwner ?? ""} />
                      </Field>
                      <div className="sm:col-span-3">
                        <Field label="Plain-language definition">
                          <Textarea name="definition" rows={2} defaultValue={m.definition ?? ""} />
                        </Field>
                      </div>
                      <div className="sm:col-span-2">
                        <Field label="Calculation formula">
                          <Input name="formula" defaultValue={m.formula ?? ""} />
                        </Field>
                      </div>
                      <Field label="Source fields">
                        <Input name="sourceFields" defaultValue={m.sourceFields ?? ""} />
                      </Field>
                      <div className="sm:col-span-2">
                        <Field label="Notes">
                          <Input name="notes" defaultValue={m.notes ?? ""} />
                        </Field>
                      </div>
                      <Field label="Active">
                        <Select name="active" defaultValue={String(m.active)}>
                          <option value="1">active</option>
                          <option value="0">inactive</option>
                        </Select>
                      </Field>
                      <div className="flex items-end gap-2 sm:col-span-3">
                        <Button size="sm" type="submit">Save metric</Button>
                        <span className="text-[11px] text-ink-3">
                          Last updated {m.updatedAt.slice(0, 16).replace("T", " ")}
                          {m.autoCompute
                            ? " · Value auto-computes from app data; manual entries override per period."
                            : " · Value comes from manual entries / imports."}
                        </span>
                      </div>
                    </form>
                  </details>
                ))}
              </CardBody>
            </Card>
          </section>
        );
      })}
    </>
  );
}
