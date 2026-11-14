import "dotenv/config";
import { Pool } from "pg";

/** Development-only: drops and recreates the schema. Refuses outside demo mode. */
async function main() {
  const test = process.argv.includes("--test");
  const url = test ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error("database url missing");
  if (process.env.APP_MODE !== "demo" || process.env.NODE_ENV === "production") {
    throw new Error("db:reset is only allowed with APP_MODE=demo outside production");
  }
  const pool = new Pool({ connectionString: url });
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
  console.log(`Reset ${new URL(url).pathname.slice(1)}`);
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
