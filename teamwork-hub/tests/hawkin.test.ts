import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { importBatches, integrations, metricValues, rawSignals, syncRuns } from "@/db/schema";
import { closeTestDb, seedOrg, viewerFor } from "./helpers/db";
import { db, FIXTURES, tx } from "./imports.helpers";
import { HawkinClient, HawkinError } from "@/lib/integrations/hawkin/client";
import { runHawkinSync } from "@/lib/integrations/hawkin/sync";
import { commitBatch, resolveIdentity, reviewGroups } from "@/lib/imports/batches";
import type { Viewer } from "@/lib/authz/policy";

const json = (rel: string) => JSON.parse(readFileSync(path.join(FIXTURES, "hawkin/api", rel), "utf8"));
const BASE = "https://cloud.hawkindynamics.com/api";
const REFRESH = "refresh-token-SECRET-do-not-log";

type Call = { url: URL; auth: string | null };

/** Mock Hawkin API backed by fixture JSON. Tests for from/to windows are filtered by timestamp. */
function mockHawkin(opts: { failTests?: number; status429?: number; retryAfter?: string } = {}) {
  const calls: Call[] = [];
  let tokenCount = 0;
  let fail = opts.failTests ?? 0;
  let r429 = opts.status429 ?? 0;
  const all = [...json("tests_page1.json").data, ...json("tests_page2.json").data];
  const f = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url, auth });
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/token") {
      if (auth !== `Bearer ${REFRESH}`) return new Response("{}", { status: 401 });
      tokenCount++;
      return ok({ access_token: `access-${tokenCount}` });
    }
    if (!auth?.startsWith("Bearer access-")) return new Response("{}", { status: 401 });
    if (url.pathname === "/api/v1/athletes") return ok(json("athletes.json"));
    if (url.pathname === "/api/v1/metrics") return ok(json("metrics.json"));
    if (url.pathname === "/api/v1/test_types") return ok(json("test_types.json"));
    if (url.pathname.startsWith("/api/v1/forcetime/")) {
      const id = url.pathname.split("/").pop();
      return id === "hkapi-0001" ? ok(json("forcetime_hkapi-0001.json")) : new Response("{}", { status: 404 });
    }
    if (url.pathname === "/api/v1") {
      if (r429 > 0) {
        r429--;
        return new Response("{}", { status: 429, headers: opts.retryAfter ? { "retry-after": opts.retryAfter } : {} });
      }
      if (fail > 0) {
        fail--;
        return new Response("{}", { status: 503 });
      }
      const q = url.searchParams;
      if (q.get("syncFrom")) return ok(json("tests_incremental.json"));
      if (q.get("from")) {
        const from = Number(q.get("from"));
        const to = Number(q.get("to"));
        const inWin = all.filter((t: { timestamp: number }) => t.timestamp >= from && t.timestamp < to);
        const offset = Number(q.get("cursor") ?? 0);
        const page = inWin.slice(offset, offset + 1);
        const more = offset + 1 < inWin.length;
        return ok({ data: page, hasMore: more, nextCursor: more ? String(offset + 1) : null, lastSyncTime: 1793520000 });
      }
      return ok(q.get("cursor") === "cursor-page-2" ? json("tests_page2.json") : json("tests_page1.json"));
    }
    return new Response("{}", { status: 404 });
  };
  return { f, calls, tokens: () => tokenCount };
}

function client(m: ReturnType<typeof mockHawkin>, sleeps: number[] = []) {
  return new HawkinClient({ refreshToken: REFRESH, baseUrl: BASE, fetch: m.f, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 });
}

