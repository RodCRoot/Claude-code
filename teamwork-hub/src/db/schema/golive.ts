import { sql } from "drizzle-orm";
import { date, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts } from "./_common";
import { users } from "./core";

/**
 * A named person's statement about something the hub cannot see for itself (a rehearsed database
 * restore, "we do not use SMS", "I confirm this open decision as it is"). One live row per
 * organization and key; withdrawing keeps the row for the record. The go-live page never treats a
 * row here as proof of anything the system can verify on its own (see src/lib/golive/readiness.ts).
 */
export const goLiveAttestations = pgTable(
  "go_live_attestations",
  {
    id: id(),
    orgId: orgId(),
    /** An id from ATTESTATIONS (src/lib/golive/attestations.ts) or `decision:<id>` from OPEN_DECISIONS. */
    key: text("key").notNull(),
    attestedByUserId: uuid("attested_by_user_id")
      .notNull()
      .references(() => users.id),
    /** Display name at the time, so the label survives a later rename. */
    attestedByName: text("attested_by_name").notNull(),
    /** The facility-local date the person says it was done or decided. */
    attestedOn: date("attested_on").notNull(),
    note: text("note"),
    /** Decisions only: the setting value that was confirmed. A later change reopens the decision. */
    valueSnapshot: jsonb("value_snapshot").$type<string | null>(),
    createdAt: createdAt(),
    withdrawnAt: ts("withdrawn_at"),
    withdrawnByUserId: uuid("withdrawn_by_user_id").references(() => users.id),
  },
  (t) => [
    uniqueIndex("go_live_attestations_live_uq")
      .on(t.orgId, t.key)
      .where(sql`${t.withdrawnAt} is null`),
    index("go_live_attestations_org_idx").on(t.orgId, t.key),
  ],
);
