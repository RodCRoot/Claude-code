import type { SeedCtx } from "./context";

/**
 * Module seed registry, run in order after the core identity seed.
 * Each module owns its own file; add one line here per module.
 */
export const moduleSeeds: [string, (ctx: SeedCtx) => Promise<void>][] = [
  ["crm", (ctx) => import("./crm").then((m) => m.seedCrm(ctx))],
];
