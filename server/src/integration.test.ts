// Route-level integration tests: scratch SQLite DB, the real Express app
// booted in-process, assertions over HTTP with real JWTs. Dependency-free
// (Node 22 global fetch). Run: `npm test` (or ts-node this file directly).
//
// Env must be set before the app/db modules load, so those are imported
// dynamically inside main().
process.env.DATABASE_URL = "file:./integration.db"; // resolved against prisma/
process.env.JWT_SECRET = "integration-test-secret";
process.env.PORT = "4123";

import assert from "assert";
import { execSync } from "child_process";
import { existsSync, rmSync } from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { dayOf, pureDate } from "./daytime";

const BASE = `http://localhost:${process.env.PORT}/api`;
const DB_FILE = path.resolve(__dirname, "../prisma/integration.db");

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

type Json = Record<string, any>;
async function call(method: string, p: string, opts: { token?: string; tz?: number; body?: unknown } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-tz-offset": String(opts.tz ?? 0),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const body: Json = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  // Fresh scratch database, then boot the real app against it.
  if (existsSync(DB_FILE)) rmSync(DB_FILE);
  execSync("npx prisma db push --skip-generate", { cwd: path.resolve(__dirname, ".."), stdio: "pipe" });
  const { prisma } = await import("./db");
  await import("./index");
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  // --- Fixtures: two orgs, a coach + athlete user in org A, athlete in org B.
  const hash = await bcrypt.hash("password123", 4);
  const orgA = await prisma.organization.create({ data: { name: "Org A" } });
  const orgB = await prisma.organization.create({ data: { name: "Org B" } });
  const coachUser = await prisma.user.create({ data: { email: "coach@a.test", passwordHash: hash, name: "Coach A", role: "COACH", orgId: orgA.id } });
  const athleteUser = await prisma.user.create({ data: { email: "athlete@a.test", passwordHash: hash, name: "Ath A1", role: "ATHLETE", orgId: orgA.id } });
  const a1 = await prisma.athlete.create({
    data: { firstName: "Ath", lastName: "A1", sex: "M", birthDate: new Date("2008-01-01"), sport: "Basketball", orgId: orgA.id, userId: athleteUser.id },
  });
  const a2 = await prisma.athlete.create({
    data: { firstName: "Ath", lastName: "A2", sex: "F", birthDate: new Date("2009-01-01"), sport: "Soccer", orgId: orgA.id },
  });
  const b1 = await prisma.athlete.create({
    data: { firstName: "Ath", lastName: "B1", sex: "M", birthDate: new Date("2008-01-01"), sport: "Soccer", orgId: orgB.id },
  });
  const exercise = await prisma.exercise.create({ data: { orgId: orgA.id, name: "Back Squat", category: "LOWER" } });
  const workout = await prisma.workout.create({
    data: {
      orgId: orgA.id, name: "Test Day", createdById: coachUser.id,
      blocks: { create: [{ name: "A", order: 0, items: { create: [{ exerciseId: exercise.id, order: 0, sets: 3, reps: "5" }] } }] },
    },
    include: { blocks: { include: { items: true } } },
  });
  const itemId = workout.blocks[0].items[0].id;

  console.log("integration (routes)");

  // --- auth ---------------------------------------------------------------
  let coachToken = "", athleteToken = "";
  await test("login succeeds with valid credentials", async () => {
    const r = await call("POST", "/auth/login", { body: { email: "coach@a.test", password: "password123" } });
    assert.equal(r.status, 200);
    assert.ok(r.body.token);
    coachToken = r.body.token;
    const r2 = await call("POST", "/auth/login", { body: { email: "athlete@a.test", password: "password123" } });
    athleteToken = r2.body.token;
  });
  await test("login rejects a wrong password", async () => {
    const r = await call("POST", "/auth/login", { body: { email: "coach@a.test", password: "wrong-password" } });
    assert.equal(r.status, 401);
  });
  await test("requests without a token are rejected", async () => {
    const r = await call("GET", "/athletes");
    assert.equal(r.status, 401);
  });

  // --- org scoping ----------------------------------------------------------
  await test("coach cannot read an athlete from another org", async () => {
    const r = await call("GET", `/wellness/athlete/${b1.id}`, { token: coachToken });
    assert.equal(r.status, 404);
  });

  // --- wellness: the client's calendar day, not the server's ----------------
  await test("check-in with tz offset lands on the client's day", async () => {
    const chicago = 300; // minutes behind UTC
    const expectedDay = dayOf(new Date(), chicago);
    const r = await call("POST", "/wellness", { token: athleteToken, tz: chicago, body: { soreness: 4, mood: 3 } });
    assert.equal(r.status, 201);
    assert.equal(new Date(r.body.checkin.date).toISOString().slice(0, 10), expectedDay);
    const me = await call("GET", "/wellness/me", { token: athleteToken, tz: chicago });
    assert.equal(me.body.submittedToday, true);
  });
  await test("re-submitting the same day updates (upserts), not duplicates", async () => {
    const chicago = 300;
    await call("POST", "/wellness", { token: athleteToken, tz: chicago, body: { soreness: 2, mood: 5 } });
    const rows = await prisma.wellnessCheckin.findMany({ where: { athleteId: a1.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].soreness, 2);
  });
  await test("explicit check-in date is stored as a pure UTC date", async () => {
    const r = await call("POST", "/wellness", { token: athleteToken, body: { date: "2026-01-15", energy: 3 } });
    assert.equal(r.status, 201);
    assert.equal(new Date(r.body.checkin.date).toISOString(), "2026-01-15T00:00:00.000Z");
  });
  await test("garbage check-in date is rejected", async () => {
    const r = await call("POST", "/wellness", { token: athleteToken, body: { date: "01/15/2026", energy: 3 } });
    assert.equal(r.status, 400);
  });

  // --- assign / copy-day / calendar ------------------------------------------
  await test("assign on a day, copy it to the next day, calendar shows both", async () => {
    const r = await call("POST", `/workouts/${workout.id}/assign`, { token: coachToken, body: { athleteIds: [a1.id], dates: ["2026-06-01"] } });
    assert.equal(r.status, 201);
    const c = await call("POST", "/assignments/copy-day", { token: coachToken, body: { fromDate: "2026-06-01", toDates: ["2026-06-02"] } });
    assert.equal(c.body.created, 1);
    const cal = await call("GET", "/assignments/calendar?from=2026-06-01&to=2026-06-02", { token: coachToken });
    const days = cal.body.assignments.map((x: Json) => x.date).sort();
    assert.deepEqual(days, ["2026-06-01", "2026-06-02"]);
  });
  await test("re-pasting the same day is idempotent", async () => {
    const c = await call("POST", "/assignments/copy-day", { token: coachToken, body: { fromDate: "2026-06-01", toDates: ["2026-06-02"] } });
    assert.equal(c.body.created, 0);
  });

  // --- adherence: day-string bucketing + coherent rate ----------------------
  await test("adherence buckets by client day and caps the rate at 100%", async () => {
    const chicago = 300;
    const yesterdayInstant = new Date(Date.now() - 864e5);
    const yesterdayDay = dayOf(yesterdayInstant, chicago);
    const tenDaysAgo = dayOf(new Date(Date.now() - 10 * 864e5), chicago);
    const fortyDaysAgo = dayOf(new Date(Date.now() - 40 * 864e5), chicago);
    await prisma.workoutAssignment.createMany({
      data: [
        // completed yesterday
        { workoutId: workout.id, athleteId: a2.id, assignedDate: pureDate(yesterdayDay), status: "COMPLETED", completedAt: yesterdayInstant },
        // scheduled 10 days ago, skipped
        { workoutId: workout.id, athleteId: a2.id, assignedDate: pureDate(tenDaysAgo), status: "ASSIGNED" },
        // assigned before the window but completed inside it — must not push rate over 100%
        { workoutId: workout.id, athleteId: a2.id, assignedDate: pureDate(fortyDaysAgo), status: "COMPLETED", completedAt: yesterdayInstant },
      ],
    });
    const r = await call("GET", "/analytics/adherence?weeks=4", { token: coachToken, tz: chicago });
    const row = r.body.rows.find((x: Json) => x.athleteId === a2.id);
    assert.ok(row, "athlete row present");
    assert.equal(row.daysSinceLast, 1);
    assert.equal(row.atRisk, false);
    assert.ok(row.completionRate !== null && row.completionRate <= 100, `rate ${row.completionRate} ≤ 100`);
    assert.equal(row.completionRate, 50); // 1 of 2 in-window sessions done
    assert.equal(row.weeks.reduce((s: number, n: number) => s + n, 0), 2); // both completions bucketed
    assert.equal(yesterdayDay <= dayOf(new Date(), chicago), true);
  });

  // --- goals: baseline capture, auto-achieve, feed celebration ---------------
  const cmj = await prisma.metricType.create({
    data: { key: "test_cmj", name: "CMJ", unit: "cm", category: "JUMP", source: "MANUAL", higherIsBetter: true },
  });
  await test("creating a goal captures the athlete's current best as baseline", async () => {
    await prisma.metricRecord.create({ data: { athleteId: a1.id, metricTypeId: cmj.id, value: 40 } });
    const r = await call("POST", "/goals", { token: athleteToken, body: { kind: "METRIC", metricTypeId: cmj.id, targetValue: 50 } });
    assert.equal(r.status, 201);
    assert.equal(r.body.goal.baselineValue, 40);
    assert.equal(r.body.goal.status, "ACTIVE");
  });
  await test("an athlete cannot set a goal for another athlete", async () => {
    const r = await call("POST", "/goals", { token: athleteToken, body: { athleteId: a2.id, kind: "METRIC", metricTypeId: cmj.id, targetValue: 60 } });
    assert.equal(r.status, 201);
    assert.equal(r.body.goal.athleteId, a1.id); // silently scoped to self
  });
  await test("crossing the target auto-achieves and celebrates on the feed", async () => {
    await prisma.metricRecord.create({ data: { athleteId: a1.id, metricTypeId: cmj.id, value: 52 } });
    const r = await call("GET", "/goals", { token: athleteToken });
    const g = r.body.goals.find((x: Json) => x.target === 50);
    assert.ok(g, "goal listed");
    assert.equal(g.status, "ACHIEVED");
    assert.equal(g.progressPct, 100);
    assert.equal(g.current, 52);
    const posts = await prisma.feedPost.findMany({ where: { kind: "GOAL", athleteId: a1.id } });
    assert.equal(posts.length, 1);
    assert.ok(posts[0].body!.includes("52"));
  });

  // --- evaluations: results write through to metric history ------------------
  let sessionId = "", protoMetricId = "";
  await test("protocol + session + results create EVAL metric records", async () => {
    protoMetricId = cmj.id;
    const p = await call("POST", "/evals/protocols", { token: coachToken, body: { name: "Combine", metricTypeIds: [cmj.id] } });
    assert.equal(p.status, 201);
    const se = await call("POST", "/evals/sessions", { token: coachToken, body: { protocolId: p.body.protocol.id, date: "2026-06-10" } });
    sessionId = se.body.session.id;
    const r = await call("POST", `/evals/sessions/${sessionId}/results`, { token: coachToken, body: { results: [{ athleteId: a2.id, metricTypeId: cmj.id, value: 44 }] } });
    assert.equal(r.body.saved, 1);
    const recs = await prisma.metricRecord.findMany({ where: { athleteId: a2.id, metricTypeId: cmj.id, source: "EVAL" } });
    assert.equal(recs.length, 1);
    assert.equal(recs[0].value, 44);
    assert.equal(recs[0].recordedAt.toISOString(), "2026-06-10T00:00:00.000Z");
  });
  await test("re-entering an eval value updates the linked record, not duplicates", async () => {
    await call("POST", `/evals/sessions/${sessionId}/results`, { token: coachToken, body: { results: [{ athleteId: a2.id, metricTypeId: protoMetricId, value: 45.5 }] } });
    const recs = await prisma.metricRecord.findMany({ where: { athleteId: a2.id, metricTypeId: protoMetricId, source: "EVAL" } });
    assert.equal(recs.length, 1);
    assert.equal(recs[0].value, 45.5);
  });
  await test("athletes cannot touch eval endpoints", async () => {
    const r = await call("GET", "/evals/protocols", { token: athleteToken });
    assert.equal(r.status, 403);
  });

  // --- set logs: idempotent upsert + athlete isolation -----------------------
  await test("re-posting a set log upserts instead of duplicating", async () => {
    const assignment = await prisma.workoutAssignment.findFirst({ where: { athleteId: a1.id } });
    assert.ok(assignment);
    const log = (reps: number) =>
      call("POST", `/assignments/${assignment!.id}/logs`, { token: athleteToken, body: { logs: [{ workoutItemId: itemId, setNumber: 1, reps }] } });
    await log(5);
    await log(6);
    const rows = await prisma.setLog.findMany({ where: { assignmentId: assignment!.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reps, 6);
  });
  await test("set logs accept nulls for blank fields (what the UI sends)", async () => {
    const assignment = await prisma.workoutAssignment.findFirst({ where: { athleteId: a1.id } });
    const r = await call("POST", `/assignments/${assignment!.id}/logs`, {
      token: athleteToken,
      body: { logs: [{ workoutItemId: itemId, setNumber: 2, reps: 3, loadKg: 60, rpe: null, velocity: 0.95, peakVelocity: null, completed: true }] },
    });
    assert.equal(r.status, 200);
  });
  await test("an athlete cannot touch another athlete's assignment", async () => {
    const other = await prisma.workoutAssignment.findFirst({ where: { athleteId: a2.id } });
    const r = await call("GET", `/assignments/${other!.id}`, { token: athleteToken });
    assert.equal(r.status, 404);
  });

  // --- VBT CSV import (GymAware-style, no cloud) ------------------------------
  async function postCsv(p: string, csv: string) {
    const res = await fetch(`${BASE}${p}`, {
      method: "POST",
      headers: { "content-type": "text/csv", authorization: `Bearer ${coachToken}`, "x-tz-offset": "0" },
      body: csv,
    });
    return { status: res.status, body: (await res.json()) as Json };
  }
  const perSetCsv = [
    "Athlete,Exercise,Date,Set,Reps,Weight (kg),Mean Velocity (m/s),Peak Velocity (m/s)",
    "Ath A1,Front Squat,2026-07-01,1,3,60,0.82,1.10",
    "Ath A1,Front Squat,2026-07-01,2,3,80,0.62,0.95",
    "Ath A1,Front Squat,2026-07-01,3,2,95,0.45,0.72",
    "Nobody Known,Front Squat,2026-07-01,1,3,60,0.80,1.00",
  ].join("\n");

  await test("vbt import dry-run previews without writing", async () => {
    const r = await postCsv("/import/vbt-csv?dryRun=1", perSetCsv);
    assert.equal(r.status, 200);
    assert.equal(r.body.wouldImportSets, 3);
    assert.equal(r.body.skipped.length, 1); // unknown athlete row
    const w = await prisma.workout.findFirst({ where: { name: { contains: "GymAware" } } });
    assert.equal(w, null);
  });
  await test("vbt import writes a completed session with velocities + e1RM profile", async () => {
    const r = await postCsv("/import/vbt-csv", perSetCsv);
    assert.equal(r.status, 201);
    assert.equal(r.body.imported.sets, 3);
    assert.equal(r.body.maxUpdates.length, 1); // 3 distinct loads → LV fit
    const asg = await prisma.workoutAssignment.findFirst({
      where: { athleteId: a1.id, workout: { name: { contains: "GymAware" } } },
      include: { setLogs: true },
    });
    assert.ok(asg && asg.status === "COMPLETED");
    assert.equal(asg!.setLogs.length, 3);
    assert.ok(asg!.setLogs.some((l) => l.velocity === 0.62 && l.loadKg === 80));
    const max = await prisma.maxProfile.findFirst({ where: { athleteId: a1.id, method: "VBT_LV", source: "IMPORT" } });
    assert.ok(max && max.e1rmKg > 95, `e1RM ${max?.e1rmKg} should exceed heaviest set`);
  });
  await test("vbt import aggregates per-rep rows and converts lbs", async () => {
    const perRep = [
      "Name,Lift,Date,Set,Rep,Weight (lbs),Mean Velocity",
      "Ath A2,Hip Thrust,7/2/2026,1,1,225,0.75",
      "Ath A2,Hip Thrust,7/2/2026,1,2,225,0.71",
      "Ath A2,Hip Thrust,7/2/2026,1,3,225,0.67",
      "Ath A2,Hip Thrust,7/2/2026,2,1,275,0.52",
    ].join("\n");
    const r = await postCsv("/import/vbt-csv", perRep);
    assert.equal(r.status, 201);
    assert.equal(r.body.imported.sets, 2); // 5 rows → 2 sets
    const asg = await prisma.workoutAssignment.findFirst({
      where: { athleteId: a2.id, workout: { name: { contains: "GymAware" } } },
      include: { setLogs: { orderBy: { setNumber: "asc" } } },
    });
    assert.equal(asg!.setLogs[0].reps, 3); // rep rows counted
    assert.ok(Math.abs(asg!.setLogs[0].loadKg! - 102.06) < 0.1, `lbs→kg (${asg!.setLogs[0].loadKg})`);
    assert.ok(Math.abs(asg!.setLogs[0].velocity! - 0.71) < 0.01); // mean of 0.75/0.71/0.67
    assert.equal(asg!.assignedDate.toISOString().slice(0, 10), "2026-07-02"); // m/d/yyyy parsed
  });

  console.log(`${passed} tests passed.\n`);
  await prisma.$disconnect();
  rmSync(DB_FILE, { force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n✗ FAILED after ${passed} passing tests:\n`, err);
  rmSync(DB_FILE, { force: true });
  process.exit(1);
});
