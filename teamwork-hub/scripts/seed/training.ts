import { randomUUID } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import {
  activitySessions,
  exercises,
  maxes,
  people,
  athletes,
  programAssignments,
  programDays,
  programItems,
  programPhases,
  programs,
  setLogs,
  trainingPlanBlocks,
  workoutItems,
  workouts,
  type ProgressionRule,
  type SetPrescription,
  type TrackingType,
} from "../../src/db/schema";
import { addDaysYmd, isoWeekday, localToUtc } from "../../src/lib/time";
import { instantiateAssignment } from "../../src/lib/training/assignments";
import { expandSets, type ResolvedSetGroup } from "../../src/lib/training/formulas";
import type { SeedCtx } from "./context";

/** Deterministic pseudo-random in [0,1) from a string (stable demo data across runs). */
function rand(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

type ExSeed = {
  name: string;
  category: string;
  pattern?: string;
  equipment?: string[];
  tracking?: TrackingType;
  unit?: "lb" | "kg" | "s" | "m" | "yd" | "reps";
  uni?: boolean;
  bw?: number;
  notes?: string;
  maxFrom?: string;
  subs?: string[];
};

const EXERCISES: ExSeed[] = [
  { name: "Back Squat", category: "Lower body", pattern: "squat", equipment: ["barbell", "rack"], notes: "Brace before descent; knees track over toes; drive up through mid-foot.", subs: ["Front Squat", "Goblet Squat"] },
  { name: "Front Squat", category: "Lower body", pattern: "squat", equipment: ["barbell", "rack"], maxFrom: "Back Squat", notes: "Elbows high; % loads use the Back Squat max.", subs: ["Goblet Squat"] },
  { name: "Goblet Squat", category: "Lower body", pattern: "squat", equipment: ["dumbbell"], notes: "Hold the bell at the chest; sit between the hips." },
  { name: "Trap Bar Deadlift", category: "Lower body", pattern: "hinge", equipment: ["trap bar"], notes: "Push the floor away; hips and shoulders rise together.", subs: ["Romanian Deadlift"] },
  { name: "Romanian Deadlift", category: "Lower body", pattern: "hinge", equipment: ["barbell"], notes: "Soft knees, hips back, bar close to legs." },
  { name: "Rear-Foot Elevated Split Squat", category: "Lower body", pattern: "lunge", equipment: ["dumbbell", "bench"], uni: true, subs: ["Walking Lunge", "Step-Up"] },
  { name: "Walking Lunge", category: "Lower body", pattern: "lunge", equipment: ["dumbbell"], uni: true },
  { name: "Single-Leg RDL", category: "Lower body", pattern: "hinge", equipment: ["dumbbell"], uni: true },
  { name: "Step-Up", category: "Lower body", pattern: "lunge", equipment: ["dumbbell", "box"], uni: true },
  { name: "Hip Thrust", category: "Lower body", pattern: "hinge", equipment: ["barbell", "bench"] },
  { name: "Nordic Hamstring Curl", category: "Lower body", pattern: "hinge", equipment: ["partner"], tracking: "bodyweight_reps", unit: "reps", bw: 0.6 },
  { name: "Lateral Lunge", category: "Lower body", pattern: "lunge", equipment: ["dumbbell"], uni: true },
  { name: "Bench Press", category: "Upper body", pattern: "horizontal push", equipment: ["barbell", "bench"], notes: "Feet planted, shoulder blades pinned, bar to lower chest.", subs: ["Incline Dumbbell Press", "Push-Up"] },
  { name: "Incline Dumbbell Press", category: "Upper body", pattern: "horizontal push", equipment: ["dumbbell", "bench"] },
  { name: "Push-Up", category: "Upper body", pattern: "horizontal push", tracking: "bodyweight_reps", unit: "reps", bw: 0.64 },
  { name: "Pull-Up", category: "Upper body", pattern: "vertical pull", equipment: ["pull-up bar"], tracking: "bodyweight_reps", unit: "reps", bw: 1, subs: ["Chin-Up", "Inverted Row"] },
  { name: "Chin-Up", category: "Upper body", pattern: "vertical pull", equipment: ["pull-up bar"], tracking: "bodyweight_reps", unit: "reps", bw: 1 },
  { name: "Dumbbell Row", category: "Upper body", pattern: "horizontal pull", equipment: ["dumbbell", "bench"], uni: true },
  { name: "Inverted Row", category: "Upper body", pattern: "horizontal pull", equipment: ["rack", "barbell"], tracking: "bodyweight_reps", unit: "reps", bw: 0.6 },
  { name: "Overhead Press", category: "Upper body", pattern: "vertical push", equipment: ["barbell"] },
  { name: "Landmine Press", category: "Upper body", pattern: "vertical push", equipment: ["landmine"], uni: true },
  { name: "Face Pull", category: "Accessory", pattern: "horizontal pull", equipment: ["cable"] },
  { name: "Power Clean", category: "Olympic", pattern: "olympic", equipment: ["barbell", "platform"], notes: "Jump and shrug, fast elbows, catch in a quarter squat.", subs: ["Hang Clean", "Box Jump"] },
  { name: "Hang Clean", category: "Olympic", pattern: "olympic", equipment: ["barbell"], maxFrom: "Power Clean" },
  { name: "Push Press", category: "Olympic", pattern: "vertical push", equipment: ["barbell"] },
  { name: "Box Jump", category: "Plyometric", pattern: "jump", equipment: ["box"], tracking: "reps", unit: "reps", notes: "Land soft and tall; step down." },
  { name: "Broad Jump", category: "Plyometric", pattern: "jump", tracking: "reps", unit: "reps" },
  { name: "Single-Leg Hop", category: "Plyometric", pattern: "jump", tracking: "reps", unit: "reps", uni: true },
  { name: "Depth Jump", category: "Plyometric", pattern: "jump", equipment: ["box"], tracking: "reps", unit: "reps" },
  { name: "Med Ball Slam", category: "Plyometric", pattern: "rotation", equipment: ["medicine ball"], tracking: "reps", unit: "reps" },
  { name: "Med Ball Rotational Throw", category: "Plyometric", pattern: "rotation", equipment: ["medicine ball", "wall"], tracking: "reps", unit: "reps", uni: true },
  { name: "10-yd Sprint", category: "Speed", pattern: "sprint", tracking: "time", unit: "s", notes: "Full recovery between reps." },
  { name: "A-Skip", category: "Speed", pattern: "sprint", tracking: "distance", unit: "yd" },
  { name: "Pro Agility (5-10-5)", category: "Speed", pattern: "sprint", tracking: "time", unit: "s" },
  { name: "Plank", category: "Core", pattern: "anti-rotation", tracking: "time", unit: "s" },
  { name: "Side Plank", category: "Core", pattern: "anti-rotation", tracking: "time", unit: "s", uni: true },
  { name: "Dead Bug", category: "Core", pattern: "anti-rotation", tracking: "reps", unit: "reps" },
  { name: "Pallof Press", category: "Core", pattern: "anti-rotation", equipment: ["band"], tracking: "reps", unit: "reps", uni: true },
  { name: "Farmer Carry", category: "Conditioning", pattern: "carry", equipment: ["dumbbell"], tracking: "distance", unit: "yd" },
  { name: "Bear Crawl", category: "Conditioning", pattern: "carry", tracking: "distance", unit: "yd" },
  { name: "Sled Push", category: "Conditioning", pattern: "sprint", equipment: ["sled"], tracking: "distance", unit: "yd" },
  { name: "World's Greatest Stretch", category: "Mobility", tracking: "reps", unit: "reps", uni: true },
];

type ItemSeed = { ex: string; label: string; type?: "straight" | "superset" | "circuit"; rx: SetPrescription[]; prog?: ProgressionRule; notes?: string };

export async function seedTraining(ctx: SeedCtx) {
  const { tx, orgId, today } = ctx;
  ctx.extra.exercises = {};
  const ex = ctx.extra.exercises;

  // --- Exercise library -----------------------------------------------------------------
  const inserted = await tx
    .insert(exercises)
    .values(
      EXERCISES.map((e) => ({
        orgId,
        name: e.name,
        category: e.category,
        movementPattern: e.pattern ?? null,
        equipment: e.equipment ?? [],
        trackingType: e.tracking ?? "weight_reps",
        defaultUnit: e.unit ?? "lb",
        isUnilateral: !!e.uni,
        bodyweightFactor: e.bw ?? null,
        coachingNotes: e.notes ? `${e.notes} (sample cue)` : null,
      })),
    )
    .returning({ id: exercises.id, name: exercises.name });
  for (const r of inserted) ex[r.name] = r.id;
  for (const e of EXERCISES) {
    if (e.maxFrom || e.subs) {
      await tx
        .update(exercises)
        .set({ maxSourceExerciseId: e.maxFrom ? ex[e.maxFrom] : null, substitutionIds: (e.subs ?? []).map((s) => ex[s]) })
        .where(eq(exercises.id, ex[e.name]));
    }
  }

  // --- Programs -----------------------------------------------------------------------------
  async function program(name: string, description: string, sport: string | null, phases: { name: string; goal: string; weeks: number; days: { title: string; items: ItemSeed[] }[] }[]) {
    const [p] = await tx.insert(programs).values({ orgId, name, description, sport, status: "active", createdBy: ctx.users.marcus, isDemo: true }).returning();
    let week = 1;
    for (const [pi, ph] of phases.entries()) {
      const [phase] = await tx.insert(programPhases).values({ programId: p.id, name: ph.name, goal: ph.goal, sortOrder: pi, weeks: ph.weeks }).returning();
      for (let w = 0; w < ph.weeks; w++) {
        for (const [di, d] of ph.days.entries()) {
          const [day] = await tx.insert(programDays).values({ programId: p.id, phaseId: phase.id, week: week + w, dayIndex: di + 1, title: d.title }).returning();
          await tx.insert(programItems).values(
            d.items.map((it, k) => ({
              dayId: day.id,
              sortOrder: k,
              exerciseId: ex[it.ex],
              blockLabel: it.label,
              blockType: it.type ?? (/^[A-Z]\d$/.test(it.label) ? "superset" : "straight"),
              prescription: it.rx,
              progression: it.prog ?? { kind: "none" as const },
              notes: it.notes ?? null,
            })),
          );
        }
      }
      week += ph.weeks;
    }
    return p.id;
  }

  const pct = (percent: number): SetPrescription["load"] => ({ type: "percent_max", percent });
  const warm = (percent: number, reps = 5): SetPrescription => ({ sets: 1, reps, load: pct(percent), isWarmup: true, restS: 60 });
  const hsDays = (base: number, sets: number, reps: number) => [
    {
      title: "Lower — Power & Squat",
      items: [
        { ex: "Power Clean", label: "A1", type: "straight" as const, rx: [warm(50, 3), { sets, reps: 3, load: pct(base - 5), restS: 120 }], prog: { kind: "linear_load" as const, perWeek: 2.5, unit: "percent" as const } },
        { ex: "Back Squat", label: "B1", type: "superset" as const, rx: [warm(50), { sets, reps, load: pct(base), restS: 150, tempo: "30X1" }], prog: { kind: "linear_load" as const, perWeek: 2.5, unit: "percent" as const } },
        { ex: "Box Jump", label: "B2", type: "superset" as const, rx: [{ sets, reps: 3, load: { type: "bodyweight" as const }, restS: 60 }] },
        { ex: "Romanian Deadlift", label: "C1", type: "superset" as const, rx: [{ sets: 3, reps: 8, load: { type: "rpe" as const, rpe: 7 }, restS: 90 }] },
        { ex: "Plank", label: "C2", type: "superset" as const, rx: [{ sets: 3, durationS: 30, load: { type: "none" as const } }] },
        { ex: "10-yd Sprint", label: "D1", type: "straight" as const, rx: [{ sets: 6, durationS: 2, repsText: "1 sprint, full rest", load: { type: "none" as const }, restS: 60 }] },
      ],
    },
    {
      title: "Upper — Press & Pull",
      items: [
        { ex: "Bench Press", label: "A1", type: "superset" as const, rx: [warm(50), { sets, reps, load: pct(base), restS: 120 }], prog: { kind: "linear_load" as const, perWeek: 2.5, unit: "percent" as const } },
        { ex: "Pull-Up", label: "A2", type: "superset" as const, rx: [{ sets, reps: 6, load: { type: "bodyweight" as const } }] },
        { ex: "Dumbbell Row", label: "B1", type: "superset" as const, rx: [{ sets: 3, reps: 10, load: { type: "absolute" as const, value: 45, unit: "lb" as const }, restS: 60 }], prog: { kind: "linear_load" as const, perWeek: 5, unit: "lb" as const } },
        { ex: "Push-Up", label: "B2", type: "superset" as const, rx: [{ sets: 3, reps: 12, load: { type: "bodyweight" as const } }] },
        { ex: "Med Ball Slam", label: "C1", type: "circuit" as const, rx: [{ sets: 3, reps: 8, load: { type: "none" as const } }] },
        { ex: "Farmer Carry", label: "C2", type: "circuit" as const, rx: [{ sets: 3, distanceM: 37, repsText: "40 yd", load: { type: "absolute" as const, value: 50, unit: "lb" as const } }] },
        { ex: "Dead Bug", label: "C3", type: "circuit" as const, rx: [{ sets: 3, reps: 10, load: { type: "none" as const } }] },
      ],
    },
    {
      title: "Total — Pull & Single Leg",
      items: [
        { ex: "Trap Bar Deadlift", label: "A1", type: "straight" as const, rx: [warm(50), { sets, reps: Math.max(3, reps - 1), load: pct(base), restS: 150 }], prog: { kind: "linear_load" as const, perWeek: 2.5, unit: "percent" as const } },
        { ex: "Front Squat", label: "B1", type: "superset" as const, rx: [{ sets: 3, reps: 5, load: pct(base - 15), restS: 120 }] },
        { ex: "Broad Jump", label: "B2", type: "superset" as const, rx: [{ sets: 3, reps: 3, load: { type: "bodyweight" as const } }] },
        { ex: "Rear-Foot Elevated Split Squat", label: "C1", type: "superset" as const, rx: [{ sets: 3, reps: 8, load: { type: "rir" as const, rir: 2 } }], notes: "Each leg." },
        { ex: "Pallof Press", label: "C2", type: "superset" as const, rx: [{ sets: 3, reps: 10, load: { type: "none" as const } }] },
      ],
    },
  ];

  const hsProgram = await program("HS Strength & Speed", "Three-phase high-school strength and speed block: accumulate volume, intensify, then realize. (Sample program.)", "Multi-sport", [
    { name: "Accumulation", goal: "Build work capacity and technique at moderate loads", weeks: 4, days: hsDays(70, 4, 6) },
    { name: "Intensification", goal: "Raise intensity, lower volume", weeks: 3, days: hsDays(80, 4, 4) },
    { name: "Realization", goal: "Express strength and speed; test week at the end", weeks: 2, days: hsDays(87.5, 3, 2) },
  ]);

  const youthProgram = await program("Youth Athletic Development", "Movement quality, landing mechanics, and bodyweight strength for 10–13 year olds. (Sample program.)", null, [
    {
      name: "Foundations",
      goal: "Learn to squat, hinge, jump, land and sprint well",
      weeks: 6,
      days: [
        {
          title: "Move Well A",
          items: [
            { ex: "World's Greatest Stretch", label: "A", rx: [{ sets: 1, reps: 5, repsText: "5 each side", load: { type: "none" } }] },
            { ex: "Goblet Squat", label: "B1", rx: [{ sets: 3, reps: 8, load: { type: "absolute", value: 15, unit: "lb" } }], prog: { kind: "linear_load", perWeek: 2.5, unit: "lb" } },
            { ex: "Broad Jump", label: "B2", rx: [{ sets: 3, reps: 3, load: { type: "bodyweight" } }], notes: "Stick every landing." },
            { ex: "Push-Up", label: "C1", type: "circuit", rx: [{ sets: 2, reps: 8, load: { type: "bodyweight" } }] },
            { ex: "Bear Crawl", label: "C2", type: "circuit", rx: [{ sets: 2, distanceM: 9, repsText: "10 yd", load: { type: "none" } }] },
            { ex: "Plank", label: "C3", type: "circuit", rx: [{ sets: 2, durationS: 20, load: { type: "none" } }] },
          ],
        },
        {
          title: "Move Well B",
          items: [
            { ex: "A-Skip", label: "A", rx: [{ sets: 3, distanceM: 18, repsText: "20 yd", load: { type: "none" } }] },
            { ex: "Romanian Deadlift", label: "B1", rx: [{ sets: 3, reps: 8, load: { type: "absolute", value: 20, unit: "lb" } }], prog: { kind: "linear_load", perWeek: 2.5, unit: "lb" } },
            { ex: "Inverted Row", label: "B2", rx: [{ sets: 3, reps: 8, load: { type: "bodyweight" } }] },
            { ex: "Single-Leg Hop", label: "C1", rx: [{ sets: 2, reps: 4, load: { type: "bodyweight" } }], notes: "Each leg." },
            { ex: "Dead Bug", label: "C2", rx: [{ sets: 2, reps: 10, load: { type: "none" } }] },
          ],
        },
      ],
    },
  ]);
  ctx.extra.programs = { hs: hsProgram, youth: youthProgram };

  // --- Max history for HS athletes (tested; Sofia's are recorded in kg to exercise unit handling) ---
  const hsKeys = ["maya", "leo", "ethan", "sofia", "liam", "mason", "zoe", "jackson"];
  const start = addDaysYmd(today, -28 - (isoWeekday(addDaysYmd(today, -28)) - 1)); // Monday ~4 weeks ago
  const lifts: [string, number][] = [["Bench Press", 135], ["Back Squat", 205], ["Trap Bar Deadlift", 255], ["Power Clean", 145]];
  const maxRows: (typeof maxes.$inferInsert)[] = [];
  for (const k of hsKeys) {
    const f = 0.7 + rand(`str-${k}`) * 0.6; // strength factor 0.7–1.3
    const kg = k === "sofia";
    for (const [lift, base] of lifts) {
      const early = Math.round((base * f * 0.92) / 5) * 5;
      const recent = Math.round((base * f) / 5) * 5;
      const conv = (lb: number) => (kg ? Math.round((lb * 0.45359237) / 2.5) * 2.5 : lb);
      maxRows.push(
        { orgId, athleteId: ctx.athletes[k], exerciseId: ex[lift], value: String(conv(early)), unit: kg ? "kg" : "lb", kind: "tested", method: "tested", recordedOn: addDaysYmd(start, -84), enteredBy: ctx.users.marcus },
        { orgId, athleteId: ctx.athletes[k], exerciseId: ex[lift], value: String(conv(recent)), unit: kg ? "kg" : "lb", kind: "tested", method: "tested", recordedOn: addDaysYmd(start, -5), enteredBy: ctx.users.marcus },
      );
    }
  }
  await tx.insert(maxes).values(maxRows);

  // --- Assign to groups and instantiate frozen workouts --------------------------------------
  const [hsAssign] = await tx
    .insert(programAssignments)
    .values({ orgId, programId: hsProgram, programVersion: 1, groupId: ctx.groups.hs, startDate: start, daysOfWeek: [1, 3, 5], assignedBy: ctx.users.marcus })
    .returning();
  const [youthAssign] = await tx
    .insert(programAssignments)
    .values({ orgId, programId: youthProgram, programVersion: 1, groupId: ctx.groups.youth, startDate: addDaysYmd(start, 1), daysOfWeek: [2, 4], assignedBy: ctx.users.tess })
    .returning();
  await instantiateAssignment(tx, orgId, hsAssign.id, { isDemo: true });
  await instantiateAssignment(tx, orgId, youthAssign.id, { isDemo: true });
  ctx.extra.assignments = { hs: hsAssign.id, youth: youthAssign.id };

  // --- Past workouts: realistic completion with set logs, a few skipped/missed ----------------
  const past = await tx.select().from(workouts).where(and(eq(workouts.orgId, orgId), lt(workouts.scheduledDate, today)));
  const pastItems = past.length ? await tx.select().from(workoutItems).where(sql`${workoutItems.workoutId} in (${sql.join(past.map((w) => sql`${w.id}`), sql`, `)})`) : [];
  const exUni = new Map(EXERCISES.map((e) => [ex[e.name], !!e.uni]));
  const logs: (typeof setLogs.$inferInsert)[] = [];
  const sessions: (typeof activitySessions.$inferInsert)[] = [];
  for (const w of past) {
    const r = rand(`w-${w.athleteId}-${w.scheduledDate}`);
    if (r < 0.08) {
      await tx.update(workouts).set({ status: "skipped" }).where(eq(workouts.id, w.id));
      continue;
    }
    if (r < 0.14) continue; // missed: stays scheduled (counts against adherence)
    const coach = ctx.users.marcus;
    for (const it of pastItems.filter((i) => i.workoutId === w.id)) {
      const sets = expandSets(it.prescription as unknown as ResolvedSetGroup[]);
      const sides = exUni.get(it.exerciseId) ? (["left", "right"] as const) : (["both"] as const);
      for (const s of sets) {
        for (const side of sides) {
          const rr = rand(`s-${it.id}-${s.setIndex}-${side}`);
          const reps = s.reps != null ? Math.max(1, s.reps - (rr < 0.12 ? 1 : 0) + (rr > 0.93 ? 1 : 0)) : null;
          let load: number | null = s.targetLoad;
          if (load != null && rr > 0.85) load += s.targetUnit === "kg" ? 2.5 : 5;
          logs.push({
            orgId,
            workoutItemId: it.id,
            athleteId: w.athleteId,
            setIndex: s.setIndex,
            side,
            isWarmup: s.isWarmup,
            reps,
            load: load != null ? String(load) : null,
            loadUnit: load != null ? s.targetUnit : null,
            durationS: s.durationS != null ? String(Math.round((s.durationS + (rr - 0.5) * 0.3) * 100) / 100) : null,
            distanceM: s.distanceM != null ? String(s.distanceM) : null,
            rpe: s.targetLoad != null && !s.isWarmup ? String(Math.round((6.5 + rr * 2.5) * 2) / 2) : null,
            completed: true,
            clientMutationId: `seed-${randomUUID()}`,
            loggedBy: rr > 0.5 ? coach : null,
            loggedVia: rr > 0.5 ? "weight_room" : "athlete_app",
            loggedAt: localToUtc(w.scheduledDate, "16:30"),
          });
        }
      }
    }
    const srpe = 5 + Math.floor(rand(`rpe-${w.id}`) * 4);
    const dur = 50 + Math.floor(rand(`dur-${w.id}`) * 25);
    const reviewed = rand(`rev-${w.id}`) < 0.6;
    await tx
      .update(workouts)
      .set({
        status: "completed",
        startedAt: localToUtc(w.scheduledDate, "16:00"),
        completedAt: localToUtc(w.scheduledDate, "17:05"),
        sessionRpe: srpe,
        durationMinutes: dur,
        coachReviewedAt: reviewed ? localToUtc(w.scheduledDate, "19:00") : null,
        coachReviewedBy: reviewed ? coach : null,
        coachFeedback: reviewed && rand(`fb-${w.id}`) < 0.3 ? "Good bar speed today — keep the same intent next session. (sample feedback)" : null,
      })
      .where(eq(workouts.id, w.id));
    sessions.push({ orgId, athleteId: w.athleteId, activityDate: w.scheduledDate, kind: "training", durationMinutes: dur, sessionRpe: srpe, workoutId: w.id, notes: `Workout: ${w.title}`, isDemo: true });
  }
  for (let i = 0; i < logs.length; i += 1000) await tx.insert(setLogs).values(logs.slice(i, i + 1000));
  if (sessions.length) await tx.insert(activitySessions).values(sessions);

  // --- Leaderboard opt-in (sample: four HS athletes opted in) --------------------------------
  for (const k of ["maya", "leo", "ethan", "mason"]) {
    const [a] = await tx.select({ personId: athletes.personId }).from(athletes).where(eq(athletes.id, ctx.athletes[k]));
    await tx.update(people).set({ customFields: sql`${people.customFields} || '{"trainingLeaderboardOptIn": true}'::jsonb` }).where(eq(people.id, a.personId));
  }

  // --- Annual plan blocks ---------------------------------------------------------------------
  await tx.insert(trainingPlanBlocks).values([
    { orgId, groupId: ctx.groups.hs, name: "Off-season base", kind: "off_season", startDate: addDaysYmd(start, -84), endDate: addDaysYmd(start, -1), focus: "General strength, aerobic base" },
    { orgId, groupId: ctx.groups.hs, name: "Pre-season strength & speed", kind: "pre_season", startDate: start, endDate: addDaysYmd(start, 62), focus: "HS Strength & Speed program", programId: hsProgram },
    { orgId, groupId: ctx.groups.hs, name: "In-season maintenance", kind: "in_season", startDate: addDaysYmd(start, 63), endDate: addDaysYmd(start, 160), focus: "2 short sessions/week, maintain strength" },
    { orgId, groupId: ctx.groups.youth, name: "Foundations", kind: "off_season", startDate: addDaysYmd(start, 1), endDate: addDaysYmd(start, 42), focus: "Youth Athletic Development", programId: youthProgram },
  ]);
}
