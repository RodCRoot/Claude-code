import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { creditBuckets, creditLedger } from "@/db/schema";

/**
 * Session-credit ledger.
 *
 * Invariants (enforced in code + DB):
 * - A settled invoice line grants credits at most once (unique credit_buckets.source_invoice_line_id).
 * - Every ledger entry has a unique idempotency key; retries are no-ops.
 * - Reservation takes a row lock on the chosen bucket and re-checks availability,
 *   so concurrent bookings cannot overspend (CHECK available >= 0 is the backstop).
 * - A booking's reservation is settled exactly once (consume | release | forfeit),
 *   via the "settle:<bookingId>" key.
 */

export type GrantInput = {
  orgId: string;
  athleteId: string;
  amount: number;
  sourceKind: (typeof creditBuckets.$inferInsert)["sourceKind"];
  sourceInvoiceLineId?: string | null;
  membershipId?: string | null;
  serviceTypeIds?: string[];
  expiresAt?: Date | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  actorUserId?: string | null;
  reason?: string;
  idempotencyKey: string;
  isDemo?: boolean;
};

export async function grantCredits(tx: Tx, g: GrantInput) {
  if (!Number.isInteger(g.amount) || g.amount <= 0) throw new Error("grant amount must be a positive integer");
  // Fast path: this idempotency key was already applied.
  const [prior] = await tx.select().from(creditLedger).where(eq(creditLedger.idempotencyKey, g.idempotencyKey));
  if (prior) {
    const [b] = await tx.select().from(creditBuckets).where(eq(creditBuckets.id, prior.bucketId));
    return { bucket: b, created: false };
  }
  const inserted = await tx
    .insert(creditBuckets)
    .values({
      orgId: g.orgId,
      athleteId: g.athleteId,
      membershipId: g.membershipId ?? null,
      sourceInvoiceLineId: g.sourceInvoiceLineId ?? null,
      sourceKind: g.sourceKind,
      serviceTypeIds: g.serviceTypeIds ?? [],
      granted: g.amount,
      available: g.amount,
      expiresAt: g.expiresAt ?? null,
      periodStart: g.periodStart ?? null,
      periodEnd: g.periodEnd ?? null,
      isDemo: g.isDemo ?? false,
    })
    .onConflictDoNothing({ target: creditBuckets.sourceInvoiceLineId })
    .returning();
  if (!inserted.length) {
    // Same invoice line already granted (e.g. duplicate webhook) — return the existing bucket.
    const [b] = await tx.select().from(creditBuckets).where(eq(creditBuckets.sourceInvoiceLineId, g.sourceInvoiceLineId!));
    return { bucket: b, created: false };
  }
  const bucket = inserted[0];
  await tx.insert(creditLedger).values({
    orgId: g.orgId,
    bucketId: bucket.id,
    athleteId: g.athleteId,
    kind: "grant",
    deltaAvailable: g.amount,
    actorUserId: g.actorUserId ?? null,
    reason: g.reason ?? null,
    idempotencyKey: g.idempotencyKey,
  });
  return { bucket, created: true };
}

export class InsufficientCreditsError extends Error {
  constructor() {
    super("No available session credits for this session type.");
    this.name = "InsufficientCreditsError";
  }
}

/**
 * Reserve `cost` credits for a booking from the soonest-expiring eligible bucket.
 * Must run inside the booking transaction.
 */
