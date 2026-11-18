import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { auditEvents, payrollRuns, staffClockPins, timeEntries } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { AuthzError } from "@/lib/authz/policy";
import {
  acknowledgeFlag,
  addManualEntry,
  approveRun,
  calculatePayroll,
  canManagePayroll,
  clock,
  createRun,
  editEntry,
  exportRun,
  importZenPlanner,
  kioskStaffClock,
  listEntries,
  payrollConfig,
  recalculateRun,
  setPayRate,
  setStaffClockPin,
  STAFF_PIN_MAX_FAILED,
  updatePayrollSettings,
  voidEntry,
} from "@/lib/payroll/service";
import { DEFAULT_IMPORT_MAPPING, DEFAULT_THRESHOLDS } from "@/lib/payroll/settings";
import { addDaysYmd, localToUtc } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

type Ctx = Awaited<ReturnType<typeof seedOrg>>;
type V = Awaited<ReturnType<typeof viewerFor>>;
const db = () => testDb();
const tx = <T>(fn: (t: Parameters<Parameters<ReturnType<typeof testDb>["transaction"]>[0]>[0]) => Promise<T>) => db().transaction(fn);

let ctx: Ctx;
let rod: V, erin: V, marcus: V, tess: V, alex: V, kiosk: V;
const at = (d: string, t: string) => localToUtc(d, t, ctx.tz);

beforeAll(async () => {
  ctx = await seedOrg("2026-03-02", { modules: [] });
  [rod, erin, marcus, tess, alex, kiosk] = await Promise.all(["rod", "erin", "marcus", "tess", "alex", "kiosk"].map((k) => viewerFor(ctx, k)));
  await tx((t) => setPayRate(t, rod, { userId: ctx.users.marcus, label: "Coach (sample)", rate: "16.50", effectiveFrom: "2025-01-01" }));
  await tx((t) => setPayRate(t, rod, { userId: ctx.users.tess, label: "Coach (sample)", rate: "15.00", effectiveFrom: "2025-01-01" }));
});
afterAll(closeTestDb);

