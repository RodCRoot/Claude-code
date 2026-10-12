"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { organizations } from "@/db/schema";
import { requireViewer } from "@/lib/auth/viewer";
import { safeAction, UserError, type ActionState } from "@/lib/actions";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { actor, TrainingError } from "@/lib/training/common";
import { createExercise, updateExercise, type ExerciseInput } from "@/lib/training/exercises";
import {
  addDay,
  addItem,
  addPhase,
  bulkEditScheme,
  copyDay,
  copyWeek,
  saveProgramLayout,
  type LayoutInput,
  type SchemePatch,
  createProgram,
  deleteDay,
  deleteItem,
  deletePhase,
  duplicateProgram,
  updateItem,
  updatePhase,
  updateProgramMeta,
} from "@/lib/training/programs";
import { applyTemplateToUnstarted, assignProgram, cancelAssignment, syncAssignment } from "@/lib/training/assignments";
import { confirmEstimatedMax, recordMax } from "@/lib/training/maxes";
import { setWorkoutStatus, substituteItem } from "@/lib/training/logging";
import { reviewWorkout } from "@/lib/training/review";
import { createPlanBlock, deletePlanBlock, importVbtCsv, setLeaderboardOptIn } from "@/lib/training/reports";
import { parseItemForm } from "./_lib/forms";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const numOrNull = (fd: FormData, k: string) => (str(fd, k) === "" ? null : Number(str(fd, k)));

/** Run domain logic in a transaction; domain errors become visible form errors. */
async function run<T>(fn: (tx: Tx, v: Viewer) => Promise<T>): Promise<T> {
  const v = await requireViewer();
  try {
    return await db.transaction((tx) => fn(tx, v));
  } catch (e) {
    if (e instanceof TrainingError) throw new UserError(e.message);
    throw e;
  }
}

// --- Exercises ------------------------------------------------------------------------------

function exerciseFromForm(fd: FormData): ExerciseInput {
  return {
    name: str(fd, "name"),
    category: str(fd, "category"),
    movementPattern: str(fd, "movementPattern") || null,
    equipment: str(fd, "equipment")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    trackingType: str(fd, "trackingType") as ExerciseInput["trackingType"],
    defaultUnit: str(fd, "defaultUnit") as ExerciseInput["defaultUnit"],
    isUnilateral: fd.get("isUnilateral") === "on",
    bodyweightFactor: numOrNull(fd, "bodyweightFactor"),
    videoUrl: str(fd, "videoUrl") || null,
    coachingNotes: str(fd, "coachingNotes") || null,
    substitutionIds: fd.getAll("substitutionIds").map(String).filter(Boolean),
    maxSourceExerciseId: str(fd, "maxSourceExerciseId") || null,
    active: fd.has("active") ? fd.getAll("active").includes("on") : true,
  };
}

export const createExerciseAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const ex = await run((tx, v) => createExercise(tx, v, exerciseFromForm(fd)));
  revalidatePath("/training/exercises");
  return { ok: true, message: `Added ${ex.name}.` };
});

export const updateExerciseAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const ex = await run((tx, v) => updateExercise(tx, v, str(fd, "id"), exerciseFromForm(fd)));
  revalidatePath("/training/exercises");
  return { ok: true, message: `Saved ${ex.name}.` };
});

// --- Programs -------------------------------------------------------------------------------

export const createProgramAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const p = await run((tx, v) => createProgram(tx, v, { name: str(fd, "name"), description: str(fd, "description") || null, sport: str(fd, "sport") || null, status: "draft" }));
  redirect(`/training/programs/${p.id}`);
});

export const updateProgramMetaAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const id = str(fd, "programId");
  await run((tx, v) =>
    updateProgramMeta(tx, v, id, { name: str(fd, "name"), description: str(fd, "description") || null, sport: str(fd, "sport") || null, status: str(fd, "status") as "draft" | "active" | "archived" }),
  );
  revalidatePath(`/training/programs/${id}`);
  return { ok: true, message: "Program details saved." };
});

export const duplicateProgramAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const p = await run((tx, v) => duplicateProgram(tx, v, str(fd, "programId"), str(fd, "name")));
  redirect(`/training/programs/${p.id}`);
});

export const addPhaseAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const id = str(fd, "programId");
  await run((tx, v) => addPhase(tx, v, id, { name: str(fd, "name"), goal: str(fd, "goal") || null, weeks: Number(str(fd, "weeks")) }));
  revalidatePath(`/training/programs/${id}`);
  return { ok: true, message: "Phase added." };
});

