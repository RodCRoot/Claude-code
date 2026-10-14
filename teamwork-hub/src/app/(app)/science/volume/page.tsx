import { Card, CardBody, CardHeader, EmptyState, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { scopedAthletes } from "@/lib/science/access";
import { FORMULAS, ZONES } from "@/lib/science/formulas";
import { volumeReport } from "@/lib/science/volume";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { FormulaTag, isYmd, sp1, type SP } from "../_components/shared";

export const metadata = { title: "Volume tracker" };

const ZONE_LABEL: Record<string, string> = { "<60": "<60%", "60-70": "60–70%", "70-80": "70–80%", "80-90": "80–90%", ">=90": "≥90%", no_max: "No max", no_load: "No load" };

export default async function VolumePage({ searchParams }: { searchParams: SP }) {
  const v = await requireViewer();
  const p = await searchParams;
  const today = todayLocal();
  const athletes = await scopedAthletes(db, v, "training.read", { includeInactive: true });
  const from = isYmd(sp1(p.from)) ? sp1(p.from) : addDaysYmd(today, -27);
  const to = isYmd(sp1(p.to)) ? sp1(p.to) : today;
  const groupBy = (["exercise", "category", "movement_pattern", "athlete", "date"] as const).find((g) => g === sp1(p.groupBy)) ?? "exercise";
  const unit = sp1(p.unit) === "kg" ? "kg" : "lb";
  const includeWarmups = sp1(p.warmups) === "on";
  const athleteParam = sp1(p.athlete);
  const athleteIds = athleteParam && athletes.some((a) => a.id === athleteParam) ? [athleteParam] : undefined;
  const res = await volumeReport(db, v, { athleteIds, from, to, groupBy, includeWarmups, displayUnit: unit });
  const tot = res.buckets.reduce(
    (a, b) => ({ t: a.t + b.tonnage, r: a.r + b.reps, s: a.s + b.sets, ml: a.ml + b.excludedMissingLoad, bw: a.bw + b.excludedBodyweightNoMass, wu: a.wu + b.excludedWarmup }),
    { t: 0, r: 0, s: 0, ml: 0, bw: 0, wu: 0 },
  );
  return (
    <>
      <PageHeader kicker="Sports science" title="Volume tracker" description={`${FORMULAS.tonnage_v1.definition}`} />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="va" className="block text-xs font-medium text-ink-3">
            Athlete
          </label>
          <Select id="va" name="athlete" defaultValue={athleteParam}>
            <option value="">All in my scope</option>
            {athletes.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor="vf" className="block text-xs font-medium text-ink-3">
            From
          </label>
          <Input id="vf" type="date" name="from" defaultValue={from} />
        </div>
        <div>
          <label htmlFor="vt" className="block text-xs font-medium text-ink-3">
            To
          </label>
          <Input id="vt" type="date" name="to" defaultValue={to} />
        </div>
        <div>
          <label htmlFor="vg" className="block text-xs font-medium text-ink-3">
            Group by
          </label>
          <Select id="vg" name="groupBy" defaultValue={groupBy}>
            <option value="exercise">Exercise</option>
            <option value="category">Category</option>
            <option value="movement_pattern">Movement pattern</option>
            <option value="athlete">Athlete</option>
            <option value="date">Date</option>
          </Select>
        </div>
        <div>
          <label htmlFor="vu" className="block text-xs font-medium text-ink-3">
            Display unit
          </label>
          <Select id="vu" name="unit" defaultValue={unit}>
            <option value="lb">lb</option>
            <option value="kg">kg</option>
          </Select>
        </div>
        <label className="flex h-10 items-center gap-2 text-sm">
          <input type="checkbox" name="warmups" defaultChecked={includeWarmups} /> Include warm-up sets
        </label>
        <button type="submit" className="h-10 rounded-lg border border-edge px-3 text-sm font-medium hover:bg-surface-2">
          Apply
        </button>
      </form>
      {!res.hasAnySetLogs ? (
        <EmptyState title="No logged sets yet">Volume comes from logged workout sets (Training module). Once athletes log sets, tonnage, reps and intensity zones appear here.</EmptyState>
      ) : res.buckets.length === 0 ? (
        <EmptyState title={`No logged sets for this selection (${from} – ${to}).`} />
      ) : (
        <div className="space-y-6">
          <p className="text-sm text-ink-2">
            {from} – {to}: <strong>{Math.round(tot.t).toLocaleString()} {unit}</strong> tonnage over {tot.s} counted sets, {tot.r} reps. Excluded from tonnage: {tot.ml} set(s) missing load (reps still counted), {tot.bw} bodyweight set(s) without known body mass (reps counted), {tot.wu} warm-up set(s) {includeWarmups ? "(included by toggle)" : "(excluded by default)"}.{" "}
            <FormulaTag k="tonnage_v1" />
          </p>
          <Card>
            <CardHeader title={`Tonnage by ${groupBy.replace("_", " ")}`} kicker={`Unit: ${unit} × reps · converted explicitly (1 lb = 0.45359237 kg)`} />
            <CardBody>
              <Table caption="Volume buckets">
                <thead>
                  <tr>
                    <Th>{groupBy.replace("_", " ")}</Th>
                    <Th align="right">Tonnage ({unit})</Th>
                    <Th align="right">Left / Right ({unit})</Th>
                    <Th align="right">Reps</Th>
                    <Th align="right">Sets</Th>
                    <Th align="right">Excl. (no load / BW no mass)</Th>
                    <Th align="right">Time (s) / Dist (m)</Th>
                  </tr>
                </thead>
                <tbody>
                  {res.buckets.map((b) => {
                    const max = res.buckets[0].tonnage || 1;
                    return (
                      <tr key={b.key}>
                        <Td>
                          <div className="font-medium">{b.label}</div>
                          <div aria-hidden className="mt-1 h-1.5 max-w-48 rounded-full bg-surface-2">
                            <div className="h-1.5 rounded-full bg-[#2a78d6] dark:bg-[#3987e5]" style={{ width: `${(b.tonnage / max) * 100}%` }} />
                          </div>
                        </Td>
                        <Td align="right">{b.setsInTonnage ? Math.round(b.tonnage).toLocaleString() : "—"}</Td>
                        <Td align="right">{b.tonnageLeft || b.tonnageRight ? `L ${Math.round(b.tonnageLeft)} / R ${Math.round(b.tonnageRight)}` : "—"}</Td>
                        <Td align="right">{b.reps}</Td>
                        <Td align="right">{b.sets}</Td>
                        <Td align="right">
                          {b.excludedMissingLoad} / {b.excludedBodyweightNoMass}
                        </Td>
                        <Td align="right">{b.durationS || b.distanceM ? `${Math.round(b.durationS * 10) / 10} / ${Math.round(b.distanceM)}` : "—"}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              <p className="mt-2 text-xs text-ink-3">Unilateral sets logged per side are summed per side (L/R) and both sides are included in the total. Duration and distance work is kept separate from tonnage.</p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Intensity zones" kicker="Sets (reps) by % of the dated max" />
            <CardBody>
              <p className="mb-2 text-xs text-ink-3">
                {FORMULAS.intensity_zone_v1.definition} <FormulaTag k="intensity_zone_v1" />
              </p>
              <Table caption="Intensity zone distribution">
                <thead>
                  <tr>
                    <Th>{groupBy.replace("_", " ")}</Th>
                    {ZONES.map((z) => (
                      <Th key={z} align="right">
                        {ZONE_LABEL[z]}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {res.buckets.map((b) => (
                    <tr key={b.key}>
                      <Td>{b.label}</Td>
                      {ZONES.map((z) => (
                        <Td key={z} align="right">
                          {b.zones[z].sets ? `${b.zones[z].sets} (${b.zones[z].reps})` : "—"}
                        </Td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </CardBody>
          </Card>
        </div>
      )}
    </>
  );
}
