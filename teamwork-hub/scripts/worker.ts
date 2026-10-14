/**
 * Job worker: claims due jobs (FOR UPDATE SKIP LOCKED) and runs them through the
 * central registry in src/lib/jobs-registry.ts.
 *
 *   pnpm jobs:work            # loop until SIGINT/SIGTERM
 *   pnpm jobs:work --once     # one pass (cron-friendly), exits non-zero if any job died
 *
 * Options: --limit N (jobs per claim, default 10), --interval MS (idle poll, default 2000).
 * Each pass also re-queues jobs stuck in `running` (crashed worker) and enqueues an hourly
 * `automation.evaluate` scan per organization (deduped per hour).
 */
import "dotenv/config";
import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import { db, getPool } from "../src/db";
import { organizations } from "../src/db/schema";
import { enqueue, runJobs } from "../src/lib/jobs";
import { jobHandlers } from "../src/lib/jobs-registry";
import { flushMonitoring, initMonitoring, log as olog, reportError } from "../src/lib/observability";

const args = process.argv.slice(2);
const once = args.includes("--once");
const num = (flag: string, d: number) => {
  const i = args.indexOf(flag);
  const n = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : d;
};
const limit = num("--limit", 10);
const interval = num("--interval", 2000);
const workerId = `worker-${hostname()}-${process.pid}`;
const STALE_MINUTES = 15;

// Structured, redacted JSON lines (src/lib/observability.ts).
const log = (msg: string, extra: Record<string, unknown> = {}) => olog("info", msg, { worker: workerId, ...extra });

async function housekeeping() {
  const res = await db.execute(sql`
    update jobs set status = 'pending', locked_at = null, locked_by = null,
      last_error = coalesce(last_error, '') || ' [re-queued after stale lock]'
    where status = 'running' and locked_at < now() - make_interval(mins => ${STALE_MINUTES})
    returning id`);
  if (res.rows.length) log("requeued_stale", { count: res.rows.length });
  const hour = new Date().toISOString().slice(0, 13);
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  for (const o of orgs) {
    await enqueue(db, { type: "automation.evaluate", orgId: o.id, payload: { orgId: o.id }, dedupeKey: `automation.evaluate:scan:${o.id}:${hour}` });
  }
}

async function pass() {
  await housekeeping();
  let total = 0;
  let dead = 0;
  for (;;) {
    const results = await runJobs(db, jobHandlers, workerId, limit);
    for (const r of results) {
      if (r.status === "dead") {
        dead++;
        // Out of retries: needs a human. Logged + sent to Sentry (when SENTRY_DSN is set).
        reportError(r.cause ?? new Error(r.error ?? "job failed"), { where: `job:${r.type}`, worker: workerId, jobId: r.id, attempts: r.attempts });
      } else if (r.status === "retry") {
        olog("warn", "job_retry", { worker: workerId, id: r.id, type: r.type, attempts: r.attempts, error: (r.error ?? "").slice(0, 300) });
      } else {
        log("job", { id: r.id, type: r.type, status: r.status });
      }
    }
    total += results.length;
    if (results.length < limit) break;
  }
  return { total, dead };
}

let stopping = false;
process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));

async function main() {
  await initMonitoring("worker");
  log("start", { once, limit, interval });
  if (once) {
    const r = await pass();
    log("done", r);
    await getPool().end();
    await flushMonitoring();
    process.exit(r.dead ? 2 : 0);
  }
  while (!stopping) {
    try {
      const r = await pass();
      if (r.total === 0) await new Promise((res) => setTimeout(res, interval));
    } catch (e) {
      reportError(e, { where: "worker:pass", worker: workerId });
      await new Promise((res) => setTimeout(res, interval * 5));
    }
  }
  log("stopped");
  await getPool().end();
  await flushMonitoring();
}

main().catch(async (e) => {
  reportError(e, { where: "worker:main", worker: workerId });
  await flushMonitoring();
  process.exit(1);
});
