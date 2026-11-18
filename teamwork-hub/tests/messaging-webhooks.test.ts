import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  commConsentEvents,
  commPreferences,
  guardianships,
  inboundMessages,
  messageDeliveries,
  messages,
  messagingProviderEvents,
  organizations,
  undeliverableAddresses,
} from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { __setEmailTransport } from "@/lib/messaging/channels/email";
import { __setSmsTransport } from "@/lib/messaging/channels/sms";
import type { OutboundMessage } from "@/lib/messaging/channels/types";
import { createDeliveries, deliverOne } from "@/lib/messaging/delivery";
import { attachInbound, dismissInbound, listInbound, stripQuoted } from "@/lib/messaging/inbound";
import { clearUndeliverable, staffConsentView } from "@/lib/messaging/preferences";
import { replyToForThread, replyToken, threadIdFromToken } from "@/lib/messaging/reply-token";
import { recipientForPerson } from "@/lib/messaging/routing";
import { loadThread, startStaffThread } from "@/lib/messaging/threads";
import { parsePostmarkEvent, smsKeyword } from "@/lib/messaging/webhooks/adapters";
import { ingestMessagingWebhook } from "@/lib/messaging/webhooks/ingest";
import { twilioSignature } from "@/lib/messaging/webhooks/verify";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
let slug: string;
const tx = () => testDb();
const T = (k: string) => ctx.extra.crm[k];
/** Far-future instant (12:00 EST) so delivery jobs we create are never claimed by other test files' workers. */
const NOON = new Date("2031-03-04T17:00:00Z");

const TWILIO_TOKEN = "test-twilio-auth-token";
const EMAIL_SECRET = "test-email-webhook-secret-123";
const BASE = "https://hub.example.test";
const DELIVERY_KEYS = ["EMAIL_PROVIDER", "EMAIL_API_KEY", "EMAIL_FROM", "SMS_PROVIDER", "SMS_ACCOUNT_SID", "SMS_FROM", "DELIVERY_ENABLED", "DELIVERY_TEST_RECIPIENTS", "EMAIL_INBOUND_DOMAIN"];
const ALL_KEYS = [...DELIVERY_KEYS, "SMS_AUTH_TOKEN", "EMAIL_WEBHOOK_SECRET", "SENDGRID_WEBHOOK_PUBLIC_KEY", "APP_URL"];
const saved: Record<string, string | undefined> = {};

const sg = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

