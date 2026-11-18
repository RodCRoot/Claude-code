import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { messageTemplates, segments } from "@/db/schema";
import { createTemplate, updateTemplate } from "@/lib/automation/templates";
import { createCampaign, submitCampaign } from "@/lib/messaging/campaigns";
import { DomainError } from "@/lib/messaging/errors";
import { lintFamilyMessage } from "@/lib/messaging/family-style";
import { postMessage, startFamilyThread, startStaffThread } from "@/lib/messaging/threads";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

const ENV_KEYS = ["EMAIL_PROVIDER", "EMAIL_API_KEY", "EMAIL_FROM", "SMS_PROVIDER", "DELIVERY_ENABLED", "DELIVERY_TEST_RECIPIENTS"];
let ctx: Awaited<ReturnType<typeof seedOrg>>;
const db = () => testDb();

beforeAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  ctx = await seedOrg();
});
afterAll(closeTestDb);

describe("family style lint on the server", () => {
  it("seeded SAMPLE templates are dash-free, and the card-update snippet is app-first and labeled SAMPLE", async () => {
    const tpls = await db().select().from(messageTemplates).where(eq(messageTemplates.orgId, ctx.orgId));
    for (const t of tpls) expect(lintFamilyMessage(`${t.subject ?? ""}\n${t.body}`).blocks, t.key).toEqual([]);
    const card = tpls.find((t) => t.key === "card_update")!;
    expect(card.isSample).toBe(true);
    expect(card.name).toMatch(/SAMPLE/);
    expect(card.body).toMatch(/^SAMPLE TEXT: .*in the app.*Payment methods.*secure link.*never text or email card numbers/);
  });

  it("templates with em dashes are refused unless staff accept the auto-replace", async () => {
    const erin = await viewerFor(ctx, "erin");
    const body = "Hi {{recipient_first_name}}, the gym is closed Monday — see you Tuesday. Thanks, {{org_name}}";
    const err = await db().transaction((tx) => createTemplate(tx, erin, { name: "Closure", channel: "email", subject: "Closed Monday", body })).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.message).toMatch(/Em dash/);
    expect(err.fieldErrors?.body).toBeTruthy();

    const row = await db().transaction((tx) => createTemplate(tx, erin, { name: "Closure", channel: "email", subject: "Closed — Monday", body, fixDashes: "comma" }));
    expect(row.body).toBe("Hi {{recipient_first_name}}, the gym is closed Monday, see you Tuesday. Thanks, {{org_name}}");
    expect(row.subject).toBe("Closed, Monday");
    await db().transaction((tx) => updateTemplate(tx, erin, row.id, { name: "Closure", channel: "email", body: "Closed Monday — back Tuesday. Thanks, {{org_name}}", fixDashes: "period" }));
    const [u] = await db().select().from(messageTemplates).where(eq(messageTemplates.id, row.id));
    expect(u.body).toBe("Closed Monday. Back Tuesday. Thanks, {{org_name}}");
    // Card numbers are never fixable automatically.
    await expect(db().transaction((tx) => createTemplate(tx, erin, { name: "Bad", channel: "sms", body: "Your card 4111 1111 1111 1111 failed. Thanks", fixDashes: "comma" }))).rejects.toThrow(/card number/);
  });

  it("staff replies to families are checked; internal notes and family messages are not", async () => {
    const erin = await viewerFor(ctx, "erin");
    const threadId = ctx.extra.crm.thread_maya_alex;
    await expect(db().transaction((tx) => postMessage(tx, erin, { threadId, body: "Booked — see you Tuesday." }))).rejects.toThrow(/Em dash/);
    await expect(db().transaction((tx) => postMessage(tx, erin, { threadId, body: "Card on file is 4111111111111111, right?" }))).rejects.toThrow(/card number/);
    const ok = await db().transaction((tx) => postMessage(tx, erin, { threadId, body: "Booked, see you Tuesday. Thanks, Erin" }));
    expect(ok.duplicate).toBe(false);
    const note = await db().transaction((tx) => postMessage(tx, erin, { threadId, body: "Internal — Alex prefers Tue/Thu.", internal: true }));
    expect(note.duplicate).toBe(false);
    const alex = await viewerFor(ctx, "alex");
    await expect(db().transaction((tx) => postMessage(tx, alex, { threadId, body: "Great — thanks!" }))).resolves.toBeTruthy();
    await expect(db().transaction((tx) => startFamilyThread(tx, alex, { athleteId: ctx.athletes.maya, subject: "Hi — question", body: "Quick one — can Maya switch days?" }))).resolves.toBeTruthy();
    await expect(
      db().transaction((tx) => startStaffThread(tx, erin, { athleteId: ctx.athletes.maya, subject: "Plan — summer", body: "Hi. Thanks, Erin", channels: [], mode: "separate" })),
    ).rejects.toThrow(/Em dash/);
  });

  it("campaigns can't be submitted with a template that fails the lint", async () => {
    const erin = await viewerFor(ctx, "erin");
    const [t] = await db()
      .insert(messageTemplates)
      .values({ orgId: ctx.orgId, key: "dash_announce", name: "Dashy", channel: "email", subject: "News", body: "Hi {{recipient_first_name}} — big news. Thanks, {{org_name}}", isSample: false })
      .returning();
    const [seg] = await db().select().from(segments).where(and(eq(segments.orgId, ctx.orgId), eq(segments.name, "Active members (families)")));
    const c = await db().transaction((tx) => createCampaign(tx, erin, { name: "Dashy news", templateId: t.id, segmentId: seg.id, channels: ["email"] }));
    await expect(db().transaction((tx) => submitCampaign(tx, erin, c.id))).rejects.toThrow(/Template "Dashy" can't be sent to families yet: Em dash/);
  });
});
