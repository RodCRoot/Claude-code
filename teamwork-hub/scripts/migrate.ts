import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function main() {
  const url = process.argv.includes("--test") ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL (or TEST_DATABASE_URL with --test) is required");
  const pool = new Pool({ connectionString: url });
  await pool.query("CREATE EXTENSION IF NOT EXISTS btree_gist");
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  console.log(`Migrations applied to ${new URL(url).pathname.slice(1)}`);
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