beforeAll(async () => {
  for (const k of ALL_KEYS) saved[k] = process.env[k];
  for (const k of ALL_KEYS) delete process.env[k];
  ctx = await seedOrg();
  [{ slug }] = await tx().select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, ctx.orgId));
  process.env.SMS_AUTH_TOKEN = TWILIO_TOKEN;
  process.env.EMAIL_WEBHOOK_SECRET = EMAIL_SECRET;
  process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = sg.publicKey.export({ type: "spki", format: "der" }).toString("base64");
});
afterEach(() => {
  for (const k of DELIVERY_KEYS) delete process.env[k];
  __setEmailTransport(null);
  __setSmsTransport(null);
});
afterAll(async () => {
  for (const k of ALL_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await closeTestDb();
});

// --- request builders (mock providers) -------------------------------------------------------

function twilio(params: Record<string, string>, opts: { badSig?: boolean; orgSlug?: string } = {}) {
  const org = opts.orgSlug ?? slug;
  const url = `${BASE}/api/webhooks/messaging/twilio-sms?org=${org}`;
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": opts.badSig ? "bad" : twilioSignature(TWILIO_TOKEN, url, params) });
  return ingestMessagingWebhook(tx(), "twilio-sms", { raw: new URLSearchParams(params).toString(), headers, url, orgSlug: org });
}
const sms = (from: string, body: string, extra: Record<string, string> = {}) => twilio({ MessageSid: `SM${randomUUID().replace(/-/g, "")}`, From: from, To: "+18125550000", Body: body, ...extra });

const basic = (secret = EMAIL_SECRET) => `Basic ${Buffer.from(`hub:${secret}`).toString("base64")}`;
function postmark(hook: "postmark-events" | "postmark-inbound", body: unknown, secret?: string) {
  return ingestMessagingWebhook(tx(), hook, { raw: JSON.stringify(body), headers: new Headers({ authorization: basic(secret) }), url: `${BASE}/x`, orgSlug: slug });
}
function sendgridEvents(events: unknown[], opts: { badSig?: boolean } = {}) {
  const raw = JSON.stringify(events);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign("sha256", Buffer.from(ts + raw), sg.privateKey).toString("base64");
  const headers = new Headers({ "x-twilio-email-event-webhook-signature": opts.badSig ? sig.slice(0, -4) + "AAAA" : sig, "x-twilio-email-event-webhook-timestamp": ts });
  return ingestMessagingWebhook(tx(), "sendgrid-events", { raw, headers, url: `${BASE}/x`, orgSlug: slug });
}

const consent = async (personId: string, channel: "email" | "sms") =>
  (await tx().select().from(commPreferences).where(and(eq(commPreferences.personId, personId), eq(commPreferences.channel, channel))))[0]?.consent;

/** Sends a real (mock-transport) delivery so the provider "accepted" it. */
async function acceptedDelivery(channel: "email" | "sms", providerMessageId = `pm-${randomUUID()}`) {
  const erin = await viewerFor(ctx, "erin");
  const res = await startStaffThread(tx(), erin, { athleteId: ctx.athletes.maya, subject: `Accepted ${channel}`, body: "Hello from staff", channels: [channel] }, NOON);
  // Separate threads per guardian: find Alex's copy.
  const [{ d, threadId: alexThread }] = await tx()
    .select({ d: messageDeliveries, threadId: messages.threadId })
    .from(messageDeliveries)
    .innerJoin(messages, eq(messages.id, messageDeliveries.messageId))
    .where(and(inArray(messages.threadId, res.threadIds), eq(messageDeliveries.channel, channel), eq(messageDeliveries.recipientPersonId, ctx.people.alex_parker)));
  if (channel === "sms") {
    Object.assign(process.env, { SMS_PROVIDER: "twilio", SMS_ACCOUNT_SID: "AC-test", SMS_FROM: "+18125550000", DELIVERY_ENABLED: "true" });
    __setSmsTransport(async () => ({ providerMessageId }));
  } else {
    Object.assign(process.env, { EMAIL_PROVIDER: "postmark", EMAIL_API_KEY: "k", EMAIL_FROM: "hub@example.test", DELIVERY_ENABLED: "true" });
    __setEmailTransport(async () => ({ providerMessageId }));
  }
  const r = await deliverOne(tx(), d.id, { attempts: 1, maxAttempts: 5 });
  expect(r.status).toBe("sent");
  return { threadId: alexThread, deliveryId: d.id, providerMessageId };
}

// --- tests -------------------------------------------------------------------------------------

describe("adapters", () => {
  it("recognizes SMS keywords and Postmark bounce severity; strips quoted email history", () => {
    expect(smsKeyword(" stop ")).toBe("stop");
    expect(smsKeyword("Unsubscribe")).toBe("stop");
    expect(smsKeyword("START")).toBe("start");
    expect(smsKeyword("help")).toBe("help");
    expect(smsKeyword("please stop by at 5")).toBeNull();
    expect(smsKeyword("anything", "STOP")).toBe("stop");
    const [hard] = parsePostmarkEvent({ RecordType: "Bounce", ID: 1, Type: "HardBounce", Email: "a@b.test" });
    const [soft] = parsePostmarkEvent({ RecordType: "Bounce", ID: 2, Type: "SoftBounce", Email: "a@b.test" });
    expect(hard).toMatchObject({ kind: "bounce", hard: true });
    expect(soft).toMatchObject({ kind: "bounce", hard: false });
    expect(stripQuoted("Sounds good!\n\nOn Tue, Mar 3, 2026 Teamwork wrote:\n> earlier")).toBe("Sounds good!");
  });

  it("reply tokens are thread-bound and tamper-evident", () => {
    const id = randomUUID();
    const tok = replyToken(id);
    expect(threadIdFromToken(tok)).toBe(id);
    expect(threadIdFromToken(tok.slice(0, -1) + (tok.endsWith("0") ? "1" : "0"))).toBeNull();
    expect(replyToForThread(id)).toBeNull(); // inbound domain not configured
    process.env.EMAIL_INBOUND_DOMAIN = "inbound.example.test";
    expect(replyToForThread(id)).toBe(`reply+${tok}@inbound.example.test`);
  });
});

describe("verification", () => {
  it("unconfigured endpoints and bad signatures are rejected and recorded, never applied", async () => {
    delete process.env.SMS_AUTH_TOKEN;
    const before = await consent(ctx.people.alex_parker, "sms");
    const res = await sms("+18125550101", "STOP");
    expect(res.httpStatus).toBe(503);
    process.env.SMS_AUTH_TOKEN = TWILIO_TOKEN;
    const bad = await twilio({ MessageSid: `SM${randomUUID()}`, From: "+18125550101", Body: "STOP" }, { badSig: true });
    expect(bad.httpStatus).toBe(401);
    expect((await postmark("postmark-events", { RecordType: "SpamComplaint", ID: 99, Email: "alex.parker@example.test" }, "wrong-secret-wrong-secret")).httpStatus).toBe(401);
    expect((await sendgridEvents([{ event: "spamreport", email: "alex.parker@example.test", sg_event_id: randomUUID() }], { badSig: true })).httpStatus).toBe(401);
    expect(await consent(ctx.people.alex_parker, "sms")).toBe(before);
    expect(await consent(ctx.people.alex_parker, "email")).toBe("opted_in");
    const rejected = await tx().select().from(messagingProviderEvents).where(eq(messagingProviderEvents.status, "rejected"));
    expect(rejected.length).toBeGreaterThanOrEqual(4);
    // Unknown org: acknowledged (no retry), nothing applied.
    const unknown = await twilio({ MessageSid: `SM${randomUUID()}`, From: "+18125550101", Body: "STOP" }, { orgSlug: "no-such-org" });
    expect(JSON.parse(unknown.body)).toMatchObject({ ok: false });
    expect(await consent(ctx.people.alex_parker, "sms")).toBe(before);
  });
});

describe("inbound SMS", () => {
  it("a reply from a known participant is threaded into the conversation we texted them", async () => {
    const { threadId } = await acceptedDelivery("sms");
    const res = await sms("(812) 555-0101", "Running 10 min late, sorry!");
    expect(res.httpStatus).toBe(200);
    expect(res.contentType).toBe("text/xml");
    const [inb] = await tx().select().from(inboundMessages).where(and(eq(inboundMessages.orgId, ctx.orgId), eq(inboundMessages.body, "Running 10 min late, sorry!")));
    expect(inb).toMatchObject({ status: "threaded", threadId, matchedPersonId: ctx.people.alex_parker });
    const [m] = await tx().select().from(messages).where(eq(messages.id, inb.messageId!));
    expect(m).toMatchObject({ threadId, senderPersonId: ctx.people.alex_parker, inboundChannel: "sms", isInternalNote: false });
    // Staff get an in-app copy; nothing goes out externally.
    const ds = await tx().select().from(messageDeliveries).where(eq(messageDeliveries.messageId, m.id));
    expect(ds.length).toBeGreaterThan(0);
    expect(ds.every((d) => d.channel === "in_app" && d.recipientPersonId === ctx.people.erin)).toBe(true);
    // Alex sees their own reply in the family view.
    const alex = await viewerFor(ctx, "alex");
    expect((await loadThread(tx(), alex, threadId)).messages.some((x) => x.id === m.id)).toBe(true);
  });

  it("a guardian who lost messaging permission is not threaded (goes to the unmatched queue)", async () => {
    await acceptedDelivery("sms");
    const [link] = await tx()
      .select()
      .from(guardianships)
      .where(and(eq(guardianships.guardianPersonId, ctx.people.alex_parker), eq(guardianships.athleteId, ctx.athletes.maya)));
    await tx().update(guardianships).set({ canMessageStaff: false }).where(eq(guardianships.id, link.id));
    try {
      await sms("+18125550101", "Can I still reply?");
      const [inb] = await tx().select().from(inboundMessages).where(and(eq(inboundMessages.orgId, ctx.orgId), eq(inboundMessages.body, "Can I still reply?")));
      expect(inb.status).toBe("unmatched");
      expect(inb.reason).toMatch(/no longer allowed/);
      expect(inb.threadId).toBeNull();
    } finally {
      await tx().update(guardianships).set({ canMessageStaff: true }).where(eq(guardianships.id, link.id));
    }
  });

  it("unknown senders and known contacts without a texted conversation land in the staff-only queue", async () => {
    await sms("+1 317 555 0000", "Who is this?");
    await sms("+1 812 555 0199", "Ava can make Saturday"); // Chris: known, never texted
    const erin = await viewerFor(ctx, "erin");
    const queue = await listInbound(tx(), erin);
    const unknown = queue.find((q) => q.body === "Who is this?")!;
    const chris = queue.find((q) => q.body === "Ava can make Saturday")!;
    expect(unknown).toMatchObject({ status: "unmatched", matchedPersonId: null, reason: "Sender not recognized" });
    expect(chris).toMatchObject({ status: "unmatched", matchedPersonId: ctx.people.chris_parker, matchedName: "Chris Parker" });
    expect(chris.reason).toMatch(/no text conversation/);

    // Coaches and families can't see the queue.
    await expect(listInbound(tx(), await viewerFor(ctx, "marcus"))).rejects.toBeInstanceOf(AuthzError);
    await expect(listInbound(tx(), await viewerFor(ctx, "alex"))).rejects.toBeInstanceOf(AuthzError);

    // Staff attach Chris's text to his conversation: credited to Chris (an eligible participant).
    const r = await attachInbound(tx(), erin, chris.id, T("thread_ava_chris"));
    const [m] = await tx().select().from(messages).where(eq(messages.id, r.messageId));
    expect(m).toMatchObject({ senderPersonId: ctx.people.chris_parker, body: "Ava can make Saturday", inboundChannel: "sms" });
    await expect(attachInbound(tx(), erin, chris.id, T("thread_ava_chris"))).rejects.toThrow(/already handled/);

    // The unknown number attached elsewhere is NOT credited to a family member.
    const r2 = await attachInbound(tx(), erin, unknown.id, T("thread_dana"));
    const [m2] = await tx().select().from(messages).where(eq(messages.id, r2.messageId));
    expect(m2.senderPersonId).toBeNull();
    expect(m2.body).toBe("[Text from +1 317 555 0000] Who is this?");

    await sms("+1 317 555 0001", "spam spam");
    const spam = (await listInbound(tx(), erin)).find((q) => q.body === "spam spam")!;
    await dismissInbound(tx(), erin, spam.id);
    expect((await listInbound(tx(), erin)).some((q) => q.id === spam.id)).toBe(false);
    expect((await listInbound(tx(), erin, "resolved")).some((q) => q.id === spam.id)).toBe(true);
  });

  it("STOP / START / HELP update consent with history; duplicates are ignored", async () => {
    const sid = `SM${randomUUID().replace(/-/g, "")}`;
    const r = await twilio({ MessageSid: sid, From: "+18125550101", To: "+18125550000", Body: "STOP" });
    expect(r.httpStatus).toBe(200);
    expect(await consent(ctx.people.alex_parker, "sms")).toBe("opted_out");
    await twilio({ MessageSid: sid, From: "+18125550101", To: "+18125550000", Body: "STOP" }); // provider retry
    const stops = await tx()
      .select()
      .from(commConsentEvents)
      .where(and(eq(commConsentEvents.personId, ctx.people.alex_parker), eq(commConsentEvents.source, "sms_keyword")));
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ channel: "sms", consent: "opted_out", previousConsent: "opted_in", detail: "Replied STOP" });
    // STOP is never threaded as a conversation message.
    expect(await tx().select().from(inboundMessages).where(eq(inboundMessages.providerMessageId, sid))).toHaveLength(0);

    // SMS to Alex is now suppressed at plan time.
    const alexR = (await recipientForPerson(tx(), ctx.orgId, ctx.people.alex_parker, "guardian"))!;
    const [m] = await tx().select().from(messages).where(eq(messages.threadId, T("thread_maya_alex"))).limit(1);
    const created = await createDeliveries(tx(), { orgId: ctx.orgId, messageId: m.id, recipients: [alexR], channels: ["sms"], now: NOON });
    expect(created.find((d) => d.channel === "sms")!.status).toBe("suppressed");

    await sms("+18125550101", "HELP");
    expect(await consent(ctx.people.alex_parker, "sms")).toBe("opted_out");
    await sms("+18125550101", "START");
    expect(await consent(ctx.people.alex_parker, "sms")).toBe("opted_in");
    const erin = await viewerFor(ctx, "erin");
    const hist = (await staffConsentView(tx(), erin, ctx.people.alex_parker)).history.filter((h) => h.source === "sms_keyword");
    expect(hist.map((h) => h.consent)).toEqual(["opted_in", "opted_out"]);
  });
});

