import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { athleteCheckinPins, auditEvents, bookings, organizations } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { AuthzError } from "@/lib/authz/policy";
import { bookSession, kioskCheckIn, kioskPinCheckIn, kioskRoster, setCheckInPin, KIOSK_PIN_MAX_FAILED } from "@/lib/scheduling";
import { addDaysYmd, localToUtc, todayLocal } from "@/lib/time";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { giveCredits, mkSession } from "./scheduling-helpers";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
const db = () => testDb();

beforeAll(async () => {
  ctx = await seedOrg();
  await db().execute(sql`update memberships set status = 'cancelled' where org_id = ${ctx.orgId}`);
  for (const k of ["eli", "maya", "leo"]) await giveCredits(ctx, k, 10);
});
afterAll(closeTestDb);

/** A session tomorrow 10:00 local and a "now" of tomorrow 09:45 (inside the check-in window). */
async function tomorrowSession(athleteKey: string) {
  const tz = ctx.tz;
  const day = addDaysYmd(todayLocal(tz), 1);
  const s = await mkSession(ctx, { startsAt: localToUtc(day, "10:00", tz), title: `PIN class ${randomUUID().slice(0, 4)}` });
  const erin = await viewerFor(ctx, "erin");
  const b = await db().transaction((tx) => bookSession(tx, erin, { sessionId: s.id, athleteId: ctx.athletes[athleteKey] }));
  return { s, b, now: localToUtc(day, "09:45", tz), day };
}

describe("setting a kiosk check-in PIN", () => {
  it("guardians with booking rights and staff can set it; it is stored only as a keyed hash; trivial or duplicate PINs are refused", async () => {
    const alex = await viewerFor(ctx, "alex");
    const casey = await viewerFor(ctx, "casey");
    const chris = await viewerFor(ctx, "chris");
    const sam = await viewerFor(ctx, "sam");
    const kiosk = await viewerFor(ctx, "kiosk");
    const set = (v: Awaited<ReturnType<typeof viewerFor>>, k: string, pin: string | null) => db().transaction((tx) => setCheckInPin(tx, v, { athleteId: ctx.athletes[k], pin }));

    await expect(set(alex, "eli", "1234")).rejects.toThrow(/easy to guess/);
    await expect(set(alex, "eli", "7777")).rejects.toThrow(/easy to guess/);
    await expect(set(alex, "eli", "12a4")).rejects.toThrow(/4 to 6 digits/);
    await expect(set(alex, "eli", "1234567")).rejects.toThrow(/4 to 6 digits/);
    await set(alex, "eli", "4826");
    await expect(set(chris, "eli", "5917")).rejects.toBeInstanceOf(AuthzError); // not Eli's guardian
    await expect(set(casey, "leo", "5917")).rejects.toBeInstanceOf(AuthzError); // can't book for Leo
    await expect(set(kiosk, "leo", "5917")).rejects.toBeInstanceOf(AuthzError);
    await expect(set(sam, "leo", "4826")).rejects.toThrow(/isn't available/);
    await set(sam, "leo", "591730");

    const rows = await db().select().from(athleteCheckinPins).where(eq(athleteCheckinPins.orgId, ctx.orgId));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.pinHash).not.toMatch(/4826|591730/);
      expect(r.pinHash.length).toBeGreaterThanOrEqual(40);
    }
    const audits = await db().select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "athlete.checkin_pin_set")));
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toMatch(/4826|591730/);
  });
});

