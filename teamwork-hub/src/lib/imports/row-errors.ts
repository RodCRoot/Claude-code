import { UserError } from "@/lib/actions";

/**
 * Turning a failure while committing ONE import row into a reason staff can read, so the row is rejected
 * and the rest of the file commits (see commitBatch). Returns null for failures that are not about the row
 * (lost connection, serialization failure, out of resources, a query that is simply wrong): those still
 * abort the whole commit, because retrying row by row would hide them.
 */

type PgError = { code: string; constraint?: string; table?: string; column?: string; detail?: string; message: string };

function pgErrorOf(e: unknown): PgError | null {
  for (let cur: unknown = e, depth = 0; cur && depth < 6; depth++) {
    const o = cur as { code?: unknown; severity?: unknown; cause?: unknown };
    if (typeof o.code === "string" && /^[0-9A-Z]{5}$/.test(o.code) && typeof o.severity === "string") return cur as PgError;
    cur = o.cause;
  }
  return null;
}

/** Wording for constraints an imported row can run into. Anything not listed still gets a readable generic reason. */
const CONSTRAINT_REASONS: Record<string, string> = {
  memberships_in_season_fixed_term_ck: "An In Season membership needs both an end date and a cancel date.",
  memberships_kind_ck: "The membership kind is not one the hub knows.",
  memberships_provider_billed_not_renewed: "A membership billed by a payment provider cannot carry a next bill date.",
  memberships_provider_billed_has_subscription: "A membership billed by a payment provider needs its subscription id.",
  sessions_time_order: "The session would end before it starts.",
  sessions_capacity_nonneg: "The session capacity would be negative.",
  sessions_coach_no_overlap: "The coach already has a session at that time.",
  sessions_resource_no_overlap: "The room or resource is already in use at that time.",
  credit_buckets_nonneg: "The class-card balance would be negative.",
  zp_bills_source_uq: "This bill is already in the imported history.",
  bookings_live_uq: "The athlete already has a booking on this session.",
  bookings_idem_uq: "This visit was already imported.",
  external_ids_uq: "This source record is already linked to another record.",
  athletes_person_uq: "This person already has an athlete record.",
};

const TRANSACTION_LEVEL = new Set(["08", "25", "40", "42", "53", "54", "55", "57", "58", "XX", "0A"]);

export function rowRejectionReason(e: unknown): string | null {
  if (e instanceof UserError) return e.message;
  const pg = pgErrorOf(e);
  if (!pg) {
    // A plain exception while handling this row's data (not a database failure).
    const msg = e instanceof Error ? e.message : String(e);
    return `Could not be imported: ${msg.slice(0, 200)}`;
  }
  const cls = pg.code.slice(0, 2);
  if (TRANSACTION_LEVEL.has(cls)) return null;
  const known = pg.constraint ? CONSTRAINT_REASONS[pg.constraint] : undefined;
  if (known) return known;
  const where = pg.table ? ` on ${pg.table.replaceAll("_", " ")}` : "";
  switch (pg.code) {
    case "23505":
      return `A record with the same key already exists${where}${pg.constraint ? ` (${pg.constraint})` : ""}.`;
    case "23514":
      return `The hub's rule "${pg.constraint ?? "check"}"${where} does not allow this row's values.`;
    case "23502":
      return `A required value is missing${pg.column ? `: ${pg.column.replaceAll("_", " ")}` : ""}${where}.`;
    case "23503":
      return `The row points at a record that does not exist${where}${pg.constraint ? ` (${pg.constraint})` : ""}.`;
    case "23P01":
      return `The row overlaps an existing record${where}${pg.constraint ? ` (${pg.constraint})` : ""}.`;
    case "22007":
    case "22008":
      return `A date or time in this row cannot be stored (${pg.message.slice(0, 120)}).`;
    case "22003":
      return "A number in this row is too large to store.";
    case "22001":
      return "A text value in this row is too long to store.";
    case "22021":
    case "22P05":
      return "The row contains characters that cannot be stored.";
    default:
      if (cls === "22" || cls === "23") return `The database refused this row (${pg.message.slice(0, 160)}).`;
      return null;
  }
}

/**
 * The commit's id cache, with an undo for one row: ids created inside a row's savepoint (a session, a plan,
 * a household) vanish with it when the row is rolled back, so the cache must forget them too.
 */
export class RowCache extends Map<string, string> {
  private added: string[] | null = null;

  override set(key: string, value: string): this {
    if (this.added && !this.has(key)) this.added.push(key);
    return super.set(key, value);
  }

  beginRow() {
    this.added = [];
  }

  /** The row committed: keep everything. */
  keepRow() {
    this.added = null;
  }

  /** The row was rolled back: drop what it cached. */
  undoRow() {
    for (const k of this.added ?? []) super.delete(k);
    this.added = null;
  }
}
