import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, creditBuckets, leads, people, trialPasses } from "@/db/schema";
import { assertCan, AuthzError, can, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/billing/errors";
import { actorOf } from "@/lib/billing/util";
import { grantCredits } from "@/lib/credits";

export const TRIAL_PASS_LIMITS = { maxCredits: 20, maxExpiryDays: 365 };

/**
 * Issue a free trial pass: N session credits with an expiry, through the existing credit ledger
 * (source "staff_grant", idempotency key per pass). Staff enter the number of sessions, the
 * expiry and a reason every time; nothing is defaulted.
 *
 * Credits belong to an athlete record, so a lead's person gets one here if they do not have it
 * yet. The lead itself stays open (not converted): converting later reuses the same athlete.
 */
export async function issueTrialPass(
  tx: Tx,
  v: Viewer,
  input: { leadId?: string | null; personId?: string | null; credits: number; expiresInDays: number; reason: string; idempotencyKey: string; now?: Date },
) {
  assertCan(v, "crm.manage");
  const reason = (input.reason ?? "").trim();
  if (!reason) throw new UserError("A reason is required for a trial pass.", { reason: "Required" });
  if (!Number.isInteger(input.credits) || input.credits <= 0 || input.credits > TRIAL_PASS_LIMITS.maxCredits) {
    throw new UserError(`Enter the number of sessions (1 to ${TRIAL_PASS_LIMITS.maxCredits}).`, { credits: "Invalid number" });
  }
  if (!Number.isInteger(input.expiresInDays) || input.expiresInDays <= 0 || input.expiresInDays > TRIAL_PASS_LIMITS.maxExpiryDays) {
    throw new UserError(`Enter how many days the pass is valid (1 to ${TRIAL_PASS_LIMITS.maxExpiryDays}).`, { expiresInDays: "Invalid number" });
  }
  if (!/^[A-Za-z0-9-]{8,64}$/.test(input.idempotencyKey)) throw new UserError("Please reload the page and try again.");
  const now = input.now ?? new Date();

  let personId = input.personId ?? null;
  let leadId: string | null = null;
  let isDemo = false;
  if (input.leadId) {
    // Row lock: two staff issuing for the same lead run one after the other.
    const [lead] = await tx.select().from(leads).where(and(eq(leads.id, input.leadId), eq(leads.orgId, v.orgId))).for("update");
    if (!lead) throw new UserError("Lead not found.");
    leadId = lead.id;
    personId = lead.personId;
    isDemo = lead.isDemo;
  }
  if (!personId) throw new UserError("Choose who the pass is for.");
  const [person] = await tx.select().from(people).where(and(eq(people.id, personId), eq(people.orgId, v.orgId))).for("update");
  if (!person || person.status === "archived") throw new UserError("Person not found.");

  const key = `trial-pass:${input.idempotencyKey}`;
  const [prior] = await tx.select().from(trialPasses).where(and(eq(trialPasses.orgId, v.orgId), eq(trialPasses.idempotencyKey, key)));
  if (prior) return { pass: prior, created: false };

  let [ath] = await tx.select().from(athletes).where(eq(athletes.personId, person.id));
  if (!ath) {
    [ath] = await tx.insert(athletes).values({ orgId: v.orgId, personId: person.id, active: true, isDemo: person.isDemo }).returning();
  } else if (ath.orgId !== v.orgId) throw new AuthzError();

  const expiresAt = new Date(now.getTime() + input.expiresInDays * 86_400_000);
  const [pass] = await tx
    .insert(trialPasses)
    .values({ orgId: v.orgId, leadId, personId: person.id, athleteId: ath.id, credits: input.credits, expiresAt, reason, issuedBy: v.userId, idempotencyKey: key, isDemo: isDemo || person.isDemo })
    .returning();
  const g = await grantCredits(tx, {
    orgId: v.orgId,
    athleteId: ath.id,
    amount: input.credits,
    sourceKind: "staff_grant",
    expiresAt,
    actorUserId: v.userId,
    reason: `Trial pass: ${reason}`,
    idempotencyKey: `trial-pass:${pass.id}`,
    isDemo: pass.isDemo,
  });
  await tx.update(trialPasses).set({ creditBucketId: g.bucket.id }).where(eq(trialPasses.id, pass.id));
  await audit(tx, actorOf(v), "growth.trial_pass.issue", "trial_pass", pass.id, {
    summary: `Trial pass: ${input.credits} session credit(s) for ${person.firstName} ${person.lastName}, valid ${input.expiresInDays} days. Reason: ${reason}`,
    after: { leadId, personId: person.id, athleteId: ath.id, credits: input.credits, expiresAt: expiresAt.toISOString(), creditBucketId: g.bucket.id },
  });
  return { pass: { ...pass, creditBucketId: g.bucket.id }, created: true };
}

/** Passes for a lead with how many credits were used (staff only). */
export async function passesForLead(tx: Tx, v: Viewer, leadId: string) {
  if (!can(v, "crm.manage")) throw new AuthzError();
  return tx
    .select({
      id: trialPasses.id,
      credits: trialPasses.credits,
      expiresAt: trialPasses.expiresAt,
      reason: trialPasses.reason,
      createdAt: trialPasses.createdAt,
      available: sql<number>`coalesce(${creditBuckets.available}, 0)`,
      reserved: sql<number>`coalesce(${creditBuckets.reserved}, 0)`,
    })
    .from(trialPasses)
    .leftJoin(creditBuckets, eq(creditBuckets.id, trialPasses.creditBucketId))
    .where(and(eq(trialPasses.leadId, leadId), eq(trialPasses.orgId, v.orgId)))
    .orderBy(desc(trialPasses.createdAt));
}
