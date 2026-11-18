import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { guardianships, jobs, messageDeliveries, messages, threadParticipants, threads } from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { backoffMs, enqueue, runJobs } from "@/lib/jobs";
import { jobHandlers } from "@/lib/jobs-registry";
import { __setEmailTransport, sendEmail } from "@/lib/messaging/channels/email";
import { __setSmsTransport } from "@/lib/messaging/channels/sms";
import { createDeliveries, deliverOne, planChannel } from "@/lib/messaging/delivery";
import { retryJob } from "@/lib/messaging/outbox";
import { quietHoursEnd } from "@/lib/messaging/quiet-hours";
import { recipientForPerson, routeForAthlete } from "@/lib/messaging/routing";
import {
  listThreadsForFamily,
  listThreadsForStaff,
  loadThread,
  markRead,
  postMessage,
  startFamilyThread,
  startStaffThread,
} from "@/lib/messaging/threads";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
const T = (k: string) => ctx.extra.crm[k];
const tx = () => testDb();

const ENV_KEYS = ["EMAIL_PROVIDER", "EMAIL_API_KEY", "EMAIL_FROM", "SMS_PROVIDER", "SMS_ACCOUNT_SID", "SMS_AUTH_TOKEN", "SMS_FROM", "DELIVERY_ENABLED", "DELIVERY_TEST_RECIPIENTS"];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  ctx = await seedOrg();
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  __setEmailTransport(null);
  __setSmsTransport(null);
});
afterAll(async () => {
  for (const k of ENV_KEYS) if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
  await closeTestDb();
});

const configureEmail = (extra: Record<string, string> = {}) => {
  Object.assign(process.env, { EMAIL_PROVIDER: "postmark", EMAIL_API_KEY: "test-key", EMAIL_FROM: "hub@example.test", DELIVERY_ENABLED: "true", ...extra });
};