describe("clock in/out and the one-open-entry rule", () => {
  it("a staff member clocks in and out; a second clock-in while open is refused", async () => {
    const r1 = await tx((t) => clock(t, tess, { op: "in", now: at("2026-02-10", "16:00") }));
    expect(r1.action).toBe("in");
    await expect(tx((t) => clock(t, tess, { op: "in", now: at("2026-02-10", "16:05") }))).rejects.toThrow(/Already clocked in/);
    const r2 = await tx((t) => clock(t, tess, { op: "toggle", now: at("2026-02-10", "20:00") }));
    expect(r2.action).toBe("out");
    expect(r2.shiftMs).toBe(4 * 3_600_000);
    await expect(tx((t) => clock(t, tess, { op: "out", now: at("2026-02-10", "20:05") }))).rejects.toThrow(/Not clocked in/);
    const [row] = await db().select().from(timeEntries).where(eq(timeEntries.id, r1.entryId));
    expect(row.source).toBe("staff");
    expect(row.originalClockOut?.toISOString()).toBe(at("2026-02-10", "20:00").toISOString());
  });

  it("concurrent clock-ins for the same person: exactly one open entry survives (DB constraint)", async () => {
    const now = at("2026-02-11", "15:30");
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => tx((t) => clock(t, marcus, { op: "in", now }))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(UserError);
    const open = await db().select().from(timeEntries).where(and(eq(timeEntries.userId, ctx.users.marcus), sql`clock_out is null`));
    expect(open).toHaveLength(1);
    // Even a raw insert bypassing the service is rejected by the partial unique index.
    await expect(db().insert(timeEntries).values({ orgId: ctx.orgId, userId: ctx.users.marcus, clockIn: now, originalClockIn: now, source: "manual" })).rejects.toThrow();
    await tx((t) => clock(t, marcus, { op: "out", now: at("2026-02-11", "19:30") }));
  });

  it("kiosk time clock by staff PIN toggles in/out; wrong PINs are rate limited; PIN stored only as a hash", async () => {
    await expect(tx((t) => setStaffClockPin(t, marcus, { userId: ctx.users.marcus, pin: "1234" }))).rejects.toThrow(/easy to guess/);
    await tx((t) => setStaffClockPin(t, marcus, { userId: ctx.users.marcus, pin: "48263" }));
    await expect(tx((t) => setStaffClockPin(t, tess, { userId: ctx.users.marcus, pin: "59173" }))).rejects.toBeInstanceOf(AuthzError);
    await expect(tx((t) => setStaffClockPin(t, rod, { userId: ctx.users.tess, pin: "48263" }))).rejects.toThrow(/isn't available/);
    const [pinRow] = await db().select().from(staffClockPins).where(eq(staffClockPins.userId, ctx.users.marcus));
    expect(pinRow.pinHash).not.toContain("48263");

    const r1 = await tx((t) => kioskStaffClock(t, kiosk, { pin: "48263", sessionKey: "k1", now: at("2026-02-13", "15:30") }));
    expect(r1).toMatchObject({ ok: true, action: "in", userId: ctx.users.marcus });
    const r2 = await tx((t) => kioskStaffClock(t, kiosk, { pin: "48263", sessionKey: "k1", now: at("2026-02-13", "19:31") }));
    expect(r2).toMatchObject({ ok: true, action: "out" });
    const [entry] = await db().select().from(timeEntries).where(eq(timeEntries.id, (r1 as { entryId: string }).entryId));
    expect(entry.source).toBe("kiosk");
    expect(entry.createdBy).toBe(ctx.users.kiosk);

    let last;
    for (let i = 0; i < STAFF_PIN_MAX_FAILED; i++) last = await tx((t) => kioskStaffClock(t, kiosk, { pin: "99881", sessionKey: "k2", now: at("2026-02-13", "20:00") }));
    expect(last).toMatchObject({ ok: false, reason: "locked" });
    const locked = await tx((t) => kioskStaffClock(t, kiosk, { pin: "48263", sessionKey: "k2", now: at("2026-02-13", "20:01") }));
    expect(locked).toMatchObject({ ok: false, reason: "locked" });
    // Only the kiosk login uses the PIN path; staff use their own session.
    await expect(tx((t) => kioskStaffClock(t, marcus, { pin: "48263", sessionKey: "k3" }))).rejects.toBeInstanceOf(AuthzError);
  });
});

describe("permissions", () => {
  it("a coach can clock and see only themselves; no payroll", async () => {
    await expect(tx((t) => clock(t, marcus, { op: "in", userId: ctx.users.tess, now: at("2026-02-12", "16:00") }))).rejects.toBeInstanceOf(AuthzError);
    const own = await tx((t) => listEntries(t, marcus, { from: "2026-02-01", to: "2026-02-28" }));
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((r) => r.userId === ctx.users.marcus)).toBe(true);
    await expect(tx((t) => listEntries(t, marcus, { userId: ctx.users.tess, from: "2026-02-01", to: "2026-02-28" }))).rejects.toBeInstanceOf(AuthzError);
    await expect(tx((t) => calculatePayroll(t, marcus, { from: "2026-02-01", to: "2026-02-14" }))).rejects.toBeInstanceOf(AuthzError);
    await expect(tx((t) => editEntry(t, marcus, { entryId: own[0].id, clockOut: at("2026-02-11", "20:00"), reason: "left late" }))).rejects.toBeInstanceOf(AuthzError);
    await expect(tx((t) => setPayRate(t, marcus, { userId: ctx.users.marcus, label: "x", rate: "99", effectiveFrom: "2026-01-01" }))).rejects.toBeInstanceOf(AuthzError);
  });

  it("non-staff and the kiosk login cannot use the staff clock", async () => {
    await expect(tx((t) => clock(t, alex, { op: "in" }))).rejects.toBeInstanceOf(AuthzError);
    await expect(tx((t) => clock(t, kiosk, { op: "in" }))).rejects.toBeInstanceOf(AuthzError);
    await expect(tx((t) => listEntries(t, alex, { from: "2026-02-01", to: "2026-02-28" }))).rejects.toBeInstanceOf(AuthzError);
  });

  it("operations has no payroll access unless an owner grants it; grants only go to operations staff", async () => {
    expect(await canManagePayroll(db(), erin)).toBe(false);
    await expect(tx((t) => calculatePayroll(t, erin, { from: "2026-02-01", to: "2026-02-14" }))).rejects.toBeInstanceOf(AuthzError);
    const base = { deductionBps: 1700, rounding: "truncate_2dp", thresholds: DEFAULT_THRESHOLDS, importMapping: DEFAULT_IMPORT_MAPPING };
    await expect(tx((t) => updatePayrollSettings(t, erin, { ...base, accessUserIds: [ctx.users.erin] }))).rejects.toBeInstanceOf(AuthzError);
    await expect(tx((t) => updatePayrollSettings(t, rod, { ...base, accessUserIds: [ctx.users.marcus] }))).rejects.toThrow(/operations staff/);
    await tx((t) => updatePayrollSettings(t, rod, { ...base, accessUserIds: [ctx.users.erin] }));
    expect(await canManagePayroll(db(), erin)).toBe(true);
    await expect(tx((t) => calculatePayroll(t, erin, { from: "2026-02-01", to: "2026-02-14" }))).resolves.toBeTruthy();
    // …but granted operations still can't change payroll settings / grants.
    await expect(tx((t) => updatePayrollSettings(t, erin, { ...base, accessUserIds: [] }))).rejects.toBeInstanceOf(AuthzError);
    await tx((t) => updatePayrollSettings(t, rod, { ...base, accessUserIds: [] }));
    expect(await canManagePayroll(db(), erin)).toBe(false);
  });
});

