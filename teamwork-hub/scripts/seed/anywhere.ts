import { and, eq, inArray } from "drizzle-orm";
import { anywhereSessions, exercises, type AnywhereCategory, type AnywhereEquipment } from "../../src/db/schema";
import type { Viewer } from "../../src/lib/authz/policy";
import { assignSession } from "../../src/lib/anywhere/assignments";
import { addEvent, calendarForAthlete, createSeason, logSport } from "../../src/lib/anywhere/season";
import { addStep, completeSession, createSession, updateSession } from "../../src/lib/anywhere/sessions";
import { addDaysYmd, isoWeekday, localToUtc, startOfWeekYmd } from "../../src/lib/time";
import type { SeedCtx } from "./context";

/**
 * Synthetic Anywhere demo data. Everything is a SAMPLE: session content is generic and meant for
 * coaches to edit, team and opponent names are made up, and no real person or club appears.
 * Safe when the training seed did not run (the library is skipped without exercises).
 */

/** Generic no-equipment movements added to the exercise library so samples have enough to draw on. Teamwork-written cues, no media. */
const EXTRA_EXERCISES: { name: string; category: string; tracking: "reps" | "time" | "bodyweight_reps"; unit: "reps" | "s"; notes: string; uni?: boolean }[] = [
  { name: "Glute Bridge", category: "Lower body", tracking: "reps", unit: "reps", notes: "Feet flat, ribs down. Squeeze at the top for a full second." },
  { name: "Bodyweight Squat", category: "Lower body", tracking: "bodyweight_reps", unit: "reps", notes: "Sit between the hips, whole foot on the floor, stand tall." },
  { name: "Reverse Lunge", category: "Lower body", tracking: "bodyweight_reps", unit: "reps", notes: "Step back softly, front knee over the middle of the foot.", uni: true },
  { name: "90/90 Hip Switch", category: "Mobility", tracking: "reps", unit: "reps", notes: "Sit tall. Rotate slowly from one side to the other without using your hands if you can." },
  { name: "Ankle Rocks", category: "Mobility", tracking: "reps", unit: "reps", notes: "Knee travels over the toes, heel stays down.", uni: true },
  { name: "Cat-Cow", category: "Mobility", tracking: "reps", unit: "reps", notes: "Move slowly, one breath per rep." },
  { name: "Easy Walk", category: "Conditioning", tracking: "time", unit: "s", notes: "Relaxed pace. You should be able to talk the whole time." },
  { name: "Jumping Jack", category: "Conditioning", tracking: "reps", unit: "reps", notes: "Light and springy. Land quietly." },
  { name: "Leg Swing", category: "Mobility", tracking: "reps", unit: "reps", notes: "Hold something for balance. Swing a little further each rep.", uni: true },
  { name: "Lateral Shuffle", category: "Speed", tracking: "reps", unit: "reps", notes: "Stay low, push off the trailing foot, do not cross your feet." },
];

type Sample = { title: string; description: string; category: AnywhereCategory; minutes: number; equipment: AnywhereEquipment[]; u13: boolean; steps: [string, string, string?][] };

