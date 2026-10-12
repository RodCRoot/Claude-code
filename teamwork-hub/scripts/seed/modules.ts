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
  ["documents", (ctx) => import("./documents").then((m) => m.seedDocuments(ctx))],
  ["training", seedTraining],
  ["crm", (ctx) => import("./crm").then((m) => m.seedCrm(ctx))],
  ["science", seedScience], // keep after any training seed (uses its set_logs if present)
];
