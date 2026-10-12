import type { SeedCtx } from "./context";
import { seedScience } from "./science";

/**
 * Module seed registry, run in order after the core identity seed.
 * Each module owns its own file; add one line here per module.
 */
export const moduleSeeds: [string, (ctx: SeedCtx) => Promise<void>][] = [
  ["science", seedScience], // keep after any training seed (uses its set_logs if present)
];
