import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { athletes, auditEvents, bookings, guardianships, jobs, maxes, messageDeliveries, monthlyRecaps, payerAuthorizations, people, questionnaireResponses, scheduleSessions, serviceTypes, exercises } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { AuthzError, type Viewer } from "@/lib/authz/policy";
import { jobHandlers } from "@/lib/jobs-registry";
import { FORBIDDEN_KEYS } from "@/lib/showcase/allowlist";
import { RECAP_MONTHLY_JOB, enqueueRecapJobs } from "@/lib/showcase/jobs";
import { RECAP_CALC_KEY, coachRecapQueue, computeRecap, finalizeOn, finalizeRecap, finalizeRecapByStaff, listRecapMonths, monthBounds, monthLabel, plannedForMonth, recapAccess, recapNotice, runMonthlyRecaps, saveCoachNote, shiftMonth, viewRecap, type RecapSnapshot } from "@/lib/showcase/recap";
import { saveShowcaseSettings } from "@/lib/showcase/settings";
import { localToUtc } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

type Ctx = Awaited<ReturnType<typeof seedOrg>>;
const TODAY = "2026-03-02";
const db = testDb();
let ctx: Ctx;
let other: Ctx;
let serviceTypeId: string;
const V: Record<string, Viewer> = {};
let maya: string;

const denied = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(AuthzError);
const refused = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(UserError);
function deepKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      out.add(k);
      deepKeys(x, out);
    }
  return out;
}

let seq = 0;
async function newAthlete() {
  const [p] = await db.insert(people).values({ orgId: ctx.orgId, firstName: `Recap${++seq}`, lastName: "Tester", dateOfBirth: "2010-01-15", isDemo: true }).returning();
  const [a] = await db.insert(athletes).values({ orgId: ctx.orgId, personId: p.id, sport: "Track", isDemo: true }).returning();
  return a.id;
}
async function addSession(athleteId: string, ymd: string, status: "attended" | "booked" | "no_show" = "attended", title = "Test session") {
  const startsAt = localToUtc(ymd, "17:00");
  const [s] = await db.insert(scheduleSessions).values({ orgId: ctx.orgId, serviceTypeId, title, startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), timezone: "America/Indiana/Indianapolis", capacity: 10 }).returning();
  const [b] = await db.insert(bookings).values({ orgId: ctx.orgId, sessionId: s.id, athleteId, status }).returning();
  return b.id;
}

beforeAll(async () => {
  ctx = await seedOrg(TODAY);
  other = await seedOrg(TODAY, { modules: [] });
  for (const k of ["rod", "erin", "marcus", "tess", "alex", "jordan", "chris", "sam", "casey", "maya", "kiosk"]) V[k] = await viewerFor(ctx, k);
  V.otherOwner = await viewerFor(other, "rod");
  maya = ctx.athletes.maya;
  [{ id: serviceTypeId }] = await db.select({ id: serviceTypes.id }).from(serviceTypes).where(eq(serviceTypes.orgId, ctx.orgId)).limit(1);
});
afterAll(closeTestDb);

describe("month helpers (pure)", () => {
  it("bounds, shifting, labels, plan and finalize date", () => {
    expect(monthBounds("2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28", days: 28 });
    expect(monthBounds("2028-02").end).toBe("2028-02-29");
    expect([shiftMonth("2026-01", -1), shiftMonth("2026-12", 1), shiftMonth("2026-03", -14)]).toEqual(["2025-12", "2027-01", "2025-01"]);
    expect(monthLabel("2026-02")).toBe("February 2026");
    expect([plannedForMonth(3, 28), plannedForMonth(3, 31), plannedForMonth(null, 30), plannedForMonth(0, 30)]).toEqual([12, 13, null, null]);
    expect([finalizeOn("2026-02", 3), finalizeOn("2026-02", 0), finalizeOn("2026-12", 3)]).toEqual(["2026-03-04", "2026-03-01", "2027-01-04"]);
  });
});