describe("Hawkin client", () => {
  it("exchanges the refresh token for an access token once and reuses it", async () => {
    const m = mockHawkin();
    const c = client(m);
    await c.athletes();
    await c.testTypes();
    expect(m.tokens()).toBe(1);
    expect(m.calls[0].url.pathname).toBe("/api/token");
    expect(m.calls[0].auth).toBe(`Bearer ${REFRESH}`);
    expect(m.calls.slice(1).every((x) => x.auth === "Bearer access-1")).toBe(true);
    // The refresh token never appears in the call log.
    expect(JSON.stringify(c.calls)).not.toContain(REFRESH);
  });

  it("refreshes the access token after it expires", async () => {
    const m = mockHawkin();
    let now = 0;
    const c = new HawkinClient({ refreshToken: REFRESH, baseUrl: BASE, fetch: m.f, now: () => now, sleep: async () => {} });
    await c.athletes();
    now = 56 * 60_000; // past the 1h lifetime minus 5 min safety margin
    await c.athletes();
    expect(m.tokens()).toBe(2);
  });

  it("follows cursor pagination", async () => {
    const m = mockHawkin();
    const r = await client(m).tests({ from: 0, to: 2_000_000_000 }).catch(() => null);
    expect(r).not.toBeNull();
    const m2 = mockHawkin();
    const c2 = client(m2);
    const res = await c2.tests({ includeInactive: true });
    expect(res.pages).toBe(2);
    expect(res.tests.map((t) => t.id)).toEqual(["hkapi-0001", "hkapi-0002", "hkapi-0003"]);
    expect(res.lastSyncTime).toBe(1793520000);
    const testCalls = m2.calls.filter((x) => x.url.pathname === "/api/v1");
    expect(testCalls[0].url.searchParams.get("paginate")).toBe("true");
    expect(testCalls[1].url.searchParams.get("cursor")).toBe("cursor-page-2");
  });

  it("backs off exponentially with jitter on 429 and honors Retry-After", async () => {
    const sleeps: number[] = [];
    const m = mockHawkin({ status429: 3 });
    const res = await client(m, sleeps).tests({ includeInactive: true });
    expect(res.tests).toHaveLength(3);
    expect(sleeps).toHaveLength(3);
    expect(sleeps[0]).toBeLessThan(sleeps[1]);
    expect(sleeps[1]).toBeLessThan(sleeps[2]);
    const sleeps2: number[] = [];
    await client(mockHawkin({ status429: 1, retryAfter: "7" }), sleeps2).tests({});
    expect(sleeps2).toEqual([7000]);
  });

  it("gives up after max retries on persistent 5xx", async () => {
    const m = mockHawkin({ failTests: 99 });
    const c = new HawkinClient({ refreshToken: REFRESH, baseUrl: BASE, fetch: m.f, sleep: async () => {}, maxRetries: 2 });
    await expect(c.tests({})).rejects.toBeInstanceOf(HawkinError);
  });

  it("refuses to combine syncFrom/syncTo with athlete/team/group/type filters", async () => {
    const c = client(mockHawkin());
    await expect(c.testPage({ syncFrom: 1, teamId: ["t1"] })).rejects.toThrow(/cannot be combined/);
    await expect(c.testPage({ syncFrom: 1, testTypeId: "x" })).rejects.toThrow(/cannot be combined/);
    await expect(c.testPage({ syncFrom: 1, athleteId: "a" })).rejects.toThrow(/cannot be combined/);
  });
});