export async function reserveCredits(
  tx: Tx,
  r: { orgId: string; athleteId: string; bookingId: string; serviceTypeId: string; cost: number; sessionStartsAt: Date; actorUserId?: string | null },
) {
  const key = `reserve:${r.bookingId}`;
  const [prior] = await tx.select().from(creditLedger).where(eq(creditLedger.idempotencyKey, key));
  if (prior) return { bucketId: prior.bucketId, reused: true };
  if (r.cost === 0) return { bucketId: null, reused: false };

  // Lock eligible buckets; FOR UPDATE re-evaluates "available >= cost" after waiting on a concurrent writer.
  const candidates = await tx
    .select()
    .from(creditBuckets)
    .where(
      and(
        eq(creditBuckets.orgId, r.orgId),
        eq(creditBuckets.athleteId, r.athleteId),
        eq(creditBuckets.status, "active"),
        sql`${creditBuckets.available} >= ${r.cost}`,
        or(isNull(creditBuckets.expiresAt), gt(creditBuckets.expiresAt, r.sessionStartsAt)),
        or(sql`${creditBuckets.periodStart} is null`, lte(creditBuckets.periodStart, sql`(${r.sessionStartsAt.toISOString()}::timestamptz)::date`)),
        sql`(jsonb_array_length(${creditBuckets.serviceTypeIds}) = 0 or ${creditBuckets.serviceTypeIds} ? ${r.serviceTypeId})`,
      ),
    )
    .orderBy(sql`${creditBuckets.expiresAt} asc nulls last`, asc(creditBuckets.createdAt))
    .for("update");
  const bucket = candidates[0];
  if (!bucket) throw new InsufficientCreditsError();

  await tx
    .update(creditBuckets)
    .set({ available: sql`${creditBuckets.available} - ${r.cost}`, reserved: sql`${creditBuckets.reserved} + ${r.cost}` })
    .where(eq(creditBuckets.id, bucket.id));
  await tx.insert(creditLedger).values({
    orgId: r.orgId,
    bucketId: bucket.id,
    athleteId: r.athleteId,
    kind: "reserve",
    deltaAvailable: -r.cost,
    deltaReserved: r.cost,
    bookingId: r.bookingId,
    actorUserId: r.actorUserId ?? null,
    idempotencyKey: key,
  });
  return { bucketId: bucket.id, reused: false };
}

export type Settlement = "consume" | "release" | "forfeit";

/**
 * Settle a booking's reservation exactly once.
 * consume: attended (credit used). release: cancelled in time (credit returned).
 * forfeit: late cancel / no-show under a forfeit policy (credit used, recorded as forfeit).
 */
export async function settleReservation(tx: Tx, s: { bookingId: string; outcome: Settlement; actorUserId?: string | null; reason?: string }) {
  const [reserve] = await tx.select().from(creditLedger).where(eq(creditLedger.idempotencyKey, `reserve:${s.bookingId}`));
  if (!reserve) return { settled: false, reason: "no_reservation" as const };
  const cost = reserve.deltaReserved;
  const [bucket] = await tx.select().from(creditBuckets).where(eq(creditBuckets.id, reserve.bucketId)).for("update");
  const inserted = await tx
    .insert(creditLedger)
    .values({
      orgId: reserve.orgId,
      bucketId: bucket.id,
      athleteId: reserve.athleteId,
      kind: s.outcome,
      deltaAvailable: s.outcome === "release" ? cost : 0,
      deltaReserved: -cost,
      bookingId: s.bookingId,
      actorUserId: s.actorUserId ?? null,
      reason: s.reason ?? null,
      idempotencyKey: `settle:${s.bookingId}`,
    })
    .onConflictDoNothing({ target: creditLedger.idempotencyKey })
    .returning();
  if (!inserted.length) return { settled: false, reason: "already_settled" as const };
  await tx
    .update(creditBuckets)
    .set({
      reserved: sql`${creditBuckets.reserved} - ${cost}`,
      available: s.outcome === "release" ? sql`${creditBuckets.available} + ${cost}` : creditBuckets.available,
    })
    .where(eq(creditBuckets.id, bucket.id));
  return { settled: true, outcome: s.outcome };
}

/** Staff reversal of a consumed/forfeited credit (e.g. excused no-show). Allowed once per booking; requires a reason. */
export async function restoreCredit(tx: Tx, r: { bookingId: string; actorUserId: string; reason: string }) {
  if (!r.reason.trim()) throw new Error("A reason is required to restore a credit.");
  const [settle] = await tx.select().from(creditLedger).where(eq(creditLedger.idempotencyKey, `settle:${r.bookingId}`));
  if (!settle || settle.kind === "release") return { restored: false };
  const cost = -settle.deltaReserved;
  const inserted = await tx
    .insert(creditLedger)
    .values({
      orgId: settle.orgId,
      bucketId: settle.bucketId,
      athleteId: settle.athleteId,
      kind: "restore",
      deltaAvailable: cost,
      bookingId: r.bookingId,
      actorUserId: r.actorUserId,
      reason: r.reason,
      idempotencyKey: `restore:${r.bookingId}`,
    })
    .onConflictDoNothing({ target: creditLedger.idempotencyKey })
    .returning();
  if (!inserted.length) return { restored: false };
  await tx.update(creditBuckets).set({ available: sql`${creditBuckets.available} + ${cost}` }).where(eq(creditBuckets.id, settle.bucketId));
  return { restored: true };
}

