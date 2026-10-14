import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/db/schema";
import { seedAll } from "./seed/index";
import { DEMO_PASSWORD } from "./seed/context";

/** Development-only synthetic seed. Refuses to run outside APP_MODE=demo. */
async function main() {
  if (process.env.APP_MODE !== "demo" || process.env.NODE_ENV === "production") {
    throw new Error("db:seed only runs with APP_MODE=demo outside production. It never touches real data.");
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });
  const existing = await pool.query("select count(*)::int as n from organizations");
  if (existing.rows[0].n > 0 && !process.argv.includes("--force")) {
    console.log("Database already has an organization. Run `npm run db:reset` first (or pass --force).");
    await pool.end();
    return;
  }
  const ctx = await db.transaction((tx) => seedAll(tx));
  console.log(`Seeded synthetic demo organization ${ctx.orgId}`);
  console.log(`Demo password for every sample login: ${DEMO_PASSWORD}  (or use /dev/switch)`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
