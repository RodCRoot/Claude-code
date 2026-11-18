import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import { athleteBadges, auditEvents, communityChallengeCompletions, invoices, jobs, leads, messageDeliveries, referralRewards, referrals, xpEvents } from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { createInvoiceRecord, recordManualPayment } from "@/lib/billing/invoices";
import { createChallenge, syncChallengeCompletions } from "@/lib/community/challenges";
import { convertLead } from "@/lib/crm/convert";
import { refreshEngagement } from "@/lib/engagement/sync";
import { createReferredInquiry } from "@/lib/growth/intake";
import { ensureReferralCode, syncReferrals } from "@/lib/growth/referrals";
import { enqueue, runJobs } from "@/lib/jobs";
import { jobHandlers } from "@/lib/jobs-registry";
import {
  CHALLENGES_NIGHTLY_JOB,
  ENGAGEMENT_NIGHTLY_JOB,
  NIGHTLY_JOB_TYPES,
  REFERRALS_NIGHTLY_JOB,
  SCHEDULED_JOBS,
  enqueueScheduledJobs,
  forEachIsolated,
  runChallengesNightly,
  runEngagementNightly,
  runReferralsNightly,
  runScheduledJobNow,
  scheduledJobHandlers,
  scheduledJobStatus,
  summarizeResult,
} from "@/lib/scheduled/jobs";
import { RECAP_MONTHLY_JOB } from "@/lib/showcase/jobs";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { inquiry, SAMPLE_CREDIT, setGrowth } from "./growth-helpers";

const T = "2026-03-02";
const db = testDb();
let ctx: Awaited<ReturnType<typeof seedOrg>>;
let other: Awaited<ReturnType<typeof seedOrg>>;
type V = Awaited<ReturnType<typeof viewerFor>>;
let rod: V;
let erin: V;
let parkerCode: string;

beforeAll(async () => {
  // No engagement, growth or community seed: nothing has been evaluated for these organizations yet.
  ctx = await seedOrg(T, { modules: ["scheduling", "billing", "crm", "training", "science"] });
  other = await seedOrg(T, { modules: ["scheduling", "training"] });
  rod = await viewerFor(ctx, "rod");
  erin = await viewerFor(ctx, "erin");
  await setGrowth(ctx.orgId, { referral: { enabled: true, reward: SAMPLE_CREDIT } });
  parkerCode = (await ensureReferralCode(db, ctx.orgId, ctx.payers.parker)).code;
});
afterAll(closeTestDb);

const mine = (type: string) => db.select().from(jobs).where(and(eq(jobs.orgId, ctx.orgId), eq(jobs.type, type)));
const count = async (table: typeof xpEvents | typeof athleteBadges | typeof communityChallengeCompletions, orgId = ctx.orgId) =>
  (await db.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(table.orgId, orgId)))[0].n;

/** A referred lead, converted to a new family, with a paid first invoice (so the next evaluation earns). */
async function paidReferral() {
  const r = await db.transaction((tx) => createReferredInquiry(tx, ctx.orgId, inquiry(), parkerCode, {}));
  await db.update(leads).set({ source: "web_inquiry_test" }).where(eq(leads.id, r.leadId));
  // Converted and invoiced with the hook unable to see the referral as started yet is not possible:
  // the invoice hook already moves it to "started". The nightly job is what moves it to "earned".
  const fam = await db.transaction((tx) => convertLead(tx, erin, { leadId: r.leadId, household: "new", payer: "new", dateOfBirth: "2013-01-15" }));
  const { invoice } = await db.transaction((tx) => createInvoiceRecord(tx, { orgId: ctx.orgId, actorUserId: erin.userId, actorRole: "operations" }, { orgId: ctx.orgId, payerAccountId: fam.payerAccountId, lines: [{ description: "Drop-in (test)", unitAmountMinor: 3000, athleteId: fam.athleteId }] }));
  await db.transaction((tx) => recordManualPayment(tx, erin, { invoiceId: invoice.id, amountMinor: invoice.totalMinor, method: "cash", reference: "TEST-CASH" }));
  const [ref] = await db.select().from(referrals).where(eq(referrals.leadId, r.leadId));
  return { ...fam, leadId: r.leadId, referralId: ref.id, invoiceId: invoice.id };
}