export const updatePhaseAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const id = str(fd, "programId");
  await run((tx, v) => updatePhase(tx, v, id, str(fd, "phaseId"), { name: str(fd, "name"), goal: str(fd, "goal") || null, weeks: Number(str(fd, "weeks")) }));
  revalidatePath(`/training/programs/${id}`);
  return { ok: true, message: "Phase saved." };
});

export const deletePhaseAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const id = str(fd, "programId");
  await run((tx, v) => deletePhase(tx, v, id, str(fd, "phaseId")));
  revalidatePath(`/training/programs/${id}`);
  return { ok: true, message: "Phase deleted." };
});

export const addDayAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const id = str(fd, "programId");
  await run((tx, v) => addDay(tx, v, id, { week: Number(str(fd, "week")), dayIndex: Number(str(fd, "dayIndex")), title: str(fd, "title"), phaseId: str(fd, "phaseId") || null }));
  revalidatePath(`/training/programs/${id}`);
  return { ok: true, message: "Day added." };
});

export const deleteDayAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const id = str(fd, "programId");
  await run((tx, v) => deleteDay(tx, v, id, str(fd, "dayId")));
  revalidatePath(`/training/programs/${id}`);
  return { ok: true, message: "Day deleted." };
});

export const copyWeekAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const id = str(fd, "programId");
  const from = Number(str(fd, "fromWeek"));
  const to = str(fd, "toWeeks")
    .split(/[,\s]+/)
    .flatMap((part) => {
      const m = part.match(/^(\d+)-(\d+)$/);
      if (m) return Array.from({ length: Math.max(0, Number(m[2]) - Number(m[1]) + 1) }, (_, i) => Number(m[1]) + i).slice(0, 104);
      return part ? [Number(part)] : [];
    })
    .filter((x) => Number.isInteger(x));
  if (!to.length) throw new UserError("Enter target weeks, e.g. 2-4 or 2,3,4.");
  const copied = await run((tx, v) => copyWeek(tx, v, id, from, to));
  revalidatePath(`/training/programs/${id}`);
  return { ok: true, message: `Copied week ${from} to week${copied.length > 1 ? "s" : ""} ${copied.join(", ")}.` };
});

export const addItemAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const id = str(fd, "programId");
  await run((tx, v) => addItem(tx, v, id, str(fd, "dayId"), parseItemForm(fd)));
  revalidatePath(`/training/programs/${id}`);
  return { ok: true, message: "Exercise added." };
});

export const updateItemAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const id = str(fd, "programId");
  await run((tx, v) => updateItem(tx, v, id, str(fd, "itemId"), parseItemForm(fd)));
  revalidatePath(`/training/programs/${id}`);
  return { ok: true, message: "Saved. Existing workouts are unchanged until you apply the template to unstarted workouts." };
});

export const deleteItemAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const id = str(fd, "programId");
  await run((tx, v) => deleteItem(tx, v, id, str(fd, "itemId")));
  revalidatePath(`/training/programs/${id}`);
  return { ok: true, message: "Exercise removed from template." };
});

// --- Builder: drag-and-drop layout, copy day, bulk set scheme ------------------------------------

/** Called by the builder (not a form): persists order/day/blocks for the touched days. */
export const saveProgramLayoutAction = safeAction(async (programId: string, input: LayoutInput) => {
  if (typeof programId !== "string") throw new UserError("Program not found.");
  const r = await run((tx, v) => saveProgramLayout(tx, v, programId, input));
  revalidatePath(`/training/programs/${programId}`);
  return { ok: true, message: r.changed ? `Saved order (v${r.version}).` : "No changes.", data: { version: r.version } };
});

export const copyDayAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const id = str(fd, "programId");
  const r = await run((tx, v) => copyDay(tx, v, id, str(fd, "dayId"), { week: Number(str(fd, "week")), dayIndex: Number(str(fd, "dayIndex")), title: str(fd, "title") || null }));
  revalidatePath(`/training/programs/${id}`);
  return { ok: true, message: `${r.created ? "Created" : "Appended to"} week ${str(fd, "week")} day ${str(fd, "dayIndex")} (${r.copied} exercises).` };
});

