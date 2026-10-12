import { sql } from "drizzle-orm";
import { boolean, timestamp, uuid } from "drizzle-orm/pg-core";

/** Primary key: server-generated UUID. */
export const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);

/** Every tenant-owned row carries its organization; queries always filter on it. */
export const orgId = () => uuid("org_id").notNull();

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** Synthetic demonstration rows are flagged so they can never be confused with real records. */
export const isDemo = () => boolean("is_demo").notNull().default(false);

export const ts = (name: string) => timestamp(name, { withTimezone: true });