describe("kiosk check-in by PIN", () => {
  it("checks the athlete in and shows only First L.; second entry says already checked in", async () => {
    const alex = await viewerFor(ctx, "alex");
    await db().transaction((tx) => setCheckInPin(tx, alex, { athleteId: ctx.athletes.eli, pin: "4826" }));
    const { b, now } = await tomorrowSession("eli");
    const kiosk = await viewerFor(ctx, "kiosk");
    const key = `k-${randomUUID()}`;
    const r = await db().transaction((tx) => kioskPinCheckIn(tx, kiosk, { pin: "4826", sessionKey: key, now }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.displayName).toBe("Eli P.");
    expect(Object.keys(r).sort()).toEqual(["alerts", "displayName", "ok", "sessions"]);
    expect(r.sessions.map((x) => x.result)).toContain("checked_in");
    expect(JSON.stringify(r)).not.toMatch(/Parker|bookingId|athleteId|@/);
    const [row] = await db().select().from(bookings).where(eq(bookings.id, b.booking.id));
    expect(row.status).toBe("attended");
    expect(row.checkInMethod).toBe("kiosk");
    const again = await db().transaction((tx) => kioskPinCheckIn(tx, kiosk, { pin: "4826", sessionKey: key, now }));
    expect(again.ok && again.sessions.some((x) => x.result === "already_checked_in")).toBe(true);
    // Guardians can't use the kiosk endpoint.
    await expect(db().transaction((tx) => kioskPinCheckIn(tx, alex, { pin: "4826", sessionKey: key, now }))).rejects.toBeInstanceOf(AuthzError);
  });

  it("rate-limits wrong PINs per kiosk session and locks for a few minutes", async () => {
    const kiosk = await viewerFor(ctx, "kiosk");
    const alex = await viewerFor(ctx, "alex");
    await db().transaction((tx) => setCheckInPin(tx, alex, { athleteId: ctx.athletes.maya, pin: "3071" }));
    const { now } = await tomorrowSession("maya");
    const key = `k-${randomUUID()}`;
    const attempt = (pin: string, at = now, k = key) => db().transaction((tx) => kioskPinCheckIn(tx, kiosk, { pin, sessionKey: k, now: at }));
    expect(await attempt("12")).toEqual({ ok: false, reason: "invalid_format" }); // not counted
    for (let i = 1; i < KIOSK_PIN_MAX_FAILED; i++) expect(await attempt("9999")).toEqual({ ok: false, reason: "no_match", attemptsLeft: KIOSK_PIN_MAX_FAILED - i });
    const locked = await attempt("9999");
    expect(locked).toMatchObject({ ok: false, reason: "locked" });
    // Even the right PIN is refused while locked…
    expect(await attempt("3071")).toMatchObject({ ok: false, reason: "locked" });
    // …but another kiosk session is unaffected, and the lock expires.
    expect((await attempt("3071", now, `k-${randomUUID()}`)).ok).toBe(true);
    expect((await attempt("3071", new Date(now.getTime() + 6 * 60_000))).ok).toBe(true);
    const lockAudit = await db().select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "kiosk.pin_lockout")));
    expect(lockAudit.length).toBeGreaterThanOrEqual(1);
  });

  it("concurrent wrong guesses from one kiosk session can't exceed the limit", async () => {
    const kiosk = await viewerFor(ctx, "kiosk");
    const key = `k-${randomUUID()}`;
    const now = new Date();
    const res = await Promise.all(Array.from({ length: 12 }, (_, i) => db().transaction((tx) => kioskPinCheckIn(tx, kiosk, { pin: String(800000 + i * 7), sessionKey: key, now }))));
    expect(res.filter((r) => !r.ok && r.reason === "no_match")).toHaveLength(KIOSK_PIN_MAX_FAILED - 1);
    expect(res.filter((r) => !r.ok && r.reason === "locked")).toHaveLength(12 - (KIOSK_PIN_MAX_FAILED - 1));
  });

  it("PIN-only mode: the kiosk never gets a name list and can't check in by booking id; staff still see the roster", async () => {
    const { s, b, now } = await tomorrowSession("leo");
    const kiosk = await viewerFor(ctx, "kiosk");
    const erin = await viewerFor(ctx, "erin");
    await db().execute(sql`update organizations set settings = settings || '{"kioskPinOnly": true}'::jsonb where id = ${ctx.orgId}`);
    try {
      expect(await db().transaction((tx) => kioskRoster(tx, kiosk, { now }))).toEqual([]);
      await expect(db().transaction((tx) => kioskCheckIn(tx, kiosk, { bookingId: b.booking.id, now }))).rejects.toBeInstanceOf(UserError);
      const staffView = await db().transaction((tx) => kioskRoster(tx, erin, { now }));
      expect(staffView.find((x) => x.id === s.id)).toBeTruthy();
    } finally {
      await db().update(organizations).set({ settings: sql`settings - 'kioskPinOnly'` }).where(eq(organizations.id, ctx.orgId));
    }
  });

  it("a cleared PIN no longer matches", async () => {
    const sam = await viewerFor(ctx, "sam");
    const kiosk = await viewerFor(ctx, "kiosk");
    await db().transaction((tx) => setCheckInPin(tx, sam, { athleteId: ctx.athletes.leo, pin: "662019" }));
    const key = `k-${randomUUID()}`;
    expect((await db().transaction((tx) => kioskPinCheckIn(tx, kiosk, { pin: "662019", sessionKey: key }))).ok).toBe(true);
    await db().transaction((tx) => setCheckInPin(tx, sam, { athleteId: ctx.athletes.leo, pin: null }));
    expect(await db().transaction((tx) => kioskPinCheckIn(tx, kiosk, { pin: "662019", sessionKey: key }))).toMatchObject({ ok: false, reason: "no_match" });
  });
});
