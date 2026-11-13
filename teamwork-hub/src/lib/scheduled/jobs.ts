/**
 * Scheduled jobs: the evaluations that used to happen only when someone opened a page.
 *
 * | Job | Same function the page calls | Pages that still call it |
 * |---|---|---|
 * | `growth.referrals.nightly` | `syncReferrals` | /refer, People > Referrals, invoice creation |
 * | `community.challenges.nightly` | `syncChallengeCompletions` | Athlete Home, /leaderboards |
 * | `engagement.refresh.nightly` | `evaluateGoals` + `syncXp` + `syncBadges` (= `refreshEngagement`) | Athlete Home, /goals, performance page |
 * | `newswatch.fetch.nightly` | `runNewsWatch` (src/lib/newswatch/job.ts) | none: it only runs here or from Run now |
 * | `recap.monthly` (daily, already existed) | `runMonthlyRecaps` | first view of a closed month |
 *
 * Retention (radar, win-back, milestones) is computed live from other tables on every view and
 * stores nothing, so it has nothing to schedule.
 *
 * How they run: the worker's housekeeping pass calls `enqueueScheduledJobs` (scripts/worker.ts).
 * It puts ONE job per organization, per job type, per facility-local date on the existing queue
 * (`jobs` table, dedupe key `<type>:<orgId>:<local date>`), once the facility-local clock has
 * passed `NIGHTLY_HOUR`. If the worker was down at that hour the job is created on its next pass
 * that day. Every evaluator is idempotent (unique keys and row locks), so running a job twice, or
 * at the same moment as a page load doing the same work, changes nothing the second time.
 *
 * Isolation: each organization has its own job row, and inside a job every athlete / referral is
 * handled in its own transaction, so one bad record is reported in the job result and the rest
 * still run. A job only fails (and is retried by the queue with backoff) when every item failed.
 *
 * Nothing here sends a message to anyone. The recap job sets an in-app notice only. If a job ever
 * needs to notify, it must go through the messaging outbox (`messaging.deliver`), which stays
 * "not configured" until a provider is connected.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB, Tx } from "@/db";
import { athletes, jobs, organizations, referralRewards, referrals } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { syncChallengeCompletions } from "@/lib/community/challenges";
import { evaluateGoals } from "@/lib/engagement/goals";
import { syncBadges, syncXp } from "@/lib/engagement/sync";
import { syncReferrals } from "@/lib/growth/referrals";
import { syncJourneys } from "@/lib/journey/sync";
import { enqueue, runJobs, type JobHandler } from "@/lib/jobs";
import { runNewsWatch } from "@/lib/newswatch/job";
import { NEWS_JOB_TYPE } from "@/lib/newswatch/shared";
import { log } from "@/lib/observability";
import { RECAP_MONTHLY_JOB, enqueueRecapJobs, recapJobHandlers } from "@/lib/showcase/jobs";
import { DEFAULT_TZ, fmt, todayLocal } from "@/lib/time";

export const REFERRALS_NIGHTLY_JOB = "growth.referrals.nightly";
export const CHALLENGES_NIGHTLY_JOB = "community.challenges.nightly";
export const ENGAGEMENT_NIGHTLY_JOB = "engagement.refresh.nightly";
export const JOURNEY_NIGHTLY_JOB = "journey.sync.nightly";

/** Facility-local hour (0 to 23) after which the nightly jobs for that date are created. */
export const NIGHTLY_HOUR = 2;
const MAX_ERRORS_KEPT = 5;

export const NEWSWATCH_NIGHTLY_JOB = NEWS_JOB_TYPE;

export const NIGHTLY_JOB_TYPES = [REFERRALS_NIGHTLY_JOB, CHALLENGES_NIGHTLY_JOB, ENGAGEMENT_NIGHTLY_JOB, JOURNEY_NIGHTLY_JOB, NEWSWATCH_NIGHTLY_JOB] as const;

