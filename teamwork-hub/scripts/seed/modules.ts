import type { SeedCtx } from "./context";
import { seedScheduling } from "./scheduling";
import { seedTraining } from "./training";
import { seedBilling } from "./billing";
import { seedScience } from "./science";

/**
 * Module seed registry, run in order after the core identity seed.
 * Each module owns its own file; add one line here per module.
 */
export const moduleSeeds: [string, (ctx: SeedCtx) => Promise<void>][] = [
  ["scheduling", seedScheduling],
  ["billing", seedBilling],
  ["locations", (ctx) => import("./locations").then((m) => m.seedLocations(ctx))], // after scheduling + billing
  ["documents", (ctx) => import("./documents").then((m) => m.seedDocuments(ctx))],
  ["training", seedTraining],
  ["vbt", (ctx) => import("./vbt").then((m) => m.seedVbt(ctx))], // after training (exercise library); synthetic bar speeds
  ["crm", (ctx) => import("./crm").then((m) => m.seedCrm(ctx))],
  ["custom-fields", (ctx) => import("./custom-fields").then((m) => m.seedCustomFields(ctx))],
  ["payroll", (ctx) => import("./payroll").then((m) => m.seedPayroll(ctx))],
  ["member-requests", (ctx) => import("./member-requests").then((m) => m.seedMemberRequests(ctx))],
  ["retention", (ctx) => import("./retention").then((m) => m.seedRetention(ctx))], // after scheduling + billing + documents
  ["growth", (ctx) => import("./growth").then((m) => m.seedGrowth(ctx))], // after billing, crm and scheduling
  ["events", (ctx) => import("./events").then((m) => m.seedEvents(ctx))], // after scheduling + billing; sample camps and clinics
  ["scoreboard", (ctx) => import("./scoreboard").then((m) => m.seedScoreboard(ctx))], // OPT-IN (see HISTORY_SEEDS): months of synthetic history for the owner scoreboard
  ["science", seedScience], // keep after any training seed (uses its set_logs if present)
  ["anywhere", (ctx) => import("./anywhere").then((m) => m.seedAnywhere(ctx))], // after training + science (reuses the exercise library, adds load rows)
  ["engagement", (ctx) => import("./engagement").then((m) => m.seedEngagement(ctx))], // last: derives XP/badges from every other module
  ["showcase", (ctx) => import("./showcase").then((m) => m.seedShowcase(ctx))], // after engagement: recaps read badges and goals
  ["community", (ctx) => import("./community").then((m) => m.seedCommunity(ctx))], // after engagement (XP ledger, badges) and showcase (adds PRs it must not see)
];

/**
 * Seeds that add a large synthetic history. They run for the demo database (`pnpm db:fresh`) and
 * when a test names them in `modules`, but NOT in the default test seed, so other modules'
 * fixtures and counts stay as they were.
 */
export const HISTORY_SEEDS = ["scoreboard"];
