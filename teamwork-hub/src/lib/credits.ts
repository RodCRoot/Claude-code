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
 * Lock the athlete's buckets that can pay `amount` for this service at this session time, best first
 * (`preferBucketId` first when given, then soonest-expiring, then oldest). FOR UPDATE re-evaluates
 * "available >= amount" after waiting on a concurrent writer.
 */
async function lockEligibleBuckets(
  tx: Tx,
  r: { orgId: string; athleteId: string; serviceTypeId: string; amount: number; sessionStartsAt: Date; preferBucketId?: string | null },
) {
  return tx
    .select()
    .from(creditBuckets)
    .where(
      and(
        eq(creditBuckets.orgId, r.orgId),
        eq(creditBuckets.athleteId, r.athleteId),
        eq(creditBuckets.status, "active"),
        sql`${creditBuckets.available} >= ${r.amount}`,
        or(isNull(creditBuckets.expiresAt), gt(creditBuckets.expiresAt, r.sessionStartsAt)),
        or(sql`${creditBuckets.periodStart} is null`, lte(creditBuckets.periodStart, sql`(${r.sessionStartsAt.toISOString()}::timestamptz)::date`)),
        sql`(jsonb_array_length(${creditBuckets.serviceTypeIds}) = 0 or ${creditBuckets.serviceTypeIds} ? ${r.serviceTypeId})`,
      ),
    )
    .orderBy(
      ...(r.preferBucketId ? [sql`(${creditBuckets.id} = ${r.preferBucketId}) desc`] : []),
      sql`${creditBuckets.expiresAt} asc nulls last`,
      asc(creditBuckets.createdAt),
    )
    .for("update");
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

  const candidates = await lockEligibleBuckets(tx, { ...r, amount: r.cost });
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
  if (!settle) return { restored: false };
  // Net-aware: a release, or an attendance correction, may already have given the credit back.
  const charge = await bookingNetCharge(tx, r.bookingId);
  if (!charge || charge.net <= 0) return { restored: false };
  const cost = charge.net;
  const bucketId = charge.lastChargeBucketId;
  await tx.select({ id: creditBuckets.id }).from(creditBuckets).where(eq(creditBuckets.id, bucketId)).for("update");
  const inserted = await tx
    .insert(creditLedger)
    .values({
      orgId: settle.orgId,
      bucketId,
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
  await tx.update(creditBuckets).set({ available: sql`${creditBuckets.available} + ${cost}` }).where(eq(creditBuckets.id, bucketId));
  return { restored: true };
}

/**
 * Credits currently charged to a booking = −Σ delta_available of its ledger entries
 * (reserve/consume/forfeit charge; release/restore give back). Null when the booking never
 * reserved credits (unlimited membership, comp, free service).
 */
export async function bookingNetCharge(tx: Tx, bookingId: string) {
  const rows = await tx.select().from(creditLedger).where(eq(creditLedger.bookingId, bookingId));
  const reserve = rows.find((e) => e.idempotencyKey === `reserve:${bookingId}`);
  if (!reserve) return null;
  const net = 0 - rows.reduce((sum, e) => sum + e.deltaAvailable, 0) || 0;
  // Corrections are numbered (`correct:<id>:<n>`); timestamps can tie inside one transaction.
  const prefix = `correct:${bookingId}:`;
  const corrections = rows
    .filter((e) => e.idempotencyKey.startsWith(prefix))
    .sort((a, b) => Number(a.idempotencyKey.slice(prefix.length)) - Number(b.idempotencyKey.slice(prefix.length)));
  // The bucket that paid most recently: the latest correction re-charge, else the reservation.
  const lastCharge = [...corrections].reverse().find((e) => e.deltaAvailable < 0);
  return {
    cost: reserve.deltaReserved,
    net,
    settled: rows.some((e) => e.idempotencyKey === `settle:${bookingId}`),
    corrections: corrections.length,
    staffRestored: rows.some((e) => e.idempotencyKey === `restore:${bookingId}`),
    lastChargeBucketId: lastCharge?.bucketId ?? reserve.bucketId,
    reserveBucketId: reserve.bucketId,
    orgId: reserve.orgId,
    athleteId: reserve.athleteId,
  };
}

/**
 * Re-settle a booking whose reservation was already settled (attendance correction).
 * charge=true → the booking should cost its credit (attended, or no-show under a forfeit policy);
 * charge=false → it should cost nothing (no-show under a release/fee policy).
 * Writes at most one ledger entry (`correct:<bookingId>:<n>`) moving the net charge to the target:
 * a refund goes back to the bucket that paid last; a re-charge prefers the original bucket, else any
 * eligible bucket (row-locked). Throws InsufficientCreditsError when nothing can pay.
 * Callers must hold the booking row lock so <n> is serialized per booking.
 */
export async function resettleBookingCharge(
  tx: Tx,
  r: { bookingId: string; charge: boolean; serviceTypeId: string; sessionStartsAt: Date; actorUserId: string; reason: string },
): Promise<{ delta: number; bucketId: string | null }> {
  const c = await bookingNetCharge(tx, r.bookingId);
  if (!c) return { delta: 0, bucketId: null };
  if (!c.settled) throw new Error("resettleBookingCharge: the reservation is not settled yet");
  // A staff credit restore (restoreCredit, "restore:<id>") is final: later corrections never re-charge it.
  const target = r.charge && !c.staffRestored ? c.cost : 0;
  const diff = target - c.net;
  if (diff === 0) return { delta: 0, bucketId: null };
  let bucketId: string;
  if (diff < 0) {
    bucketId = c.lastChargeBucketId;
    await tx.select({ id: creditBuckets.id }).from(creditBuckets).where(eq(creditBuckets.id, bucketId)).for("update");
  } else {
    const candidates = await lockEligibleBuckets(tx, {
      orgId: c.orgId,
      athleteId: c.athleteId,
      serviceTypeId: r.serviceTypeId,
      amount: diff,
      sessionStartsAt: r.sessionStartsAt,
      preferBucketId: c.reserveBucketId,
    });
    if (!candidates[0]) throw new InsufficientCreditsError();
    bucketId = candidates[0].id;
  }
  await tx.insert(creditLedger).values({
    orgId: c.orgId,
    bucketId,
    athleteId: c.athleteId,
    kind: diff > 0 ? "consume" : "restore",
    deltaAvailable: -diff,
    bookingId: r.bookingId,
    actorUserId: r.actorUserId,
    reason: r.reason,
    idempotencyKey: `correct:${r.bookingId}:${c.corrections + 1}`,
  });
  await tx.update(creditBuckets).set({ available: sql`${creditBuckets.available} - ${diff}` }).where(eq(creditBuckets.id, bucketId));
  return { delta: -diff, bucketId };
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