describe("thread visibility", () => {
  it("guardians never see internal notes", async () => {
    const alex = await viewerFor(ctx, "alex");
    const view = await loadThread(tx(), alex, T("thread_maya_alex"));
    expect(view.mode).toBe("family");
    expect(view.messages.length).toBeGreaterThan(0);
    expect(view.messages.some((m) => m.isInternalNote)).toBe(false);
    expect(view.messages.map((m) => m.body).join(" ")).not.toContain("check with Marcus");

    // Staff do see it.
    const erin = await viewerFor(ctx, "erin");
    const staffView = await loadThread(tx(), erin, T("thread_maya_alex"));
    expect(staffView.messages.some((m) => m.isInternalNote)).toBe(true);

    // List previews never leak the note either.
    const list = await listThreadsForFamily(tx(), alex);
    const row = list.find((r) => r.id === T("thread_maya_alex"))!;
    expect(row.lastBody).not.toContain("check with Marcus");
    expect(row.lastIsInternal).toBe(false);

    await expect(postMessage(tx(), alex, { threadId: T("thread_maya_alex"), body: "sneaky", internal: true })).rejects.toBeInstanceOf(AuthzError);
  });

  it("internal notes are never delivered", async () => {
    const erin = await viewerFor(ctx, "erin");
    const r = await postMessage(tx(), erin, { threadId: T("thread_maya_alex"), body: "staff only", internal: true, channels: ["email", "sms"] });
    const ds = await tx().select().from(messageDeliveries).where(eq(messageDeliveries.messageId, r.messageId));
    expect(ds).toHaveLength(0);
  });

  it("families never see other families' threads", async () => {
    const chris = await viewerFor(ctx, "chris");
    await expect(loadThread(tx(), chris, T("thread_maya_alex"))).rejects.toBeInstanceOf(AuthzError);
    const ids = (await listThreadsForFamily(tx(), chris)).map((r) => r.id);
    expect(ids).toContain(T("thread_ava_chris"));
    expect(ids).not.toContain(T("thread_maya_alex"));
    expect(ids).not.toContain(T("thread_leo_casey"));
  });

  it("Jordan and Alex participate independently", async () => {
    const alex = await viewerFor(ctx, "alex");
    const jordan = await viewerFor(ctx, "jordan");
    await expect(loadThread(tx(), jordan, T("thread_maya_alex"))).rejects.toBeInstanceOf(AuthzError);
    await expect(loadThread(tx(), alex, T("thread_maya_jordan"))).rejects.toBeInstanceOf(AuthzError);
    const jv = await loadThread(tx(), jordan, T("thread_maya_jordan"));
    // Alex's reply in Alex's thread is not in Jordan's thread.
    expect(jv.messages.map((m) => m.body).join(" ")).not.toContain("Tuesdays and Thursdays");

    // Jordan's reply goes to staff in-app only — never to Alex.
    const r = await postMessage(tx(), jordan, { threadId: T("thread_maya_jordan"), body: "Thanks, Jordan here", clientMutationId: randomUUID() });
    const ds = await tx().select().from(messageDeliveries).where(eq(messageDeliveries.messageId, r.messageId));
    expect(ds.every((d) => d.channel === "in_app")).toBe(true);
    expect(ds.some((d) => d.recipientPersonId === ctx.people.alex_parker)).toBe(false);
    expect(ds.some((d) => d.recipientPersonId === ctx.people.erin)).toBe(true);
  });

  it("losing messages.send on the athlete hides the thread from that guardian", async () => {
    const db = tx();
    const alex = await viewerFor(ctx, "alex");
    const [link] = await db
      .select()
      .from(guardianships)
      .where(and(eq(guardianships.guardianPersonId, ctx.people.alex_parker), eq(guardianships.athleteId, ctx.athletes.maya)));
    await db.update(guardianships).set({ canMessageStaff: false }).where(eq(guardianships.id, link.id));
    try {
      await expect(loadThread(db, alex, T("thread_maya_alex"))).rejects.toBeInstanceOf(AuthzError);
      expect((await listThreadsForFamily(db, alex)).map((r) => r.id)).not.toContain(T("thread_maya_alex"));
      // Staff replies are no longer delivered to Alex either.
      const erin = await viewerFor(ctx, "erin");
      const r = await postMessage(db, erin, { threadId: T("thread_maya_alex"), body: "Update while link paused" });
      const ds = await db.select().from(messageDeliveries).where(eq(messageDeliveries.messageId, r.messageId));
      expect(ds.some((d) => d.recipientPersonId === ctx.people.alex_parker)).toBe(false);
    } finally {
      await db.update(guardianships).set({ canMessageStaff: true }).where(eq(guardianships.id, link.id));
    }
  });

  it("Casey (cannot book) still messages per her own flags; staff messages reach both co-parents separately", async () => {
    const casey = await viewerFor(ctx, "casey");
    const t = await startFamilyThread(tx(), casey, { athleteId: ctx.athletes.leo, subject: "Question", body: "Hi from Casey" });
    expect((await loadThread(tx(), casey, t.threadId)).mode).toBe("family");

    const erin = await viewerFor(ctx, "erin");
    const res = await startStaffThread(tx(), erin, { athleteId: ctx.athletes.leo, subject: "Leo update", body: "Great week!", mode: "separate" });
    expect(res.threadIds).toHaveLength(2);
    const parts = await tx().select().from(threadParticipants).where(inArray(threadParticipants.threadId, res.threadIds));
    const family = parts.filter((p) => p.role !== "staff").map((p) => p.personId);
    expect(family.sort()).toEqual([ctx.people.sam_rivera, ctx.people.casey_nguyen].sort());
    // Sam cannot see Casey's copy.
    const sam = await viewerFor(ctx, "sam");
    const caseyThread = parts.find((p) => p.personId === ctx.people.casey_nguyen)!.threadId;
    await expect(loadThread(tx(), sam, caseyThread)).rejects.toBeInstanceOf(AuthzError);
  });

  it("a guardian without messaging permission cannot start a thread", async () => {
    const chris = await viewerFor(ctx, "chris");
    await expect(startFamilyThread(tx(), chris, { athleteId: ctx.athletes.maya, subject: "x", body: "y" })).rejects.toBeInstanceOf(AuthzError);
  });

  it("messages about a minor go to guardians, not the minor; an adult athlete receives their own", async () => {
    const route = await routeForAthlete(tx(), ctx.orgId, ctx.athletes.maya);
    expect(route!.isMinor).toBe(true);
    expect(route!.recipients.map((r) => r.personId).sort()).toEqual([ctx.people.alex_parker, ctx.people.jordan_parker].sort());
    const maya = await viewerFor(ctx, "maya");
    expect((await listThreadsForFamily(tx(), maya)).map((r) => r.id)).not.toContain(T("thread_maya_alex"));
    await expect(startFamilyThread(tx(), maya, { athleteId: ctx.athletes.maya, subject: "hi", body: "hi" })).rejects.toBeInstanceOf(AuthzError);

    const dana = await routeForAthlete(tx(), ctx.orgId, ctx.athletes.dana);
    expect(dana!.isMinor).toBe(false);
    expect(dana!.recipients.map((r) => r.personId)).toEqual([ctx.people.dana_brooks]);
  });
});