describe("schedule", () => {
  it("creates one job per organization, type and facility-local date, only after 2:00 AM local, and never twice", async () => {
    // Rolled back at the end so other test files' organizations never see these rows.
    await db
      .transaction(async (tx) => {
        const key = (type: string, date: string) => `${type}:${ctx.orgId}:${date}`;
        const rowsFor = async (date: string) => (await tx.select().from(jobs).where(and(eq(jobs.orgId, ctx.orgId), like(jobs.dedupeKey, `%:${date}`)))).map((j) => j.dedupeKey).sort();
        // 05:30 UTC on July 9 is 1:30 AM in Indianapolis (EDT): too early for the nightly jobs. The recap job has no hour gate.
        await enqueueScheduledJobs(tx, new Date("2031-07-09T05:30:00Z"));
        expect(await rowsFor("2031-07-09")).toEqual([key(RECAP_MONTHLY_JOB, "2031-07-09")]);
        // 06:05 UTC is 2:05 AM local.
        const created = await enqueueScheduledJobs(tx, new Date("2031-07-09T06:05:00Z"));
        expect(created).toBeGreaterThanOrEqual(3);
        expect(await rowsFor("2031-07-09")).toEqual([...NIGHTLY_JOB_TYPES.map((t) => key(t, "2031-07-09")), key(RECAP_MONTHLY_JOB, "2031-07-09")].sort());
        // Every later pass that day (and a second worker) adds nothing.
        // (Counted for this organization: other test files create organizations while this runs, and those get their own first jobs.)
        const mine = async () => (await tx.select().from(jobs).where(eq(jobs.orgId, ctx.orgId))).length;
        const n = await mine();
        await enqueueScheduledJobs(tx, new Date("2031-07-09T06:06:00Z"));
        await enqueueScheduledJobs(tx, new Date("2031-07-09T23:00:00Z"));
        expect(await mine()).toBe(n);
        // 03:00 UTC on July 10 is still 11 PM on July 9 locally: nothing new. Next local morning: a new set.
        await enqueueScheduledJobs(tx, new Date("2031-07-10T03:00:00Z"));
        expect(await mine()).toBe(n);
        expect(await enqueueScheduledJobs(tx, new Date("2031-07-10T07:00:00Z"))).toBeGreaterThanOrEqual(4);
        const [j] = await tx.select().from(jobs).where(eq(jobs.dedupeKey, key(ENGAGEMENT_NIGHTLY_JOB, "2031-07-10")));
        expect(j).toMatchObject({ orgId: ctx.orgId, status: "pending", payload: { orgId: ctx.orgId, date: "2031-07-10" } });
        throw new Error("rollback");
      })
      .catch((e) => {
        if ((e as Error).message !== "rollback") throw e;
      });
  });

  it("every scheduled job has a handler in the worker's registry", () => {
    for (const j of SCHEDULED_JOBS) expect(typeof jobHandlers[j.type]).toBe("function");
    expect(SCHEDULED_JOBS.map((j) => j.type)).toEqual(expect.arrayContaining([...NIGHTLY_JOB_TYPES, RECAP_MONTHLY_JOB]));
  });
});