describe("Hawkin sync → import pipeline", () => {
  let ctx: Awaited<ReturnType<typeof seedOrg>>;
  let rod: Viewer;
  const integ = async () => (await db().select().from(integrations).where(and(eq(integrations.orgId, ctx.orgId), eq(integrations.provider, "hawkin"))))[0];

  beforeAll(async () => {
    ctx = await seedOrg(undefined, { modules: [] });
    rod = await viewerFor(ctx, "rod");
  });
  afterAll(closeTestDb);

  it("without credentials reports not_configured and never claims to work", async () => {
    const r = await runHawkinSync(db(), rod, { mode: "incremental" }, { client: null });
    expect(r.status).toBe("not_configured");
    expect(r.status === "not_configured" && r.envVars).toContain("HAWKIN_REFRESH_TOKEN");
    expect((await integ()).status).toBe("not_configured");
  });

  it("incremental sync without a checkpoint is refused", async () => {
    await expect(runHawkinSync(db(), rod, { mode: "incremental" }, { client: client(mockHawkin()) })).rejects.toThrow(/historical/);
  });

  it("failed fetch records a failed run and leaves the checkpoint alone", async () => {
    const before = (await integ()).checkpoint;
    const c = new HawkinClient({ refreshToken: REFRESH, baseUrl: BASE, fetch: mockHawkin({ failTests: 99 }).f, sleep: async () => {}, maxRetries: 1 });
    const r = await runHawkinSync(db(), rod, { mode: "historical", from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-12-01T00:00:00Z") }, { client: c });
    expect(r.status).toBe("failed");
    const [run] = await db().select().from(syncRuns).where(eq(syncRuns.id, r.status === "failed" ? r.syncRunId : ""));
    expect(run.status).toBe("failed");
    expect(run.error).not.toContain(REFRESH);
    expect((await integ()).checkpoint).toEqual(before);
    expect((await integ()).status).toBe("error");
  });

  it("historical window sync waits for identity review; checkpoint advances only after commit", async () => {
    const m = mockHawkin();
    const r = await runHawkinSync(db(), rod, { mode: "historical", from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-12-01T00:00:00Z"), chunkDays: 30 }, { client: client(m), autoCommit: true });
    if (r.status === "not_configured") throw new Error("unexpected");
    expect(r.status).toBe("awaiting_review");
    expect(r.fetched).toBe(3);
    // Every creation-date window was requested with from/to and no sync params.
    const windows = m.calls.filter((x) => x.url.pathname === "/api/v1" && !x.url.searchParams.get("cursor"));
    expect(windows.length).toBe(10);
    expect(windows.every((x) => x.url.searchParams.get("from") && !x.url.searchParams.get("syncFrom"))).toBe(true);
    expect((await integ()).checkpoint.historicalThrough).toBeUndefined();

    const [batch] = await db().select().from(importBatches).where(eq(importBatches.id, r.batchId!));
    expect(batch.source).toBe("hawkin_api");
    const groups = await tx((t) => reviewGroups(t, rod, batch.id));
    const ids: Record<string, string> = { Maya: ctx.people.maya_parker, Leo: ctx.people.leo_rivera, Noah: ctx.people.noah_kim };
    for (const g of groups) await tx((t) => resolveIdentity(t, rod, batch.id, g.key, { resolution: "link", personId: ids[g.identity.firstName!] }));
    await tx((t) => commitBatch(t, rod, batch.id));
    const cp = (await integ()).checkpoint;
    expect(cp.historicalThrough).toBe(Math.floor(new Date("2026-12-01T00:00:00Z").getTime() / 1000));
    const [run] = await db().select().from(syncRuns).where(eq(syncRuns.importBatchId, batch.id));
    expect(run.status).toBe("succeeded");
    // Raw payload preserved on the trial, nulls kept.
    const mv = await db().select().from(metricValues).where(eq(metricValues.sourceRecordId, "hkapi-0001"));
    expect(mv.find((x) => x.unit === "N/s")!.value).toBeNull();
  });

  it("incremental sync uses syncFrom without filters, filters in backend, warns on schema changes, auto-commits", async () => {
    await db()
      .update(integrations)
      .set({ config: { filters: { teamIds: ["team-hs"] }, autoCommit: true, knownMetricFields: { "Countermovement Jump": ["Braking RFD(N/s)", "Jump Height(m)", "Peak Propulsive Force(N)", "RSI-modified(m/s)"] } } })
      .where(and(eq(integrations.orgId, ctx.orgId), eq(integrations.provider, "hawkin")));
    const m = mockHawkin();
    const r = await runHawkinSync(db(), rod, { mode: "incremental" }, { client: client(m), fetchForceTime: true, now: () => new Date("2026-11-10T00:00:00Z") });
    if (r.status === "not_configured") throw new Error("unexpected");
    const call = m.calls.find((x) => x.url.pathname === "/api/v1")!;
    expect(call.url.searchParams.get("syncFrom")).toBe(String(Math.floor(new Date("2026-12-01T00:00:00Z").getTime() / 1000)));
    expect(call.url.searchParams.get("teamId")).toBeNull();
    expect(r.fetched).toBe(2);
    expect(r.kept).toBe(1); // Jamie Ortiz (team-other) filtered out locally
    expect(r.warnings.join("\n")).toMatch(/New metric field "Countermovement Depth\(m\)"/);
    expect(r.warnings.join("\n")).toMatch(/Unrecognized field "deviceFirmware"/);
    expect(r.warnings.join("\n")).toMatch(/Expected metric field "Braking RFD\(N\/s\)" missing|not in Hawkin/);
    expect(r.status).toBe("succeeded");
    expect((await integ()).checkpoint.lastSyncTime).toBe(1794003600);
    const updated = await db().select().from(metricValues).where(and(eq(metricValues.sourceRecordId, "hkapi-0001"), eq(metricValues.unit, "m")));
    expect(updated.map((x) => x.rawValue).sort()).toContain("0.4315");
    const [run] = await db().select().from(syncRuns).where(eq(syncRuns.id, r.syncRunId));
    expect(((run.cursorAfter as Record<string, unknown>).warnings as string[]).length).toBeGreaterThan(0);
    // No new trials for an updated test → no force-time archived for it; the call log never leaks the token.
    expect(JSON.stringify(m.calls.map((c) => c.url.toString()))).not.toContain(REFRESH);
  });

  it("archives raw force-time curves for newly committed API tests when enabled", async () => {
    // Fresh org avoids the global (source, test id) uniqueness of test sessions.
    const ctx2 = await seedOrg(undefined, { modules: [] });
    const owner = await viewerFor(ctx2, "rod");
    // Pre-link Maya so the first window commits without review.
    const { externalIds } = await import("@/db/schema");
    await db().insert(externalIds).values({ orgId: ctx2.orgId, source: "hawkin", sourceEntityType: "athlete", sourceId: "hkath-maya", localEntityType: "person", localId: ctx2.people.maya_parker });
    await db().update(integrations).set({ config: { filters: { athleteIds: ["hkath-maya"] } } }).where(and(eq(integrations.orgId, ctx2.orgId), eq(integrations.provider, "hawkin")));
    const all = [...json("tests_page1.json").data, ...json("tests_page2.json").data].map((t: { id: string }) => ({ ...t, id: `${t.id}-org2` }));
    const f = async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname === "/api/token") return new Response(JSON.stringify({ access_token: "access-x" }));
      void init;
      if (url.pathname === "/api/v1/athletes") return new Response(JSON.stringify(json("athletes.json")));
      if (url.pathname === "/api/v1/metrics") return new Response(JSON.stringify(json("metrics.json")));
      if (url.pathname === "/api/v1/forcetime/hkapi-0001-org2") return new Response(JSON.stringify(json("forcetime_hkapi-0001.json")));
      if (url.pathname === "/api/v1") return new Response(JSON.stringify({ data: all, hasMore: false, nextCursor: null }));
      return new Response("{}", { status: 404 });
    };
    const c = new HawkinClient({ refreshToken: REFRESH, baseUrl: BASE, fetch: f, sleep: async () => {} });
    const r = await runHawkinSync(db(), owner, { mode: "historical", from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-03-20T00:00:00Z") }, { client: c, autoCommit: true, fetchForceTime: true });
    if (r.status === "not_configured") throw new Error("unexpected");
    expect(r.status).toBe("succeeded");
    const sig = await db().select().from(rawSignals).where(eq(rawSignals.orgId, ctx2.orgId));
    expect(sig).toHaveLength(1);
    expect(sig[0].sampleRateHz).toBe(1000);
    expect(sig[0].channels.map((ch) => ch.name)).toContain("force_combined");
    expect(sig[0].sampleCount).toBe(5);
  });
});