describe("assembling a recap", () => {
  it("counts the month in facility time and reads no health value", async () => {
    const a = await newAthlete();
    // Feb 2026: three attended, one missed. Jan 31 and Mar 1 fall outside. One booked in March.
    for (const d of ["2026-02-02", "2026-02-10", "2026-02-28"]) await addSession(a, d);
    await addSession(a, "2026-02-12", "no_show");
    await addSession(a, "2026-01-31");
    await addSession(a, "2026-03-01");
    await addSession(a, "2026-03-09", "booked", "Speed School");
    const [ex] = await db.select().from(exercises).where(eq(exercises.orgId, ctx.orgId)).limit(1);
    await db.insert(maxes).values([
      { orgId: ctx.orgId, athleteId: a, exerciseId: ex.id, value: "100", unit: "lb", kind: "tested", method: "tested", recordedOn: "2026-01-10", enteredBy: ctx.users.marcus },
      { orgId: ctx.orgId, athleteId: a, exerciseId: ex.id, value: "115", unit: "lb", kind: "tested", method: "tested", recordedOn: "2026-02-14", enteredBy: ctx.users.marcus },
    ]);
    const s = (await computeRecap(db, ctx.orgId, a, "2026-02", { today: TODAY }))!;
    expect(s).toMatchObject({ calcKey: RECAP_CALC_KEY, month: "2026-02", period: { start: "2026-02-01", end: "2026-02-28" }, asOf: "2026-02-28" });
    expect(s.sessions).toEqual({ attended: 3, missed: 1, planPerWeek: null, planned: null, stillBooked: 0 });
    expect(s.training.prs).toEqual([{ exercise: ex.name, value: 115, unit: "lb", date: "2026-02-14", gain: 15, basis: "measured" }]);
    expect(s.training.streak.current).toBeGreaterThan(0);
    expect(s.next).toMatchObject({ month: "2026-03", bookedCount: 1 });
    expect(s.next.bookings[0].title).toBe("Speed School");
    // A recap is in-app and may list sessions; health, billing and identity keys are still never in it.
    const never = (FORBIDDEN_KEYS as readonly string[]).filter((k) => !["attendance", "bookings"].includes(k));
    for (const k of deepKeys(s)) expect(never, `key ${k}`).not.toContain(k);
    // An unknown athlete, or one from another organization, yields nothing.
    expect(await computeRecap(db, other.orgId, a, "2026-02", { today: TODAY })).toBeNull();
  });

  it("Maya's seeded month has tests with a comparable change, and never a wellness value", async () => {
    const wellness = await db.select().from(questionnaireResponses).where(eq(questionnaireResponses.athleteId, maya));
    expect(wellness.length).toBeGreaterThan(0);
    const months = ["2026-02", "2026-01", "2025-12"];
    const snaps = (await Promise.all(months.map((m) => computeRecap(db, ctx.orgId, maya, m, { today: TODAY })))) as RecapSnapshot[];
    const withTests = snaps.find((s) => s.training.tests.length > 0)!;
    expect(withTests).toBeTruthy();
    for (const t of withTests.training.tests) {
      if (t.previous) expect(t.change).toBeCloseTo(t.value - t.previous.value, 6);
      else expect(t.change).toBeNull();
    }
    const json = JSON.stringify(snaps).toLowerCase();
    for (const word of ["wellness", "readiness", "sleep", "soreness", "pain", "injur", "invoice", "date_of_birth"]) expect(json, word).not.toContain(word);
  });
});

