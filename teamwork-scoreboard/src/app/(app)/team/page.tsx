import Link from "next/link";
import { sql, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  scorecardTemplates,
  scorecardMetrics,
  metrics as metricsTable,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { lastNWeekStarts, resolvePeriod, todayStr, weekStartOf } from "@/lib/periods";
import { average, formatValue, goalAttainment, statusFor } from "@/lib/calc";
import { computeMetric, type MetricRow } from "@/lib/kpi";
import { saveScorecardWeek, ownerCommentScorecard } from "@/app/actions/team";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  Badge,
  StatusDot,
  Button,
  Input,
  Textarea,
  Select,
  Field,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { parseISO } from "date-fns";
import { PrintButton } from "@/components/print-button";

export const metadata = { title: "Team Scorecards" };

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string; week?: string; template?: string }>;
}) {
  const me = await requireUser("view_dashboard");
  const sp = await searchParams;
  const canViewAll = me.permissions.includes("view_all_scorecards");
  const canReview = me.permissions.includes("review_reports");

  const staff = db.all<{ id: number; name: string; roleName: string; title: string | null }>(sql`
    SELECT u.id, u.name, r.name AS roleName, u.title
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.active = 1 AND r.permissions LIKE '%submit_scorecard%'
    ORDER BY u.name
  `);

  const selectedUserId = canViewAll
    ? parseInt(sp.user ?? "", 10) || (staff.find((s) => s.id === me.id)?.id ?? staff[0]?.id)
    : me.id;
  const selectedUser = staff.find((s) => s.id === selectedUserId) ?? staff[0];

  const templates = db
    .select()
    .from(scorecardTemplates)
    .where(eq(scorecardTemplates.active, 1))
    .all();
  const defaultTemplate =
    templates.find(
      (t) =>
        selectedUser &&
        (t.roleName.toLowerCase() === selectedUser.roleName.toLowerCase() ||
          (selectedUser.title ?? "").toLowerCase().includes(t.roleName.toLowerCase().split("/")[0]))
    ) ?? templates[0];
  const templateId = parseInt(sp.template ?? "", 10) || defaultTemplate?.id;
  const template = templates.find((t) => t.id === templateId) ?? defaultTemplate;

  const weeks = lastNWeekStarts(6);
  const selectedWeek =
    sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? weekStartOf(sp.week) : weeks[weeks.length - 1];

  const scMetrics = template
    ? db
        .select()
        .from(scorecardMetrics)
        .where(eq(scorecardMetrics.templateId, template.id))
        .all()
        .filter((m) => m.active === 1)
        .sort((a, b) => a.sortOrder - b.sortOrder)
    : [];

  // entries[metricId][weekStart] = value
  const entries = new Map<number, Map<string, number>>();
  if (selectedUser) {
    const rows = db.all<{ scorecard_metric_id: number; week_start: string; value: number }>(sql`
      SELECT scorecard_metric_id, week_start, value FROM scorecard_entries
      WHERE user_id = ${selectedUser.id} AND week_start IN (${sql.raw(
        weeks.map((w) => `'${w}'`).join(",")
      )})
    `);
    for (const r of rows) {
      if (!entries.has(r.scorecard_metric_id)) entries.set(r.scorecard_metric_id, new Map());
      entries.get(r.scorecard_metric_id)!.set(r.week_start, r.value);
    }
  }

  // Auto-computed reference values for the selected week
  const autoValues = new Map<number, number | null>();
  const allMetricRows = db.select().from(metricsTable).all() as unknown as MetricRow[];
  for (const m of scMetrics) {
    if (!m.autoKey) continue;
    const dict = allMetricRows.find((x) => x.key === m.autoKey);
    if (!dict || !dict.autoCompute) continue;
    const wp = resolvePeriod("weekly", parseISO(selectedWeek));
    autoValues.set(m.id, computeMetric(dict, wp, new Date()).value);
  }

  const weekRow = selectedUser
    ? db.get<{ staff_note: string | null; owner_comment: string | null; submitted_at: string | null }>(sql`
        SELECT staff_note, owner_comment, submitted_at FROM scorecard_weeks
        WHERE user_id = ${selectedUser.id} AND week_start = ${selectedWeek}
      `)
    : undefined;

  // Month-to-date totals
  const monthStart = todayStr().slice(0, 8) + "01";

  return (
    <>
      <PageHeader
        kicker="Team Scoreboards"
        title={selectedUser ? `${selectedUser.name} — ${template?.roleName ?? ""} Scorecard` : "Team Scorecards"}
        subtitle="Rolling six-week view. Enter this week's numbers, then submit — submitting prompts your 5-15 report."
        actions={
          <div className="no-print flex flex-wrap gap-2">
            {canViewAll && (
              <form method="get" action="/team" className="flex gap-2">
                <Select name="user" defaultValue={String(selectedUser?.id ?? "")} className="w-44">
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
                <Select name="template" defaultValue={String(template?.id ?? "")} className="w-52">
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.roleName}
                    </option>
                  ))}
                </Select>
                <Button variant="secondary" size="md" type="submit">View</Button>
              </form>
            )}
            <PrintButton />
          </div>
        }
      />

      {!template || !selectedUser ? (
        <p className="text-sm text-ink-3">No scorecard templates or staff configured yet.</p>
      ) : (
        <>
          {/* Six-week grid */}
          <Card className="mb-6 print-block">
            <CardHeader
              kicker="Rolling 6 weeks"
              title="Weekly results"
              action={
                weekRow?.submitted_at ? (
                  <Badge variant="green">Week submitted {weekRow.submitted_at.slice(0, 10)}</Badge>
                ) : (
                  <Badge variant="yellow">This week not submitted</Badge>
                )
              }
            />
            <CardBody>
              <div className="overflow-x-auto">
                <table className="w-full min-w-max text-sm">
                  <thead>
                    <tr className="border-b border-edge text-left">
                      <th className="px-2 py-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
                        Measurable
                      </th>
                      <th className="px-2 py-2 text-xs font-semibold text-ink-3">Goal</th>
                      {weeks.map((w) => (
                        <th key={w} className="px-2 py-2 text-center text-xs font-semibold text-ink-3">
                          <Link
                            href={`/team?user=${selectedUser.id}&template=${template.id}&week=${w}`}
                            className={cn(
                              "rounded px-1.5 py-0.5",
                              w === selectedWeek ? "bg-brand-600 text-white" : "hover:bg-surface-3"
                            )}
                          >
                            {w.slice(5)}
                          </Link>
                        </th>
                      ))}
                      <th className="px-2 py-2 text-center text-xs font-semibold text-ink-3">6-wk avg</th>
                      <th className="px-2 py-2 text-center text-xs font-semibold text-ink-3">MTD</th>
                      <th className="px-2 py-2 text-center text-xs font-semibold text-ink-3">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scMetrics.map((m) => {
                      const row = entries.get(m.id) ?? new Map<string, number>();
                      const vals = weeks
                        .map((w) => row.get(w))
                        .filter((v): v is number => v !== undefined);
                      const avg = average(vals);
                      const mtd = [...row.entries()]
                        .filter(([w]) => w >= monthStart)
                        .reduce((a, [, v]) => a + v, 0);
                      const current = row.get(selectedWeek) ?? null;
                      const att = goalAttainment(current, m.weeklyGoal, m.direction as "up" | "down");
                      const status = statusFor(att);
                      return (
                        <tr key={m.id} className="border-b border-edge/60 last:border-0">
                          <td className="px-2 py-2 font-medium">
                            {m.name}
                            {m.autoKey ? (
                              <span className="ml-1.5 rounded bg-surface-3 px-1 py-0.5 text-[10px] font-semibold text-ink-3">
                                auto: {formatValue(autoValues.get(m.id) ?? null, m.unit)}
                              </span>
                            ) : null}
                          </td>
                          <td className="px-2 py-2 text-ink-2">
                            {formatValue(m.weeklyGoal, m.unit)}
                          </td>
                          {weeks.map((w) => (
                            <td key={w} className="px-2 py-2 text-center tabular-nums">
                              {row.has(w) ? formatValue(row.get(w)!, m.unit) : "·"}
                            </td>
                          ))}
                          <td className="px-2 py-2 text-center font-semibold tabular-nums">
                            {formatValue(avg, m.unit)}
                          </td>
                          <td className="px-2 py-2 text-center tabular-nums">
                            {m.unit === "percent" ? "—" : formatValue(mtd, m.unit)}
                          </td>
                          <td className="px-2 py-2 text-center">
                            <StatusDot status={status} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Entry form */}
            <Card className="no-print">
              <CardHeader
                kicker={`Week of ${selectedWeek}`}
                title="Enter weekly numbers"
              />
              <CardBody>
                {me.permissions.includes("submit_scorecard") &&
                (selectedUser.id === me.id || canViewAll) ? (
                  <form action={saveScorecardWeek} className="space-y-3">
                    <input type="hidden" name="userId" value={selectedUser.id} />
                    <input type="hidden" name="weekStart" value={selectedWeek} />
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {scMetrics.map((m) => (
                        <Field
                          key={m.id}
                          label={`${m.name}${m.unit === "percent" ? " (%)" : ""}`}
                        >
                          <Input
                            type="number"
                            step="any"
                            name={`metric_${m.id}`}
                            defaultValue={
                              entries.get(m.id)?.get(selectedWeek) ??
                              (m.autoKey && autoValues.get(m.id) !== null && autoValues.get(m.id) !== undefined
                                ? Math.round((autoValues.get(m.id) as number) * 10) / 10
                                : "")
                            }
                            placeholder={m.autoKey ? "auto value prefilled" : ""}
                          />
                        </Field>
                      ))}
                    </div>
                    <Field label="Staff notes for the week">
                      <Textarea name="staffNote" defaultValue={weekRow?.staff_note ?? ""} rows={3} />
                    </Field>
                    <div className="flex gap-2">
                      <Button type="submit" variant="secondary">Save draft</Button>
                      <Button type="submit" name="submit" value="1">
                        Save &amp; submit week →
                      </Button>
                    </div>
                    <p className="text-[11px] text-ink-3">
                      Submitting takes you straight to your 5-15 report for this week.
                    </p>
                  </form>
                ) : (
                  <p className="text-sm text-ink-3">
                    You can view this scorecard but not edit it.
                  </p>
                )}
              </CardBody>
            </Card>

            {/* Notes & owner comments */}
            <Card>
              <CardHeader kicker="Coaching loop" title="Notes & comments" />
              <CardBody className="space-y-4">
                <div>
                  <div className="kicker mb-1">Staff note</div>
                  <p className="text-sm text-ink-2">
                    {weekRow?.staff_note || <span className="text-ink-3">No note for this week.</span>}
                  </p>
                </div>
                <div>
                  <div className="kicker mb-1">Owner comment</div>
                  <p className="text-sm text-ink-2">
                    {weekRow?.owner_comment || <span className="text-ink-3">No comment yet.</span>}
                  </p>
                </div>
                {canReview && (
                  <form action={ownerCommentScorecard} className="no-print space-y-2">
                    <input type="hidden" name="userId" value={selectedUser.id} />
                    <input type="hidden" name="weekStart" value={selectedWeek} />
                    <Textarea
                      name="ownerComment"
                      rows={2}
                      placeholder="Leave a comment for this staff member's week…"
                      defaultValue={weekRow?.owner_comment ?? ""}
                    />
                    <Button size="sm" variant="secondary" type="submit">
                      Save comment
                    </Button>
                  </form>
                )}
                <p className="text-xs text-ink-3">
                  Add measurables or change goals in{" "}
                  <Link href="/admin/scorecards" className="underline">
                    Admin → Scorecard Templates
                  </Link>
                  .
                </p>
              </CardBody>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
