import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  invoices,
  memberRequests,
  memberships,
  messages,
  products,
  productVersions,
  threadParticipants,
  threads,
} from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { DomainError } from "@/lib/messaging/errors";
import { receiveInbound } from "@/lib/messaging/inbound";
import { postMessage, startFamilyThread } from "@/lib/messaging/threads";
import {
  confirmSuggestion,
  createRequest,
  dismissSuggestion,
  listRequests,
  scanForSuggestions,
  updateRequest,
} from "@/lib/member-ops/requests";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

const TODAY = "2026-10-12";
let ctx: Awaited<ReturnType<typeof seedOrg>>;
const db = () => testDb();

beforeAll(async () => {
  ctx = await seedOrg(TODAY, { modules: [] });
});
afterAll(closeTestDb);

async function staffThread(athlete: string, guardianPersonKey: string) {
  const [t] = await db().insert(threads).values({ orgId: ctx.orgId, subject: "Membership question", athleteId: ctx.athletes[athlete], kind: "family" }).returning();
  await db().insert(threadParticipants).values({ threadId: t.id, personId: ctx.people[guardianPersonKey], role: "guardian" });
  return t.id;
}

describe("member requests log", () => {
  it("records a request with sent and received dates, audited; validates dates and refs", async () => {
    const erin = await viewerFor(ctx, "erin");
    const threadId = await staffThread("ethan", "ethan_guardian");
    const r = await createRequest(
      db(),
      erin,
      { type: "hold", channel: "email_forwarded", athleteIds: [ctx.athletes.ethan], requesterPersonId: ctx.people.ethan_guardian, sentOn: "2026-10-01", receivedOn: "2026-10-08", threadId, summary: "Hold through December for football", ownerUserId: ctx.users.erin },
      TODAY,
    );
    expect(r.status).toBe("new");
    const [a] = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, r.id), eq(auditEvents.action, "member_request.create")));
    expect(a.summary).toContain("sent 2026-10-01");

    await expect(createRequest(db(), erin, { type: "hold", channel: "sms", athleteIds: [ctx.athletes.ethan], sentOn: "2026-10-20", summary: "x" }, TODAY)).rejects.toThrow(/future/);
    await expect(createRequest(db(), erin, { type: "hold", channel: "sms", athleteIds: [ctx.athletes.ethan], sentOn: "2026-10-05", receivedOn: "2026-10-01", summary: "x" }, TODAY)).rejects.toThrow(/before/);
    await expect(createRequest(db(), erin, { type: "hold", channel: "sms", athleteIds: [ctx.athletes.ethan], sentOn: "2026-10-05" }, TODAY)).rejects.toBeInstanceOf(DomainError);
    await expect(createRequest(db(), erin, { type: "hold", channel: "sms", athleteIds: [randomUUID()], sentOn: "2026-10-05", summary: "x" }, TODAY)).rejects.toThrow(/Athlete not found/);
  });

  it("coaches and families cannot use the log", async () => {
    const coach = await viewerFor(ctx, "marcus");
    const alex = await viewerFor(ctx, "alex");
    await expect(listRequests(db(), coach)).rejects.toBeInstanceOf(AuthzError);
    await expect(createRequest(db(), alex, { type: "cancel", channel: "in_app", athleteIds: [ctx.athletes.maya], sentOn: "2026-10-01", summary: "x" }, TODAY)).rejects.toBeInstanceOf(AuthzError);
  });

  it("shows days unprocessed, SLA, repeat asks, already-replied and billed-since", async () => {
    const rod = await viewerFor(ctx, "rod");
    const threadId = await staffThread("sofia", "sofia_guardian");
    // Billed on Oct 1 after the family asked Sep 25.
    const [p] = await db().insert(products).values({ orgId: ctx.orgId, name: "Sample plan", kind: "recurring_membership" }).returning();
    const [pv] = await db().insert(productVersions).values({ productId: p.id, version: 1, priceMinor: 14900, interval: "month", effectiveFrom: "2025-01-01" }).returning();
    const [m] = await db().insert(memberships).values({ orgId: ctx.orgId, athleteId: ctx.athletes.sofia, payerAccountId: ctx.payers.sofia, productVersionId: pv.id, status: "active", startDate: "2026-01-01", billingProvider: "manual" }).returning();
    await db().insert(invoices).values({ orgId: ctx.orgId, payerAccountId: ctx.payers.sofia, number: "R-1", status: "paid", totalMinor: 14900, subtotalMinor: 14900, membershipId: m.id, periodStart: "2026-10-01" });

    const first = await createRequest(db(), rod, { type: "pause", channel: "sms", athleteIds: [ctx.athletes.sofia], sentOn: "2026-09-25", threadId, summary: "Pause please" }, TODAY);
    const second = await createRequest(db(), rod, { type: "hold", channel: "phone_ai_recap", athleteIds: [ctx.athletes.sofia], sentOn: "2026-10-09", pastedText: "AI Call Recap: parent asked again to hold (synthetic)" }, TODAY);

    let { rows } = await listRequests(db(), rod, { athleteId: ctx.athletes.sofia }, TODAY);
    const r1 = rows.find((r) => r.id === first.id)!;
    expect(r1.daysUnprocessed).toBe(17);
    expect(r1.sla).toBe("breach");
    expect(r1.asks).toBe(2);
    expect(r1.reply).toBeNull();
    expect(r1.billedSince).toEqual({ count: 1, totalMinor: 14900 });
    const r2 = rows.find((r) => r.id === second.id)!;
    expect(r2.asks).toBe(2);
    expect(r2.firstAskedOn).toBe("2026-09-25");
    expect(r2.sla).toBe("warn");

    // A staff reply in the conversation after the sent date → "already replied".
    await db().insert(messages).values({ threadId, senderUserId: ctx.users.erin, body: "Got it — processing your pause.", createdAt: new Date("2026-10-10T14:00:00Z") });
    // Internal notes never count as a reply.
    await db().insert(messages).values({ threadId, senderUserId: ctx.users.erin, body: "internal", isInternalNote: true, createdAt: new Date("2026-09-26T14:00:00Z") });
    ({ rows } = await listRequests(db(), rod, { athleteId: ctx.athletes.sofia }, TODAY));
    expect(rows.find((r) => r.id === first.id)!.reply?.at.toISOString()).toBe("2026-10-10T14:00:00.000Z");
  });

  it("moves new → in progress → resolved (notes required), audited with before/after; reopen clears resolution", async () => {
    const erin = await viewerFor(ctx, "erin");
    const r = await createRequest(db(), erin, { type: "card_update", channel: "web_form", athleteIds: [ctx.athletes.liam], sentOn: "2026-10-10", summary: "New card" }, TODAY);
    await updateRequest(db(), erin, r.id, { status: "in_progress", ownerUserId: ctx.users.erin });
    await expect(updateRequest(db(), erin, r.id, { status: "resolved" })).rejects.toThrow(/resolution notes/);
    const done = await updateRequest(db(), erin, r.id, { status: "resolved", resolutionNotes: "Family updated card in portal" }, new Date("2026-10-11T15:00:00Z"));
    expect(done.resolvedByUserId).toBe(ctx.users.erin);
    const { rows } = await listRequests(db(), erin, { view: "closed", athleteId: ctx.athletes.liam }, TODAY);
    expect(rows[0].daysUnprocessed).toBe(1);
    expect(rows[0].sla).toBe("closed");
    const evs = await db().select().from(auditEvents).where(eq(auditEvents.entityId, r.id));
    expect(evs.map((e) => e.action)).toEqual(expect.arrayContaining(["member_request.create", "member_request.update", "member_request.resolved"]));
    const reopened = await updateRequest(db(), erin, r.id, { status: "in_progress" });
    expect(reopened.resolvedAt).toBeNull();
  });
});