describe("staff scope", () => {
  it("a coach cannot open or start threads for athletes they are not assigned to", async () => {
    const tess = await viewerFor(ctx, "tess"); // youth coach; Maya is HS
    await expect(startStaffThread(tx(), tess, { athleteId: ctx.athletes.maya, subject: "Hi", body: "Hi" })).rejects.toBeInstanceOf(AuthzError);
    await expect(loadThread(tx(), tess, T("thread_maya_alex"))).rejects.toBeInstanceOf(AuthzError);
    expect((await listThreadsForStaff(tx(), tess, { status: "all" })).map((r) => r.id)).not.toContain(T("thread_maya_alex"));

    const marcus = await viewerFor(ctx, "marcus"); // HS coach
    expect((await loadThread(tx(), marcus, T("thread_maya_alex"))).mode).toBe("staff");
    const ok = await startStaffThread(tx(), marcus, { athleteId: ctx.athletes.maya, subject: "Nice work", body: "Great session" });
    expect(ok.threadIds.length).toBe(2);
  });

  it("unread tracking uses last_read_at", async () => {
    const erin = await viewerFor(ctx, "erin");
    const before = (await listThreadsForStaff(tx(), erin, { status: "all" })).find((r) => r.id === T("thread_dana"))!;
    expect(before.unread).toBeGreaterThan(0);
    await markRead(tx(), erin, T("thread_dana"));
    const after = (await listThreadsForStaff(tx(), erin, { status: "all" })).find((r) => r.id === T("thread_dana"))!;
    expect(after.unread).toBe(0);
  });
});

describe("idempotent sends", () => {
  it("the same client mutation id creates one message", async () => {
    const alex = await viewerFor(ctx, "alex");
    const cmid = randomUUID();
    const a = await postMessage(tx(), alex, { threadId: T("thread_maya_alex"), body: "double click", clientMutationId: cmid });
    const b = await postMessage(tx(), alex, { threadId: T("thread_maya_alex"), body: "double click", clientMutationId: cmid });
    expect(b.duplicate).toBe(true);
    expect(b.messageId).toBe(a.messageId);
    const rows = await tx().select().from(messages).where(and(eq(messages.threadId, T("thread_maya_alex")), eq(messages.body, "double click")));
    expect(rows).toHaveLength(1);

    const erin = await viewerFor(ctx, "erin");
    const cm2 = randomUUID();
    const s1 = await startStaffThread(tx(), erin, { athleteId: ctx.athletes.eli, subject: "Eli", body: "hello", clientMutationId: cm2 });
    const s2 = await startStaffThread(tx(), erin, { athleteId: ctx.athletes.eli, subject: "Eli", body: "hello", clientMutationId: cm2 });
    expect(s2.duplicate).toBe(true);
    expect(s2.threadIds.sort()).toEqual(s1.threadIds.sort());
  });
});

