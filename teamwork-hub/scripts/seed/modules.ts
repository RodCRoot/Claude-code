import type { SeedCtx } from "./context";

/**
 * Module seed registry, run in order after the core identity seed.
 * Each module owns its own file; add one line here per module.
 */
export const moduleSeeds: [string, (ctx: SeedCtx) => Promise<void>][] = [
  ["documents", (ctx) => import("./documents").then((m) => m.seedDocuments(ctx))],
];
