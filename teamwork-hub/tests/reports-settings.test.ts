import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { authSessions, users } from "@/db/schema";
import { REPORTS, toCsv } from "@/lib/reports";
import { changeRole, inviteUser, redeemToken, setUserDisabled } from "@/lib/auth/accounts";
import { sha256 } from "@/lib/auth/session";
import { recheckIntegrations, updateOrgSettings } from "@/lib/settings";
import { missingRequiredForms, paymentExceptionsSummary, integrationHealth, familyAthletes, todaysSessions } from "@/lib/dashboards";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
beforeAll(async () => {
  ctx = await seedOrg();
});
afterAll(closeTestDb);

describe("reports", () => {
  it.each(REPORTS.map((r) => [r.key, r] as const))("%s runs and returns its declared columns", async (_k, def) => {
    const res = await def.run(testDb(), ctx.orgId, { from: "2026-02-01", to: "2026-03-02", tz: ctx.tz });
    expect(Array.isArray(res.rows)).toBe(true);
    const csv = toCsv(def.columns, res.rows);
    expect(csv.split("\n")[0].split(",").length).toBe(def.columns.length);
  });

  it("CSV export neutralizes formula injection but keeps negative numbers", () => {
    const csv = toCsv([{ key: "a", label: "A" }, { key: "b", label: "B", kind: "int" }, { key: "m", label: "M", kind: "money" }], [{ a: "=HYPERLINK(\"x\")", b: -5, m: 1999 }]);
    const line = csv.split("\n")[1];
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
    expect(line).toContain(",-5,");
    expect(line.endsWith("19.99")).toBe(true);
  });

  it("dashboard queries run for staff and families", async () => {
    const db = testDb();
    await todaysSessions(db, ctx.orgId, { day: "2026-03-02" });
    await missingRequiredForms(db, ctx.orgId);
    const pay = await paymentExceptionsSummary(db, ctx.orgId);
    expect(pay.past_due).toBeTypeOf("number");
    const h = await integrationHealth(db, ctx.orgId);
    expect(h.integrations.find((i) => i.provider === "stripe")?.status).toBe("not_configured");
    const alex = await viewerFor(ctx, "alex");
    const kids = await familyAthletes(db, alex);
    expect(kids.map((k) => k.athleteId).sort()).toEqual([ctx.athletes.eli, ctx.athletes.maya].sort());
    const jordan = await viewerFor(ctx, "jordan");
    const jKids = await familyAthletes(db, jordan);
    expect(jKids.every((k) => !k.caps.includes("health.read"))).toBe(true);
  });
});

describe("accounts & settings", () => {
  it("invite → redeem sets a password once; token cannot be reused", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    const { token, userId } = await db.transaction((tx) => inviteUser(tx, rod, { email: "newcoach@example.test", role: "coach", displayName: "New Coach" }));
    const [stored] = await db.select().from(users).where(eq(users.id, userId));
    expect(stored.inviteTokenHash).toBe(sha256(token));
    expect(stored.inviteTokenHash).not.toBe(token);
    await expect(db.transaction((tx) => redeemToken(tx, "invite", token, "short"))).rejects.toThrow();
    await db.transaction((tx) => redeemToken(tx, "invite", token, "a-long-password-123"));
    await expect(db.transaction((tx) => redeemToken(tx, "invite", token, "a-long-password-123"))).rejects.toThrow(/invalid or has expired/);
  });

  it("only the owner can grant admin; operations can't manage users; disabling revokes sessions", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    const erin = await viewerFor(ctx, "erin");
    await expect(db.transaction((tx) => inviteUser(tx, erin, { email: "x@example.test", role: "coach", displayName: "X" }))).rejects.toThrow();
    await db.transaction((tx) => changeRole(tx, rod, ctx.users.tess, "admin"));
    const tessAdmin = await viewerFor(ctx, "tess");
    await expect(db.transaction((tx) => changeRole(tx, tessAdmin, ctx.users.marcus, "admin"))).rejects.toThrow(/Only the owner/);
    await db.insert(authSessions).values({ userId: ctx.users.marcus, tokenHash: sha256("marcus-session"), expiresAt: new Date(Date.now() + 3600_000) });
    await db.transaction((tx) => setUserDisabled(tx, rod, ctx.users.marcus, true));
    const [s] = await db.select().from(authSessions).where(eq(authSessions.tokenHash, sha256("marcus-session")));
    expect(s.revokedAt).not.toBeNull();
    await db.transaction((tx) => setUserDisabled(tx, rod, ctx.users.marcus, false));
    await db.transaction((tx) => changeRole(tx, rod, ctx.users.tess, "coach"));
  });

  it("settings validate and integration re-check never claims verification without credentials", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    await expect(db.transaction((tx) => updateOrgSettings(tx, rod, { displayName: "T", primaryColor: "blue" }))).rejects.toThrow();
    await db.transaction((tx) =>
      updateOrgSettings(tx, rod, {
        displayName: "Teamwork",
        primaryColor: "#123456",
        requireStaffMfa: false,
        pendingBankPaymentPolicy: "grant_on_settlement",
        bookingWindowDays: 14,
        familyBookingCutoffMinutes: 30,
        quietStart: "21:00",
        quietEnd: "07:00",
        minorsReceiveDirectMessages: false,
      }),
    );
    const saved = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    await db.transaction((tx) => recheckIntegrations(tx, rod));
    const h = await integrationHealth(db, ctx.orgId);
    expect(h.integrations.find((i) => i.provider === "stripe")?.status).toBe("not_configured");
    if (saved) process.env.STRIPE_SECRET_KEY = saved;
    const marcus = await viewerFor(ctx, "marcus");
    await expect(db.transaction((tx) => recheckIntegrations(tx, marcus))).rejects.toThrow();
  });
});
