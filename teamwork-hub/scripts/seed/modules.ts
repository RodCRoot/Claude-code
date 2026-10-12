import type { SeedCtx } from "./context";
import { seedScheduling } from "./scheduling";
import { seedTraining } from "./training";
import { seedBilling } from "./billing";

/**
 * Module seed registry, run in order after the core identity seed.
 * Each module owns its own file; add one line here per module.
 */
export const moduleSeeds: [string, (ctx: SeedCtx) => Promise<void>][] = [
  ["scheduling", seedScheduling],
  ["billing", seedBilling],
  ["documents", (ctx) => import("./documents").then((m) => m.seedDocuments(ctx))],
  ["training", seedTraining],
];
