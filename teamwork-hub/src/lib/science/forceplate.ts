import { and, desc, eq } from "drizzle-orm";
import Papa from "papaparse";
import type { Tx } from "@/db";
import { rawSignals, storedObjects, testSessions, testTypes, trials } from "@/db/schema";
import { AuthzError, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { objectStore } from "@/lib/storage";
import { asymmetryPct, isNum } from "./formulas";
import { athleteMetricSeries } from "./kpis";

/** Force-plate dashboard: force_plate-category metric series (vendor + Teamwork-derived) + raw signal index. */
export async function forcePlateDashboard(tx: Tx, v: Viewer, athleteId: string, opts: { from?: string; to?: string } = {}) {
  await requireOnAthlete(tx, v, athleteId, "training.read");
  const series = await athleteMetricSeries(tx, v, athleteId, { ...opts, category: "force_plate" });
  const signals = await tx
    .select({ id: rawSignals.id, trialId: rawSignals.trialId, trialNumber: trials.trialNumber, testedAt: testSessions.testedAt, testType: testTypes.name, sampleRateHz: rawSignals.sampleRateHz, channels: rawSignals.channels, sampleCount: rawSignals.sampleCount, filename: storedObjects.filename })
    .from(rawSignals)
    .innerJoin(trials, eq(trials.id, rawSignals.trialId))
    .innerJoin(testSessions, eq(testSessions.id, trials.testSessionId))
    .innerJoin(testTypes, eq(testTypes.id, testSessions.testTypeId))
    .innerJoin(storedObjects, eq(storedObjects.id, rawSignals.objectId))
    .where(and(eq(rawSignals.orgId, v.orgId), eq(testSessions.athleteId, athleteId)))
    .orderBy(desc(testSessions.testedAt));
  return { series, signals };
}

export type ForceTrace = {
  signalId: string;
  points: { t: number; left: number | null; right: number | null }[];
  samples: number;
  durationS: number | null;
  peakLeftN: number | null;
  peakRightN: number | null;
  peakAsymmetryPct: number | null;
  units: { time: string; force: string };
  downsampledTo: number;
};

/** Parse a stored force-time CSV (time_s, force_left_N, force_right_N). Pure — exported for tests. */
export function parseForceCsv(text: string, maxPoints = 600): Omit<ForceTrace, "signalId"> {
  const res = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
  const fields = res.meta.fields ?? [];
  for (const need of ["time_s", "force_left_N", "force_right_N"]) if (!fields.includes(need)) throw new Error(`Raw signal is missing column ${need}`);
  const num = (s: string | undefined) => {
    if (s === undefined || s.trim() === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const all = res.data.map((r) => ({ t: num(r.time_s), left: num(r.force_left_N), right: num(r.force_right_N) })).filter((p): p is { t: number; left: number | null; right: number | null } => isNum(p.t));
  const peak = (k: "left" | "right") => {
    const xs = all.map((p) => p[k]).filter(isNum);
    return xs.length ? Math.max(...xs) : null;
  };
  const step = Math.max(1, Math.ceil(all.length / maxPoints));
  const points = all.filter((_, i) => i % step === 0);
  const pl = peak("left");
  const pr = peak("right");
  return {
    points,
    samples: all.length,
    durationS: all.length > 1 ? all.at(-1)!.t - all[0].t : null,
    peakLeftN: pl,
    peakRightN: pr,
    peakAsymmetryPct: asymmetryPct(pl, pr),
    units: { time: "s", force: "N" },
    downsampledTo: points.length,
  };
}

/** Read a raw signal through the storage adapter (server-side), after an athlete-scope check. */
export async function readForceTrace(tx: Tx, v: Viewer, signalId: string): Promise<ForceTrace> {
  const [row] = await tx
    .select({ sig: rawSignals, athleteId: testSessions.athleteId, key: storedObjects.storageKey })
    .from(rawSignals)
    .innerJoin(trials, eq(trials.id, rawSignals.trialId))
    .innerJoin(testSessions, eq(testSessions.id, trials.testSessionId))
    .innerJoin(storedObjects, eq(storedObjects.id, rawSignals.objectId))
    .where(and(eq(rawSignals.id, signalId), eq(rawSignals.orgId, v.orgId)));
  if (!row) throw new AuthzError();
  await requireOnAthlete(tx, v, row.athleteId, "training.read");
  const bytes = await objectStore().get(row.key);
  return { signalId, ...parseForceCsv(new TextDecoder().decode(bytes)) };
}
