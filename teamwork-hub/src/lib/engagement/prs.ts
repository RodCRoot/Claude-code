/**
 * Personal-record detection from max history (pure). A PR is a max that beats every earlier max
 * for the same exercise measured the same way. The first max of each kind is the starting point,
 * not a PR. Tested/manual/imported maxes ("measured") and estimated maxes are never compared with
 * each other, and units are only compared when they convert exactly (lb and kg).
 */
import { convertUnit, isNum, unitFamily } from "@/lib/science/formulas";

export type MaxRow = { id: string; exerciseId: string; value: number; unit: string; kind: string; recordedOn: string; createdAt?: Date | string | null };
export type MaxBasis = "measured" | "estimated";
export const maxBasisOf = (kind: string): MaxBasis => (kind === "estimated" ? "estimated" : "measured");

export type PrEvent = { maxId: string; exerciseId: string; value: number; unit: string; recordedOn: string; basis: MaxBasis; previous: number; previousUnit: string };

const stamp = (v: Date | string | null | undefined) => (v instanceof Date ? v.toISOString() : String(v ?? ""));

export function detectPrs(rows: readonly MaxRow[]): PrEvent[] {
  const sorted = [...rows]
    .filter((r) => unitFamily(r.unit) === "mass" && isNum(r.value))
    .sort((a, b) => a.recordedOn.localeCompare(b.recordedOn) || stamp(a.createdAt).localeCompare(stamp(b.createdAt)) || a.id.localeCompare(b.id));
  const best = new Map<string, { value: number; unit: string }>();
  const out: PrEvent[] = [];
  for (const r of sorted) {
    const basis = maxBasisOf(r.kind);
    const key = `${r.exerciseId}:${basis}`;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, { value: r.value, unit: r.unit });
      continue;
    }
    const inPrevUnit = convertUnit(r.value, r.unit, prev.unit);
    if (isNum(inPrevUnit) && inPrevUnit > prev.value) {
      out.push({ maxId: r.id, exerciseId: r.exerciseId, value: r.value, unit: r.unit, recordedOn: r.recordedOn, basis, previous: prev.value, previousUnit: prev.unit });
      best.set(key, { value: r.value, unit: r.unit });
    }
  }
  return out;
}
