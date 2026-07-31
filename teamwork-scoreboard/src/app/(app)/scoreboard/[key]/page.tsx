import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { subWeeks } from "date-fns";
import { db } from "@/db";
import { metrics } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import {
  computeMetric,
  drillRecords,
  type MetricRow,
} from "@/lib/kpi";
import { resolvePeriod } from "@/lib/periods";
import { formatValue } from "@/lib/calc";
import { addKpiValue } from "@/app/actions/team";
import { TrendChart, type TrendPoint } from "@/components/trend-chart";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  StatusBadge,
  Table,
  Input,
  Textarea,
  Button,
  Field,
} from "@/components/ui";

export default async function MetricDrillPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const user = await requireUser("view_dashboard");
  const { key } = await params;
  const metric = db.select().from(metrics).where(eq(metrics.key, key)).get() as
    | MetricRow
    | undefined;
  if (!metric) notFound();
  if (metric.sensitive && !user.permissions.includes("view_financials")) {
    notFound();
  }

  const now = new Date();
  const week = resolvePeriod("weekly", now);
  const month = resolvePeriod("monthly", now);
  const weekResult = computeMetric(metric, week, now);
  const monthResult = computeMetric(metric, month, now);

  // 8-week trend
  const trend: TrendPoint[] = [];
  for (let i = 7; i >= 0; i--) {
    const wp = resolvePeriod("weekly", subWeeks(now, i));
    const r = computeMetric(metric, wp, subWeeks(now, i));
    trend.push({ label: wp.start.slice(5), value: r.value });
  }

  const drill = drillRecords(key, month, now);
  const canOverride = user.permissions.includes("override_values");

  return (
    <>
      <PageHeader
        kicker={`Metric · ${metric.groupKey}`}
        title={metric.name}
        subtitle={metric.definition ?? undefined}
        actions={
          <Link
            href="/scoreboard"
            className="no-print text-sm font-medium text-brand-600 hover:underline"
          >
            ← Back to scoreboard
          </Link>
        }
      />

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        {[
          { label: "This week", r: weekResult },
          { label: "This month", r: monthResult },
        ].map(({ label, r }) => (
          <Card key={label} className="p-4">
            <div className="kicker">{label}</div>
            <div className="mt-1 flex items-baseline justify-between">
              <span className="stat-figure text-3xl font-bold">
                {formatValue(r.value, metric.unit)}
              </span>
              <StatusBadge status={r.status} />
            </div>
            <p className="mt-1 text-xs text-ink-3">
              Goal {formatValue(r.goal, metric.unit)} · Diff{" "}
              {formatValue(r.diff, metric.unit)} ·{" "}
              {r.attainment !== null ? `${Math.round(r.attainment)}% of goal` : "no goal"}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-3">
              Source: {r.source}
              {r.lastUpdated ? ` · updated ${r.lastUpdated.slice(0, 16).replace("T", " ")}` : ""}
            </p>
          </Card>
        ))}
        <Card className="p-4">
          <div className="kicker">Definition</div>
          <p className="mt-1 text-sm text-ink-2">{metric.formula ?? "—"}</p>
          <p className="mt-2 text-xs text-ink-3">
            System: {metric.sourceSystem ?? "—"} · Owner: {metric.dataOwner ?? "—"} ·{" "}
            {metric.direction === "up" ? "Higher is better" : "Lower is better"} ·{" "}
            {metric.frequency} goal
          </p>
          <p className="mt-1 text-xs text-ink-3">
            Thresholds: red &lt; {metric.redBelowPct}% · yellow &lt; {metric.yellowBelowPct}% of goal
          </p>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader kicker="Trend" title="Last 8 weeks" />
        <CardBody>
          <TrendChart data={trend} goal={weekResult.goal} unit={metric.unit} />
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            kicker="Drill-down"
            title="Records behind this number"
            action={<span className="text-xs text-ink-3">{month.label}</span>}
          />
          <CardBody>
            {drill.note ? <p className="mb-2 text-xs text-ink-3">{drill.note}</p> : null}
            <Table columns={drill.columns} rows={drill.rows} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            kicker="Manual entry"
            title="Record a value"
          />
          <CardBody>
            {canOverride ? (
              <form action={addKpiValue} className="space-y-3">
                <input type="hidden" name="metricKey" value={metric.key} />
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Period start">
                    <Input type="date" name="periodStart" required defaultValue={week.start} />
                  </Field>
                  <Field label="Period end">
                    <Input type="date" name="periodEnd" defaultValue={week.end} />
                  </Field>
                </div>
                <Field label={`Value (${metric.unit})`}>
                  <Input type="number" step="any" name="value" required />
                </Field>
                <Field label="Source note">
                  <Input name="sourceNote" placeholder="e.g. Zen Planner report 7/28" />
                </Field>
                <Field label="Reason (if overriding an automatic value)">
                  <Textarea name="overrideReason" rows={2} />
                </Field>
                <Button type="submit" className="w-full">Save value</Button>
                <p className="text-[11px] text-ink-3">
                  Entries are audited with your name and timestamp. A manual entry
                  for a period overrides the auto-computed value for that period.
                </p>
              </form>
            ) : (
              <p className="text-sm text-ink-3">
                Your role cannot record manual values. Ask an administrator for the
                “Override values” permission.
              </p>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
