import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import benchmarkData from "./benchmarks.json";
import { e1rmFromLoadVelocity } from "../src/prescription";

const prisma = new PrismaClient();

// Deterministic PRNG so seeds are reproducible.
let seed = 42;
function rand() {
  seed = (seed * 1664525 + 1013904223) % 0xffffffff;
  return seed / 0xffffffff;
}
function gaussian(mean: number, sd: number) {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
// Pure date (UTC midnight) of the calendar day containing a timestamp — the
// storage convention for session days and check-in days (see src/daytime.ts).
function utcDay(ms: number): Date {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// --- Metric catalog ---------------------------------------------------------
// `relativeToBw` flags metrics the rating engine judges relative to bodyweight.
const METRIC_TYPES = [
  { key: "sprint_10m", name: "10m Sprint", unit: "s", category: "SPEED", source: "TIMING", higherIsBetter: false, relativeToBw: false },
  { key: "sprint_40yd", name: "40yd Dash", unit: "s", category: "SPEED", source: "TIMING", higherIsBetter: false, relativeToBw: false },
  { key: "cmj_height", name: "CMJ Jump Height", unit: "cm", category: "JUMP", source: "HAWKIN", higherIsBetter: true, relativeToBw: false },
  { key: "cmj_rsi_mod", name: "CMJ RSI-Modified", unit: "", category: "POWER", source: "HAWKIN", higherIsBetter: true, relativeToBw: false },
  { key: "cmj_peak_power", name: "CMJ Peak Power", unit: "W/kg", category: "POWER", source: "HAWKIN", higherIsBetter: true, relativeToBw: false },
  { key: "dj_rsi", name: "Drop Jump RSI", unit: "", category: "JUMP", source: "OVR", higherIsBetter: true, relativeToBw: false },
  { key: "vertical_jump", name: "Vertical Jump", unit: "cm", category: "JUMP", source: "OVR", higherIsBetter: true, relativeToBw: false },
  { key: "back_squat_1rm", name: "Back Squat 1RM", unit: "kg", category: "STRENGTH", source: "MANUAL", higherIsBetter: true, relativeToBw: true },
];

// Elite reference norms come from the editable, cited dataset in benchmarks.json.
const BENCHMARKS = benchmarkData.benchmarks;

// Positions per sport, used to demo position-aware ratings.
const POSITIONS: Record<string, string[]> = {
  Basketball: ["Guard", "Big"],
  Soccer: ["Forward", "Midfielder", "Defender"],
};

// Per-metric population centers used to synthesize athlete data.
const POP: Record<string, { M: number; F: number; sd: number }> = {
  sprint_10m: { M: 1.78, F: 1.92, sd: 0.07 },
  sprint_40yd: { M: 4.9, F: 5.4, sd: 0.2 },
  cmj_height: { M: 48, F: 38, sd: 6 },
  cmj_rsi_mod: { M: 0.42, F: 0.36, sd: 0.07 },
  cmj_peak_power: { M: 47, F: 40, sd: 5 },
  dj_rsi: { M: 1.9, F: 1.6, sd: 0.35 },
  vertical_jump: { M: 58, F: 46, sd: 7 },
  back_squat_1rm: { M: 120, F: 80, sd: 22 },
};

const SPORTS = ["Basketball", "Soccer"];
const FIRST = ["Jordan", "Taylor", "Alex", "Morgan", "Casey", "Riley", "Jamie", "Drew", "Sam", "Quinn", "Avery", "Reese"];
const LAST = ["Smith", "Johnson", "Lee", "Garcia", "Brown", "Davis", "Martinez", "Clark", "Lewis", "Walker", "Hall", "Young"];

const EXERCISES: {
  name: string; category: string; equipment: string; muscleGroups: string[];
  videoUrl: string; description: string; mvt?: number;
}[] = [
  { name: "Back Squat", category: "LOWER", equipment: "Barbell", muscleGroups: ["Quads", "Glutes"], videoUrl: "https://www.youtube.com/watch?v=ultWZbUMPL8", description: "Bilateral lower-body strength. Brace, sit between the hips, drive through midfoot.", mvt: 0.3 },
  { name: "Trap Bar Deadlift", category: "LOWER", equipment: "Trap Bar", muscleGroups: ["Glutes", "Hamstrings"], videoUrl: "https://www.youtube.com/watch?v=Va4Qh3z6IqA", description: "Hip-dominant pull, athlete-friendly bar path for triple extension." },
  { name: "Power Clean", category: "OLYMPIC", equipment: "Barbell", muscleGroups: ["Full Body"], videoUrl: "https://www.youtube.com/watch?v=KwYJTpQ_x5A", description: "Triple extension power. Violent hip drive, fast elbows under the bar." },
  { name: "Hex Bar Jump", category: "PLYO", equipment: "Trap Bar", muscleGroups: ["Quads", "Glutes"], videoUrl: "https://www.youtube.com/watch?v=4tF7nWvltQ8", description: "Loaded jump for power. Light load, maximal intent, soft landing." },
  { name: "Depth Drop to Pogo", category: "PLYO", equipment: "Box", muscleGroups: ["Calves", "Quads"], videoUrl: "https://www.youtube.com/watch?v=8diUmAFktA4", description: "Reactive strength. Minimize ground contact, stiff ankles." },
  { name: "Nordic Hamstring Curl", category: "LOWER", equipment: "Pad", muscleGroups: ["Hamstrings"], videoUrl: "https://www.youtube.com/watch?v=1Q3IkmTPmgQ", description: "Eccentric hamstring strength for sprint resilience." },
  { name: "Bench Press", category: "UPPER", equipment: "Barbell", muscleGroups: ["Chest", "Triceps"], videoUrl: "https://www.youtube.com/watch?v=rT7DgCr-3pg", description: "Upper-body pressing strength.", mvt: 0.17 },
  { name: "Pull-Up", category: "UPPER", equipment: "Bar", muscleGroups: ["Back", "Biceps"], videoUrl: "https://www.youtube.com/watch?v=eGo4IYlbE5g", description: "Vertical pulling. Full range, controlled tempo." },
  { name: "Pallof Press", category: "CORE", equipment: "Cable", muscleGroups: ["Core"], videoUrl: "https://www.youtube.com/watch?v=AH_QZLm_0-s", description: "Anti-rotation core stability." },
  { name: "Sled March", category: "CONDITIONING", equipment: "Sled", muscleGroups: ["Quads", "Glutes"], videoUrl: "https://www.youtube.com/watch?v=2nQdLViTr3o", description: "Acceleration-specific resisted marching." },
];

async function main() {
  // Safety guard: never wipe a populated database (e.g. on a redeploy).
  // Set FORCE_SEED=1 to override and reseed from scratch.
  const existing = await prisma.user.count().catch(() => 0);
  if (existing > 0 && !process.env.FORCE_SEED) {
    console.log(`Database already has ${existing} users — skipping seed. Set FORCE_SEED=1 to reseed.`);
    return;
  }

  console.log("Seeding Vantage...");

  // Clean slate (dev only).
  await prisma.evalResult.deleteMany();
  await prisma.evalSession.deleteMany();
  await prisma.evalProtocolItem.deleteMany();
  await prisma.evalProtocol.deleteMany();
  await prisma.goal.deleteMany();
  await prisma.wellnessCheckin.deleteMany();
  await prisma.feedReaction.deleteMany();
  await prisma.feedPost.deleteMany();
  await prisma.message.deleteMany();
  await prisma.threadParticipant.deleteMany();
  await prisma.messageThread.deleteMany();
  await prisma.athleteGroup.deleteMany();
  await prisma.group.deleteMany();
  await prisma.maxProfile.deleteMany();
  await prisma.workoutAssignment.deleteMany();
  await prisma.workoutItem.deleteMany();
  await prisma.workoutBlock.deleteMany();
  await prisma.workout.deleteMany();
  await prisma.exercise.deleteMany();
  await prisma.metricRecord.deleteMany();
  await prisma.benchmark.deleteMany();
  await prisma.metricType.deleteMany();
  await prisma.athlete.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();

  const org = await prisma.organization.create({ data: { name: "Teamwork Performance" } });

  // Metric types
  const typeByKey: Record<string, string> = {};
  for (const t of METRIC_TYPES) {
    const created = await prisma.metricType.create({ data: t });
    typeByKey[t.key] = created.id;
  }

  // Benchmarks (from the editable, cited dataset)
  for (const b of BENCHMARKS) {
    if (!typeByKey[b.metricKey]) {
      console.warn(`  ! benchmark references unknown metricKey "${b.metricKey}" — skipped`);
      continue;
    }
    await prisma.benchmark.create({
      data: {
        metricTypeId: typeByKey[b.metricKey],
        sport: b.sport ?? null,
        position: b.position ?? null,
        sex: b.sex ?? null,
        level: b.level,
        mean: b.mean,
        sd: b.sd ?? null,
        sourceName: b.source ?? null,
        confidence: b.confidence ?? null,
        notes: b.notes ?? null,
      },
    });
  }

  // Coach login
  const coachUser = await prisma.user.create({
    data: {
      email: "coach@vantage.dev",
      passwordHash: await bcrypt.hash("password123", 10),
      name: "Coach Rod",
      role: "COACH",
      orgId: org.id,
    },
  });
  let athleteUserId = "";

  // Athletes (with a linked login for the first one)
  const now = Date.now();
  const athleteIds: string[] = [];
  const athleteMeta: { id: string; sex: string; sport: string; ability: number; age: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const sex = i % 2 === 0 ? "M" : "F";
    const sport = SPORTS[i % SPORTS.length];
    // Spread ages 11-18 so age-group leaderboards (U12..U18) are populated.
    const age = 11 + (i % 8); // 11-18
    const birthDate = new Date(now - age * 365.25 * 24 * 3600 * 1000);
    // give a spread of ability per athlete
    const ability = gaussian(0, 1);

    const positions = POSITIONS[sport] ?? [];
    const position = positions.length ? positions[i % positions.length] : null;

    const athlete = await prisma.athlete.create({
      data: {
        firstName: FIRST[i],
        lastName: LAST[i],
        sex,
        birthDate,
        sport,
        position,
        gradYear: 2026 + (18 - age),
        heightCm: Math.round(gaussian(sex === "M" ? 180 : 168, 8)),
        weightKg: Math.round(gaussian(sex === "M" ? 75 : 63, 9)),
        orgId: org.id,
      },
    });
    athleteIds.push(athlete.id);
    athleteMeta.push({ id: athlete.id, sex, sport, ability, age });

    // Link a login to the first athlete so you can log in as an athlete too.
    if (i === 0) {
      const au = await prisma.user.create({
        data: {
          email: "athlete@vantage.dev",
          passwordHash: await bcrypt.hash("password123", 10),
          name: `${athlete.firstName} ${athlete.lastName}`,
          role: "ATHLETE",
          orgId: org.id,
          athlete: { connect: { id: athlete.id } },
        },
      });
      athleteUserId = au.id;
    }

    // Generate 6 monthly testing dates with a gentle improvement trend.
    for (const key of Object.keys(POP)) {
      const p = POP[key];
      const center = (sex === "M" ? p.M : p.F) + ability * p.sd;
      const higherBetter = METRIC_TYPES.find((m) => m.key === key)!.higherIsBetter;
      for (let m = 5; m >= 0; m--) {
        const recordedAt = new Date(now - m * 30 * 24 * 3600 * 1000);
        // improvement: better over time
        const trend = (5 - m) * 0.01 * (higherBetter ? 1 : -1) * center;
        const value = Math.round((gaussian(center, p.sd * 0.3) + trend) * 100) / 100;
        await prisma.metricRecord.create({
          data: {
            athleteId: athlete.id,
            metricTypeId: typeByKey[key],
            value,
            recordedAt,
            source: METRIC_TYPES.find((mt) => mt.key === key)!.source,
          },
        });
      }
    }
  }

  // Exercise library
  const exIds: string[] = [];
  for (const e of EXERCISES) {
    const created = await prisma.exercise.create({
      data: {
        orgId: org.id,
        name: e.name,
        category: e.category,
        equipment: e.equipment,
        videoUrl: e.videoUrl,
        description: e.description,
        muscleGroups: JSON.stringify(e.muscleGroups),
        tags: JSON.stringify([e.category.toLowerCase()]),
        mvt: e.mvt ?? null,
      },
    });
    exIds.push(created.id);
  }

  // A sample workout
  const coach = await prisma.user.findUnique({ where: { email: "coach@vantage.dev" } });
  const workout = await prisma.workout.create({
    data: {
      orgId: org.id,
      name: "Lower Power — Day A",
      description: "Speed-strength emphasis for in-season athletes.",
      createdById: coach!.id,
      blocks: {
        create: [
          {
            name: "A. Power",
            order: 0,
            items: {
              create: [
                { exerciseId: exIds[2], order: 0, sets: 5, reps: "3", load: "70% 1RM", restSec: 120, notes: "Maximal intent." },
                { exerciseId: exIds[3], order: 1, sets: 4, reps: "3", load: "light", restSec: 90 },
              ],
            },
          },
          {
            name: "B. Strength",
            order: 1,
            items: {
              create: [
                { exerciseId: exIds[0], order: 0, sets: 4, reps: "5", load: "RPE 8", restSec: 150 },
                { exerciseId: exIds[5], order: 1, sets: 3, reps: "6 each", load: "bodyweight", restSec: 60 },
              ],
            },
          },
        ],
      },
    },
  });

  // Assign the sample workout to every athlete so there's something to log.
  await prisma.workoutAssignment.createMany({
    data: athleteIds.map((athleteId) => ({
      workoutId: workout.id,
      athleteId,
      assignedDate: utcDay(now),
      dueDate: utcDay(now + 2 * 24 * 3600 * 1000),
    })),
  });

  // --- Max / e1RM profiles --------------------------------------------------
  // Squat via VBT (load-velocity points), bench direct, deadlift from a rep-max.
  const squatEx = exIds[0];
  const deadliftEx = exIds[1];
  const benchEx = exIds[6];
  for (const a of athleteMeta) {
    // Age- and ability-scaled squat e1RM, then synthesize a load-velocity line
    // whose MVT-intercept reproduces it (so the VBT preview is truthful).
    const ageScale = Math.min(1, 0.55 + (a.age - 11) * 0.064); // ~0.55 at 11 → 1.0 at 18
    const squat = Math.max(40, Math.round(((a.sex === "M" ? 120 : 80) + a.ability * 22) * ageScale));
    const b = -0.0045; // velocity-per-kg slope
    const mvt = 0.3;
    const intercept = mvt - b * squat; // a in v = a + b*L so that v(squat)=mvt
    const lv = [0.5, 0.7, 0.85].map((frac) => {
      const loadKg = Math.round(squat * frac);
      return { loadKg, velocity: Math.round((intercept + b * loadKg) * 1000) / 1000 };
    });
    const squatE1rm = Math.round(e1rmFromLoadVelocity(lv, mvt) ?? squat);

    const bench = Math.max(30, Math.round(squat * (a.sex === "M" ? 0.72 : 0.66)));
    const dlRepWeight = Math.max(40, Math.round(squat * 1.1));

    await prisma.maxProfile.createMany({
      data: [
        { athleteId: a.id, exerciseId: squatEx, e1rmKg: squatE1rm, method: "VBT_LV", source: "VBT", lvJson: JSON.stringify(lv) },
        { athleteId: a.id, exerciseId: benchEx, e1rmKg: bench, method: "DIRECT", source: "MANUAL" },
        { athleteId: a.id, exerciseId: deadliftEx, e1rmKg: Math.round(dlRepWeight * (1 + 5 / 30)), method: "EPLEY", source: "MANUAL", notes: `${dlRepWeight}kg x 5` },
      ],
    });
  }

  // --- Groups / teams -------------------------------------------------------
  const bball = await prisma.group.create({ data: { orgId: org.id, name: "Varsity Basketball", type: "TEAM" } });
  const soccer = await prisma.group.create({ data: { orgId: org.id, name: "Varsity Soccer", type: "TEAM" } });
  const privateAm = await prisma.group.create({ data: { orgId: org.id, name: "Private — AM", type: "PRIVATE" } });
  for (const a of athleteMeta) {
    const groupId = a.sport === "Basketball" ? bball.id : soccer.id;
    await prisma.athleteGroup.create({ data: { groupId, athleteId: a.id } });
  }
  // A few athletes also train as private clients.
  for (const a of athleteMeta.slice(0, 3)) {
    await prisma.athleteGroup.create({ data: { groupId: privateAm.id, athleteId: a.id } });
  }

  // --- VBT-prescribed workout (today) --------------------------------------
  const vbt = await prisma.workout.create({
    data: {
      orgId: org.id,
      name: "Speed-Strength — VBT Day",
      description: "Velocity-targeted session. Loads auto-scale to each athlete's e1RM.",
      createdById: coach!.id,
      blocks: {
        create: [
          {
            name: "A. Power (velocity targets)",
            order: 0,
            items: {
              create: [
                { exerciseId: exIds[2], order: 0, sets: 5, reps: "2", prescribeBy: "VELOCITY", targetVelocity: 1.0, load: "≈ 1.0 m/s", restSec: 150, notes: "Stop set if velocity drops >10%." },
                { exerciseId: exIds[3], order: 1, sets: 4, reps: "3", prescribeBy: "ZONE", velocityZone: "SPEED", load: "max intent", restSec: 90 },
              ],
            },
          },
          {
            name: "B. Strength (%e1RM)",
            order: 1,
            items: {
              create: [
                { exerciseId: exIds[0], order: 0, sets: 5, reps: "3", prescribeBy: "PCT", targetPctE1rm: 0.75, targetVelocity: 0.6, load: "75% e1RM", restSec: 150 },
                { exerciseId: exIds[6], order: 1, sets: 4, reps: "5", prescribeBy: "PCT", targetPctE1rm: 0.7, load: "70% e1RM", restSec: 120 },
              ],
            },
          },
        ],
      },
    },
  });
  await prisma.workoutAssignment.createMany({
    data: athleteIds.map((athleteId) => ({
      workoutId: vbt.id,
      athleteId,
      assignedDate: utcDay(now),
      dueDate: utcDay(now + 24 * 3600 * 1000),
    })),
  });

  // --- Historical adherence (completed sessions over the last 4 weeks) -------
  // Powers the coach "who's training / who's fallen off" board with realistic
  // variety: most athletes train consistently, a couple tapered off two weeks
  // ago (→ flagged), and one never started.
  {
    const dayMs = 864e5;
    const monday = utcDay(now);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const adherence: { workoutId: string; athleteId: string; assignedDate: Date; status: string; completedAt: Date }[] = [];
    athleteMeta.forEach((a, i) => {
      const profile = i % 8 === 0 ? "never" : i % 8 === 1 ? "fell-off" : "regular";
      if (profile === "never") return;
      for (let w = 0; w < 4; w++) {
        if (profile === "fell-off" && w >= 2) continue; // stopped ~2 weeks ago
        const weekStart = new Date(monday.getTime() - (3 - w) * 7 * dayMs);
        const base = 2 + Math.round(Math.max(0, Math.min(2, a.ability + 1)));
        const count = Math.max(1, Math.min(5, base + Math.round(gaussian(0, 0.6))));
        for (let s = 0; s < count; s++) {
          const dayOffset = Math.min(6, s + Math.round(Math.abs(gaussian(0, 1))));
          const day = new Date(weekStart.getTime() + dayOffset * dayMs); // pure date (UTC midnight)
          const done = new Date(day.getTime() + 17 * 3600 * 1000); // 17:00Z that day
          if (done.getTime() > now) continue; // never complete in the future
          adherence.push({ workoutId: workout.id, athleteId: a.id, assignedDate: day, status: "COMPLETED", completedAt: done });
        }
      }
    });
    await prisma.workoutAssignment.createMany({ data: adherence });
  }

  // --- Team feed (PR posts + an announcement) -------------------------------
  // Surface a few standout CMJ results as PRs so the feed isn't empty on a
  // fresh seed (live PRs are generated when athletes beat a prior best).
  const cmjType = await prisma.metricType.findUnique({ where: { key: "cmj_height" } });
  if (cmjType) {
    const topCmj = await prisma.metricRecord.findMany({
      where: { metricTypeId: cmjType.id },
      orderBy: { value: "desc" },
      take: 3,
      include: { athlete: { select: { id: true, firstName: true, lastName: true } } },
    });
    for (const r of topCmj) {
      await prisma.feedPost.create({
        data: {
          orgId: org.id, kind: "PR", athleteId: r.athlete.id,
          title: `${r.athlete.firstName} ${r.athlete.lastName} set a new PR`,
          metricLabel: cmjType.name, value: r.value, unit: cmjType.unit,
        },
      });
    }
  }
  await prisma.feedPost.create({
    data: { orgId: org.id, kind: "ANNOUNCEMENT", authorUserId: coachUser.id, title: "Testing day this Friday", body: "Sprints + force plates. Show up fueled and ready to PR." },
  });

  // --- A sample conversation ------------------------------------------------
  if (athleteUserId) {
    const thread = await prisma.messageThread.create({
      data: { orgId: org.id, participants: { create: [{ userId: coachUser.id }, { userId: athleteUserId }] } },
    });
    await prisma.message.create({ data: { threadId: thread.id, authorUserId: coachUser.id, body: "Welcome to Vantage! Check your Today tab for this week's plan." } });
    await prisma.message.create({ data: { threadId: thread.id, authorUserId: athleteUserId, body: "Got it, thanks coach!" } });
    await prisma.messageThread.update({ where: { id: thread.id }, data: { lastMessageAt: new Date() } });
  }

  // --- Wellness check-ins (last 5 days for each athlete) --------------------
  for (const a of athleteMeta) {
    for (let dgo = 4; dgo >= 0; dgo--) {
      const date = utcDay(now - dgo * 864e5);
      const base = 3 + Math.round(a.ability); // ability-tinted self-report
      const clamp = (n: number) => Math.max(1, Math.min(5, n));
      const sleepQuality = clamp(base + Math.round(gaussian(0, 0.8)));
      const soreness = clamp(3 - Math.round(a.ability) + Math.round(gaussian(0, 0.8)));
      const mood = clamp(base + Math.round(gaussian(0, 0.8)));
      const energy = clamp(base + Math.round(gaussian(0, 0.8)));
      const stress = clamp(3 - Math.round(a.ability * 0.5) + Math.round(gaussian(0, 0.8)));
      const sleepHours = Math.round((7 + gaussian(0, 1)) * 10) / 10;
      const parts = [(sleepQuality - 1) / 4, (mood - 1) / 4, (energy - 1) / 4, (5 - soreness) / 4, (5 - stress) / 4, Math.max(0, Math.min(1, (sleepHours - 4) / 4))];
      const readiness = Math.round((parts.reduce((x, y) => x + y, 0) / parts.length) * 100);
      await prisma.wellnessCheckin.create({
        data: { athleteId: a.id, date, sleepHours, sleepQuality, soreness, mood, energy, stress, readiness },
      });
    }
  }

  // --- Goals ------------------------------------------------------------------
  // One mid-progress metric goal, one nearly-done e1RM goal, and one already
  // past its target (auto-achieves + posts to the feed on first view).
  {
    const cmj = await prisma.metricType.findUnique({ where: { key: "cmj_height" } });
    if (cmj) {
      for (const [i, profile] of (["mid", "near", "crossed"] as const).entries()) {
        const a = athleteMeta[i + 1];
        if (profile === "near" || profile === "mid") {
          const best = await prisma.metricRecord.aggregate({
            where: { athleteId: a.id, metricTypeId: cmj.id }, _max: { value: true },
          });
          const cur = best._max.value ?? 40;
          const target = profile === "mid" ? Math.round(cur + 4) : Math.round(cur + 1);
          await prisma.goal.create({
            data: {
              athleteId: a.id, createdById: coach!.id, kind: "METRIC", metricTypeId: cmj.id,
              targetValue: target, baselineValue: Math.round((cur - 3) * 10) / 10,
              deadline: utcDay(now + 45 * 864e5), notes: profile === "mid" ? "Combine prep" : "So close — finish it",
            },
          });
        } else {
          const max = await prisma.maxProfile.findFirst({ where: { athleteId: a.id }, orderBy: { recordedAt: "desc" } });
          if (max) {
            await prisma.goal.create({
              data: {
                athleteId: a.id, createdById: coach!.id, kind: "E1RM", exerciseId: max.exerciseId,
                targetValue: Math.max(40, max.e1rmKg - 5), baselineValue: max.e1rmKg - 20,
                notes: "Winter strength block",
              },
            });
          }
        }
      }
    }
  }

  // --- Evaluations: a testing protocol + one completed session ---------------
  {
    const battery = ["sprint_10m", "cmj_height", "vertical_jump"].map((k) => typeByKey[k]).filter(Boolean);
    if (battery.length === 3) {
      const protocol = await prisma.evalProtocol.create({
        data: {
          orgId: org.id, name: "Spring Testing", description: "Pre-season combine battery",
          createdById: coach!.id,
          items: { create: battery.map((metricTypeId, i) => ({ metricTypeId, order: i })) },
        },
      });
      const sessionDay = utcDay(now - 10 * 864e5);
      const session = await prisma.evalSession.create({
        data: { protocolId: protocol.id, date: sessionDay, createdById: coach!.id, notes: "Full squad tested" },
      });
      for (const a of athleteMeta.slice(0, 8)) {
        for (const metricTypeId of battery) {
          // Re-test near the athlete's existing level with a little noise.
          const best = await prisma.metricRecord.aggregate({
            where: { athleteId: a.id, metricTypeId }, _avg: { value: true },
          });
          const base = best._avg.value ?? 40;
          const value = Math.round(base * (1 + gaussian(0, 0.02)) * 100) / 100;
          const record = await prisma.metricRecord.create({
            data: { athleteId: a.id, metricTypeId, value, source: "EVAL", recordedAt: sessionDay, notes: "Testing: Spring Testing" },
          });
          await prisma.evalResult.create({
            data: { sessionId: session.id, athleteId: a.id, metricTypeId, value, metricRecordId: record.id },
          });
        }
      }
    }
  }

  console.log("Seed complete.");
  console.log("  Coach login:   coach@vantage.dev / password123");
  console.log("  Athlete login: athlete@vantage.dev / password123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