const SAMPLES: Sample[] = [
  { title: "10-Minute Hips and Ankles", description: "A short reset for tight hips and ankles. Good for any day.", category: "mobility", minutes: 10, equipment: ["none"], u13: true, steps: [["Cat-Cow", "8 slow reps"], ["World's Greatest Stretch", "5 each side"], ["90/90 Hip Switch", "8 each way"], ["Ankle Rocks", "10 each side"], ["Glute Bridge", "2 x 10, hold the top"]] },
  { title: "Full-Body Mobility Flow", description: "Move every joint before school or after a long sit.", category: "mobility", minutes: 15, equipment: ["none"], u13: true, steps: [["Cat-Cow", "10 slow reps"], ["World's Greatest Stretch", "6 each side"], ["Leg Swing", "10 each leg, front and side"], ["90/90 Hip Switch", "10 each way"], ["Bodyweight Squat", "10 slow reps, pause at the bottom"]] },
  { title: "Day-After Reset", description: "Easy movement for the day after a game or a hard practice.", category: "recovery", minutes: 12, equipment: ["none"], u13: true, steps: [["Easy Walk", "5 minutes"], ["Cat-Cow", "8 slow reps"], ["World's Greatest Stretch", "4 each side"], ["Glute Bridge", "2 x 8, easy"]] },
  { title: "Core Four", description: "Four moves, no equipment. Quality over speed.", category: "core", minutes: 10, equipment: ["none"], u13: true, steps: [["Dead Bug", "2 x 8 each side", "Low back stays on the floor."], ["Plank", "2 x 30 seconds"], ["Side Plank", "2 x 20 seconds each side"], ["Bear Crawl", "2 x 10 yards"]] },
  { title: "Band Core and Hips", description: "Needs one light band and something sturdy to anchor it.", category: "core", minutes: 12, equipment: ["band"], u13: false, steps: [["Pallof Press", "3 x 8 each side", "Stand tall and do not let the band turn you."], ["Dead Bug", "2 x 8 each side"], ["Side Plank", "2 x 25 seconds each side"], ["Glute Bridge", "2 x 12"]] },
  { title: "Field Speed Starts", description: "Short sprints with full rest. Find a flat field or open space.", category: "speed_agility", minutes: 20, equipment: ["field"], u13: false, steps: [["A-Skip", "2 x 20 yards"], ["Lateral Shuffle", "2 x 10 yards each way"], ["10-yd Sprint", "6 reps, walk back to rest", "Every rep fast. Stop the set if you slow down."], ["Broad Jump", "3 x 3, stick the landing"]] },
  { title: "Youth Agility Play", description: "Quick feet and soft landings for younger athletes.", category: "speed_agility", minutes: 15, equipment: ["field"], u13: true, steps: [["Jumping Jack", "2 x 15"], ["A-Skip", "2 x 15 yards"], ["Lateral Shuffle", "3 x 8 yards each way"], ["Single-Leg Hop", "2 x 5 each leg, land quietly"]] },
  { title: "Bodyweight Strength Circuit", description: "Three rounds. Rest as needed between rounds.", category: "bodyweight_strength", minutes: 20, equipment: ["none"], u13: false, steps: [["Bodyweight Squat", "3 x 12"], ["Push-Up", "3 x 8, or as many good reps as you have"], ["Reverse Lunge", "3 x 8 each leg"], ["Plank", "3 x 30 seconds"], ["Glute Bridge", "3 x 12"]] },
  { title: "Hotel Room 15", description: "Fits between two beds. Quiet enough for the floor below.", category: "travel", minutes: 15, equipment: ["none"], u13: true, steps: [["Cat-Cow", "8 slow reps"], ["World's Greatest Stretch", "5 each side"], ["Bodyweight Squat", "2 x 12"], ["Push-Up", "2 x 8"], ["Dead Bug", "2 x 8 each side"], ["Glute Bridge", "2 x 12"]] },
  { title: "Pre-Game Warm-Up", description: "Ten minutes to get warm and ready before a game.", category: "pre_game_warmup", minutes: 10, equipment: ["field"], u13: true, steps: [["Jumping Jack", "20 reps"], ["Leg Swing", "10 each leg, front and side"], ["World's Greatest Stretch", "4 each side"], ["A-Skip", "2 x 15 yards"], ["Lateral Shuffle", "2 x 8 yards each way"], ["10-yd Sprint", "3 reps, building up to fast"]] },
];