export const bulkEditSchemeAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const id = str(fd, "programId");
  const intOrUndef = (k: string) => (str(fd, k) === "" ? undefined : Number(str(fd, k)));
  const loadType = str(fd, "bulk_loadType");
  const val = Number(str(fd, "bulk_loadValue"));
  let load: SchemePatch["load"];
  switch (loadType) {
    case "absolute":
      load = { type: "absolute", value: val, unit: str(fd, "bulk_loadUnit") === "kg" ? "kg" : "lb" };
      break;
    case "percent_max":
      load = { type: "percent_max", percent: val };
      break;
    case "rpe":
      load = { type: "rpe", rpe: val };
      break;
    case "rir":
      load = { type: "rir", rir: val };
      break;
    case "bodyweight":
    case "none":
      load = { type: loadType };
      break;
    default:
      load = undefined;
  }
  const itemIds = fd.getAll("itemIds").map(String).filter(Boolean);
  const r = await run((tx, v) =>
    bulkEditScheme(tx, v, id, itemIds, {
      sets: intOrUndef("bulk_sets"),
      reps: intOrUndef("bulk_reps"),
      repsText: str(fd, "bulk_repsText") || undefined,
      load,
      restS: intOrUndef("bulk_restS"),
      tempo: str(fd, "bulk_tempo") || undefined,
      applyTo: str(fd, "bulk_applyTo") === "all" ? "all" : "working",
    }),
  );
  revalidatePath(`/training/programs/${id}`);
  return { ok: true, message: `Updated the set scheme on ${r.updated} exercise${r.updated === 1 ? "" : "s"} (v${r.version}).` };
});

// --- Assignments ----------------------------------------------------------------------------

export const assignProgramAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const target = str(fd, "target"); // "group:<id>" | "athlete:<id>"
  const [kind, targetId] = target.split(":");
  if (!targetId || (kind !== "group" && kind !== "athlete")) throw new UserError("Choose a group or athlete.");
  const res = await run((tx, v) =>
    assignProgram(tx, v, {
      programId: str(fd, "programId"),
      groupId: kind === "group" ? targetId : null,
      athleteId: kind === "athlete" ? targetId : null,
      startDate: str(fd, "startDate"),
      daysOfWeek: fd.getAll("daysOfWeek").map(Number),
    }),
  );
  revalidatePath(`/training/programs/${str(fd, "programId")}`);
  return { ok: true, message: `Assigned. ${res.created} workouts created as frozen snapshots.` };
});

export const syncAssignmentAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const n = await run((tx, v) => syncAssignment(tx, v, str(fd, "assignmentId")));
  revalidatePath(`/training/programs/${str(fd, "programId")}`);
  return { ok: true, message: n ? `${n} workouts added for new members.` : "Already up to date." };
});

export const applyTemplateAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const r = await run((tx, v) => applyTemplateToUnstarted(tx, v, str(fd, "assignmentId")));
  revalidatePath(`/training/programs/${str(fd, "programId")}`);
  return { ok: true, message: `Rebuilt ${r.created} unstarted workouts from the current version (${r.removed} replaced). Started and past workouts were not changed.` };
});

export const cancelAssignmentAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const n = await run((tx, v) => cancelAssignment(tx, v, str(fd, "assignmentId")));
  revalidatePath(`/training/programs/${str(fd, "programId")}`);
  return { ok: true, message: `Assignment cancelled. ${n} unstarted future workouts removed; history kept.` };
});

// --- Maxes ----------------------------------------------------------------------------------

export const recordMaxAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const athleteId = str(fd, "athleteId");
  const r = await run((tx, v) =>
    recordMax(tx, v, {
      athleteId,
      exerciseId: str(fd, "exerciseId"),
      value: Number(str(fd, "value")),
      unit: str(fd, "unit") as "lb" | "kg",
      kind: str(fd, "kind") === "manual" ? "manual" : "tested",
      recordedOn: str(fd, "recordedOn"),
    }),
  );
  revalidatePath(`/training/athletes/${athleteId}`);
  return { ok: true, message: `Max recorded.${r.refreshed ? ` Updated % loads on ${r.refreshed} upcoming exercise${r.refreshed > 1 ? "s" : ""}.` : ""}` };
});

export const confirmEstimateAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const method = str(fd, "method") === "brzycki_v1" ? "brzycki_v1" : "epley_v1";
  await run((tx, v) => confirmEstimatedMax(tx, v, str(fd, "setLogId"), method));
  revalidatePath(`/training/athletes/${str(fd, "athleteId")}`);
  return { ok: true, message: "Estimated max saved." };
});

