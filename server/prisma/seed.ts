import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import benchmarkData from "./benchmarks.json";

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

const EXERCISES = [
  { name: "Back Squat", category: "LOWER", equipment: "Barbell", muscleGroups: ["Quads", "Glutes"], videoUrl: "https://www.youtube.com/watch?v=ultWZbUMPL8", description: "Bilateral lower-body strength. Brace, sit between the hips, drive through midfoot." },
  { name: "Trap Bar Deadlift", category: "LOWER", equipment: "Trap Bar", muscleGroups: ["Glutes", "Hamstrings"], videoUrl: "https://www.youtube.com/watch?v=Va4Qh3z6IqA", description: "Hip-dominant pull, athlete-friendly bar path for triple extension." },
  { name: "Power Clean", category: "OLYMPIC", equipment: "Barbell", muscleGroups: ["Full Body"], videoUrl: "https://www.youtube.com/watch?v=KwYJTpQ_x5A", description: "Triple extension power. Violent hip drive, fast elbows under the bar." },
  { name: "Hex Bar Jump", category: "PLYO", equipment: "Trap Bar", muscleGroups: ["Quads", "Glutes"], videoUrl: "https://www.youtube.com/watch?v=4tF7nWvltQ8", description: "Loaded jump for power. Light load, maximal intent, soft landing." },
  { name: "Depth Drop to Pogo", category: "PLYO", equipment: "Box", muscleGroups: ["Calves", "Quads"], videoUrl: "https://www.youtube.com/watch?v=8diUmAFktA4", description: "Reactive strength. Minimize ground contact, stiff ankles." },
  { name: "Nordic Hamstring Curl", category: "LOWER", equipment: "Pad", muscleGroups: ["Hamstrings"], videoUrl: "https://www.youtube.com/watch?v=1Q3IkmTPmgQ", description: "Eccentric hamstring strength for sprint resilience." },
  { name: "Bench Press", category: "UPPER", equipment: "Barbell", muscleGroups: ["Chest", "Triceps"], videoUrl: "https://www.youtube.com/watch?v=rT7DgCr-3pg", description: "Upper-body pressing strength." },
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
  await prisma.user.create({
    data: {
      email: "coach@vantage.dev",
      passwordHash: await bcrypt.hash("password123", 10),
      name: "Coach Rod",
      role: "COACH",
      orgId: org.id,
    },
  });

  // Athletes (with a linked login for the first one)
  const now = Date.now();
  const athleteIds: string[] = [];
  for (let i = 0; i < 12; i++) {
    const sex = i % 2 === 0 ? "M" : "F";
    const sport = SPORTS[i % SPORTS.length];
    const age = 15 + (i % 4); // 15-18
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

    // Link a login to the first athlete so you can log in as an athlete too.
    if (i === 0) {
      await prisma.user.create({
        data: {
          email: "athlete@vantage.dev",
          passwordHash: await bcrypt.hash("password123", 10),
          name: `${athlete.firstName} ${athlete.lastName}`,
          role: "ATHLETE",
          orgId: org.id,
          athlete: { connect: { id: athlete.id } },
        },
      });
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
      dueDate: new Date(now + 2 * 24 * 3600 * 1000),
    })),
  });

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