export const SCHEDULED_JOBS: { type: string; label: string; schedule: string; does: string; manual: boolean }[] = [
  {
    type: REFERRALS_NIGHTLY_JOB,
    label: "Referral progress",
    schedule: "Nightly, after 2:00 AM facility time",
    does: "Moves referrals to Started and Reward earned, applies the new family discount to a first invoice, and withholds rewards after a full refund. Rewards for the referring family still wait for staff approval.",
    manual: true,
  },
  {
    type: CHALLENGES_NIGHTLY_JOB,
    label: "Team challenge completions",
    schedule: "Nightly, after 2:00 AM facility time",
    does: "Records who finished a current challenge and awards the challenge badges.",
    manual: true,
  },
  {
    type: ENGAGEMENT_NIGHTLY_JOB,
    label: "Goals, XP and badges",
    schedule: "Nightly, after 2:00 AM facility time",
    does: "Brings every active athlete's auto-achieved goals, XP and badges up to date. Streaks are worked out from attendance when shown and need no job.",
    manual: true,
  },
  {
    type: JOURNEY_NIGHTLY_JOB,
    label: "Member journey",
    schedule: "Nightly, after 2:00 AM facility time",
    does: "Starts onboarding, touchpoint, milestone, hold and offboarding checklists from memberships, holds, cancellations and visit counts, and ticks the steps the system can already see are done. Sends nothing.",
    manual: true,
  },
  {
    type: NEWSWATCH_NIGHTLY_JOB,
    label: "News watch",
    schedule: "Nightly, after 2:00 AM facility time",
    does: "Reads the news feeds listed in Settings, News watch and puts headlines that match a watched name in Wins, Leads to check. It reads headlines and summaries only, approves nothing and shares nothing. Does nothing while News watch is switched off.",
    manual: true,
  },
  {
    type: RECAP_MONTHLY_JOB,
    label: "Monthly recaps",
    schedule: "Daily; closes last month once the grace period has passed",
    does: "Finalizes last month's recap for athletes who trained and shows the in-app notice. Sends no email or text.",
    manual: true,
  },
];

type ItemError = { id: string; error: string };
export type IsolatedResult = { processed: number; failed: number; errors: ItemError[] };

/**
 * Run `fn` for every id in its own transaction. A failure is recorded and the loop goes on.
 * Throws only when there was work and ALL of it failed (so the queue retries with backoff).
 */
export async function forEachIsolated(db: DB, ids: string[], fn: (tx: Tx, id: string) => Promise<void>, where: string): Promise<IsolatedResult> {
  const out: IsolatedResult = { processed: 0, failed: 0, errors: [] };
  for (const id of ids) {
    try {
      await db.transaction((tx) => fn(tx, id));
      out.processed++;
    } catch (e) {
      out.failed++;
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      if (out.errors.length < MAX_ERRORS_KEPT) out.errors.push({ id, error });
      log("warn", "scheduled_job_item_failed", { where, id, error });
    }
  }
  if (ids.length && out.failed === ids.length) throw new Error(`${where}: all ${ids.length} item(s) failed. First error: ${out.errors[0]?.error ?? "unknown"}`);
  return out;
}

/** Test seam: called inside each item's transaction before the work (lets a test make one item fail). */
type RunOpts = { now?: Date; onItem?: (id: string) => void | Promise<void> };

async function orgTz(db: DB, orgId: string): Promise<string | null> {
  const [o] = await db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId));
  return o ? o.tz || DEFAULT_TZ : null;
}

/** Referral progress for one organization, one referral per transaction. */
export async function runReferralsNightly(db: DB, orgId: string, opts: RunOpts = {}) {
  const tz = await orgTz(db, orgId);
  if (!tz) return { skipped: "organization not found" as const };
  const now = opts.now ?? new Date();
  const today = todayLocal(tz, now);
  // Everything that can still move: open referrals, pending rewards, and applied discounts (an
  // invoice may have been voided since).
  const open = await db.select({ id: referrals.id }).from(referrals).where(and(eq(referrals.orgId, orgId), inArray(referrals.status, ["inquired", "started"])));
  const withRewards = await db
    .select({ id: referralRewards.referralId })
    .from(referralRewards)
    .where(and(eq(referralRewards.orgId, orgId), sql`(${referralRewards.status} = 'pending' or (${referralRewards.kind} = 'invoice_discount' and ${referralRewards.status} = 'approved'))`));
  const ids = [...new Set([...open, ...withRewards].map((r) => r.id))];
  const totals = { started: 0, earned: 0, rejected: 0, rewards: 0, discountsApplied: 0, discountsReleased: 0, discountsConverted: 0, withheld: 0 };
  const res = await forEachIsolated(
    db,
    ids,
    async (tx, id) => {
      await opts.onItem?.(id);
      const r = await syncReferrals(tx, orgId, today, now, { referralIds: [id] });
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r[k];
    },
    REFERRALS_NIGHTLY_JOB,
  );
  return { date: today, referrals: ids.length, ...totals, ...res };
}

/** Challenge completions and their badges for one organization. */
export async function runChallengesNightly(db: DB, orgId: string, opts: RunOpts = {}) {
  const tz = await orgTz(db, orgId);
  if (!tz) return { skipped: "organization not found" as const };
  const today = todayLocal(tz, opts.now ?? new Date());
  const completions = await db.transaction((tx) => syncChallengeCompletions(tx, orgId, { today }));
  return { date: today, completions };
}