describe("corrections are reasoned, audited, and keep the original values", () => {
  it("owner corrects a missed clock-out; originals preserved; audit has before/after and reason", async () => {
    const r = await tx((t) => clock(t, tess, { op: "in", now: at("2026-02-17", "16:00") }));
    await expect(tx((t) => editEntry(t, rod, { entryId: r.entryId, clockOut: at("2026-02-17", "20:00"), reason: "" }))).rejects.toBeInstanceOf(ZodError);
    await expect(tx((t) => editEntry(t, rod, { entryId: r.entryId, clockOut: at("2026-02-17", "15:00"), reason: "Forgot to clock out" }))).rejects.toThrow(/after clock-in/);
    await tx((t) => editEntry(t, rod, { entryId: r.entryId, clockOut: at("2026-02-17", "20:02"), reason: "Forgot to clock out; confirmed by text" }));
    const [row] = await db().select().from(timeEntries).where(eq(timeEntries.id, r.entryId));
    expect(row.clockOut?.toISOString()).toBe(at("2026-02-17", "20:02").toISOString());
    expect(row.originalClockOut).toBeNull(); // never actually clocked out
    expect(row.originalClockIn.toISOString()).toBe(at("2026-02-17", "16:00").toISOString());
    expect(row.editReason).toMatch(/confirmed by text/);
    expect(row.editedBy).toBe(ctx.users.rod);

    await tx((t) => editEntry(t, rod, { entryId: r.entryId, clockIn: at("2026-02-17", "15:55"), reason: "Arrived early per schedule" }));
    const [row2] = await db().select().from(timeEntries).where(eq(timeEntries.id, r.entryId));
    expect(row2.originalClockIn.toISOString()).toBe(at("2026-02-17", "16:00").toISOString());

    const audits = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, r.entryId), eq(auditEvents.action, "time_entry.edit"))).orderBy(auditEvents.createdAt);
    expect(audits).toHaveLength(2);
    expect(audits[0].actorUserId).toBe(ctx.users.rod);
    expect(JSON.stringify(audits[0].after)).toMatch(/confirmed by text/);
    expect((audits[0].before as { clockOut: string | null }).clockOut).toBeNull();

    // The DB itself refuses to rewrite originals or delete entries.
    await expect(db().update(timeEntries).set({ originalClockIn: at("2026-02-17", "09:00") }).where(eq(timeEntries.id, r.entryId))).rejects.toThrow();
    await expect(db().delete(timeEntries).where(eq(timeEntries.id, r.entryId))).rejects.toThrow();
  });

  it("manual add, void and flag acknowledgement require a reason and are audited", async () => {
    await expect(tx((t) => addManualEntry(t, rod, { userId: ctx.users.tess, clockIn: at("2026-02-19", "16:00"), clockOut: at("2026-02-19", "20:00"), reason: "x" }))).rejects.toBeInstanceOf(ZodError);
    const m = await tx((t) => addManualEntry(t, rod, { userId: ctx.users.tess, clockIn: at("2026-02-19", "16:00"), clockOut: at("2026-02-19", "20:00"), reason: "Kiosk was offline" }));
    expect(m.source).toBe("manual");
    await tx((t) => acknowledgeFlag(t, rod, { entryId: m.id, code: "tiny", note: "Short demo session" }));
    await expect(tx((t) => acknowledgeFlag(t, rod, { entryId: m.id, code: "no_rate", note: "nope nope" }))).rejects.toThrow(/can't be acknowledged/);
    await tx((t) => voidEntry(t, rod, { entryId: m.id, reason: "Duplicate of kiosk entry" }));
    const actions = (await db().select({ a: auditEvents.action }).from(auditEvents).where(eq(auditEvents.entityId, m.id))).map((r) => r.a);
    expect(actions).toEqual(expect.arrayContaining(["time_entry.manual_add", "time_entry.flag_ack", "time_entry.void"]));
    await expect(tx((t) => editEntry(t, rod, { entryId: m.id, clockOut: at("2026-02-19", "20:30"), reason: "late" }))).rejects.toThrow(/voided/);
  });
});

