import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { and, asc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { workouts } from "@/db/schema";
import { buildCsp, proxy, TRAINING_SW_PATH } from "@/proxy";
import { offlineOwnerKey, offlineTodayPayload } from "@/lib/training/offline";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
beforeAll(async () => {
  ctx = await seedOrg("2026-03-02", { modules: ["training"] });
});
afterAll(closeTestDb);

describe("offline copy for the athlete logger", () => {
  it("only athletes get an owner key; it is per user and reveals no id", async () => {
    const maya = await viewerFor(ctx, "maya");
    const dana = await viewerFor(ctx, "dana");
    const km = offlineOwnerKey(maya)!;
    expect(km).toMatch(/^[a-f0-9]{32}$/);
    expect(offlineOwnerKey(dana)).not.toBe(km);
    expect(km).not.toContain(maya.userId.replace(/-/g, "").slice(0, 8));
    for (const who of ["marcus", "rod", "alex", "erin"]) expect(offlineOwnerKey(await viewerFor(ctx, who))).toBeNull();
    expect(await offlineTodayPayload(testDb(), await viewerFor(ctx, "marcus"))).toBeNull();
    expect(await offlineTodayPayload(testDb(), await viewerFor(ctx, "alex"))).toBeNull();
  });

  it("holds only the athlete's own workouts for the day, minimized (no names, coach feedback, or other athletes)", async () => {
    const maya = await viewerFor(ctx, "maya");
    const [w] = await testDb()
      .select()
      .from(workouts)
      .where(and(eq(workouts.orgId, ctx.orgId), eq(workouts.athleteId, ctx.athletes.maya)))
      .orderBy(asc(workouts.scheduledDate));
    expect(w).toBeTruthy();
    // Give it coach feedback to prove it is stripped.
    await testDb().update(workouts).set({ coachFeedback: "Secret coach note" }).where(eq(workouts.id, w.id));
    const others = await testDb().select({ id: workouts.id, athleteId: workouts.athleteId }).from(workouts).where(and(eq(workouts.orgId, ctx.orgId), eq(workouts.scheduledDate, w.scheduledDate)));
    expect(others.some((o) => o.athleteId !== ctx.athletes.maya)).toBe(true); // teammates train the same day

    const p = (await offlineTodayPayload(testDb(), maya, w.scheduledDate))!;
    expect(p.owner).toBe(offlineOwnerKey(maya));
    expect(p.date).toBe(w.scheduledDate);
    expect(p.workouts.map((x) => x.id)).toEqual(others.filter((o) => o.athleteId === ctx.athletes.maya).map((o) => o.id));
    const text = JSON.stringify(p);
    expect(text).not.toMatch(/Maya|Parker|Secret coach note|athleteName|athleteId|coachFeedback|substitutionOptions|coachReviewedBy|assignmentId|orgId/);
    for (const o of others.filter((x) => x.athleteId !== ctx.athletes.maya)) expect(text).not.toContain(o.id);
    // Still has what the logger needs.
    const item = p.workouts[0].items[0];
    expect(item.sets.length).toBeGreaterThan(0);
    expect(item.performed.name).toBeTruthy();
    expect(Object.keys(p.workouts[0]).sort()).toEqual(["athleteComment", "durationMinutes", "id", "items", "scheduledDate", "sessionRpe", "status", "title"]);
  });
});

describe("service worker delivery", () => {
  it("page CSP allows only same-origin workers", () => {
    const csp = buildCsp({ nonce: "n", pathname: "/training/today", isDev: false, https: true });
    expect(csp).toContain("worker-src 'self';");
    expect(csp).not.toContain("blob:;");
    expect(csp).toContain("manifest-src 'self'");
  });

  it("the worker script gets its own strict CSP (no nonce) and is revalidated on every update check", () => {
    const res = proxy(new NextRequest(`http://localhost:3105${TRAINING_SW_PATH}`));
    expect(res.headers.get("location")).toBeNull(); // never redirected to /login
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toContain("nonce");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("the worker only intercepts its scope, the today data endpoint and static assets; never POSTs", () => {
    const src = readFileSync("public/training-sw.js", "utf8");
    expect(src).toMatch(/if \(req\.method !== "GET"\) return;/);
    expect(src).toContain('const SCOPE_PATH = "/training/today"');
    expect(src).toContain('const DATA_PATH = "/api/training/today"');
    // No other API path is referenced (the set queue POSTs straight to the network).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(new Set(code.match(/\/api\/[a-z/]+/g))).toEqual(new Set(["/api/training/today"]));
  });
});