describe("snapshots", () => {
  it("finalizing freezes the numbers: later edits do not rewrite history", async () => {
    const a = await newAthlete();
    await db.insert(guardianships).values({ orgId: ctx.orgId, guardianPersonId: ctx.people.alex_parker, athleteId: a, canViewHealth: true });
    for (const d of ["2026-01-05", "2026-01-12"]) await addSession(a, d);
    await refused(db.transaction((tx) => finalizeRecap(tx, ctx.orgId, a, "2026-03", "job", { today: TODAY }))); // month not over
    const done = await db.transaction((tx) => finalizeRecap(tx, ctx.orgId, a, "2026-01", "job", { today: TODAY }));
    expect(done).toMatchObject({ status: "final", calcKey: "tw_recap_v1", finalizedVia: "job" });
    expect(done.noticeAt).toBeInstanceOf(Date);
    const frozen = done.snapshot as RecapSnapshot;
    expect(frozen.sessions.attended).toBe(2);

    // History changes afterwards: another attended session is recorded in January, one is corrected to a no-show.
    const late = await addSession(a, "2026-01-20");
    await db.update(bookings).set({ status: "no_show" }).where(and(eq(bookings.athleteId, a), eq(bookings.id, late)));
    await addSession(a, "2026-01-21");
    expect((await computeRecap(db, ctx.orgId, a, "2026-01", { today: TODAY }))!.sessions).toMatchObject({ attended: 3, missed: 1 });
    const view = (await db.transaction((tx) => viewRecap(tx, V.alex, a, "2026-01", { today: TODAY })))!;
    expect(view.state).toBe("final");
    expect(view.recap.sessions).toMatchObject({ attended: 2, missed: 0 });
    expect(view.recap.generatedAt).toBe(frozen.generatedAt);
    // Finalizing again is a no-op, even concurrently.
    const again = await Promise.all([1, 2, 3].map(() => db.transaction((tx) => finalizeRecap(tx, ctx.orgId, a, "2026-01", "on_demand", { today: TODAY }))));
    for (const r of again) expect(r.finalizedAt!.getTime()).toBe(done.finalizedAt!.getTime());
    expect((await db.select().from(monthlyRecaps).where(and(eq(monthlyRecaps.athleteId, a), eq(monthlyRecaps.month, "2026-01")))).length).toBe(1);
    expect((await db.select().from(auditEvents).where(and(eq(auditEvents.entityId, done.id), eq(auditEvents.action, "recap.finalize")))).length).toBe(1);

    // The database itself refuses to rewrite or delete a finalized recap.
    const row = eq(monthlyRecaps.id, done.id);
    await expect(db.update(monthlyRecaps).set({ snapshot: { ...frozen, sessions: { ...frozen.sessions, attended: 99 } } }).where(row)).rejects.toThrow();
    await expect(db.update(monthlyRecaps).set({ coachNote: "edited later" }).where(row)).rejects.toThrow();
    await expect(db.update(monthlyRecaps).set({ status: "open" }).where(row)).rejects.toThrow();
    await expect(db.update(monthlyRecaps).set({ calcKey: "tw_recap_v2" }).where(row)).rejects.toThrow();
    await expect(db.update(monthlyRecaps).set({ month: "2026-02" }).where(row)).rejects.toThrow();
    await expect(db.delete(monthlyRecaps).where(row)).rejects.toThrow();
    await db.update(monthlyRecaps).set({ noticeAt: new Date() }).where(row); // the notice may move; the content may not
    await expect(db.execute(sql`insert into monthly_recaps (org_id, athlete_id, month, status, calc_key) values (${ctx.orgId}, ${a}, '2025-12', 'final', 'x')`)).rejects.toThrow(); // final needs a snapshot
    await expect(db.execute(sql`insert into monthly_recaps (org_id, athlete_id, month, calc_key) values (${ctx.orgId}, ${a}, '2026-13', 'x')`)).rejects.toThrow();
    // A coach note cannot be added once final.
    await db.insert(guardianships).values({ orgId: ctx.orgId, guardianPersonId: ctx.people.chris_parker, athleteId: a }).onConflictDoNothing();
    await refused(db.transaction((tx) => saveCoachNote(tx, V.rod, { athleteId: a, month: "2026-01", note: "too late" }, { today: TODAY })));
  });

  it("an open month is live, a closing month waits out the grace period, then finalizes on first view", async () => {
    const a = await newAthlete();
    await db.insert(guardianships).values({ orgId: ctx.orgId, guardianPersonId: ctx.people.alex_parker, athleteId: a });
    await db.update(athletes).set({ createdAt: new Date("2026-01-02T12:00:00Z") }).where(eq(athletes.id, a));
    await addSession(a, "2026-02-03");
    await addSession(a, "2026-03-01");
    const cur = (await db.transaction((tx) => viewRecap(tx, V.alex, a, "2026-03", { today: TODAY })))!;
    expect(cur).toMatchObject({ state: "in_progress", finalizedAt: null });
    expect(cur.recap.asOf).toBe(TODAY);
    expect(cur.recap.sessions.attended).toBe(1);
    // Mar 2 is inside February's grace period (3 days): still live, not yet stored.
    const closing = (await db.transaction((tx) => viewRecap(tx, V.alex, a, "2026-02", { today: TODAY })))!;
    expect(closing).toMatchObject({ state: "closing", finalOn: "2026-03-04" });
    expect((await db.select().from(monthlyRecaps).where(eq(monthlyRecaps.athleteId, a))).length).toBe(0);
    // From Mar 4 the first view freezes it.
    const fin = (await db.transaction((tx) => viewRecap(tx, V.alex, a, "2026-02", { today: "2026-03-04" })))!;
    expect(fin.state).toBe("final");
    const [row] = await db.select().from(monthlyRecaps).where(eq(monthlyRecaps.athleteId, a));
    expect(row).toMatchObject({ status: "final", finalizedVia: "on_demand", month: "2026-02" });
    // Future months and months before the athlete joined do not exist.
    expect(await db.transaction((tx) => viewRecap(tx, V.alex, a, "2026-04", { today: TODAY }))).toBeNull();
    expect(await db.transaction((tx) => viewRecap(tx, V.alex, a, "2025-11", { today: TODAY }))).toBeNull();
    expect(await db.transaction((tx) => viewRecap(tx, V.alex, a, "nonsense", { today: TODAY }))).toBeNull();
    const months = await listRecapMonths(db, V.alex, a, { today: "2026-03-05" });
    expect(months.map((m) => [m.month, m.state])).toEqual([["2026-03", "in_progress"], ["2026-02", "final"], ["2026-01", "closing"]]);
    expect(months[1].isNew).toBe(true);
    expect(await recapNotice(db, V.alex, a)).toMatchObject({ ready: { month: "2026-02", label: "February 2026" } });
  });
});