describe("payroll runs: flags → resolve → approve → export", () => {
  it("blocks approval on a runaway + stray clock-out, then approves once resolved; approved runs are immutable", async () => {
    // Marcus: Mon/Wed/Fri 15:30–19:30 history, then a runaway Wednesday and the stray clock-out Thursday.
    const hist: (typeof timeEntries.$inferInsert)[] = [];
    for (let d = "2026-01-05"; d <= "2026-02-27"; d = addDaysYmd(d, 1)) {
      const wd = new Date(d + "T12:00:00Z").getUTCDay();
      if ((wd === 1 || wd === 3 || wd === 5) && !["2026-02-11", "2026-02-13", "2026-02-25"].includes(d))
        hist.push({ orgId: ctx.orgId, userId: ctx.users.marcus, clockIn: at(d, "15:30"), clockOut: at(d, "19:30"), originalClockIn: at(d, "15:30"), originalClockOut: at(d, "19:30"), source: "import" });
    }
    await db().insert(timeEntries).values(hist);
    const runaway = await tx((t) => clock(t, marcus, { op: "in", now: at("2026-02-25", "15:32") }));
    await tx((t) => clock(t, marcus, { op: "out", now: at("2026-02-26", "06:14") }));
    const orphanIn = await tx((t) => clock(t, marcus, { op: "in", now: at("2026-02-26", "06:14") }));
    await tx((t) => clock(t, marcus, { op: "out", now: at("2026-02-26", "06:19") }));
    const now = at("2026-03-02", "12:00");

    const res = await tx((t) => calculatePayroll(t, rod, { from: "2026-02-23", to: "2026-03-01", now }));
    const m = res.employees.find((e) => e.userId === ctx.users.marcus)!;
    const codes = m.rows.flatMap((r) => r.flags.map((f) => f.code));
    expect(codes).toEqual(expect.arrayContaining(["runaway", "orphan"]));
    expect(m.blockingOpen).toBe(2);

    const run = await tx((t) => createRun(t, rod, { from: "2026-02-23", to: "2026-03-01", now }));
    await expect(tx((t) => approveRun(t, rod, run.id))).rejects.toThrow(/Resolve the 2 open flag/);

    await tx((t) => editEntry(t, rod, { entryId: runaway.entryId, clockOut: at("2026-02-25", "19:47"), reason: "Real clock-out per coach", now }));
    await tx((t) => voidEntry(t, rod, { entryId: orphanIn.entryId, reason: "Stray clock-out tap" }));
    await tx((t) => recalculateRun(t, rod, run.id, now));
    await tx((t) => approveRun(t, rod, run.id));

    const [saved] = await db().select().from(payrollRuns).where(eq(payrollRuns.id, run.id));
    expect(saved.status).toBe("approved");
    // Mon 4 h + Wed 4.25 h + Fri 4 h at $16.50 (truncate rule): 1650×4 + 1650×4.25 + 1650×4 = 20 212.5 → per-shift cents.
    expect(saved.grossMinor).toBe(6600 + 7013 + 6600);
    expect(saved.deductionMinor).toBe(Math.round((20213 * 1700) / 10000));
    expect(saved.netMinor).toBe(saved.grossMinor - saved.deductionMinor);

    await expect(db().update(payrollRuns).set({ grossMinor: 1 }).where(eq(payrollRuns.id, run.id))).rejects.toThrow();
    await expect(db().delete(payrollRuns).where(eq(payrollRuns.id, run.id))).rejects.toThrow();
    await expect(tx((t) => exportRun(t, marcus, run.id))).rejects.toBeInstanceOf(AuthzError);

    const { csv, filename } = await tx((t) => exportRun(t, rod, run.id));
    expect(filename).toBe("teamwork-payroll-2026-02-23-to-2026-03-01.csv");
    expect(csv).toMatch(/COMBINED,12\.25,202\.13,34\.36,167\.77/);
    expect(csv).toMatch(/confirm with your accountant/);
    const [exported] = await db().select().from(payrollRuns).where(eq(payrollRuns.id, run.id));
    expect(exported.status).toBe("exported");
    const runAudits = (await db().select({ a: auditEvents.action }).from(auditEvents).where(eq(auditEvents.entityId, run.id))).map((r) => r.a);
    expect(runAudits).toEqual(expect.arrayContaining(["payroll.run_create", "payroll.run_recalculate", "payroll.run_approve", "payroll.run_export"]));
  });

  it("deduction percent and rounding rule are settings", async () => {
    const base = { thresholds: DEFAULT_THRESHOLDS, importMapping: DEFAULT_IMPORT_MAPPING, accessUserIds: [] };
    await tx((t) => updatePayrollSettings(t, rod, { ...base, deductionBps: 2000, rounding: "exact" }));
    expect((await payrollConfig(db(), ctx.orgId)).deductionBps).toBe(2000);
    const res = await tx((t) => calculatePayroll(t, rod, { from: "2026-02-23", to: "2026-03-01", now: at("2026-03-02", "12:00") }));
    expect(res.rounding).toBe("exact");
    const m = res.employees.find((e) => e.userId === ctx.users.marcus)!;
    expect(m.actual.grossMinor).toBe(6600 + 7013 + 6600); // 4.25 h is exact either way here
    expect(m.actual.deductionMinor).toBe(Math.round(m.actual.grossMinor * 0.2));
    await tx((t) => updatePayrollSettings(t, rod, { ...base, deductionBps: 1700, rounding: "truncate_2dp" }));
  });
});

