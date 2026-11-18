import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, types } from "pg";
import * as schema from "./schema";

// Return DATE columns as plain "YYYY-MM-DD" strings (no timezone shifting).
types.setTypeParser(1082, (v) => v);

export type DB = NodePgDatabase<typeof schema>;
/** Either the root db or a transaction handle. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0] | DB;

const globalForDb = globalThis as unknown as { __twPool?: Pool; __twDb?: DB };

export function getPool(): Pool {
  if (!globalForDb.__twPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForDb.__twPool = new Pool({ connectionString: url, max: 10 });
  }
  return globalForDb.__twPool;
}

export const db: DB = new Proxy({} as DB, {
  get(_t, prop) {
    if (!globalForDb.__twDb) globalForDb.__twDb = drizzle(getPool(), { schema });
    return Reflect.get(globalForDb.__twDb, prop);
  },
});

export { schema };