describe("who sees what", () => {
  it("guardian flags: training access gates numbers and the coach note; health access changes nothing", async () => {
    const last = "2026-02";
    // The seed finalized February for Maya with a coach note.
    const alex = (await db.transaction((tx) => viewRecap(tx, V.alex, maya, last, { today: TODAY })))!;
    const jordan = (await db.transaction((tx) => viewRecap(tx, V.jordan, maya, last, { today: TODAY })))!;
    const self = (await db.transaction((tx) => viewRecap(tx, V.maya, maya, last, { today: TODAY })))!;
    expect(alex.state).toBe("final");
    expect(alex.coachNote?.text).toMatch(/Sample coach note/);
    expect(alex.coachNote?.by).toBe("Coach Marcus Hale");
    expect(alex.recap.training).not.toBeNull();
    // Jordan has no health access: the recap is identical, because nothing in it is health data.
    expect(jordan.recap).toEqual(alex.recap);
    expect(jordan.coachNote).toEqual(alex.coachNote);
    expect(self.recap).toEqual(alex.recap);

    const link = and(eq(guardianships.guardianPersonId, ctx.people.jordan_parker), eq(guardianships.athleteId, maya));
    await db.update(guardianships).set({ canViewTraining: false }).where(link);
    try {
      const limited = (await db.transaction((tx) => viewRecap(tx, V.jordan, maya, last, { today: TODAY })))!;
      expect(limited.access).toMatchObject({ canView: true, canSeeTraining: false, canWriteNote: false });
      expect(limited.recap.training).toBeNull();
      expect(limited.coachNote).toBeNull();
      expect(limited.recap.goals.every((g) => g.measured === null)).toBe(true);
      expect(limited.recap.goals.map((g) => g.title)).toEqual(alex.recap.goals.map((g) => g.title));
      expect(limited.recap.sessions).toEqual(alex.recap.sessions);
      expect(limited.recap.next).toEqual(alex.recap.next);
      const text = JSON.stringify(limited);
      expect(text).not.toContain("Sample coach note");
      for (const pr of alex.recap.training!.prs) expect(text).not.toContain(pr.exercise);
      for (const t of alex.recap.training!.tests) expect(text).not.toContain(t.metric);
    } finally {
      await db.update(guardianships).set({ canViewTraining: true }).where(link);
    }
    // Casey cannot book or pay, but is a guardian of Leo: she sees Leo's recap.
    expect((await db.transaction((tx) => viewRecap(tx, V.casey, ctx.athletes.leo, last, { today: TODAY })))!.state).toBe("final");
  });

  it("an unrelated guardian, a payer-only adult, the kiosk and another organization see nothing", async () => {
    const all = async (v: Viewer) => {
      expect(await recapAccess(db, v, maya)).toMatchObject({ canView: false, canWriteNote: false });
      await denied(db.transaction((tx) => viewRecap(tx, v, maya, "2026-02", { today: TODAY })));
      await denied(listRecapMonths(db, v, maya, { today: TODAY }));
      expect(await recapNotice(db, v, maya)).toBeNull();
      await denied(db.transaction((tx) => saveCoachNote(tx, v, { athleteId: maya, month: "2026-03", note: "x" }, { today: TODAY })));
      await denied(db.transaction((tx) => finalizeRecapByStaff(tx, v, maya, "2026-01", { today: TODAY })));
    };
    for (const k of ["chris", "sam", "kiosk", "otherOwner"]) await all(V[k]);
    await db.insert(payerAuthorizations).values({ payerAccountId: ctx.payers.parker, personId: ctx.people.chris_parker, canViewInvoices: true, canPay: true });
    try {
      await all(V.chris);
    } finally {
      await db.delete(payerAuthorizations).where(and(eq(payerAuthorizations.payerAccountId, ctx.payers.parker), eq(payerAuthorizations.personId, ctx.people.chris_parker)));
    }
  });

  it("coach scope: notes and the queue cover assigned athletes only; families and operations cannot write", async () => {
    const month = "2026-03";
    const saved = await db.transaction((tx) => saveCoachNote(tx, V.marcus, { athleteId: maya, month, note: "  Good  week.\n<b>Keep going</b>  " }, { today: TODAY }));
    expect(saved).toMatchObject({ status: "open", coachNote: "Good week.\nbKeep going/b", coachNoteBy: V.marcus.userId });
    // Tess coaches the youth group, not Maya.
    await denied(db.transaction((tx) => saveCoachNote(tx, V.tess, { athleteId: maya, month, note: "x" }, { today: TODAY })));
    await denied(db.transaction((tx) => finalizeRecapByStaff(tx, V.tess, maya, "2026-01", { today: TODAY })));
    for (const k of ["erin", "alex", "jordan", "maya"]) await denied(db.transaction((tx) => saveCoachNote(tx, V[k], { athleteId: maya, month, note: "x" }, { today: TODAY })));
    await refused(db.transaction((tx) => saveCoachNote(tx, V.marcus, { athleteId: maya, month: "2026-04", note: "x" }, { today: TODAY })));
    await refused(db.transaction((tx) => saveCoachNote(tx, V.marcus, { athleteId: maya, month, note: "x".repeat(1201) }, { today: TODAY })));
    // The audit entry records who and when, not the note text.
    const [a] = await db.select().from(auditEvents).where(and(eq(auditEvents.entityId, saved.id), eq(auditEvents.action, "recap.note.save")));
    expect(a.actorUserId).toBe(V.marcus.userId);
    expect(JSON.stringify(a)).not.toContain("Good week");

    const mq = await coachRecapQueue(db, V.marcus, month, { today: TODAY });
    const tq = await coachRecapQueue(db, V.tess, month, { today: TODAY });
    const rq = await coachRecapQueue(db, V.rod, month, { today: TODAY });
    expect(mq.rows.find((r) => r.athleteId === maya)).toMatchObject({ note: "Good week.\nbKeep going/b", state: "open" });
    expect(mq.rows.map((r) => r.athleteId)).not.toContain(ctx.athletes.eli);
    expect(tq.rows.map((r) => r.athleteId)).toContain(ctx.athletes.eli);
    expect(tq.rows.map((r) => r.athleteId)).not.toContain(maya);
    expect(JSON.stringify(tq)).not.toContain("Good week");
    expect(rq.rows.length).toBeGreaterThan(mq.rows.length);
    expect(mq).toMatchObject({ ended: false, finalOn: "2026-04-04" });
    for (const k of ["erin", "alex", "maya", "kiosk"]) await denied(coachRecapQueue(db, V[k], month, { today: TODAY }));
    expect((await coachRecapQueue(db, V.otherOwner, month, { today: TODAY })).rows.map((r) => r.athleteId)).not.toContain(maya);

    // The family sees the note on the in-progress month; clearing it removes it.
    expect((await db.transaction((tx) => viewRecap(tx, V.alex, maya, month, { today: TODAY })))!.coachNote?.text).toContain("Good week.");
    await db.transaction((tx) => saveCoachNote(tx, V.marcus, { athleteId: maya, month, note: "   " }, { today: TODAY }));
    expect((await db.transaction((tx) => viewRecap(tx, V.alex, maya, month, { today: TODAY })))!.coachNote).toBeNull();
    // A coach can preview an assigned athlete's recap and nobody else's.
    expect(await db.transaction((tx) => viewRecap(tx, V.marcus, maya, month, { today: TODAY }))).not.toBeNull();
    await denied(db.transaction((tx) => viewRecap(tx, V.tess, maya, month, { today: TODAY })));
  });
});