/** Goals, XP and badges for every active athlete of one organization, one athlete per transaction. */
export async function runEngagementNightly(db: DB, orgId: string, opts: RunOpts = {}) {
  const tz = await orgTz(db, orgId);
  if (!tz) return { skipped: "organization not found" as const };
  const today = todayLocal(tz, opts.now ?? new Date());
  const rows = await db.select({ id: athletes.id }).from(athletes).where(and(eq(athletes.orgId, orgId), eq(athletes.active, true))).orderBy(athletes.id);
  const totals = { goalsAchieved: 0, xpEvents: 0, badges: 0 };
  const res = await forEachIsolated(
    db,
    rows.map((r) => r.id),
    async (tx, id) => {
      await opts.onItem?.(id);
      // Same order as refreshEngagement: goals first so their XP and badge land in the same pass.
      const goals = await evaluateGoals(tx, orgId, id);
      const xp = await syncXp(tx, orgId, id);
      const badges = await syncBadges(tx, orgId, id, { today });
      totals.goalsAchieved += goals.length;
      totals.xpEvents += xp;
      totals.badges += badges.length;
    },
    ENGAGEMENT_NIGHTLY_JOB,
  );
  return { date: today, athletes: rows.length, ...totals, ...res };
}

/**
 * Member journey: starts checklists from real events (membership, hold, cancellation, visit
 * counts, 5-star feedback) and ticks the steps the system can already see are done. One
 * transaction per organization under an advisory lock; idempotent (unique anchor and step keys).
 * Sends nothing.
 */
export async function runJourneyNightly(db: DB, orgId: string, opts: RunOpts = {}) {
  const tz = await orgTz(db, orgId);
  if (!tz) return { skipped: "organization not found" as const };
  const now = opts.now ?? new Date();
  return db.transaction((tx) => syncJourneys(tx, orgId, { now, today: todayLocal(tz, now) }));
}

const orgOf = (payload: Record<string, unknown>, job: { orgId: string | null }) => {
  const orgId = (typeof payload.orgId === "string" && payload.orgId) || job.orgId;
  if (!orgId) throw new Error("payload.orgId is required");
  return orgId;
};

/** Registered in src/lib/jobs-registry.ts. */
export function scheduledJobHandlers(db: DB): Record<string, JobHandler> {
  return {
    [REFERRALS_NIGHTLY_JOB]: (p, job) => runReferralsNightly(db, orgOf(p, job)),
    [CHALLENGES_NIGHTLY_JOB]: (p, job) => runChallengesNightly(db, orgOf(p, job)),
    [ENGAGEMENT_NIGHTLY_JOB]: (p, job) => runEngagementNightly(db, orgOf(p, job)),
    [JOURNEY_NIGHTLY_JOB]: (p, job) => runJourneyNightly(db, orgOf(p, job)),
    [NEWSWATCH_NIGHTLY_JOB]: (p, job) => runNewsWatch(db, orgOf(p, job)),
  };
}

/**
 * Called on every worker pass. Creates today's nightly jobs for each organization whose
 * facility-local time is past NIGHTLY_HOUR (deduped per organization, type and local date), and
 * the daily recap job. Returns how many jobs were newly created.
 */
export async function enqueueScheduledJobs(tx: Tx, now = new Date()): Promise<number> {
  const orgs = await tx.select({ id: organizations.id, tz: organizations.timezone }).from(organizations);
  let n = 0;
  for (const o of orgs) {
    const tz = o.tz || DEFAULT_TZ;
    if (Number(fmt(now, "H", tz)) < NIGHTLY_HOUR) continue;
    const date = todayLocal(tz, now);
    for (const type of NIGHTLY_JOB_TYPES) {
      if (await enqueue(tx, { type, orgId: o.id, payload: { orgId: o.id, date }, dedupeKey: `${type}:${o.id}:${date}`, maxAttempts: 3 })) n++;
    }
  }
  return n + (await enqueueRecapJobs(tx, now));
}

// ---------------------------------------------------------------------------
// Status (Settings > Scheduled jobs)
// ---------------------------------------------------------------------------

export type ScheduledJobStatus = {
  type: string;
  label: string;
  schedule: string;
  does: string;
  /** The most recent finished run (done or dead), if any. */
  last: { at: Date; outcome: "ok" | "partial" | "failed"; summary: string; attempts: number } | null;
  /** A job that is waiting, running or retrying right now. */
  waiting: { status: string; runAt: Date; attempts: number; lastError: string | null } | null;
};

