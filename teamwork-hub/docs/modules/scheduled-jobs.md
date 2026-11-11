# Scheduled jobs

Module `scheduled`. Code in `src/lib/scheduled/jobs.ts`, handlers registered in
`src/lib/jobs-registry.ts`, schedule created by `scripts/worker.ts`, status page
`/settings/jobs`, tests in `tests/scheduled-jobs.test.ts`, browser test `e2e/jobs.spec.ts`.

## What used to wait for a page load

| Evaluation | Page(s) that run it | Scheduled job | Function (shared with the page) |
|---|---|---|---|
| Referral progress (started, earned, new family discount, refund withholding) | `/refer`, People → Referrals, invoice creation | `growth.referrals.nightly` | `syncReferrals` |
| Team challenge completions and challenge badges | Athlete Home, `/leaderboards` | `community.challenges.nightly` | `syncChallengeCompletions` |
| Auto-achieved goals, XP ledger, badges | Athlete Home, `/goals`, performance page | `engagement.refresh.nightly` | `evaluateGoals`, `syncXp`, `syncBadges` (what `refreshEngagement` does) |
| Monthly recap finalization | first view of a closed month | `recap.monthly` (already existed, daily) | `runMonthlyRecaps` |

Checked and not scheduled, because nothing is stored:
- **Streaks**: computed from attendance each time they are shown.
- **Retention radar, win-back list, milestones**: computed live from memberships, attendance,
  billing and feedback on every view. There is no cached score to refresh. Staff tasks and outcomes
  are only ever created by a person.
- **Helpful offers / opportunities**: computed live.
- **Automation rules** already run from the queue hourly (`automation.evaluate`).

The pages still run the same functions, so nothing changes when no worker is running.

## How the schedule works

- Every worker pass (`pnpm jobs:work`, about every 2 seconds when idle) calls `enqueueScheduledJobs`.
- For each organization whose **facility-local** time is past 2:00 AM (`NIGHTLY_HOUR`), it inserts
  one job per nightly type with the dedupe key `<type>:<orgId>:<local date>`. The unique index on
  `jobs.dedupe_key` makes every later pass that day, and any second worker, a no-op.
- If the worker was down at 2:00 AM, the jobs are created on its first pass later that local day.
  A whole missed day is not back-filled; the next night's run covers everything, because every
  evaluation looks at current data and not at "what changed since yesterday".
- The recap job keeps its own daily key and has no hour gate.
- Nothing else is needed in deployment: no cron entry, no second scheduler. See `docs/DEPLOY.md`.

## Safety properties (each has a test)

| Property | How |
|---|---|
| Idempotent, safe to run twice | Unique keys (`xp_events` idempotency key, one badge per athlete and key, one completion per challenge and athlete, one reward per referral and side) and conditional updates |
| Safe alongside a page load doing the same work | The same functions; referral and reward rows are locked `FOR UPDATE`; inserts use `ON CONFLICT DO NOTHING`. Tests race the job against the page function |
| Per organization | One job row per organization; handlers take the org id from the job |
| One failure does not stop the rest | Referrals and athletes each run in their own transaction (`forEachIsolated`). Failures are counted and the first five are kept in the job result and logged (`scheduled_job_item_failed`). Other organizations have separate job rows |
| A broken run is visible and retried | If every item fails, the handler throws: the queue retries with backoff (3 attempts) and then marks the job dead, which the worker reports to Sentry and the status page shows as Failed |
| Sends nothing | No handler creates a message, a delivery or a `messaging.deliver` job (asserted in tests). The recap job only sets the in-app notice. If a job ever needs to notify someone it must go through the messaging outbox, which stays "not configured" without a provider |

## Status page (`/settings/jobs`, owner and admin)

One row per scheduled job: what it does, its schedule, when it last finished for this organization
(facility time), the outcome (Completed, Completed with problems, Failed) and a one-sentence summary
built from the job result, plus whether a run is waiting or retrying. Reads the `jobs` table; no new
table. **Run now** puts one job on the queue for this organization and runs it in the web process
through the same handler (audited as `scheduled_job.run_now`). It exists so the jobs can be used and
checked before a worker is deployed.

## Not done

- No worker has been deployed, so the schedule itself has only run in tests and by hand locally.
- No per-job enable/disable switch and no configurable hour (2:00 AM is a constant).
- Challenge completions for one organization are one transaction (not one per challenge).
- Old finished job rows are not pruned.