describe("the monthly job", () => {
  it("waits for the grace period, finalizes once, makes an in-app notice and sends nothing", async () => {
    const a = await newAthlete();
    await addSession(a, "2026-02-17");
    const idle = await newAthlete(); // no activity in February: no recap is made for them
    const deliveries = async () => Number(((await db.execute(sql`select count(*)::int as n from message_deliveries d join people p on p.id = d.recipient_person_id where p.org_id = ${ctx.orgId}`)).rows[0] as { n: number }).n);
    const jobCount = async () => Number(((await db.execute(sql`select count(*)::int as n from jobs where org_id = ${ctx.orgId}`)).rows[0] as { n: number }).n);
    const d0 = await deliveries();
    const j0 = await jobCount();

    expect(await db.transaction((tx) => runMonthlyRecaps(tx, ctx.orgId, { today: "2026-03-03" }))).toEqual({ month: "2026-02", finalized: 0, skipped: "grace" });
    const first = await db.transaction((tx) => runMonthlyRecaps(tx, ctx.orgId, { today: "2026-03-04" }));
    expect(first).toMatchObject({ month: "2026-02", skipped: null });
    expect(first.finalized).toBeGreaterThan(0);
    const [row] = await db.select().from(monthlyRecaps).where(and(eq(monthlyRecaps.athleteId, a), eq(monthlyRecaps.month, "2026-02")));
    expect(row).toMatchObject({ status: "final", finalizedVia: "job", calcKey: RECAP_CALC_KEY });
    expect(row.noticeAt).toBeInstanceOf(Date);
    expect((await db.select().from(monthlyRecaps).where(eq(monthlyRecaps.athleteId, idle))).length).toBe(0);
    // Idempotent.
    expect((await db.transaction((tx) => runMonthlyRecaps(tx, ctx.orgId, { today: "2026-03-05" }))).finalized).toBe(0);
    // Nothing was sent or queued: no deliveries, no jobs.
    expect(await deliveries()).toBe(d0);
    expect(await jobCount()).toBe(j0);
    expect(messageDeliveries).toBeDefined();

    // Turned off in settings: the job does nothing and families lose the page; staff keep the queue.
    await db.transaction((tx) => saveShowcaseSettings(tx, V.rod, { enabled: true, minAge: 13, defaultExpiryDays: 90, recapEnabled: false, recapGraceDays: 0 }));
    expect((await db.transaction((tx) => runMonthlyRecaps(tx, ctx.orgId, { today: "2026-04-10" }))).skipped).toBe("disabled");
    expect((await recapAccess(db, V.alex, maya)).canView).toBe(false);
    expect((await recapAccess(db, V.marcus, maya)).canView).toBe(true);
    await db.transaction((tx) => saveShowcaseSettings(tx, V.rod, { enabled: true, minAge: 13, defaultExpiryDays: 90, recapEnabled: true, recapGraceDays: 0 }));
    // With no grace period the month closes on the 1st.
    expect((await db.transaction((tx) => runMonthlyRecaps(tx, ctx.orgId, { today: "2026-04-01" }))).skipped).toBeNull();
  });

  it("is registered with the worker and enqueued once per organization per day", async () => {
    expect(typeof jobHandlers[RECAP_MONTHLY_JOB]).toBe("function");
    const now = new Date("2031-05-06T15:00:00Z");
    await db.transaction((tx) => enqueueRecapJobs(tx, now));
    await db.transaction((tx) => enqueueRecapJobs(tx, now));
    const mine = await db.select().from(jobs).where(and(eq(jobs.orgId, ctx.orgId), eq(jobs.type, RECAP_MONTHLY_JOB), eq(jobs.dedupeKey, `recap.monthly:${ctx.orgId}:2031-05-06`)));
    expect(mine.length).toBe(1);
    expect(mine[0].payload).toEqual({ orgId: ctx.orgId });
    await db.delete(jobs).where(and(eq(jobs.type, RECAP_MONTHLY_JOB), sql`${jobs.dedupeKey} like '%:2031-05-06'`));
  });
});
