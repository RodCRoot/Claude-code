import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { athletes, guardianships, householdMembers, people } from "@/db/schema";
import { findGhlContact, GhlError, GhlNotConfiguredError, ghlConfig, sendGhlSms } from "@/lib/integrations/gohighlevel/client";
import { batchRows, resolveIdentity } from "@/lib/imports/batches";
import { parseGhlContactName } from "@/lib/imports/schemas/gohighlevel";
import { sendSms, smsConfig } from "@/lib/messaging/channels/sms";
import { closeTestDb, seedOrg, viewerFor } from "./helpers/db";
import { confirmAndCommit, db, fixture, tx, uploadAndValidate } from "./imports.helpers";

/** Every test here mocks fetch: nothing ever reaches GoHighLevel. */
const ENV_KEYS = ["GHL_API_KEY", "GHL_LOCATION_ID", "GHL_FROM_NUMBER", "SMS_PROVIDER", "DELIVERY_ENABLED", "DELIVERY_TEST_RECIPIENTS"] as const;
let saved: Record<string, string | undefined>;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function configure() {
  process.env.GHL_API_KEY = "pit-test-token";
  process.env.GHL_LOCATION_ID = "loc-test-123";
}

describe("GoHighLevel client (mocked fetch)", () => {
  it("is not configured without GHL_API_KEY / GHL_LOCATION_ID and never calls the network", async () => {
    expect(ghlConfig()).toMatchObject({ configured: false, missing: ["GHL_API_KEY", "GHL_LOCATION_ID"] });
    await expect(findGhlContact({ phone: "+18125550101" })).rejects.toBeInstanceOf(GhlNotConfiguredError);
    await expect(sendGhlSms({ contactId: "c1", message: "Hi" })).rejects.toBeInstanceOf(GhlNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("looks up a contact by phone with the documented path, query encoding and Version header", async () => {
    configure();
    fetchMock.mockResolvedValueOnce(json(200, { contact: { id: "ct_1", firstName: "Riley", lastName: "Exampleton", phone: "+18125550199", email: "x@example.test" } }));
    const c = await findGhlContact({ phone: "+18125550199" });
    expect(c).toMatchObject({ id: "ct_1", firstName: "Riley", phone: "+18125550199" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=loc-test-123&number=%2B18125550199");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ Authorization: "Bearer pit-test-token", Version: "2021-07-28", Accept: "application/json" });

    fetchMock.mockResolvedValueOnce(json(200, { contact: null }));
    expect(await findGhlContact({ email: "nobody+tag@example.test" })).toBeNull();
    expect(fetchMock.mock.calls[1][0]).toContain("email=nobody%2Btag%40example.test");
  });

  it("sends SMS with type SMS + contactId and only reports success with a messageId", async () => {
    configure();
    process.env.GHL_FROM_NUMBER = "+18125550000";
    fetchMock.mockResolvedValueOnce(json(200, { conversationId: "cv_1", messageId: "m_1", status: "pending" }));
    const r = await sendGhlSms({ contactId: "ct_1", message: "Hi there. Thanks, Teamwork", toNumber: "+18125550199" });
    expect(r).toEqual({ messageId: "m_1", conversationId: "cv_1", status: "pending" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://services.leadconnectorhq.com/conversations/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Version: "2021-04-15", "Content-Type": "application/json", Authorization: "Bearer pit-test-token" });
    expect(JSON.parse(init.body)).toEqual({ type: "SMS", contactId: "ct_1", message: "Hi there. Thanks, Teamwork", fromNumber: "+18125550000", toNumber: "+18125550199" });

    fetchMock.mockResolvedValueOnce(json(200, { status: "pending" }));
    await expect(sendGhlSms({ contactId: "ct_1", message: "x" })).rejects.toThrow(/no messageId/);
  });

  it("maps HTTP errors: 401 is final, 429/5xx retryable", async () => {
    configure();
    fetchMock.mockResolvedValueOnce(json(401, { message: "Invalid JWT" }));
    const e401 = await findGhlContact({ phone: "+18125550101" }).catch((e) => e);
    expect(e401).toBeInstanceOf(GhlError);
    expect(e401).toMatchObject({ status: 401, retryable: false });
    expect(e401.message).toMatch(/401: Invalid JWT/);
    fetchMock.mockResolvedValueOnce(json(429, {}));
    expect(await findGhlContact({ phone: "+18125550101" }).catch((e) => e)).toMatchObject({ status: 429, retryable: true });
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await findGhlContact({ phone: "+18125550101" }).catch((e) => e)).toMatchObject({ retryable: true });
  });
});

describe("SMS channel with SMS_PROVIDER=gohighlevel (mocked fetch)", () => {
  it("reports exactly which settings are missing", () => {
    process.env.SMS_PROVIDER = "gohighlevel";
    const cfg = smsConfig();
    expect(cfg.configured).toBe(false);
    expect(cfg.missing).toEqual(["GHL_API_KEY", "GHL_LOCATION_ID", "DELIVERY_ENABLED=true"]);
    expect(cfg.missing).not.toContain("SMS_ACCOUNT_SID");
  });

  it("not configured → not_configured, no network", async () => {
    process.env.SMS_PROVIDER = "gohighlevel";
    configure(); // but DELIVERY_ENABLED is off
    const r = await sendSms({ to: "+18125550199", subject: "", body: "Hi" });
    expect(r.status).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("looks the number up, then sends to that contact", async () => {
    process.env.SMS_PROVIDER = "gohighlevel";
    process.env.DELIVERY_ENABLED = "true";
    configure();
    fetchMock.mockResolvedValueOnce(json(200, { contact: { id: "ct_9" } })).mockResolvedValueOnce(json(200, { conversationId: "cv", messageId: "m_9", status: "pending" }));
    const r = await sendSms({ to: "+18125550199", subject: "", body: "See you Tuesday. Thanks, Coach Sam" });
    expect(r).toMatchObject({ status: "sent", address: "+18125550199", providerMessageId: "ghl:m_9" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ type: "SMS", contactId: "ct_9" });
  });

  it("a number with no GHL contact fails without retry and creates nothing in GHL", async () => {
    process.env.SMS_PROVIDER = "gohighlevel";
    process.env.DELIVERY_ENABLED = "true";
    configure();
    fetchMock.mockResolvedValueOnce(json(200, { contact: null }));
    const r = await sendSms({ to: "+18125550111", subject: "", body: "Hi" });
    expect(r).toMatchObject({ status: "failed", retryable: false });
    expect(r.reason).toMatch(/No GoHighLevel contact/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });

  it("provider 5xx stays retryable", async () => {
    process.env.SMS_PROVIDER = "gohighlevel";
    process.env.DELIVERY_ENABLED = "true";
    configure();
    fetchMock.mockResolvedValueOnce(json(200, { contact: { id: "ct_9" } })).mockResolvedValueOnce(json(503, {}));
    expect(await sendSms({ to: "+18125550199", subject: "", body: "Hi" })).toMatchObject({ status: "failed", retryable: true });
  });
});

describe("GHL contact name convention", () => {
  it("splits siblings sharing a surname", () => {
    expect(parseGhlContactName({ full: "Riley, Sam, Alex Exampleton" })).toMatchObject({ firstNames: ["Riley", "Sam", "Alex"], lastName: "Exampleton" });
    expect(parseGhlContactName({ first: "Quinn & Rowan", last: "Samplefield" })).toMatchObject({ firstNames: ["Quinn", "Rowan"], lastName: "Samplefield" });
    expect(parseGhlContactName({ full: "Quinn and Rowan Samplefield" }).firstNames).toEqual(["Quinn", "Rowan"]);
    expect(parseGhlContactName({ full: "Riley Exampleton" })).toMatchObject({ firstNames: ["Riley"], lastName: "Exampleton", warnings: [] });
    expect(parseGhlContactName({ first: "Riley Exampleton", last: "" })).toMatchObject({ firstNames: ["Riley"], lastName: "Exampleton" });
    const odd = parseGhlContactName({ full: "Mary Kate Exampleton (Mom: Pat)" });
    expect(odd.firstNames).toEqual(["Mary Kate"]);
    expect(odd.warnings.join(" ")).toMatch(/Ignored "\(Mom: Pat\)".*more than one word/);
  });
});

describe("GHL contacts import", () => {
  let ctx: Awaited<ReturnType<typeof seedOrg>>;
  beforeAll(async () => {
    ctx = await seedOrg("2026-03-02", { modules: [] });
  });
  afterAll(closeTestDb);

  it("one contact → one row per athlete; parent phone/email → guardian contact; nothing auto-merged", async () => {
    const rod = await viewerFor(ctx, "rod");
    const r = await uploadAndValidate(rod, "gohighlevel.contacts", "ghl-contacts.csv", fixture("gohighlevel/contacts.csv"));
    // 4 lines → 3 + 1 + 2 + 1 (invalid) rows.
    const rows = await tx((t) => batchRows(t, rod, r.batchId));
    expect(rows).toHaveLength(7);
    expect(rows.filter((x) => x.status === "invalid")).toHaveLength(1);
    const exampleton = rows
      .filter((x) => (x.normalized as Record<string, unknown>).lastName === "Exampleton")
      .sort((a, b) => Number((a.normalized as Record<string, unknown>).siblingIndex) - Number((b.normalized as Record<string, unknown>).siblingIndex));
    expect(exampleton.map((x) => (x.normalized as Record<string, unknown>).firstName)).toEqual(["Riley", "Sam", "Alex"]);
    expect(exampleton.every((x) => x.rowNumber === 2)).toBe(true);
    // Athlete identity never carries the parent's email/phone.
    expect(exampleton.every((x) => (x.normalized as { _identity: { email: unknown; phone: unknown } })._identity.email === null)).toBe(true);
    expect(exampleton[0].warnings.join(" ")).toMatch(/covers 3 athletes/);

    // Maya Parker: name-only match is never auto-linked, and the parent email proposes Alex as guardian.
    const maya = rows.find((x) => (x.normalized as Record<string, unknown>).firstName === "Maya")!;
    expect(maya.status).toBe("needs_review");
    expect(maya.matchConfidence).toBe("ambiguous");
    expect(maya.warnings.join(" ")).toMatch(/matches Alex Parker/);
    expect((maya.normalized as Record<string, unknown>)._guardianPersonId).toBe(ctx.people.alex_parker);

    // Staff confirms the match; everything else is created.
    await tx((t) => resolveIdentity(t, rod, r.batchId, String((maya.normalized as Record<string, unknown>)._identityKey), { resolution: "link", personId: ctx.people.maya_parker }));
    const [{ needs }] = [{ needs: (await tx((t) => batchRows(t, rod, r.batchId, ["needs_review"]))).length }];
    expect(needs).toBe(0);
    const counts = await confirmAndCommit(rod, r.batchId);
    expect(counts).toMatchObject({ create: 5, link: 1, reject: 1 });

    // Siblings: 3 athletes, ONE placeholder guardian holding the phone/email, one household.
    const sibs = await db()
      .select({ id: athletes.id, first: people.firstName })
      .from(athletes)
      .innerJoin(people, eq(people.id, athletes.personId))
      .where(and(eq(athletes.orgId, ctx.orgId), eq(people.lastName, "Exampleton")));
    expect(sibs.map((s) => s.first).sort()).toEqual(["Alex", "Riley", "Sam"]);
    const guardians = await db().select().from(people).where(and(eq(people.orgId, ctx.orgId), eq(people.email, "exampleton.family@example.test")));
    expect(guardians).toHaveLength(1);
    expect(guardians[0]).toMatchObject({ firstName: "Parent/guardian", lastName: "Exampleton", phone: "+1 812 555 0163", source: "gohighlevel" });
    const gs = await db().select().from(guardianships).where(inArray(guardianships.athleteId, sibs.map((s) => s.id)));
    expect(gs).toHaveLength(3);
    expect(gs.every((g) => g.guardianPersonId === guardians[0].id && g.canViewHealth === false && g.status !== "revoked")).toBe(true);
    const hh = await db().select().from(householdMembers).where(eq(householdMembers.personId, guardians[0].id));
    expect(hh).toHaveLength(1);

    // Maya stays one person (linked, not duplicated); Alex already was her guardian.
    const mayas = await db().select().from(people).where(and(eq(people.orgId, ctx.orgId), eq(people.firstName, "Maya"), eq(people.lastName, "Parker")));
    expect(mayas).toHaveLength(1);
    const alexOnMaya = await db().select().from(guardianships).where(and(eq(guardianships.athleteId, ctx.athletes.maya), eq(guardianships.guardianPersonId, ctx.people.alex_parker)));
    expect(alexOnMaya).toHaveLength(1);

    // No phone/email → athletes created, no guardian.
    const sample = await db().select().from(people).where(and(eq(people.orgId, ctx.orgId), eq(people.lastName, "Samplefield")));
    expect(sample.map((p) => p.firstName).sort()).toEqual(["Quinn", "Rowan"]);

    // Import never talks to GHL.
    expect(fetchMock).not.toHaveBeenCalled();

    // Re-import: everything already known → no new people.
    const before = (await db().select({ id: people.id }).from(people).where(eq(people.orgId, ctx.orgId))).length;
    const again = await uploadAndValidate(rod, "gohighlevel.contacts", "ghl-contacts-again.csv", new TextEncoder().encode(new TextDecoder().decode(fixture("gohighlevel/contacts.csv")) + "\n"));
    const againCounts = await confirmAndCommit(rod, again.batchId);
    expect(againCounts.create).toBe(0);
    const after = (await db().select({ id: people.id }).from(people).where(eq(people.orgId, ctx.orgId))).length;
    expect(after).toBe(before);
  });
});
