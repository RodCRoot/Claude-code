import type { SeedCtx } from "./context";
import { seedTraining } from "./training";

/**
 * Module seed registry, run in order after the core identity seed.
 * Each module owns its own file; add one line here per module.
 */
export const moduleSeeds: [string, (ctx: SeedCtx) => Promise<void>][] = [
  ["training", seedTraining],
];