describe("referral progress job", () => {
  it("earns a paid referral without anyone opening a page; a second run and a concurrent page load change nothing", async () => {
    const a = await paidReferral();
    expect((await db.select().from(referrals).where(eq(referrals.id, a.referralId)))[0].status).toBe("started");
    const first = await runReferralsNightly(db, ctx.orgId);
    expect(first).toMatchObject({ earned: 1, rewards: 1, failed: 0 });
    expect((await db.select().from(referrals).where(eq(referrals.id, a.referralId)))[0]).toMatchObject({ status: "earned", qualifyingInvoiceId: a.invoiceId });
    expect(await runReferralsNightly(db, ctx.orgId)).toMatchObject({ earned: 0, rewards: 0, failed: 0 });

    const b = await paidReferral();
    const today = T;
    const raced = await Promise.allSettled([
      runReferralsNightly(db, ctx.orgId),
      db.transaction((tx) => syncReferrals(tx, ctx.orgId, today)), // what /refer and People > Referrals do
      db.transaction((tx) => syncReferrals(tx, ctx.orgId, today)),
      runReferralsNightly(db, ctx.orgId),
    ]);
    expect(raced.every((r) => r.status === "fulfilled")).toBe(true);
    const rewards = await db.select().from(referralRewards).where(eq(referralRewards.referralId, b.referralId));
    expect(rewards).toHaveLength(1);
    expect(rewards[0]).toMatchObject({ status: "pending", beneficiary: "referrer" });
    expect(await db.select().from(auditEvents).where(and(eq(auditEvents.entityId, b.referralId), eq(auditEvents.action, "growth.referral.earned")))).toHaveLength(1);
  });

  it("one referral that fails does not stop the others, and the failure is reported; all failing makes the job fail", async () => {
    const a = await paidReferral();
    const b = await paidReferral();
    const res = await runReferralsNightly(db, ctx.orgId, {
      onItem: (id) => {
        if (id === a.referralId) throw new Error("boom (test)");
      },
    });
    expect(res).toMatchObject({ failed: 1 });
    expect((res as { errors: { id: string; error: string }[] }).errors).toEqual([{ id: a.referralId, error: "boom (test)" }]);
    const status = async (id: string) => (await db.select().from(referrals).where(eq(referrals.id, id)))[0].status;
    expect(await status(a.referralId)).toBe("started");
    expect(await status(b.referralId)).toBe("earned");
    await expect(
      runReferralsNightly(db, ctx.orgId, {
        onItem: () => {
          throw new Error("down (test)");
        },
      }),
    ).rejects.toThrow(/all \d+ item\(s\) failed/);
    // The next clean run picks the failed one up.
    expect(await runReferralsNightly(db, ctx.orgId)).toMatchObject({ earned: 1, failed: 0 });
    expect(await status(a.referralId)).toBe("earned");
  });

  it("forEachIsolated: a failing item rolls back only its own transaction", async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(invoices).where(eq(invoices.orgId, ctx.orgId));
    const res = await forEachIsolated(
      db,
      ["ok", "bad"],
      async (tx, id) => {
        await tx.update(invoices).set({ memo: `touched ${id}` }).where(eq(invoices.orgId, ctx.orgId));
        if (id === "bad") throw new Error("nope");
      },
      "test",
    );
    expect(res).toMatchObject({ processed: 1, failed: 1 });
    const memos = await db.select({ memo: invoices.memo }).from(invoices).where(eq(invoices.orgId, ctx.orgId));
    expect(memos.length).toBe(before[0].n);
    expect(memos.every((m) => m.memo === "touched ok")).toBe(true);
    expect(await forEachIsolated(db, [], async () => {}, "test")).toEqual({ processed: 0, failed: 0, errors: [] });
  });
});

