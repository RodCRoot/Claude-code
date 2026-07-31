import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

const DB_PATH = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "teamwork.db");

type DB = BetterSQLite3Database<typeof schema>;

declare global {
  var __tbDb: DB | undefined;
}

function createDb(): DB {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const database = drizzle(sqlite, { schema });
  // Apply committed migrations on boot so a fresh checkout "just runs".
  const migrationsFolder = path.join(process.cwd(), "drizzle");
  if (fs.existsSync(migrationsFolder)) {
    migrate(database, { migrationsFolder });
  }
  return database;
}

// Singleton across Next.js dev hot reloads.
export const db: DB = globalThis.__tbDb ?? createDb();
if (process.env.NODE_ENV !== "production") globalThis.__tbDb = db;

export * as tables from "./schema";
