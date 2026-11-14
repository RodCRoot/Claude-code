import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Card, CardBody, CardHeader, EmptyState, Field, Input, PageHeader, Select, Stat, Table, Td, Th, Textarea } from "@/components/ui";
import { db } from "@/db";
import { groups } from "@/db/schema";
import { requireViewer } from "@/lib/auth/viewer";
import { can, isStaff } from "@/lib/authz/policy";
import { scopedAthletes } from "@/lib/science/access";
import { athleteMetricSeries, attendanceKpi, groupKpiTable, listMetrics, listTestTypes } from "@/lib/science/kpis";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { createMetricAction, createTestTypeAction, recordTestAction, setTargetAction } from "../actions";
import { AthletePicker, FormulaTag, SourceBadge, fmtN, isYmd, pickAthlete, sp1, type SP } from "../_components/shared";
import { MetricCard } from "../_components/metric-card";

export const metadata = { title: "KPI tracker" };

export default async function KpiPage({ searchParams }: { searchParams: SP }) {
  const v = await requireViewer();
  const p = await searchParams;
  const view = sp1(p.view) === "group" && isStaff(v) ? "group" : sp1(p.view) === "setup" && can(v, "science.manage") ? "setup" : "athlete";
  const tabs = [
    { k: "athlete", label: "Athlete dashboard" },
    ...(isStaff(v) ? [{ k: "group", label: "Group dashboard" }] : []),
    ...(can(v, "science.manage") ? [{ k: "setup", label: "Metrics, tests & entry" }] : []),
  ];
  return (
    <>
      <PageHeader kicker="Sports science" title="KPI tracker" description="Vendor metrics are badged as vendor and never relabeled as Teamwork results. Values in different units are converted explicitly to each metric's unit before comparison." />
      {tabs.length > 1 ? (
        <div className="mb-4 flex flex-wrap gap-2" role="tablist">
          {tabs.map((t) => (
            <Link key={t.k} href={`/science/kpis?view=${t.k}`} role="tab" aria-selected={view === t.k} className={`min-h-10 rounded-full border px-4 py-2 text-sm font-medium ${view === t.k ? "border-brand bg-brand text-brand-ink" : "border-edge hover:bg-surface-2"}`}>
              {t.label}
            </Link>
          ))}
        </div>
      ) : null}
      {view === "athlete" ? <AthleteView p={p} /> : view === "group" ? <GroupView p={p} /> : <SetupView />}
    </>
  );
}

async function AthleteView({ p }: { p: Awaited<SP> }) {
  const v = await requireViewer();
  const today = todayLocal();
  const athletes = await scopedAthletes(db, v, "training.read");
  const athlete = pickAthlete(athletes, sp1(p.athlete));
  if (!athlete) return <EmptyState title="No athletes in your scope." />;
  const from = isYmd(sp1(p.from)) ? sp1(p.from) : addDaysYmd(today, -179);
  const to = isYmd(sp1(p.to)) ? sp1(p.to) : today;
  const series = await athleteMetricSeries(db, v, athlete.id, { from, to });
  const att = await attendanceKpi(db, v, athlete.id, addDaysYmd(today, -89), today);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <AthletePicker athletes={athletes} current={athlete.id} extra={{ from, to }} />
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="athlete" value={athlete.id} />
          <div>
            <label htmlFor="kf" className="block text-xs font-medium text-ink-3">
              From
            </label>
            <Input id="kf" type="date" name="from" defaultValue={from} />
          </div>
          <div>
            <label htmlFor="kt" className="block text-xs font-medium text-ink-3">
              To
            </label>
            <Input id="kt" type="date" name="to" defaultValue={to} max={today} />
          </div>
          <button type="submit" className="h-10 rounded-lg border border-edge px-3 text-sm font-medium hover:bg-surface-2">
            Apply
          </button>
        </form>
      </div>
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Attendance (90 days)" value={att.ratePct === null ? "—" : `${fmtN(att.ratePct, 0)}%`} hint={att.ratePct === null ? "No attended/no-show bookings yet" : `${att.attended} attended · ${att.noShow} no-show`} />
      </div>
      <p className="mb-4 text-xs text-ink-3">
        Attendance <FormulaTag k="attendance_rate_v1" /> from bookings with status “attended” vs “no-show”. Session values use the test’s trial rule <FormulaTag k="trial_selection_v1" />; change band <FormulaTag k="swc_02sd_v1" />.
      </p>
      {series.length === 0 ? <EmptyState title={`No test results for ${athlete.name} in ${from} – ${to}.`} /> : null}
      <div className="grid gap-6 lg:grid-cols-2">
        {series.map((s) => (
          <MetricCard key={s.metric.id} s={s} from={from} to={to} />
        ))}
      </div>
    </>
  );
}

