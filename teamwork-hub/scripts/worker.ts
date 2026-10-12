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

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), worker: workerId, msg, ...extra }));

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
      log("job", { id: r.id, type: r.type, status: r.status, ...(r.error ? { error: r.error.slice(0, 300) } : {}) });
      if (r.status === "dead") dead++;
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
  log("start", { once, limit, interval });
  if (once) {
    const r = await pass();
    log("done", r);
    await getPool().end();
    process.exit(r.dead ? 2 : 0);
  }
  while (!stopping) {
    try {
      const r = await pass();
      if (r.total === 0) await new Promise((res) => setTimeout(res, interval));
    } catch (e) {
      log("pass_failed", { error: e instanceof Error ? e.message : String(e) });
      await new Promise((res) => setTimeout(res, interval * 5));
    }
  }
  log("stopped");
  await getPool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
