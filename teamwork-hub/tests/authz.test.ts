import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessibleAthleteIds, athleteCapabilities, canReadNote, can } from "@/lib/authz/policy";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
let other: Awaited<ReturnType<typeof seedOrg>>;

beforeAll(async () => {
  ctx = await seedOrg();
  other = await seedOrg();
});
afterAll(closeTestDb);

describe("guardian scope", () => {
  it("guardian sees own children only, never the unrelated same-surname family", async () => {
    const alex = await viewerFor(ctx, "alex");
    const ids = await accessibleAthleteIds(testDb(), alex, "profile.read");
    expect(ids).toEqual(expect.arrayContaining([ctx.athletes.maya, ctx.athletes.eli]));
    expect(ids).not.toContain(ctx.athletes.ava);
    expect((await athleteCapabilities(testDb(), alex, ctx.athletes.ava)).size).toBe(0);
  });

  it("independent guardians have independent permissions (Jordan has no health access)", async () => {
    const jordan = await viewerFor(ctx, "jordan");
    const caps = await athleteCapabilities(testDb(), jordan, ctx.athletes.maya);
    expect(caps.has("training.read")).toBe(true);
    expect(caps.has("health.read")).toBe(false);
    const alex = await viewerFor(ctx, "alex");
    expect((await athleteCapabilities(testDb(), alex, ctx.athletes.maya)).has("health.read")).toBe(true);
  });

  it("payment access does not confer health access; non-payer guardian cannot book when disallowed", async () => {
    const casey = await viewerFor(ctx, "casey");
    const caps = await athleteCapabilities(testDb(), casey, ctx.athletes.leo);
    expect(caps.has("booking.create")).toBe(false);
    expect(caps.has("billing.read")).toBe(false);
    const sam = await viewerFor(ctx, "sam");
    const samCaps = await athleteCapabilities(testDb(), sam, ctx.athletes.leo);
    expect(samCaps.has("billing.read")).toBe(true);
  });

  it("organization boundary: a guardian gets nothing on another org's athlete", async () => {
    const alex = await viewerFor(ctx, "alex");
    expect((await athleteCapabilities(testDb(), alex, other.athletes.maya)).size).toBe(0);
  });
});

describe("coach scope", () => {
  it("coach accesses assigned athletes (via group) but not others", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    const ids = await accessibleAthleteIds(testDb(), marcus, "training.read");
    expect(ids).toEqual(expect.arrayContaining([ctx.athletes.maya, ctx.athletes.leo, ctx.athletes.dana]));
    expect(ids).not.toContain(ctx.athletes.eli);
    expect((await athleteCapabilities(testDb(), marcus, ctx.athletes.eli)).size).toBe(0);
  });

  it("coach has no billing capability and cannot read sensitive/owner-only notes", async () => {
    const marcus = await viewerFor(ctx, "marcus");
    expect((await athleteCapabilities(testDb(), marcus, ctx.athletes.maya)).has("billing.read")).toBe(false);
    expect(can(marcus, "billing.manage")).toBe(false);
    expect(canReadNote(marcus, "sensitive", true)).toBe(false);
    expect(canReadNote(marcus, "coaches_assigned", true)).toBe(true);
    expect(canReadNote(marcus, "coaches_assigned", false)).toBe(false);
  });
});

describe("staff and kiosk", () => {
  it("operations manages billing but has no health access", async () => {
    const erin = await viewerFor(ctx, "erin");
    expect(can(erin, "billing.manage")).toBe(true);
    expect(can(erin, "billing.refund")).toBe(false);
    expect((await athleteCapabilities(testDb(), erin, ctx.athletes.maya)).has("health.read")).toBe(false);
  });

  it("kiosk has no athlete capabilities and only check-in org capability", async () => {
    const kiosk = await viewerFor(ctx, "kiosk");
    expect((await athleteCapabilities(testDb(), kiosk, ctx.athletes.maya)).size).toBe(0);
    expect(can(kiosk, "schedule.checkin")).toBe(true);
    expect(can(kiosk, "people.manage")).toBe(false);
  });

  it("athlete sees only themself", async () => {
    const maya = await viewerFor(ctx, "maya");
    expect(await accessibleAthleteIds(testDb(), maya, "training.read")).toEqual([ctx.athletes.maya]);
    expect((await athleteCapabilities(testDb(), maya, ctx.athletes.eli)).size).toBe(0);
  });
});