describe("goals, XP and badges job", () => {
  it("awards XP and badges for every active athlete of this organization only, once, also when a page load runs at the same time", async () => {
    expect(await count(xpEvents)).toBe(0);
    const [first, , again] = await Promise.all([
      runEngagementNightly(db, ctx.orgId),
      db.transaction((tx) => refreshEngagement(tx, ctx.orgId, ctx.athletes.maya, { today: T })), // Athlete Home
      runEngagementNightly(db, ctx.orgId),
    ]);
    expect(first).toMatchObject({ failed: 0 });
    expect(again).toMatchObject({ failed: 0 });
    const n = await count(xpEvents);
    expect(n).toBeGreaterThan(0);
    // No duplicates: the unique key did its job.
    const dup = await db.execute(sql`select idempotency_key from xp_events where org_id = ${ctx.orgId} group by idempotency_key having count(*) > 1`);
    expect(dup.rows).toHaveLength(0);
    const badgeDup = await db.execute(sql`select athlete_id, badge_key from athlete_badges where org_id = ${ctx.orgId} group by 1, 2 having count(*) > 1`);
    expect(badgeDup.rows).toHaveLength(0);
    const badges = await count(athleteBadges);
    // A third run finds nothing to add.
    expect(await runEngagementNightly(db, ctx.orgId)).toMatchObject({ xpEvents: 0, badges: 0, goalsAchieved: 0, failed: 0 });
    expect(await count(xpEvents)).toBe(n);
    expect(await count(athleteBadges)).toBe(badges);
    // The other organization was not touched.
    expect(await count(xpEvents, other.orgId)).toBe(0);
    expect(await runEngagementNightly(db, "00000000-0000-4000-8000-000000000000")).toEqual({ skipped: "organization not found" });
  });

  it("one athlete that fails does not stop the rest", async () => {
    await db.execute(sql`delete from athlete_badges where org_id = ${other.orgId}`);
    const res = await runEngagementNightly(db, other.orgId, {
      onItem: (id) => {
        if (id === other.athletes.maya) throw new Error("bad athlete (test)");
      },
    });
    expect(res).toMatchObject({ failed: 1 });
    expect((res as { processed: number }).processed).toBeGreaterThan(1);
    expect((await db.select().from(xpEvents).where(and(eq(xpEvents.orgId, other.orgId), eq(xpEvents.athleteId, other.athletes.maya)))).length).toBe(0);
    expect(await count(xpEvents, other.orgId)).toBeGreaterThan(0);
    const again = await runEngagementNightly(db, other.orgId);
    expect(again).toMatchObject({ failed: 0 });
    expect((await db.select().from(xpEvents).where(and(eq(xpEvents.orgId, other.orgId), eq(xpEvents.athleteId, other.athletes.maya)))).length).toBeGreaterThan(0);
  });
});

describe("challenge completions job", () => {
  it("records finishers and the badge once, with a concurrent page load", async () => {
    await db.transaction((tx) => createChallenge(tx, rod, { title: "One session (test)", mode: "individual", metric: "attendance", target: 1, startsOn: "2026-02-01", endsOn: "2026-03-31", groupId: null }, { today: T }));
    const now = new Date("2026-03-02T17:00:00Z");
    const raced = await Promise.allSettled([
      runChallengesNightly(db, ctx.orgId, { now }),
      db.transaction((tx) => syncChallengeCompletions(tx, ctx.orgId, { today: T })), // Athlete Home and /leaderboards
      runChallengesNightly(db, ctx.orgId, { now }),
    ]);
    expect(raced.every((r) => r.status === "fulfilled")).toBe(true);
    const n = await count(communityChallengeCompletions);
    expect(n).toBeGreaterThan(0);
    const dup = await db.execute(sql`select challenge_id, athlete_id from community_challenge_completions where org_id = ${ctx.orgId} group by 1, 2 having count(*) > 1`);
    expect(dup.rows).toHaveLength(0);
    expect(await runChallengesNightly(db, ctx.orgId, { now })).toEqual({ date: T, completions: 0 });
    expect(await count(communityChallengeCompletions)).toBe(n);
    expect((await db.select().from(athleteBadges).where(and(eq(athleteBadges.orgId, ctx.orgId), eq(athleteBadges.badgeKey, "challenge_complete_v1")))).length).toBe(n);
  });
});