async function GroupView({ p }: { p: Awaited<SP> }) {
  const v = await requireViewer();
  const metrics = await listMetrics(db, v);
  const gs = await db.select({ id: groups.id, name: groups.name }).from(groups).where(eq(groups.orgId, v.orgId)).orderBy(asc(groups.name));
  const metric = metrics.find((m) => m.id === sp1(p.metric)) ?? metrics[0];
  if (!metric) return <EmptyState title="No metrics defined yet." />;
  const leaderboard = sp1(p.leaderboard) === "on";
  const res = await groupKpiTable(db, v, { metricId: metric.id, groupId: sp1(p.group) || null, leaderboard });
  const d = metric.precision;
  return (
    <>
      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <input type="hidden" name="view" value="group" />
        <div>
          <label htmlFor="gm" className="block text-xs font-medium text-ink-3">
            Metric
          </label>
          <Select id="gm" name="metric" defaultValue={metric.id}>
            {metrics.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.unit})
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor="gg" className="block text-xs font-medium text-ink-3">
            Group
          </label>
          <Select id="gg" name="group" defaultValue={sp1(p.group)}>
            <option value="">All my athletes</option>
            {gs.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </div>
        <label className="flex h-10 items-center gap-2 text-sm">
          <input type="checkbox" name="leaderboard" defaultChecked={leaderboard} /> Rank as leaderboard (opt-in)
        </label>
        <button type="submit" className="h-10 rounded-lg border border-edge px-3 text-sm font-medium hover:bg-surface-2">
          Apply
        </button>
      </form>
      {leaderboard && metric.higherIsBetter === null ? <p className="mb-2 text-sm text-warn">This metric has no direction, so it can’t be ranked.</p> : null}
      <Card>
        <CardHeader title={`${metric.name} (${metric.unit})`} kicker={res?.leaderboard ? "Leaderboard · only athletes you coach" : "Group table · only athletes you coach"} action={<SourceBadge source={metric.definedBy} />} />
        <CardBody>
          <Table caption={`${metric.name} group table`}>
            <thead>
              <tr>
                {res?.leaderboard ? <Th>#</Th> : null}
                <Th>Athlete</Th>
                <Th align="right">Latest ({metric.unit})</Th>
                <Th>Date</Th>
                <Th align="right">Baseline</Th>
                <Th align="right">Target</Th>
                <Th align="right">Change %</Th>
              </tr>
            </thead>
            <tbody>
              {res?.rows.map((r, i) => (
                <tr key={r.athlete.id}>
                  {res.leaderboard ? <Td>{r.series?.latest ? i + 1 : "—"}</Td> : null}
                  <Td>
                    <Link href={`/science/kpis?athlete=${r.athlete.id}`} className="font-medium hover:underline">
                      {r.athlete.name}
                    </Link>
                  </Td>
                  <Td align="right">{fmtN(r.series?.latest?.value, d)}</Td>
                  <Td className="text-xs text-ink-3">{r.series?.latest?.date ?? "no result"}</Td>
                  <Td align="right">{fmtN(r.series?.baseline?.value, d)}</Td>
                  <Td align="right">{fmtN(r.series?.target?.value, d)}</Td>
                  <Td align="right">{fmtN(r.series?.changePct, 1)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardBody>
      </Card>
    </>
  );
}

async function SetupView() {
  const v = await requireViewer();
  const [metrics, types, athletes] = await Promise.all([listMetrics(db, v), listTestTypes(db, v), scopedAthletes(db, v, "training.write")]);
  const gs = await db.select({ id: groups.id, name: groups.name }).from(groups).where(eq(groups.orgId, v.orgId)).orderBy(asc(groups.name));
  const today = todayLocal();
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader title="Record a test session" kicker="Manual entry · one session, up to 3 trials per metric" />
        <CardBody>
          {athletes.length === 0 || types.length === 0 || metrics.length === 0 ? (
            <p className="text-sm text-ink-3">You need at least one athlete in your scope, one test type, and one metric.</p>
          ) : (
            <ActionForm action={recordTestAction} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Athlete" htmlFor="rt-a" required>
                  <Select id="rt-a" name="athleteId" required>
                    {athletes.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Test" htmlFor="rt-t" required>
                  <Select id="rt-t" name="testTypeId" required>
                    {types.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.trialSelection})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Date" htmlFor="rt-d" required>
                  <Input id="rt-d" type="date" name="date" defaultValue={today} max={today} required />
                </Field>
                <Field label="Time (facility)" htmlFor="rt-tm">
                  <Input id="rt-tm" type="time" name="time" defaultValue="16:00" />
                </Field>
              </div>
              {[0, 1, 2].map((row) => (
                <fieldset key={row} className="grid gap-2 rounded-lg border border-edge p-3 sm:grid-cols-6">
                  <legend className="px-1 text-xs font-semibold text-ink-3">Metric {row + 1}{row ? " (optional)" : ""}</legend>
                  <Field label="Metric" htmlFor={`rt-m${row}`} className="sm:col-span-2">
                    <Select id={`rt-m${row}`} name={`metric_${row}`} defaultValue={row === 0 ? metrics[0].id : ""}>
                      {row ? <option value="">—</option> : null}
                      {metrics.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} [{m.unit}]
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Unit entered" htmlFor={`rt-u${row}`} hint="e.g. cm or in; s; m">
                    <Input id={`rt-u${row}`} name={`unit_${row}`} placeholder="metric unit" />
                  </Field>
                  {[1, 2, 3].map((t) => (
                    <Field key={t} label={`Trial ${t}`} htmlFor={`rt-v${row}${t}`}>
                      <Input id={`rt-v${row}${t}`} name={`v_${row}_${t}`} type="number" step="any" inputMode="decimal" />
                    </Field>
                  ))}
                </fieldset>
              ))}
              <p className="text-xs text-ink-3">A blank unit means the metric&apos;s own unit. Other units (e.g. in for a cm metric) are kept as entered and converted explicitly in views. Blank trials are not stored (never saved as 0).</p>
              <Field label="Notes" htmlFor="rt-n">
                <Textarea id="rt-n" name="notes" maxLength={500} />
              </Field>
              <SubmitButton>Save session</SubmitButton>
            </ActionForm>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="KPI target / baseline" />
        <CardBody>
          <ActionForm action={setTargetAction} className="grid gap-3 sm:grid-cols-2">
            <Field label="Metric" htmlFor="kt-m" required>
              <Select id="kt-m" name="metricDefinitionId" required>
                {metrics.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.unit})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="For" htmlFor="kt-f" required>
              <Select id="kt-f" name="target" required>
                <optgroup label="Groups">
                  {gs.map((g) => (
                    <option key={g.id} value={`group:${g.id}`}>
                      {g.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Athletes">
                  {athletes.map((a) => (
                    <option key={a.id} value={`athlete:${a.id}`}>
                      {a.name}
                    </option>
                  ))}
                </optgroup>
              </Select>
            </Field>
            <Field label="Target value (metric unit)" htmlFor="kt-t" required>
              <Input id="kt-t" name="targetValue" type="number" step="any" required />
            </Field>
            <Field label="Goal date" htmlFor="kt-g">
              <Input id="kt-g" name="goalDate" type="date" />
            </Field>
            <Field label="Baseline value" htmlFor="kt-b" hint="Blank = first session">
              <Input id="kt-b" name="baselineValue" type="number" step="any" />
            </Field>
            <Field label="Baseline date" htmlFor="kt-bd">
              <Input id="kt-bd" name="baselineDate" type="date" />
            </Field>
            <Field label="Trial selection" htmlFor="kt-s">
              <Select id="kt-s" name="trialSelection" defaultValue="best">
                <option value="best">Best trial</option>
                <option value="mean">Mean of trials</option>
                <option value="latest">Latest trial</option>
              </Select>
            </Field>
            <div className="self-end">
              <SubmitButton>Save target</SubmitButton>
            </div>
          </ActionForm>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="New metric definition" />
        <CardBody>
          <ActionForm action={createMetricAction} resetOnSuccess className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="md-n" required>
              <Input id="md-n" name="name" required />
            </Field>
            <Field label="Key" htmlFor="md-k" required hint="lowercase_with_underscores">
              <Input id="md-k" name="key" required pattern="[a-z][a-z0-9_]+" />
            </Field>
            <Field label="Unit" htmlFor="md-u" required>
              <Input id="md-u" name="unit" required placeholder="s, cm, m, W, %" />
            </Field>
            <Field label="Direction" htmlFor="md-h">
              <Select id="md-h" name="higherIsBetter" defaultValue="true">
                <option value="true">Higher is better</option>
                <option value="false">Lower is better</option>
                <option value="">No direction</option>
              </Select>
            </Field>
            <Field label="Category" htmlFor="md-c">
              <Select id="md-c" name="category" defaultValue="other">
                {["sprint", "jump", "strength", "force_plate", "anthropometric", "other"].map((c) => (
                  <option key={c} value={c}>
                    {c.replace("_", " ")}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Defined by" htmlFor="md-d">
              <Select id="md-d" name="definedBy" defaultValue="teamwork_manual">
                <option value="teamwork_manual">Teamwork (manual test)</option>
                <option value="teamwork_derived">Teamwork-derived</option>
                <option value="hawkin">Hawkin (vendor)</option>
                <option value="teambuildr">TeamBuildr (vendor)</option>
                <option value="other_vendor">Other vendor</option>
              </Select>
            </Field>
            <Field label="Decimals" htmlFor="md-p">
              <Input id="md-p" name="precision" type="number" min={0} max={4} defaultValue={2} />
            </Field>
            <Field label="Protocol / description" htmlFor="md-desc">
              <Input id="md-desc" name="description" />
            </Field>
            <div className="sm:col-span-2">
              <SubmitButton>Create metric</SubmitButton>
            </div>
          </ActionForm>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="New test type" />
        <CardBody>
          <ActionForm action={createTestTypeAction} resetOnSuccess className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="tt-n" required>
              <Input id="tt-n" name="name" required />
            </Field>
            <Field label="Key" htmlFor="tt-k" required>
              <Input id="tt-k" name="key" required pattern="[a-z][a-z0-9_]+" />
            </Field>
            <Field label="Vendor" htmlFor="tt-v">
              <Select id="tt-v" name="vendor" defaultValue="teamwork">
                <option value="teamwork">Teamwork</option>
                <option value="hawkin">Hawkin</option>
                <option value="teambuildr">TeamBuildr</option>
                <option value="other">Other</option>
              </Select>
            </Field>
            <Field label="Trial selection rule" htmlFor="tt-s">
              <Select id="tt-s" name="trialSelection" defaultValue="best">
                <option value="best">Best</option>
                <option value="mean">Mean</option>
                <option value="latest">Latest</option>
              </Select>
            </Field>
            <Field label="Protocol" htmlFor="tt-p" className="sm:col-span-2">
              <Textarea id="tt-p" name="protocol" maxLength={1000} />
            </Field>
            <div className="sm:col-span-2">
              <SubmitButton>Create test type</SubmitButton>
            </div>
          </ActionForm>
          <ul className="mt-4 text-sm">
            {types.map((t) => (
              <li key={t.id} className="border-b border-edge/60 py-1">
                {t.name} · {t.vendor} · rule: {t.trialSelection}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