export async function seedAnywhere(ctx: SeedCtx) {
  const { tx, orgId, today, tz } = ctx;
  if (!ctx.users.rod) return;
  const owner: Viewer = { userId: ctx.users.rod, orgId, role: "owner", personId: ctx.people.rod ?? null, displayName: "Rod (Owner)", mfaVerified: true };
  const at = (date: string, time: string) => localToUtc(date, time, tz);

  // --- Library -------------------------------------------------------------------------------
  const haveTraining = (await tx.select({ id: exercises.id }).from(exercises).where(eq(exercises.orgId, orgId)).limit(1)).length > 0;
  const sessionIds: Record<string, string> = {};
  if (haveTraining) {
    await tx
      .insert(exercises)
      .values(EXTRA_EXERCISES.map((e) => ({ orgId, name: e.name, category: e.category, trackingType: e.tracking, defaultUnit: e.unit, isUnilateral: !!e.uni, coachingNotes: e.notes, equipment: [] })))
      .onConflictDoNothing();
    const names = [...new Set(SAMPLES.flatMap((s) => s.steps.map((x) => x[0])))];
    const byName = new Map((await tx.select({ id: exercises.id, name: exercises.name }).from(exercises).where(and(eq(exercises.orgId, orgId), inArray(exercises.name, names)))).map((e) => [e.name, e.id]));
    for (const s of SAMPLES) {
      const input = { title: s.title, description: s.description, category: s.category, durationMinutes: s.minutes, equipment: s.equipment, suitableUnder13: s.u13 };
      const row = await createSession(tx, owner, { ...input, status: "draft" });
      let n = 0;
      for (const [name, prescription, cue] of s.steps) {
        const exerciseId = byName.get(name);
        if (!exerciseId) continue;
        await addStep(tx, owner, row.id, { exerciseId, prescription, cue });
        n++;
      }
      if (n) await updateSession(tx, owner, row.id, { ...input, status: "published" });
      await tx.update(anywhereSessions).set({ isSample: true, isDemo: true }).where(eq(anywhereSessions.id, row.id));
      sessionIds[s.title] = row.id;
    }
    ctx.extra.anywhereSessions = sessionIds;

    // --- Assignments for the demo groups ---------------------------------------------------
    const weekStart = startOfWeekYmd(today);
    const weekEnd = addDaysYmd(weekStart, 6);
    if (ctx.groups.hs) await assignSession(tx, owner, { what: "category:mobility", groupId: ctx.groups.hs, startDate: weekStart, endDate: weekEnd, targetCount: 2, note: "Two short mobility sessions this week (sample)." });
    if (ctx.groups.youth && sessionIds["Youth Agility Play"]) await assignSession(tx, owner, { what: `session:${sessionIds["Youth Agility Play"]}`, groupId: ctx.groups.youth, startDate: weekStart, endDate: weekEnd, targetCount: 1 });
    if (ctx.athletes.maya && sessionIds["Core Four"]) await assignSession(tx, owner, { what: `session:${sessionIds["Core Four"]}`, athleteId: ctx.athletes.maya, startDate: weekStart, endDate: weekEnd, targetCount: 1, note: "Before your next gym day (sample)." });

    // --- A few finished sessions -----------------------------------------------------------
    const done = async (athlete: string, title: string, daysAgo: number, time: string, load: { min: number; rpe: number } | null) => {
      const athleteId = ctx.athletes[athlete];
      const sessionId = sessionIds[title];
      if (!athleteId || !sessionId) return;
      const date = addDaysYmd(today, -daysAgo);
      await completeSession(tx, owner, { athleteId, sessionId, clientKey: `seed-${athlete}-${daysAgo}-${sessionId.slice(0, 8)}`, stepsDone: 50, durationMinutes: load?.min ?? null, rpe: load?.rpe ?? null }, at(date, time));
    };
    await done("maya", "10-Minute Hips and Ankles", 1, "19:15", { min: 10, rpe: 2 });
    await done("maya", "Day-After Reset", 8, "17:40", null);
    await done("maya", "Hotel Room 15", 16, "07:30", { min: 15, rpe: 4 });
    await done("leo", "Full-Body Mobility Flow", 2, "18:05", { min: 15, rpe: 3 });
    await done("dana", "Bodyweight Strength Circuit", 3, "06:45", { min: 20, rpe: 6 });
  }

  // --- A demo season: weekly practices, two games, a few logged sessions ----------------------
  // Practices fall on yesterday's weekday and three days ago, so there is always one to log.
  const season = async (athlete: string, team: string, sport: string, opts: { gameInDays: number[]; opponents: string[]; logPast: boolean }) => {
    const athleteId = ctx.athletes[athlete];
    if (!athleteId) return;
    const s = await createSeason(tx, owner, { athleteId, teamName: team, sport, startsOn: addDaysYmd(today, -35), endsOn: addDaysYmd(today, 49) });
    const days = [...new Set([isoWeekday(addDaysYmd(today, -1)), isoWeekday(addDaysYmd(today, -3))])];
    await addEvent(tx, owner, { seasonId: s.id, kind: "practice", repeat: "weekly", weekdays: days, startTime: "16:30", durationMinutes: 90, location: "Sample school gym" });
    for (const [i, d] of opts.gameInDays.entries()) {
      await addEvent(tx, owner, { seasonId: s.id, kind: "game", repeat: "once", date: addDaysYmd(today, d), startTime: i === 0 ? "19:30" : "10:00", durationMinutes: 90, opponent: opts.opponents[i] ?? "Sample Opponent", location: i === 0 ? "Home, sample school main gym" : "Away, sample fieldhouse" });
    }
    await addEvent(tx, owner, { seasonId: s.id, kind: "rest", repeat: "once", date: addDaysYmd(today, opts.gameInDays[0] + 1) });
    if (!opts.logPast) return;
    // Log most past practices (not yesterday's, and one is left out on purpose: missing stays missing).
    const past = (await calendarForAthlete(tx, owner, athleteId, addDaysYmd(today, -28), addDaysYmd(today, -2))).filter((o) => o.loggable);
    for (const [i, o] of past.entries()) {
      if (i === 2) continue;
      await logSport(tx, owner, { athleteId, eventId: o.eventId, occurrenceDate: o.date, durationMinutes: o.kind === "practice" ? 90 - (i % 3) * 10 : 75, rpe: o.kind === "practice" ? 4 + (i % 3) : 8 }, at(o.date, "21:00"));
    }
  };
  await season("maya", "Sample Volleyball Club 16U", "Volleyball", { gameInDays: [0, 4, -9], opponents: ["Sample Opponent A", "Sample Opponent B", "Sample Opponent C"], logPast: true });
  await season("leo", "Sample High School JV", "Football", { gameInDays: [1], opponents: ["Sample Opponent D"], logPast: false });
}