describe("through the queue, the status view and Run now", () => {
  it("runs from the outbox per organization, stores the result, and sends nothing to anyone", async () => {
    const deliveries = async () => Number(((await db.execute(sql`select count(*)::int as n from message_deliveries d join people p on p.id = d.recipient_person_id where p.org_id = ${ctx.orgId}`)).rows[0] as { n: number }).n);
    expect(messageDeliveries).toBeDefined();
    const otherJobs = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(jobs).where(and(eq(jobs.orgId, ctx.orgId), sql`${jobs.type} not in ${[...NIGHTLY_JOB_TYPES, RECAP_MONTHLY_JOB]}`)))[0].n;
    const d0 = await deliveries();
    const j0 = await otherJobs();
    for (const type of NIGHTLY_JOB_TYPES) await enqueue(db, { type, orgId: ctx.orgId, payload: { orgId: ctx.orgId }, dedupeKey: `${type}:${ctx.orgId}:test-queue` });
    // The same key again is ignored.
    expect(await enqueue(db, { type: REFERRALS_NIGHTLY_JOB, orgId: ctx.orgId, payload: { orgId: ctx.orgId }, dedupeKey: `${REFERRALS_NIGHTLY_JOB}:${ctx.orgId}:test-queue` })).toBeNull();
    const results = await runJobs(db, scheduledJobHandlers(db), "test-worker", 10, { orgId: ctx.orgId });
    expect(results.map((r) => [r.type, r.status]).sort()).toEqual(NIGHTLY_JOB_TYPES.map((t) => [t, "done"]).sort());
    const [row] = await mine(ENGAGEMENT_NIGHTLY_JOB);
    expect(row).toMatchObject({ status: "done" });
    expect(row.result).toMatchObject({ failed: 0, xpEvents: 0 });
    expect(row.finishedAt).not.toBeNull();
    // No message, no delivery job, nothing queued for anyone.
    expect(await deliveries()).toBe(d0);
    expect(await otherJobs()).toBe(j0);

    const status = await scheduledJobStatus(db, rod);
    expect(status.map((s) => s.type)).toEqual(SCHEDULED_JOBS.map((j) => j.type));
    const eng = status.find((s) => s.type === ENGAGEMENT_NIGHTLY_JOB)!;
    expect(eng.last).toMatchObject({ outcome: "ok" });
    expect(eng.last!.summary).toMatch(/athletes checked/);
    expect(status.find((s) => s.type === RECAP_MONTHLY_JOB)!.last).toBeNull();
    // Another organization's owner sees only their own (nothing ran there through the queue).
    const otherRod = await viewerFor(other, "rod");
    expect((await scheduledJobStatus(db, otherRod)).every((s) => s.last === null)).toBe(true);
    for (const who of ["erin", "marcus", "alex", "maya", "kiosk"]) await expect(scheduledJobStatus(db, await viewerFor(ctx, who))).rejects.toThrow(AuthzError);
  });

  it("a job whose handler throws is retried, then shown as failed; partial failures are shown as such", async () => {
    await enqueue(db, { type: CHALLENGES_NIGHTLY_JOB, orgId: ctx.orgId, payload: { orgId: ctx.orgId }, dedupeKey: `${CHALLENGES_NIGHTLY_JOB}:${ctx.orgId}:test-dead`, maxAttempts: 1 });
    const res = await runJobs(db, { [CHALLENGES_NIGHTLY_JOB]: async () => { throw new Error("database unavailable (test)"); } }, "test-worker", 5, { orgId: ctx.orgId });
    expect(res[0]).toMatchObject({ status: "dead" });
    const s = (await scheduledJobStatus(db, rod)).find((x) => x.type === CHALLENGES_NIGHTLY_JOB)!;
    expect(s.last).toMatchObject({ outcome: "failed" });
    expect(s.last!.summary).toMatch(/database unavailable/);
    expect(summarizeResult({ athletes: 12, xpEvents: 3, badges: 0, failed: 2, processed: 10 })).toBe("12 athletes checked, 3 XP awards. 2 could not be processed and will be tried again on the next run.");
    expect(summarizeResult({ referrals: 0, started: 0 })).toBe("0 referrals checked.");
    expect(summarizeResult({ skipped: "grace", finalized: 0 })).toMatch(/grace period/);
    expect(summarizeResult(null)).toBe("Finished");
  });

  it("Run now: owner or admin only, audited, uses the real queue path", async () => {
    await expect(runScheduledJobNow(db, erin, ENGAGEMENT_NIGHTLY_JOB)).rejects.toThrow(AuthzError);
    await expect(runScheduledJobNow(db, rod, "automation.evaluate")).rejects.toThrow(/Unknown/);
    const before = (await mine(RECAP_MONTHLY_JOB)).length;
    const res = await runScheduledJobNow(db, rod, RECAP_MONTHLY_JOB);
    expect(res.some((r) => r.type === RECAP_MONTHLY_JOB && r.status === "done")).toBe(true);
    expect((await mine(RECAP_MONTHLY_JOB)).length).toBe(before + 1);
    expect((await scheduledJobStatus(db, rod)).find((s) => s.type === RECAP_MONTHLY_JOB)!.last).not.toBeNull();
    const [au] = await db.select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "scheduled_job.run_now")));
    expect(au.actorUserId).toBe(rod.userId);
  });
});