/** Attributable staff adjustment on an existing bucket (positive or negative). */
export async function adjustCredits(tx: Tx, a: { bucketId: string; delta: number; actorUserId: string; reason: string; idempotencyKey: string }) {
  if (!a.reason.trim()) throw new Error("A reason is required for credit adjustments.");
  if (!Number.isInteger(a.delta) || a.delta === 0) throw new Error("Adjustment must be a non-zero integer.");
  const [bucket] = await tx.select().from(creditBuckets).where(eq(creditBuckets.id, a.bucketId)).for("update");
  if (!bucket) throw new Error("Credit bucket not found.");
  if (bucket.available + a.delta < 0) throw new Error("Adjustment would make available credits negative.");
  const inserted = await tx
    .insert(creditLedger)
    .values({
      orgId: bucket.orgId,
      bucketId: bucket.id,
      athleteId: bucket.athleteId,
      kind: "adjust",
      deltaAvailable: a.delta,
      actorUserId: a.actorUserId,
      reason: a.reason,
      idempotencyKey: a.idempotencyKey,
    })
    .onConflictDoNothing({ target: creditLedger.idempotencyKey })
    .returning();
  if (!inserted.length) return { applied: false };
  await tx
    .update(creditBuckets)
    .set({
      available: sql`${creditBuckets.available} + ${a.delta}`,
      granted: a.delta > 0 ? sql`${creditBuckets.granted} + ${a.delta}` : creditBuckets.granted,
    })
    .where(eq(creditBuckets.id, bucket.id));
  return { applied: true };
}

/** Expire unused credits whose expiry has passed. Reserved credits are left to settle normally. */
export async function expireCredits(tx: Tx, now = new Date()) {
  const due = await tx
    .select()
    .from(creditBuckets)
    .where(and(eq(creditBuckets.status, "active"), lte(creditBuckets.expiresAt, now)))
    .for("update", { skipLocked: true });
  let expired = 0;
  for (const b of due) {
    if (b.available > 0) {
      const ins = await tx
        .insert(creditLedger)
        .values({
          orgId: b.orgId,
          bucketId: b.id,
          athleteId: b.athleteId,
          kind: "expire",
          deltaAvailable: -b.available,
          reason: "Credits expired",
          idempotencyKey: `expire:${b.id}`,
        })
        .onConflictDoNothing({ target: creditLedger.idempotencyKey })
        .returning();
      if (ins.length) expired += b.available;
    }
    await tx
      .update(creditBuckets)
      .set({ available: 0, status: b.reserved > 0 ? "active" : "expired" })
      .where(eq(creditBuckets.id, b.id));
  }
  return { bucketsProcessed: due.length, creditsExpired: expired };
}

/** Current balances for an athlete (active buckets only). */
export async function creditSummary(tx: Tx, athleteId: string, now = new Date()) {
  const rows = await tx
    .select()
    .from(creditBuckets)
    .where(and(eq(creditBuckets.athleteId, athleteId), eq(creditBuckets.status, "active")))
    .orderBy(sql`${creditBuckets.expiresAt} asc nulls last`);
  const live = rows.filter((b) => !b.expiresAt || b.expiresAt > now);
  return {
    available: live.reduce((s, b) => s + b.available, 0),
    reserved: rows.reduce((s, b) => s + b.reserved, 0),
    buckets: rows,
  };
}

/**
 * Ledger consistency check used by tests and the reconciliation report:
 * for every bucket, available/reserved must equal the sum of ledger deltas.
 */
export async function verifyLedger(tx: Tx, orgId: string) {
  const res = await tx.execute(sql`
    select b.id, b.available, b.reserved,
      coalesce(sum(l.delta_available),0)::int as ledger_available,
      coalesce(sum(l.delta_reserved),0)::int as ledger_reserved
    from credit_buckets b left join credit_ledger l on l.bucket_id = b.id
    where b.org_id = ${orgId}
    group by b.id`);
  return (res.rows as { id: string; available: number; reserved: number; ledger_available: number; ledger_reserved: number }[]).filter(
    (r) => r.available !== r.ledger_available || r.reserved !== r.ledger_reserved,
  );
}