describe("Zen Planner import", () => {
  const paste = [
    "Mon, 02 Feb 2026 | Coach (sample) | $15.00 / hour | 4:00 PM | 8:00 PM | 4.00 hours | $60.00",
    "Tue, 03 Feb 2026 | Add",
    "Thu, 05 Feb 2026 | Coach (sample) | $15.00 / hour | 4:01 PM | 8:16 PM | 4.25 hours | $63.75",
    "Sat, 07 Feb 2026 | Coach (sample) | $15.00 / hour | 9:00 AM |  | 0.00 hours | $0.00",
  ].join("\n");

  it("previews without writing, commits as source=import, and skips duplicates on re-import", async () => {
    await expect(tx((t) => importZenPlanner(t, marcus, { userId: ctx.users.tess, text: paste, commit: false }))).rejects.toBeInstanceOf(AuthzError);
    const preview = await tx((t) => importZenPlanner(t, rod, { userId: ctx.users.tess, text: paste, commit: false }));
    expect(preview.rows.map((r) => r.status)).toEqual(["entry", "no_entry", "entry", "error"]);
    expect(preview.created).toBe(0);
    expect(preview.configuredRateMinor).toBe(1500);
    const before = await db().select().from(timeEntries).where(and(eq(timeEntries.userId, ctx.users.tess), eq(timeEntries.source, "import")));
    expect(before).toHaveLength(0);

    const done = await tx((t) => importZenPlanner(t, rod, { userId: ctx.users.tess, text: paste, commit: true }));
    expect(done.created).toBe(2);
    const again = await tx((t) => importZenPlanner(t, rod, { userId: ctx.users.tess, text: paste, commit: true }));
    expect(again.created).toBe(0);
    expect(again.duplicates).toBe(2);
    const rows = await db().select().from(timeEntries).where(and(eq(timeEntries.userId, ctx.users.tess), eq(timeEntries.source, "import")));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.importRaw).join("\n")).toMatch(/04 Feb|05 Feb/);
    const res = await tx((t) => calculatePayroll(t, rod, { from: "2026-02-02", to: "2026-02-08", now: at("2026-03-02", "12:00") }));
    const tessRes = res.employees.find((e) => e.userId === ctx.users.tess)!;
    expect(tessRes.actual.hoursHundredths).toBe(400 + 425);
    expect(tessRes.actual.grossMinor).toBe(6000 + 6375);
  });
});

describe("seeded demo data", () => {
  it("the synthetic payroll seed exercises every detector", async () => {
    const demo = await seedOrg("2026-03-02", { modules: ["payroll"] });
    const owner = await viewerFor(demo, "rod");
    const res = await testDb().transaction((t) => calculatePayroll(t, owner, { from: addDaysYmd("2026-03-02", -14), to: addDaysYmd("2026-03-02", 6), now: localToUtc("2026-03-02", "12:00", demo.tz) }));
    const codes = new Set(res.employees.flatMap((e) => e.rows.flatMap((r) => r.flags.map((f) => f.code))));
    for (const c of ["runaway", "orphan", "tiny", "missing_expected_day", "off_pattern_start", "missed_clock_out"]) expect(codes, c).toContain(c);
    expect(res.employees.some((e) => e.rows.some((r) => r.kind === "estimate" && r.hoursHundredths > 0))).toBe(true);
    expect(res.employees.map((e) => e.name).join(" ")).not.toMatch(/Kiosk/);
  });
});