describe("delivery rules", () => {
  const noon = new Date("2026-03-03T17:00:00Z"); // 12:00 EST, outside quiet hours

  it("opt-out → suppressed; SMS without opt-in → suppressed; in-app always delivered", async () => {
    const erin = await viewerFor(ctx, "erin");
    const res = await startStaffThread(tx(), erin, { athleteId: ctx.athletes.maya, subject: "Consent check", body: "Hello", channels: ["email", "sms"] }, noon);
    const msgIds = (await tx().select({ id: messages.id }).from(messages).where(inArray(messages.threadId, res.threadIds))).map((m) => m.id);
    const ds = await tx().select().from(messageDeliveries).where(inArray(messageDeliveries.messageId, msgIds));
    const get = (person: string, ch: string) => ds.find((d) => d.recipientPersonId === person && d.channel === ch)!;
    expect(get(ctx.people.jordan_parker, "email").status).toBe("suppressed");
    expect(get(ctx.people.jordan_parker, "email").statusReason).toMatch(/opted out/);
    expect(get(ctx.people.jordan_parker, "sms").status).toBe("suppressed");
    expect(get(ctx.people.jordan_parker, "sms").statusReason).toMatch(/opt-in/);
    expect(get(ctx.people.jordan_parker, "in_app").status).toBe("delivered");
    expect(get(ctx.people.alex_parker, "email").status).toBe("queued");
    expect(get(ctx.people.alex_parker, "sms").status).toBe("queued");
    const queued = await tx().select().from(jobs).where(eq(jobs.dedupeKey, `messaging.deliver:${get(ctx.people.alex_parker, "email").id}`));
    expect(queued).toHaveLength(1);
    expect(queued[0].runAt.getTime()).toBe(noon.getTime());
  });

  it("no provider configured → not_configured (nothing sent)", async () => {
    let called = false;
    __setEmailTransport(async () => {
      called = true;
      return { providerMessageId: "x" };
    });
    const d = await queuedEmailFor(ctx.people.alex_parker);
    const r = await deliverOne(tx(), d.id, { attempts: 1, maxAttempts: 5 });
    expect(r.status).toBe("not_configured");
    expect(called).toBe(false);
    const [row] = await tx().select().from(messageDeliveries).where(eq(messageDeliveries.id, d.id));
    expect(row.status).toBe("not_configured");
    expect(row.statusReason).toMatch(/DELIVERY_ENABLED/);

    // Provider vars set but DELIVERY_ENABLED not "true" → still not configured.
    configureEmail({ DELIVERY_ENABLED: "false" });
    expect((await sendEmail({ to: "a@example.test", subject: "s", body: "b" })).status).toBe("not_configured");
    expect(called).toBe(false);
  });

  it("DELIVERY_TEST_RECIPIENTS redirects real addresses → test_redirected", async () => {
    const sentTo: string[] = [];
    __setEmailTransport(async (m) => {
      sentTo.push(m.to);
      return { providerMessageId: "pm-1" };
    });
    configureEmail({ DELIVERY_TEST_RECIPIENTS: "qa-inbox@example.test,+15550000000" });
    const d = await queuedEmailFor(ctx.people.alex_parker);
    const r = await deliverOne(tx(), d.id, { attempts: 1, maxAttempts: 5 });
    expect(r.status).toBe("test_redirected");
    expect(sentTo).toEqual(["qa-inbox@example.test"]);
    const [row] = await tx().select().from(messageDeliveries).where(eq(messageDeliveries.id, d.id));
    expect(row.status).toBe("test_redirected");
    expect(row.address).toBe("alex.parker@example.test");
    expect(row.providerMessageId).toBe("pm-1");
  });

  it("re-checks consent at send time", async () => {
    configureEmail();
    __setEmailTransport(async () => ({ providerMessageId: "never" }));
    const d = await queuedEmailFor(ctx.people.casey_nguyen);
    const { commPreferences } = await import("@/db/schema");
    await tx()
      .update(commPreferences)
      .set({ consent: "opted_out", consentSource: "test" })
      .where(and(eq(commPreferences.personId, ctx.people.casey_nguyen), eq(commPreferences.channel, "email")));
    const r = await deliverOne(tx(), d.id, { attempts: 1, maxAttempts: 5 });
    expect(r.status).toBe("suppressed");
  });
});

/** Creates a fresh queued email delivery to a person (bypasses quiet hours by using noon). */
async function queuedEmailFor(personId: string) {
  const db = tx();
  const [t] = await db.insert(threads).values({ orgId: ctx.orgId, subject: "Delivery test", kind: "family" }).returning();
  const [m] = await db.insert(messages).values({ threadId: t.id, body: "Test body" }).returning();
  const r = (await recipientForPerson(db, ctx.orgId, personId, "guardian"))!;
  const ds = await createDeliveries(db, { orgId: ctx.orgId, messageId: m.id, recipients: [r], channels: ["email"], now: new Date("2026-03-03T17:00:00Z") });
  const d = ds.find((x) => x.channel === "email")!;
  expect(d.status).toBe("queued");
  return d;
}