describe("inbound email", () => {
  it("a reply to reply+<token>@ from a participant threads into that conversation", async () => {
    const thread = T("thread_maya_alex");
    const token = replyToken(thread);
    const res = await postmark("postmark-inbound", {
      MessageID: randomUUID(),
      From: "Alex Parker <alex.parker@example.test>",
      FromFull: { Email: "Alex.Parker@example.test", Name: "Alex Parker" },
      To: `reply+${token}@inbound.example.test`,
      ToFull: [{ Email: `reply+${token}@inbound.example.test`, MailboxHash: token }],
      Subject: "Re: Maya's summer training plan",
      TextBody: "Saturdays work too.\n\nOn Mon, Teamwork wrote:\n> Hi!",
      StrippedTextReply: "Saturdays work too.",
    });
    expect(res.httpStatus).toBe(200);
    const [inb] = await tx().select().from(inboundMessages).where(and(eq(inboundMessages.orgId, ctx.orgId), eq(inboundMessages.body, "Saturdays work too.")));
    expect(inb).toMatchObject({ status: "threaded", threadId: thread, channel: "email" });

    // Someone else using Alex's reply address is not threaded.
    await postmark("postmark-inbound", { MessageID: randomUUID(), FromFull: { Email: "chris.parker@example.test" }, To: `reply+${token}@inbound.example.test`, TextBody: "Hijack attempt" });
    const [hijack] = await tx().select().from(inboundMessages).where(eq(inboundMessages.body, "Hijack attempt"));
    expect(hijack).toMatchObject({ status: "unmatched", orgId: ctx.orgId });

    // A tampered token is ignored; Alex has never been *sent* an email here, so it's unmatched.
    const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    await postmark("postmark-inbound", { MessageID: randomUUID(), FromFull: { Email: "alex.parker@example.test" }, To: `reply+${tampered}@inbound.example.test`, TextBody: "Tampered" });
    const [t2] = await tx().select().from(inboundMessages).where(eq(inboundMessages.body, "Tampered"));
    expect(t2.status).toBe("unmatched");
    expect(t2.reason).toMatch(/no email conversation/);
  });

  it("SendGrid Inbound Parse (basic auth) threads by token", async () => {
    const token = replyToken(T("thread_dana"));
    const res = await ingestMessagingWebhook(tx(), "sendgrid-inbound", {
      raw: "",
      headers: new Headers({ authorization: basic() }),
      url: `${BASE}/x`,
      orgSlug: slug,
      form: {
        from: "Dana Brooks <dana.brooks@example.test>",
        to: `reply+${token}@inbound.example.test`,
        subject: "Re: Moving to early mornings",
        text: "6am works, thanks!",
        envelope: JSON.stringify({ to: [`reply+${token}@inbound.example.test`], from: "dana.brooks@example.test" }),
        headers: `Message-ID: <${randomUUID()}@mail.example.test>\nSubject: x`,
      },
    });
    expect(res.httpStatus).toBe(200);
    const [inb] = await tx().select().from(inboundMessages).where(eq(inboundMessages.body, "6am works, thanks!"));
    expect(inb).toMatchObject({ status: "threaded", threadId: T("thread_dana"), provider: "sendgrid" });
  });

  it("outbound email carries the thread's Reply-To when an inbound domain is configured", async () => {
    process.env.EMAIL_INBOUND_DOMAIN = "inbound.example.test";
    let sent: OutboundMessage | null = null;
    const erin = await viewerFor(ctx, "erin");
    const res = await startStaffThread(tx(), erin, { athleteId: ctx.athletes.dana, subject: "Reply-to check", body: "Hi Dana", channels: ["email"] }, NOON);
    const [m] = await tx().select().from(messages).where(eq(messages.threadId, res.threadIds[0]));
    const [d] = await tx()
      .select()
      .from(messageDeliveries)
      .where(and(eq(messageDeliveries.messageId, m.id), eq(messageDeliveries.channel, "email")));
    Object.assign(process.env, { EMAIL_PROVIDER: "postmark", EMAIL_API_KEY: "k", EMAIL_FROM: "hub@example.test", DELIVERY_ENABLED: "true" });
    __setEmailTransport(async (msg) => {
      sent = msg;
      return { providerMessageId: "x" };
    });
    await deliverOne(tx(), d.id, { attempts: 1, maxAttempts: 5 });
    expect(sent!.replyTo).toBe(`reply+${replyToken(res.threadIds[0])}@inbound.example.test`);
  });
});

