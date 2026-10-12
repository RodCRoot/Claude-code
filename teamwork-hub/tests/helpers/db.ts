import "dotenv/config";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/db/schema";
import type { DB } from "@/db";
import { seedAll } from "../../scripts/seed/index";
import type { SeedCtx } from "../../scripts/seed/context";
import type { Viewer } from "@/lib/authz/policy";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

// Point the app's lazy db singleton at the test database.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let pool: Pool | null = null;
export function testDb(): DB {
  if (!pool) pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 20 });
  return drizzle(pool, { schema });
}

export async function closeTestDb() {
  await pool?.end();
  pool = null;
  const g = globalThis as unknown as { __twPool?: Pool; __twDb?: unknown };
  if (g.__twPool) {
    await g.__twPool.end();
    g.__twPool = undefined;
    g.__twDb = undefined;
  }
}

/** Seeds an isolated synthetic organization (unique slug) with a fixed "today". */
/** `modules` limits which module seeds run (default: all) so a test file depends only on the fixtures it needs. */
export async function seedOrg(today = "2026-03-02", opts: { modules?: string[] } = {}): Promise<Omit<SeedCtx, "tx">> {
  const db = testDb();
  const ctx = await db.transaction((tx) => seedAll(tx, { today, slug: `test-${randomUUID()}`, modules: opts.modules }));
  const rest: Partial<SeedCtx> = { ...ctx };
  delete rest.tx;
  return rest as Omit<SeedCtx, "tx">;
}

export async function viewerFor(ctx: Omit<SeedCtx, "tx">, userKey: string): Promise<Viewer> {
  const db = testDb();
  const [u] = await db.select().from(users).where(eq(users.id, ctx.users[userKey]));
  return { userId: u.id, orgId: u.orgId, role: u.role, personId: u.personId, displayName: u.displayName, mfaVerified: true };
}
