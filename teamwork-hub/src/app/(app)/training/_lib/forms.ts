import type { ItemInput } from "@/lib/training/programs";
import type { SetPrescription } from "@/db/schema";

const s = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const n = (fd: FormData, k: string) => {
  const v = s(fd, k);
  if (v === "") return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : Number.NaN;
};

export const SET_GROUP_ROWS = 4;

/** Parse the program item editor form (up to 4 set-group rows g0..g3). Empty rows are skipped. */
export function parseItemForm(fd: FormData): ItemInput {
  const prescription: SetPrescription[] = [];
  for (let i = 0; i < SET_GROUP_ROWS; i++) {
    const sets = n(fd, `g${i}_sets`);
    if (sets === undefined) continue;
    const loadType = s(fd, `g${i}_loadType`) || "none";
    const val = n(fd, `g${i}_loadValue`);
    let load: SetPrescription["load"];
    switch (loadType) {
      case "absolute":
        load = { type: "absolute", value: val ?? Number.NaN, unit: s(fd, `g${i}_loadUnit`) === "kg" ? "kg" : "lb" };
        break;
      case "percent_max":
        load = { type: "percent_max", percent: val ?? Number.NaN };
        break;
      case "rpe":
        load = { type: "rpe", rpe: val ?? Number.NaN };
        break;
      case "rir":
        load = { type: "rir", rir: val ?? Number.NaN };
        break;
      case "bodyweight":
        load = { type: "bodyweight" };
        break;
      default:
        load = { type: "none" };
    }
    const p: SetPrescription = { sets, load };
    const reps = n(fd, `g${i}_reps`);
    if (reps !== undefined) p.reps = reps;
    if (s(fd, `g${i}_repsText`)) p.repsText = s(fd, `g${i}_repsText`);
    const d = n(fd, `g${i}_durationS`);
    if (d !== undefined) p.durationS = d;
    const dist = n(fd, `g${i}_distanceM`);
    if (dist !== undefined) p.distanceM = dist;
    if (s(fd, `g${i}_tempo`)) p.tempo = s(fd, `g${i}_tempo`);
    const rest = n(fd, `g${i}_restS`);
    if (rest !== undefined) p.restS = rest;
    if (fd.get(`g${i}_warmup`) === "on") p.isWarmup = true;
    prescription.push(p);
  }
  const progKind = s(fd, "progKind");
  return {
    exerciseId: s(fd, "exerciseId"),
    blockLabel: s(fd, "blockLabel").toUpperCase(),
    blockType: (s(fd, "blockType") || "straight") as "straight" | "superset" | "circuit",
    notes: s(fd, "notes") || null,
    prescription,
    progression:
      progKind === "linear_load"
        ? { kind: "linear_load", perWeek: n(fd, "progPerWeek") ?? Number.NaN, unit: (s(fd, "progUnit") || "lb") as "lb" | "kg" | "percent" }
        : { kind: "none" },
  };
}