// --- Workouts -------------------------------------------------------------------------------

export const reviewWorkoutAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const id = str(fd, "workoutId");
  const reviewed = str(fd, "reviewed") !== "false";
  await run((tx, v) => reviewWorkout(tx, v, id, str(fd, "feedback") || null, reviewed));
  revalidatePath(`/training/workouts/${id}`);
  revalidatePath("/training/review");
  return { ok: true, message: reviewed ? "Marked reviewed." : "Marked as not reviewed." };
});

export const substituteAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const wid = str(fd, "workoutId");
  await run((tx, v) => substituteItem(tx, v, str(fd, "itemId"), str(fd, "substituteExerciseId") || null, str(fd, "modification") || null));
  revalidatePath(`/training/workouts/${wid}`);
  revalidatePath("/training/today");
  return { ok: true, message: "Saved for this workout only." };
});

export const workoutStatusAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const wid = str(fd, "workoutId");
  const status = str(fd, "status") === "skipped" ? "skipped" : "scheduled";
  await run((tx, v) => setWorkoutStatus(tx, v, wid, status));
  revalidatePath(`/training/workouts/${wid}`);
  revalidatePath("/training/today");
  return { ok: true, message: status === "skipped" ? "Marked skipped." : "Reopened." };
});

// --- Annual plan ----------------------------------------------------------------------------

export const createPlanBlockAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const [kind, targetId] = str(fd, "target").split(":");
  await run((tx, v) =>
    createPlanBlock(tx, v, {
      name: str(fd, "name"),
      kind: str(fd, "kind") as "off_season",
      startDate: str(fd, "startDate"),
      endDate: str(fd, "endDate"),
      focus: str(fd, "focus") || null,
      groupId: kind === "group" ? targetId : null,
      athleteId: kind === "athlete" ? targetId : null,
      programId: str(fd, "programId") || null,
    }),
  );
  revalidatePath("/training/plan");
  return { ok: true, message: "Block added." };
});

export const deletePlanBlockAction = safeAction(async (_p: ActionState, fd: FormData) => {
  await run((tx, v) => deletePlanBlock(tx, v, str(fd, "blockId")));
  revalidatePath("/training/plan");
  return { ok: true, message: "Block deleted." };
});

// --- Reports / settings ---------------------------------------------------------------------

export const importVbtAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const f = fd.get("file");
  if (!(f instanceof File) || f.size === 0) throw new UserError("Choose a CSV file.");
  if (f.size > 5_000_000) throw new UserError("File too large (5 MB max).");
  const text = await f.text();
  const r = await run((tx, v) => importVbtCsv(tx, v, { name: f.name, text }));
  revalidatePath("/training/reports");
  const errs = r.errors.slice(0, 8).map((e) => `row ${e.row}: ${e.message}`).join("; ");
  return {
    ok: true,
    message: `Imported ${r.imported} readings from "${f.name}" (${r.duplicates} already imported, ${r.errors.length} rejected).${errs ? ` ${errs}${r.errors.length > 8 ? " …" : ""}` : ""}`,
  };
});

export const leaderboardOptInAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const athleteId = str(fd, "athleteId");
  const optIn = str(fd, "optIn") === "true";
  await run((tx, v) => setLeaderboardOptIn(tx, v, athleteId, optIn));
  revalidatePath(`/training/athletes/${athleteId}`);
  return { ok: true, message: optIn ? "Opted in to group leaderboards." : "Opted out of leaderboards." };
});

export const saveTrainingSettingsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const lb = Number(str(fd, "incrementLb"));
  const kg = Number(str(fd, "incrementKg"));
  if (!(lb > 0 && lb <= 25) || !(kg > 0 && kg <= 10)) throw new UserError("Increments must be positive (lb ≤ 25, kg ≤ 10).");
  await run(async (tx, v) => {
    assertCan(v, "settings.manage");
    const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, v.orgId));
    await tx
      .update(organizations)
      .set({ settings: sql`${organizations.settings} || ${JSON.stringify({ training: { incrementLb: lb, incrementKg: kg } })}::jsonb` })
      .where(eq(organizations.id, v.orgId));
    await audit(tx, actor(v), "training.settings.update", "organization", v.orgId, { before: o?.settings?.training ?? null, after: { incrementLb: lb, incrementKg: kg } });
  });
  revalidatePath("/training/settings");
  return { ok: true, message: "Saved. New increments apply to workouts instantiated or recomputed from now on." };
});
