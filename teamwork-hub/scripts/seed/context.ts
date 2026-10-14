import type { Tx } from "../../src/db";

/**
 * Shared seed context. Core seed fills the identity maps; module seeds
 * (scheduling, billing, training, science, crm, documents, imports) read them
 * and add their own keys. All data is synthetic and flagged is_demo.
 */
export type SeedCtx = {
  tx: Tx;
  orgId: string;
  /** Facility-local "today" (YYYY-MM-DD); fixed in tests for determinism. */
  today: string;
  tz: string;
  users: Record<string, string>;
  people: Record<string, string>;
  athletes: Record<string, string>;
  households: Record<string, string>;
  payers: Record<string, string>;
  groups: Record<string, string>;
  extra: Record<string, Record<string, string>>;
};

export const DEMO_PASSWORD = "teamwork-demo-1";