describe("keyword suggestions (never auto-acted on)", () => {
  it("a family message mentioning a pause becomes a suggested request; staff messages do not", async () => {
    const alex = await viewerFor(ctx, "alex");
    const rod = await viewerFor(ctx, "rod");
    const { threadId } = await startFamilyThread(db(), alex, { athleteId: ctx.athletes.maya, subject: "Volleyball season", body: "Hi! Can we pause Maya's membership while she's in club season?" });
    await postMessage(db(), rod, { threadId, body: "We can put the hold in for you." });
    const sugg = await db().select().from(memberRequests).where(and(eq(memberRequests.orgId, ctx.orgId), eq(memberRequests.threadId, threadId)));
    expect(sugg).toHaveLength(1);
    expect(sugg[0]).toMatchObject({ suggested: true, status: "new", type: "pause", channel: "in_app", requesterPersonId: ctx.people.alex_parker });

    const { rows } = await listRequests(db(), rod, { view: "suggested" }, TODAY);
    const row = rows.find((r) => r.id === sugg[0].id)!;
    expect(row.athletes.map((a) => a.name)).toEqual(["Maya Parker"]);
    // Not in the open queue until confirmed.
    expect((await listRequests(db(), rod, { view: "open" }, TODAY)).rows.some((r) => r.id === sugg[0].id)).toBe(false);

    const confirmed = await confirmSuggestion(db(), rod, sugg[0].id, { type: "hold" });
    expect(confirmed).toMatchObject({ suggested: false, type: "hold", ownerUserId: ctx.users.rod });
    expect((await listRequests(db(), rod, { view: "open" }, TODAY)).rows.some((r) => r.id === sugg[0].id)).toBe(true);
    await expect(confirmSuggestion(db(), rod, sugg[0].id)).rejects.toThrow(/not an unconfirmed/);
  });

  it("unmatched inbound email with 'cancel' is suggested; dismiss keeps an audited record; scan is idempotent", async () => {
    const rod = await viewerFor(ctx, "rod");
    const res = await receiveInbound(db(), {
      orgId: ctx.orgId,
      channel: "email",
      provider: "test",
      providerMessageId: `m-${randomUUID()}`,
      from: "harper.guardian@example.test",
      to: "memberships@example.test",
      subject: "Cancel Harper",
      body: "Please cancel Harper's membership at the end of the month.",
      token: null,
    });
    expect(res.status).toBe("unmatched");
    const [s] = await db().select().from(memberRequests).where(eq(memberRequests.sourceInboundId, res.inboundId));
    expect(s).toMatchObject({ type: "cancel", suggested: true, channel: "email_direct", requesterPersonId: ctx.people.harper_guardian });

    const scan1 = await scanForSuggestions(db(), rod, 30);
    expect(scan1.created).toBe(0);

    await dismissSuggestion(db(), rod, s.id, "Spam test");
    const [after] = await db().select().from(memberRequests).where(eq(memberRequests.id, s.id));
    expect(after.status).toBe("dismissed");
    const [ev] = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, s.id), eq(auditEvents.action, "member_request.dismiss_suggestion")));
    expect(ev).toBeTruthy();
    await expect(updateRequest(db(), rod, s.id, { status: "in_progress" })).rejects.toThrow(/dismissed/);
  });

  it("scan backfills older family messages once", async () => {
    const rod = await viewerFor(ctx, "rod");
    const threadId = await staffThread("owen", "owen_guardian");
    await db().insert(messages).values({ threadId, senderPersonId: ctx.people.owen_guardian, body: "Our card expired, how do I update it?", createdAt: new Date() });
    const a = await scanForSuggestions(db(), rod, 30);
    expect(a.created).toBe(1);
    const b = await scanForSuggestions(db(), rod, 30);
    expect(b.created).toBe(0);
    const [s] = await db().select().from(memberRequests).where(eq(memberRequests.threadId, threadId));
    expect(s.type).toBe("card_update");
  });
});
