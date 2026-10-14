import { ChartFigure } from "@/components/charts/chart-figure";
import { TrendChart } from "@/components/charts/trend-chart";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Badge, Callout, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { can, canOnAthlete } from "@/lib/authz/policy";
import { scopedAthletes } from "@/lib/science/access";
import { wearableDashboard } from "@/lib/science/wearables";
import { WEARABLE_METRICS, WEARABLE_PROVIDERS } from "@/lib/science/wearables/provider";
import { addDaysYmd, fmt, todayLocal } from "@/lib/time";
import { importWearablesAction, manualWearableAction } from "../actions";
import { AthletePicker, HealthOnly, fmtN, pickAthlete, sp1, type SP } from "../_components/shared";

export const metadata = { title: "Wearables" };

export default async function WearablesPage({ searchParams }: { searchParams: SP }) {
  const v = await requireViewer();
  const p = await searchParams;
  const today = todayLocal();
  const athletes = await scopedAthletes(db, v, "health.read");
  if (!athletes.length) {
    return (
      <>
        <PageHeader kicker="Sports science" title="Wearables" />
        <HealthOnly />
      </>
    );
  }
  const athlete = pickAthlete(athletes, sp1(p.athlete))!;
  const from = addDaysYmd(today, -27);
  const dash = await wearableDashboard(db, v, athlete.id, from, today);
  const canWrite = await canOnAthlete(db, v, athlete.id, "health.write");
  return (
    <>
      <PageHeader kicker="Sports science" title="Wearables" description="Normalized observations from CSV exports or manual entry. Missing days are shown as missing — never carried forward or set to 0." />
      <Callout className="mb-4" title="No live device connections">
        Teamwork Hub is a web app, so it can’t read Apple Health / HealthKit or Bluetooth devices. Vendor cloud APIs (WHOOP, Oura, Garmin, Polar, Fitbit) need OAuth credentials and athlete consent; none are configured. Import a CSV export instead.
      </Callout>
      <div className="mb-4">
        <AthletePicker athletes={athletes} current={athlete.id} />
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        {dash.metrics.map((m) => (
          <Card key={m.key}>
            <CardHeader title={m.label} kicker={`${m.unit} · ${from} → ${today}`} />
            <CardBody>
              <ChartFigure
                title={`${m.label} · ${athlete.name}`}
                unit={m.unit}
                range={`${from} – ${today}`}
                summary={`${m.daysWithValue} of ${m.days.length} days with a value (mean ${fmtN(m.mean, 1)} ${m.unit}); ${m.daysMissing} reported missing by the device; ${m.daysNoData} with no data at all. Sources: ${m.providers.join(", ") || "none"}.`}
                columns={["Date", "Value", "Quality", "Provider"]}
                rows={m.days.map((d) => [d.date, d.value, d.quality.replace("_", " "), d.provider])}
              >
                <TrendChart data={m.days.map((d) => ({ x: d.date, value: d.value }))} series={[{ key: "value", label: m.label }]} unit={m.unit} digits={1} height={180} />
              </ChartFigure>
            </CardBody>
          </Card>
        ))}
      </div>
      <Card className="mt-6">
        <CardHeader title="Provenance" kicker="Import batches feeding this view" />
        <CardBody>
          {dash.batches.length ? (
            <Table caption="Import batches">
              <thead>
                <tr>
                  <Th>File</Th>
                  <Th>Coverage</Th>
                  <Th>Imported</Th>
                  <Th>Notes</Th>
                </tr>
              </thead>
              <tbody>
                {dash.batches.map((b) => (
                  <tr key={b.id}>
                    <Td>{b.originalFilename ?? b.id.slice(0, 8)}</Td>
                    <Td>
                      {b.coverageStart} → {b.coverageEnd}
                    </Td>
                    <Td>{fmt(b.committedAt ?? b.createdAt)}</Td>
                    <Td className="text-xs text-ink-3">{b.limitations ?? JSON.stringify(b.stats)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="text-sm text-ink-3">No imported data for this athlete in the window (manual entries only, or none).</p>
          )}
        </CardBody>
      </Card>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {can(v, "science.manage") ? (
          <Card>
            <CardHeader title="Import CSV" kicker="Column mapping" />
            <CardBody>
              <ActionForm action={importWearablesAction} className="grid gap-3 sm:grid-cols-2">
                <Field label="CSV file" htmlFor="wi-f" required className="sm:col-span-2" hint="Max 2 MB / 5,000 rows. One row per athlete, date and metric.">
                  <Input id="wi-f" name="file" type="file" accept=".csv,text/csv" required />
                </Field>
                <Field label="Provider label" htmlFor="wi-p" hint="Stored on every row for provenance">
                  <Input id="wi-p" name="provider" defaultValue="csv" />
                </Field>
                <Field label="Match athletes by" htmlFor="wi-m">
                  <Select id="wi-m" name="athleteMatch" defaultValue="email">
                    <option value="email">Email (unique match only)</option>
                    <option value="external_id">External id (registry)</option>
                  </Select>
                </Field>
                {[
                  ["col_date", "Date column", "date"],
                  ["col_athlete", "Athlete column", "athlete_email"],
                  ["col_metric", "Metric column", "metric"],
                  ["col_value", "Value column", "value"],
                  ["col_unit", "Unit column", "unit"],
                ].map(([n, l, d]) => (
                  <Field key={n} label={l} htmlFor={`wi-${n}`}>
                    <Input id={`wi-${n}`} name={n} defaultValue={d} required />
                  </Field>
                ))}
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <input type="checkbox" name="dryRun" defaultChecked /> Preview only (validate without saving)
                </label>
                <p className="text-xs text-ink-3 sm:col-span-2">
                  Metric values: {Object.entries(WEARABLE_METRICS).map(([k, m]) => `${k} (${m.unit})`).join(", ")}. Accepted unit aliases are converted explicitly (e.g. sleep in min → h). Blank values are stored as “missing”.
                </p>
                <div className="sm:col-span-2">
                  <SubmitButton>Run import</SubmitButton>
                </div>
              </ActionForm>
            </CardBody>
          </Card>
        ) : null}
        {canWrite ? (
          <Card>
            <CardHeader title={`Manual entry · ${athlete.name}`} />
            <CardBody>
              <ActionForm action={manualWearableAction} resetOnSuccess className="grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="athleteId" value={athlete.id} />
                <Field label="Metric" htmlFor="wm-k">
                  <Select id="wm-k" name="metricKey">
                    {Object.entries(WEARABLE_METRICS).map(([k, m]) => (
                      <option key={k} value={k}>
                        {m.label} ({m.unit})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Date" htmlFor="wm-d">
                  <Input id="wm-d" type="date" name="observedOn" defaultValue={today} max={today} required />
                </Field>
                <Field label="Value (canonical unit)" htmlFor="wm-v">
                  <Input id="wm-v" name="value" type="number" step="any" min={0} required />
                </Field>
                <Field label="Quality" htmlFor="wm-q">
                  <Select id="wm-q" name="quality" defaultValue="measured">
                    <option value="measured">Measured</option>
                    <option value="device_estimate">Device estimate</option>
                  </Select>
                </Field>
                <div className="sm:col-span-2">
                  <SubmitButton>Save</SubmitButton>
                </div>
              </ActionForm>
            </CardBody>
          </Card>
        ) : null}
        <Card>
          <CardHeader title="Provider adapters" kicker="src/lib/science/wearables/provider.ts" />
          <CardBody>
            <ul className="space-y-2 text-sm">
              {WEARABLE_PROVIDERS.map((pr) => (
                <li key={pr.key} className="flex flex-wrap items-start justify-between gap-2 border-b border-edge/60 pb-2">
                  <div>
                    <div className="font-medium">{pr.name}</div>
                    <div className="text-xs text-ink-3">{pr.notes}</div>
                  </div>
                  <Badge variant={pr.status() === "file_import" ? "green" : "neutral"}>{pr.status() === "file_import" ? "available" : "not configured"}</Badge>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