const SUMMARY_LABEL: Record<string, string> = {
  referrals: "referrals checked",
  started: "started",
  earned: "earned",
  rejected: "not counted",
  rewards: "rewards created",
  discountsApplied: "discounts applied",
  discountsReleased: "discounts released",
  discountsConverted: "discounts turned into credit",
  withheld: "rewards withheld",
  completions: "new completions",
  athletes: "athletes checked",
  goalsAchieved: "goals achieved",
  xpEvents: "XP awards",
  badges: "badges",
  finalized: "recaps finalized",
  journeysCreated: "checklists started",
  stepsCreated: "steps created",
  autoCompleted: "steps ticked automatically",
  moved: "due dates moved for a hold",
  closed: "checklists closed",
  journeysCompleted: "checklists completed",
  sourcesFetched: "news sources read",
  itemsSeen: "headlines read",
  newClips: "new clips to review",
  sourcesSkipped: "sources not due yet",
};

/** One plain sentence from a job's result JSON. */
export function summarizeResult(result: unknown): string {
  if (!result || typeof result !== "object") return "Finished";
  const r = result as Record<string, unknown>;
  if (typeof r.skipped === "string") return r.skipped === "disabled" ? "Skipped: recaps are turned off" : r.skipped === "grace" ? "Nothing to do yet: last month is still in its grace period" : `Skipped: ${r.skipped}`;
  const parts = Object.entries(SUMMARY_LABEL)
    .filter(([k]) => typeof r[k] === "number" && (k === "referrals" || k === "athletes" || k === "completions" || k === "finalized" || k === "stepsCreated" || k === "sourcesFetched" || k === "newClips" || (r[k] as number) > 0))
    .map(([k, label]) => `${r[k]} ${label}`);
  const failed = typeof r.failed === "number" && r.failed > 0 ? ` ${r.failed} could not be processed and will be tried again on the next run.` : "";
  return `${parts.length ? parts.join(", ") : "Nothing to do"}.${failed}`;
}

/** Owner/admin: when each scheduled job last ran for this organization and what it did. */
export async function scheduledJobStatus(tx: Tx, v: Viewer): Promise<ScheduledJobStatus[]> {
  assertCan(v, "settings.manage");
  const out: ScheduledJobStatus[] = [];
  for (const def of SCHEDULED_JOBS) {
    const [fin] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.orgId, v.orgId), eq(jobs.type, def.type), inArray(jobs.status, ["done", "dead"])))
      .orderBy(desc(sql`coalesce(${jobs.finishedAt}, ${jobs.runAt})`))
      .limit(1);
    const [wait] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.orgId, v.orgId), eq(jobs.type, def.type), inArray(jobs.status, ["pending", "running"])))
      .orderBy(jobs.runAt)
      .limit(1);
    const failedItems = Number((fin?.result as { failed?: unknown } | null)?.failed ?? 0);
    out.push({
      type: def.type,
      label: def.label,
      schedule: def.schedule,
      does: def.does,
      last: fin
        ? {
            at: fin.finishedAt ?? fin.runAt,
            outcome: fin.status === "dead" ? "failed" : failedItems > 0 ? "partial" : "ok",
            summary: fin.status === "dead" ? `Failed after ${fin.attempts} attempts: ${(fin.lastError ?? "unknown error").slice(0, 300)}` : summarizeResult(fin.result),
            attempts: fin.attempts,
          }
        : null,
      waiting: wait ? { status: wait.status, runAt: wait.runAt, attempts: wait.attempts, lastError: wait.lastError } : null,
    });
  }
  return out;
}

/**
 * Owner/admin "Run now": puts one job for this organization on the queue and runs this
 * organization's waiting jobs of that type in this process, through the same handler the worker
 * uses. Useful before a worker is deployed and after fixing data. Audited.
 */
export async function runScheduledJobNow(db: DB, v: Viewer, type: string, now = new Date()) {
  assertCan(v, "settings.manage");
  const def = SCHEDULED_JOBS.find((j) => j.type === type && j.manual);
  if (!def) throw new Error("Unknown scheduled job.");
  const handlers = { ...scheduledJobHandlers(db), ...recapJobHandlers };
  await db.transaction(async (tx) => {
    await enqueue(tx, { type, orgId: v.orgId, payload: { orgId: v.orgId, manual: true }, dedupeKey: `${type}:${v.orgId}:manual:${now.toISOString()}`, maxAttempts: 1 });
    await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "scheduled_job.run_now", "organization", v.orgId, { summary: `Ran scheduled job now: ${def.label}` });
  });
  return runJobs(db, { [type]: handlers[type] }, `manual-${v.userId}`, 5, { orgId: v.orgId });
}