describe("bounces and complaints", () => {
  it("a hard bounce marks the address undeliverable, fails the accepted delivery, and suppresses future email until cleared", async () => {
    const { deliveryId, providerMessageId } = await acceptedDelivery("email");
    const soft = await postmark("postmark-events", { RecordType: "Bounce", ID: Date.now(), Type: "SoftBounce", Email: "alex.parker@example.test", MessageID: providerMessageId });
    expect(JSON.parse(soft.body).results[0].status).toBe("ignored");
    expect(await tx().select().from(undeliverableAddresses).where(eq(undeliverableAddresses.orgId, ctx.orgId))).toHaveLength(0);

    const ev = { RecordType: "Bounce", ID: Date.now() + 1, Type: "HardBounce", Email: "Alex.Parker@example.test", MessageID: providerMessageId, Description: "Mailbox does not exist" };
    await postmark("postmark-events", ev);
    const dup = await postmark("postmark-events", ev);
    expect(JSON.parse(dup.body).results[0].status).toBe("duplicate");
    const flags = await tx().select().from(undeliverableAddresses).where(eq(undeliverableAddresses.orgId, ctx.orgId));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ address: "alex.parker@example.test", reason: "hard_bounce", provider: "postmark" });
    const [d] = await tx().select().from(messageDeliveries).where(eq(messageDeliveries.id, deliveryId));
    expect(d.status).toBe("failed");
    expect(d.statusReason).toMatch(/Bounced after the provider accepted it/);

    const alexR = (await recipientForPerson(tx(), ctx.orgId, ctx.people.alex_parker, "guardian"))!;
    const [m] = await tx().select().from(messages).where(eq(messages.threadId, T("thread_maya_alex"))).limit(1);
    let created = await createDeliveries(tx(), { orgId: ctx.orgId, messageId: m.id, recipients: [alexR], channels: ["email"], now: NOON });
    expect(created.find((x) => x.channel === "email")).toMatchObject({ status: "suppressed" });
    expect(created.find((x) => x.channel === "email")!.statusReason).toMatch(/undeliverable/);

    const erin = await viewerFor(ctx, "erin");
    const view = await staffConsentView(tx(), erin, ctx.people.alex_parker);
    expect(view.undeliverable).toHaveLength(1);
    await expect(clearUndeliverable(tx(), await viewerFor(ctx, "marcus"), flags[0].id)).rejects.toBeInstanceOf(AuthzError);
    await clearUndeliverable(tx(), erin, flags[0].id);
    created = await createDeliveries(tx(), { orgId: ctx.orgId, messageId: m.id, recipients: [alexR], channels: ["email"], now: NOON });
    expect(created.find((x) => x.channel === "email")!.status).toBe("queued");
  });

  it("a signed SendGrid spam report opts the person out of email and flags the address", async () => {
    const res = await sendgridEvents([
      { event: "delivered", email: "dana.brooks@example.test", sg_event_id: randomUUID(), timestamp: 1 },
      { event: "spamreport", email: "dana.brooks@example.test", sg_event_id: randomUUID(), sg_message_id: "abc.def", timestamp: 2 },
    ]);
    expect(res.httpStatus).toBe(200);
    expect(JSON.parse(res.body).results.map((r: { status: string }) => r.status)).toEqual(["ignored", "processed"]);
    expect(await consent(ctx.people.dana_brooks, "email")).toBe("opted_out");
    const [ev] = await tx()
      .select()
      .from(commConsentEvents)
      .where(and(eq(commConsentEvents.personId, ctx.people.dana_brooks), eq(commConsentEvents.source, "email_complaint")));
    expect(ev).toMatchObject({ consent: "opted_out", previousConsent: "opted_in" });
    const flags = await tx()
      .select()
      .from(undeliverableAddresses)
      .where(and(eq(undeliverableAddresses.orgId, ctx.orgId), eq(undeliverableAddresses.address, "dana.brooks@example.test")));
    expect(flags[0]?.reason).toBe("spam_complaint");
  });
});

describe("route handler", () => {
  it("verifies Twilio against APP_URL + path and answers with empty TwiML; unknown hooks 404", async () => {
    process.env.APP_URL = BASE;
    const { POST } = await import("@/app/api/webhooks/messaging/[hook]/route");
    const params = { MessageSid: `SM${randomUUID().replace(/-/g, "")}`, From: "+1 812 555 0102", To: "+18125550000", Body: "HELP" };
    const path = `/api/webhooks/messaging/twilio-sms?org=${slug}`;
    const req = new Request(`http://127.0.0.1:3000${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(TWILIO_TOKEN, `${BASE}${path}`, params) },
      body: new URLSearchParams(params).toString(),
    });
    const res = await POST(req, { params: Promise.resolve({ hook: "twilio-sms" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/xml");
    expect(await res.text()).toContain("<Response>");
    const nf = await POST(new Request("http://127.0.0.1:3000/api/webhooks/messaging/nope", { method: "POST", body: "" }), { params: Promise.resolve({ hook: "nope" }) });
    expect(nf.status).toBe(404);
  });
});