describe("quiet hours (America/Indiana/Indianapolis)", () => {
  const qh = { start: "21:00", end: "07:30" };
  it("defers to the end of the window across the spring-forward DST change", () => {
    // 2026-03-08 01:30 EST (UTC-5) = 06:30Z. Window ends 07:30 EDT (UTC-4) = 11:30Z — 5 real hours later.
    const end = quietHoursEnd(new Date("2026-03-08T06:30:00Z"), qh)!;
    expect(end.toISOString()).toBe("2026-03-08T11:30:00.000Z");
  });
  it("defers across the fall-back DST change", () => {
    // 2026-10-31 23:00 EDT = 2026-11-01T03:00Z. Ends 2026-11-01 07:30 EST = 12:30Z.
    const end = quietHoursEnd(new Date("2026-11-01T03:00:00Z"), qh)!;
    expect(end.toISOString()).toBe("2026-11-01T12:30:00.000Z");
  });
  it("does not defer outside the window, and handles same-day windows", () => {
    expect(quietHoursEnd(new Date("2026-03-03T17:00:00Z"), qh)).toBeNull();
    expect(quietHoursEnd(new Date("2026-03-03T17:30:00Z"), { start: "12:00", end: "13:00" })!.toISOString()).toBe("2026-03-03T18:00:00.000Z");
  });
  it("delivery jobs are scheduled at the end of quiet hours; personal windows override the facility window", () => {
    const night = new Date("2026-03-08T06:30:00Z");
    const pref = { id: "x", orgId: ctx.orgId, personId: "p1", channel: "email" as const, consent: "opted_in" as const, consentSource: null, capturedAt: null, quietStartLocal: null, quietEndLocal: null };
    const plan = planChannel({ personId: "p1", email: "a@example.test", phone: null }, "email", [pref], { quietHours: qh, timezone: "America/Indiana/Indianapolis" }, night);
    expect(plan.status).toBe("queued");
    expect(plan.runAt!.toISOString()).toBe("2026-03-08T11:30:00.000Z");
    const personal = planChannel(
      { personId: "p1", email: "a@example.test", phone: null },
      "email",
      [{ ...pref, quietStartLocal: "22:00:00", quietEndLocal: "06:00:00" }],
      { quietHours: qh, timezone: "America/Indiana/Indianapolis" },
      night,
    );
    expect(personal.runAt!.toISOString()).toBe("2026-03-08T10:00:00.000Z"); // 06:00 EDT
  });
});

describe("outbox retry/backoff", () => {
  it("failed deliveries back off, dead-letter after max attempts, and can be retried", async () => {
    configureEmail();
    let calls = 0;
    __setEmailTransport(async (m) => {
      // Other due jobs in the shared test DB may also be claimed; count only ours.
      if (m.to === "dana.brooks@example.test") calls++;
      throw new Error("provider 503");
    });
    const db = tx();
    const d = await queuedEmailFor(ctx.people.dana_brooks);
    // Use our own job (max 3 attempts) instead of the default one.
    await db.update(jobs).set({ status: "cancelled" }).where(eq(jobs.dedupeKey, `messaging.deliver:${d.id}`));
    const jobId = (await enqueue(db, { type: "messaging.deliver", orgId: ctx.orgId, payload: { deliveryId: d.id }, maxAttempts: 3, dedupeKey: `test-retry:${d.id}` }))!;

    const runUntilTouched = async (attempts: number) => {
      for (let i = 0; i < 50; i++) {
        await runJobs(db, jobHandlers, "test-worker", 25);
        const [j] = await db.select().from(jobs).where(eq(jobs.id, jobId));
        if (j.attempts >= attempts && j.status !== "running") return j;
      }
      throw new Error("job never ran");
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const before = Date.now();
      const j = await runUntilTouched(attempt);
      expect(j.status).toBe("pending");
      expect(j.lastError).toMatch(/provider 503/);
      expect(j.runAt.getTime()).toBeGreaterThanOrEqual(before + backoffMs(attempt) - 1000);
      const [row] = await db.select().from(messageDeliveries).where(eq(messageDeliveries.id, d.id));
      expect(row.status).toBe("queued");
      expect(row.attempts).toBe(attempt);
      await db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, jobId)); // skip the wait
    }
    expect(backoffMs(2)).toBeGreaterThan(backoffMs(1));
    const dead = await runUntilTouched(3);
    expect(dead.status).toBe("dead");
    expect(calls).toBe(3);
    const [failed] = await db.select().from(messageDeliveries).where(eq(messageDeliveries.id, d.id));
    expect(failed.status).toBe("failed");

    // Outbox retry (admin only).
    const erin = await viewerFor(ctx, "erin");
    await expect(retryJob(db, erin, jobId)).rejects.toBeInstanceOf(AuthzError);
    const rod = await viewerFor(ctx, "rod");
    await retryJob(db, rod, jobId);
    const [again] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(again.status).toBe("pending");
    expect(again.attempts).toBe(0);
    const [requeued] = await db.select().from(messageDeliveries).where(eq(messageDeliveries.id, d.id));
    expect(requeued.status).toBe("queued");

    __setEmailTransport(async () => ({ providerMessageId: "ok-1" }));
    const done = await runUntilTouched(1);
    expect(done.status).toBe("done");
    const [sent] = await db.select().from(messageDeliveries).where(eq(messageDeliveries.id, d.id));
    expect(sent.status).toBe("sent");
  });
});
