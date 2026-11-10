import { randomInt } from "node:crypto";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import {
  accountCreditLedger,
  athletes,
  invoices,
  leads,
  memberships,
  organizations,
  payerAccounts,
  payerBeneficiaries,
  paymentAttempts,
  people,
  referralCodes,
  referralRewards,
  referrals,
  type ReferralRejection,
} from "@/db/schema";
import { assertCan, AuthzError, can, payerAccountIdsFor, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/billing/errors";
import { invoiceMoney, settleInvoiceIfCovered } from "@/lib/billing/invoices";
import { actorOf, int } from "@/lib/billing/util";
import { grantCredits } from "@/lib/credits";
import { addDaysYmd } from "@/lib/time";
import { describeReward, growthSettings, type GrowthSettings, type RewardSpec } from "./settings";

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/** No look-alike characters (0/o, 1/l/i). 10 characters from 31 symbols is about 49 bits. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const CODE_LENGTH = 10;
export const CODE_PATTERN = /^[a-z0-9]{8,16}$/;

export function generateReferralCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** Normalizes what someone typed or a URL segment; returns null when it cannot be a code. */
export function normalizeCode(raw: string | null | undefined): string | null {
  const c = (raw ?? "").trim().toLowerCase();
  return CODE_PATTERN.test(c) ? c : null;
}

/** The payer account's active code, created on first use. Safe under concurrent calls (partial unique index). */
export async function ensureReferralCode(tx: Tx, orgId: string, payerAccountId: string, opts: { actorUserId?: string | null; isDemo?: boolean; code?: string } = {}) {
  const [existing] = await tx
    .select()
    .from(referralCodes)
    .where(and(eq(referralCodes.orgId, orgId), eq(referralCodes.payerAccountId, payerAccountId), eq(referralCodes.status, "active")));
  if (existing) return existing;
  const [payer] = await tx.select({ id: payerAccounts.id }).from(payerAccounts).where(and(eq(payerAccounts.id, payerAccountId), eq(payerAccounts.orgId, orgId)));
  if (!payer) throw new AuthzError();
  await tx
    .insert(referralCodes)
    .values({ orgId, payerAccountId, code: opts.code ?? generateReferralCode(), createdBy: opts.actorUserId ?? null, isDemo: opts.isDemo ?? false })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(referralCodes)
    .where(and(eq(referralCodes.orgId, orgId), eq(referralCodes.payerAccountId, payerAccountId), eq(referralCodes.status, "active")));
  if (!row) throw new Error("could not create a referral code");
  return row;
}

/** Staff: revoke a code (it stops resolving at once) and issue a fresh one for the same family. */
export async function revokeReferralCode(tx: Tx, v: Viewer, codeId: string, opts: { reissue?: boolean } = {}) {
  assertCan(v, "crm.manage");
  const [code] = await tx.select().from(referralCodes).where(and(eq(referralCodes.id, codeId), eq(referralCodes.orgId, v.orgId))).for("update");
  if (!code) throw new UserError("Referral code not found.");
  if (code.status === "active") {
    await tx.update(referralCodes).set({ status: "revoked", revokedAt: new Date(), revokedBy: v.userId }).where(eq(referralCodes.id, code.id));
    await audit(tx, actorOf(v), "growth.referral_code.revoke", "referral_code", code.id, { summary: "Referral code revoked", before: { status: "active" }, after: { status: "revoked" } });
  }
  return opts.reissue === false ? null : ensureReferralCode(tx, v.orgId, code.payerAccountId, { actorUserId: v.userId });
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

const last10 = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").slice(-10);

type Identity = { personIds: string[]; emails: string[]; phones: string[] };

async function identityOf(tx: Tx, personIds: string[]): Promise<Identity> {
  const ids = [...new Set(personIds.filter(Boolean))];
  if (!ids.length) return { personIds: [], emails: [], phones: [] };
  const rows = await tx.select({ id: people.id, email: people.email, phone: people.phone }).from(people).where(inArray(people.id, ids));
  return {
    personIds: ids,
    emails: [...new Set(rows.map((r) => r.email?.toLowerCase()).filter((x): x is string => !!x))],
    phones: [...new Set(rows.map((r) => last10(r.phone)).filter((x) => x.length >= 7))],
  };
}

const overlaps = (a: Identity, b: Identity) =>
  a.personIds.some((x) => b.personIds.includes(x)) || a.emails.some((x) => b.emails.includes(x)) || a.phones.some((x) => b.phones.includes(x));

/** People in this org (not archived) sharing an email or phone with the identity, plus the identity itself. */
async function samePeople(tx: Tx, orgId: string, who: Identity): Promise<string[]> {
  const conds = [];
  if (who.emails.length) conds.push(sql`lower(${people.email}) in ${who.emails}`);
  if (who.phones.length) conds.push(sql`right(regexp_replace(coalesce(${people.phone}, ''), '\\D', '', 'g'), 10) in ${who.phones}`);
  if (!conds.length) return who.personIds;
  const rows = await tx
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.orgId, orgId), sql`${people.status} <> 'archived'`, sql`(${sql.join(conds, sql` or `)})`));
  return [...new Set([...who.personIds, ...rows.map((r) => r.id)])];
}

/** The referrer's side: people who pay on the account, and everyone else in that family. */
async function referrerFamily(tx: Tx, payerAccountId: string) {
  const payers = (await tx.execute(sql`select person_id from payer_authorizations where payer_account_id = ${payerAccountId}`)).rows.map((r) => (r as { person_id: string }).person_id);
  const rest = (
    await tx.execute(sql`
      select a.person_id from payer_beneficiaries pb join athletes a on a.id = pb.athlete_id where pb.payer_account_id = ${payerAccountId}
      union
      select g.guardian_person_id from payer_beneficiaries pb join guardianships g on g.athlete_id = pb.athlete_id and g.status = 'active' where pb.payer_account_id = ${payerAccountId}
      union
      select hm.person_id from payer_accounts pa join household_members hm on hm.household_id = pa.household_id where pa.id = ${payerAccountId}
      union
      select hm2.person_id from payer_authorizations au join household_members hm on hm.person_id = au.person_id
        join household_members hm2 on hm2.household_id = hm.household_id where au.payer_account_id = ${payerAccountId}`)
  ).rows.map((r) => (r as { person_id: string }).person_id);
  return { payers: await identityOf(tx, payers), household: await identityOf(tx, rest) };
}

/** Does any of these people already belong to a family with a membership (as athlete, guardian or payer) created before `before`? */
async function hasPriorMembership(tx: Tx, orgId: string, personIds: string[], before: Date): Promise<boolean> {
  if (!personIds.length) return false;
  const rows = await tx.execute(sql`
    select 1 from memberships m
    where m.org_id = ${orgId} and m.created_at < ${before.toISOString()}::timestamptz and (
      m.athlete_id in (select id from athletes where person_id in ${personIds})
      or m.athlete_id in (select athlete_id from guardianships where guardian_person_id in ${personIds} and status <> 'revoked')
      or m.payer_account_id in (select payer_account_id from payer_authorizations where person_id in ${personIds})
    ) limit 1`);
  return rows.rows.length > 0;
}

export type AttributionResult =
  | { attributed: true; referralId: string }
  | { attributed: false; reason: "disabled" | "unknown_code" | "lead_already_has_referral" | ReferralRejection; referralId?: string };

/**
 * Attach a referral code to a lead. Rules (first failing rule decides):
 * 1. the program is on and the code is an active code of this org, otherwise nothing is recorded;
 * 2. a lead keeps its first referral (unique lead_id);
 * 3. self-referral (the inquirer is someone who pays on the referrer's account) is blocked;
 * 4. same-household referral (anyone in the referrer's household, their athletes or guardians) is blocked;
 * 5. the referred family must be new: nobody matching the inquirer has a membership here (configurable);
 * 6. the same family cannot be referred twice: an earlier, still valid referral of the same people wins.
 * Blocked attempts are stored as `rejected` with the reason so staff can see them; families never do.
 */
export async function attributeReferral(
  tx: Tx,
  orgId: string,
  leadId: string,
  rawCode: string | null | undefined,
  meta: { via?: "link" | "staff"; actorUserId?: string | null; settings?: GrowthSettings; isDemo?: boolean } = {},
): Promise<AttributionResult> {
  const settings = meta.settings ?? (await growthSettings(tx, orgId));
  const code = normalizeCode(rawCode);
  // Always run the lookup (even for malformed input) so valid and invalid codes cost the same.
  const [row] = await tx
    .select()
    .from(referralCodes)
    .where(and(eq(referralCodes.code, code ?? "invalid000"), eq(referralCodes.orgId, orgId)));
  if (!settings.referral.enabled) return { attributed: false, reason: "disabled" };
  if (!code || !row) return { attributed: false, reason: "unknown_code" };
  if (row.status !== "active") return { attributed: false, reason: "code_revoked" };

  const [lead] = await tx.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.orgId, orgId))).for("update");
  if (!lead) return { attributed: false, reason: "unknown_code" };
  const [prior] = await tx.select({ id: referrals.id }).from(referrals).where(eq(referrals.leadId, lead.id));
  if (prior) return { attributed: false, reason: "lead_already_has_referral", referralId: prior.id };

  const inquirer = await identityOf(tx, [lead.personId, lead.contactPersonId ?? ""]);
  const family = await referrerFamily(tx, row.payerAccountId);
  let rejection: ReferralRejection | null = null;
  if (overlaps(inquirer, family.payers)) rejection = "self_referral";
  else if (settings.referral.blockSameHousehold && overlaps(inquirer, family.household)) rejection = "same_household";
  else if (settings.referral.requireNewFamily && (await hasPriorMembership(tx, orgId, await samePeople(tx, orgId, inquirer), lead.createdAt))) rejection = "existing_member";
  else {
    const others = await tx
      .select({ personId: leads.personId, contactPersonId: leads.contactPersonId })
      .from(referrals)
      .innerJoin(leads, eq(leads.id, referrals.leadId))
      .where(and(eq(referrals.orgId, orgId), sql`${referrals.status} <> 'rejected'`));
    for (const o of others) {
      if (overlaps(inquirer, await identityOf(tx, [o.personId, o.contactPersonId ?? ""]))) {
        rejection = "already_referred";
        break;
      }
    }
  }

  const [ref] = await tx
    .insert(referrals)
    .values({
      orgId,
      codeId: row.id,
      referrerPayerAccountId: row.payerAccountId,
      leadId: lead.id,
      status: rejection ? "rejected" : "inquired",
      rejectionReason: rejection,
      attachedVia: meta.via ?? "link",
      attachedBy: meta.actorUserId ?? null,
      isDemo: meta.isDemo ?? lead.isDemo,
    })
    .onConflictDoNothing()
    .returning();
  if (!ref) return { attributed: false, reason: "lead_already_has_referral" };
  await audit(tx, { orgId, actorUserId: meta.actorUserId ?? null, actorRole: meta.via === "staff" ? "staff" : "public" }, "growth.referral.attribute", "referral", ref.id, {
    summary: rejection ? `Referral not counted (${rejection.replaceAll("_", " ")})` : "Referral attributed to a family",
    after: { leadId: lead.id, referrerPayerAccountId: row.payerAccountId, status: ref.status, via: meta.via ?? "link" },
  });
  return rejection ? { attributed: false, reason: rejection, referralId: ref.id } : { attributed: true, referralId: ref.id };
}

/** Staff enter a code a family mentioned in person or by phone. Same rules as the public link. */
export async function attachReferralByStaff(tx: Tx, v: Viewer, input: { leadId: string; code: string }) {
  assertCan(v, "crm.manage");
  const res = await attributeReferral(tx, v.orgId, input.leadId, input.code, { via: "staff", actorUserId: v.userId });
  if (!res.attributed) {
    if (res.reason === "disabled") throw new UserError("The referral program is turned off in Settings → Growth.");
    if (res.reason === "unknown_code" || res.reason === "code_revoked") throw new UserError("That is not an active referral code.", { code: "Not an active code" });
    if (res.reason === "lead_already_has_referral") throw new UserError("This lead already has a referral. The first code wins.");
  }
  return res;
}

// ---------------------------------------------------------------------------
// Progress: inquired → started → earned (idempotent evaluator)
// ---------------------------------------------------------------------------

function rewardRow(spec: RewardSpec, currency: string) {
  if (spec.type === "account_credit" && spec.amountMinor && spec.amountMinor > 0) return { kind: "account_credit" as const, amountMinor: spec.amountMinor, currency, credits: null, creditExpiryDays: null };
  if (spec.type === "session_credits" && spec.credits && spec.credits > 0) return { kind: "session_credits" as const, amountMinor: null, currency: null, credits: spec.credits, creditExpiryDays: spec.creditExpiryDays };
  return null;
}

/**
 * Moves referrals forward from what the rest of the system recorded. Safe to run any number of
 * times and concurrently (rows are locked; reward rows are unique per referral and side).
 * - started: the lead was converted to an athlete (rules re-checked against the real family);
 * - earned: per Settings → Growth, the referred member's first invoice above $0 is PAID (which only
 *   happens after a verified provider webhook or a staff-recorded payment), or a membership has
 *   been active for the configured days. Earning creates PENDING rewards; nothing is issued here.
 */
export async function syncReferrals(tx: Tx, orgId: string, today: string, now = new Date()) {
  const settings = await growthSettings(tx, orgId);
  const [org] = await tx.select({ currency: organizations.currency }).from(organizations).where(eq(organizations.id, orgId));
  const open = await tx
    .select()
    .from(referrals)
    .where(and(eq(referrals.orgId, orgId), inArray(referrals.status, ["inquired", "started"])))
    .orderBy(referrals.createdAt)
    .for("update");
  const out = { started: 0, earned: 0, rejected: 0, rewards: 0 };
  for (const r of open) {
    let cur = r;
    if (cur.status === "inquired") {
      const [lead] = await tx.select().from(leads).where(eq(leads.id, cur.leadId));
      if (!lead?.convertedAthleteId) continue;
      const [ath] = await tx.select().from(athletes).where(eq(athletes.id, lead.convertedAthleteId));
      const payerRows = await tx.select({ id: payerBeneficiaries.payerAccountId }).from(payerBeneficiaries).where(eq(payerBeneficiaries.athleteId, ath.id));
      const family = await referrerFamily(tx, cur.referrerPayerAccountId);
      const converted = await identityOf(tx, [ath.personId]);
      let rejection: ReferralRejection | null = null;
      if (payerRows.some((p) => p.id === cur.referrerPayerAccountId) || overlaps(converted, family.payers)) rejection = "self_referral";
      else if (settings.referral.blockSameHousehold && overlaps(converted, family.household)) rejection = "same_household";
      else if (settings.referral.requireNewFamily && (await hasPriorMembership(tx, orgId, [ath.personId], lead.createdAt))) rejection = "existing_member";
      if (rejection) {
        await tx.update(referrals).set({ status: "rejected", rejectionReason: rejection, convertedAthleteId: ath.id, updatedAt: now }).where(eq(referrals.id, cur.id));
        await audit(tx, { orgId, actorUserId: null, actorRole: "system" }, "growth.referral.reject", "referral", cur.id, { summary: `Referral not counted at conversion (${rejection.replaceAll("_", " ")})` });
        out.rejected++;
        continue;
      }
      const [upd] = await tx
        .update(referrals)
        .set({ status: "started", convertedAthleteId: ath.id, convertedPayerAccountId: payerRows[0]?.id ?? null, startedAt: lead.convertedAt ?? now, updatedAt: now })
        .where(eq(referrals.id, cur.id))
        .returning();
      cur = upd;
      out.started++;
    }
    if (cur.status !== "started" || !cur.convertedAthleteId || !settings.referral.enabled) continue;

    const [m] = await tx
      .select({ id: memberships.id, status: memberships.status, startDate: memberships.startDate })
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.athleteId, cur.convertedAthleteId)))
      .orderBy(memberships.createdAt)
      .limit(1);
    let qualifyingInvoiceId: string | null = null;
    let earned = false;
    if (settings.referral.earnedWhen === "first_paid_invoice") {
      const res = await tx.execute(sql`
        select i.id from invoices i
        where i.org_id = ${orgId} and i.status = 'paid' and i.total_minor > 0 and i.paid_at is not null
          and i.created_at >= ${cur.createdAt.toISOString()}::timestamptz
          and (exists (select 1 from invoice_lines l where l.invoice_id = i.id and l.athlete_id = ${cur.convertedAthleteId})
               or i.membership_id in (select id from memberships where athlete_id = ${cur.convertedAthleteId}))
        order by i.paid_at asc limit 1`);
      qualifyingInvoiceId = (res.rows[0] as { id: string } | undefined)?.id ?? null;
      earned = !!qualifyingInvoiceId;
    } else if (settings.referral.daysActive) {
      const res = await tx.execute(sql`
        select 1 from memberships where org_id = ${orgId} and athlete_id = ${cur.convertedAthleteId}
          and status in ('active','trialing') and start_date <= ${addDaysYmd(today, -settings.referral.daysActive)} limit 1`);
      earned = res.rows.length > 0;
    }
    if (!earned) {
      if (m && !cur.membershipId) await tx.update(referrals).set({ membershipId: m.id, updatedAt: now }).where(eq(referrals.id, cur.id));
      continue;
    }
    await tx.update(referrals).set({ status: "earned", earnedAt: now, membershipId: m?.id ?? cur.membershipId, qualifyingInvoiceId, updatedAt: now }).where(eq(referrals.id, cur.id));
    out.earned++;
    const sides: { beneficiary: "referrer" | "referred"; payerAccountId: string | null; spec: RewardSpec }[] = [
      { beneficiary: "referrer", payerAccountId: cur.referrerPayerAccountId, spec: settings.referral.reward },
      { beneficiary: "referred", payerAccountId: cur.convertedPayerAccountId, spec: settings.referral.referredReward },
    ];
    for (const side of sides) {
      const row = rewardRow(side.spec, org?.currency ?? "USD");
      if (!row || !side.payerAccountId) continue;
      const ins = await tx
        .insert(referralRewards)
        .values({ orgId, referralId: cur.id, beneficiary: side.beneficiary, payerAccountId: side.payerAccountId, ...row, isDemo: cur.isDemo })
        .onConflictDoNothing()
        .returning({ id: referralRewards.id });
      out.rewards += ins.length;
    }
    await audit(tx, { orgId, actorUserId: null, actorRole: "system" }, "growth.referral.earned", "referral", cur.id, {
      summary: `Referral reward earned (${settings.referral.earnedWhen === "first_paid_invoice" ? "first paid invoice" : `${settings.referral.daysActive} days active`}); waiting for staff approval`,
      after: { qualifyingInvoiceId },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reward approval (staff, one click, audited, idempotent)
// ---------------------------------------------------------------------------

/**
 * Approve a pending reward. The reward row is locked, so two staff clicking at once issue it once;
 * a repeat click returns `alreadyApproved`. Account credit goes to the account credit ledger and
 * session credits to the existing credit ledger, each under an idempotency key tied to the reward.
 */
export async function approveReward(tx: Tx, v: Viewer, input: { rewardId: string; athleteId?: string | null }) {
  assertCan(v, "billing.manage");
  const [rw] = await tx.select().from(referralRewards).where(and(eq(referralRewards.id, input.rewardId), eq(referralRewards.orgId, v.orgId))).for("update");
  if (!rw) throw new UserError("Reward not found.");
  if (rw.status === "approved") return { reward: rw, alreadyApproved: true };
  if (rw.status === "declined") throw new UserError("This reward was declined and cannot be approved.");

  let athleteId: string | null = null;
  let creditBucketId: string | null = null;
  if (rw.kind === "account_credit") {
    await tx
      .insert(accountCreditLedger)
      .values({
        orgId: v.orgId,
        payerAccountId: rw.payerAccountId,
        deltaMinor: rw.amountMinor!,
        currency: rw.currency!,
        kind: "referral_reward",
        rewardId: rw.id,
        reason: `Referral reward (${rw.beneficiary})`,
        actorUserId: v.userId,
        idempotencyKey: `referral-reward:${rw.id}`,
        isDemo: rw.isDemo,
      })
      .onConflictDoNothing();
  } else {
    const bens = await tx.select({ athleteId: payerBeneficiaries.athleteId }).from(payerBeneficiaries).where(eq(payerBeneficiaries.payerAccountId, rw.payerAccountId));
    athleteId = input.athleteId ?? (bens.length === 1 ? bens[0].athleteId : null);
    if (!athleteId) throw new UserError("Choose which athlete receives the session credits.", { athleteId: "Choose an athlete" });
    if (!bens.some((b) => b.athleteId === athleteId)) throw new UserError("That athlete is not on this family's billing account.", { athleteId: "Not on this account" });
    const g = await grantCredits(tx, {
      orgId: v.orgId,
      athleteId,
      amount: rw.credits!,
      sourceKind: "staff_grant",
      expiresAt: rw.creditExpiryDays ? new Date(Date.now() + rw.creditExpiryDays * 86_400_000) : null,
      actorUserId: v.userId,
      reason: `Referral reward (${rw.beneficiary})`,
      idempotencyKey: `referral-reward:${rw.id}`,
      isDemo: rw.isDemo,
    });
    creditBucketId = g.bucket.id;
  }
  const [upd] = await tx
    .update(referralRewards)
    .set({ status: "approved", decidedBy: v.userId, decidedAt: new Date(), athleteId, creditBucketId })
    .where(eq(referralRewards.id, rw.id))
    .returning();
  await audit(tx, actorOf(v), "growth.reward.approve", "referral_reward", rw.id, {
    summary: rw.kind === "account_credit" ? `Approved referral reward: ${rw.amountMinor} ${rw.currency} account credit` : `Approved referral reward: ${rw.credits} session credit(s)`,
    before: { status: "pending" },
    after: { status: "approved", kind: rw.kind, amountMinor: rw.amountMinor, credits: rw.credits, athleteId, payerAccountId: rw.payerAccountId },
  });
  return { reward: upd, alreadyApproved: false };
}

export async function declineReward(tx: Tx, v: Viewer, input: { rewardId: string; reason: string }) {
  assertCan(v, "billing.manage");
  if (!input.reason.trim()) throw new UserError("A reason is required to decline a reward.", { reason: "Required" });
  const [rw] = await tx.select().from(referralRewards).where(and(eq(referralRewards.id, input.rewardId), eq(referralRewards.orgId, v.orgId))).for("update");
  if (!rw) throw new UserError("Reward not found.");
  if (rw.status !== "pending") throw new UserError(`This reward is already ${rw.status}.`);
  await tx.update(referralRewards).set({ status: "declined", decidedBy: v.userId, decidedAt: new Date(), declineReason: input.reason.trim() }).where(eq(referralRewards.id, rw.id));
  await audit(tx, actorOf(v), "growth.reward.decline", "referral_reward", rw.id, { summary: `Declined referral reward: ${input.reason.trim()}`, before: { status: "pending" }, after: { status: "declined" } });
}

// ---------------------------------------------------------------------------
// Account credit
// ---------------------------------------------------------------------------

export async function accountCreditBalances(tx: Tx, orgId: string, payerAccountIds?: string[]): Promise<Record<string, number>> {
  if (payerAccountIds && !payerAccountIds.length) return {};
  const rows = await tx
    .select({ payerAccountId: accountCreditLedger.payerAccountId, n: sql<string>`coalesce(sum(${accountCreditLedger.deltaMinor}),0)::bigint` })
    .from(accountCreditLedger)
    .where(and(eq(accountCreditLedger.orgId, orgId), payerAccountIds ? inArray(accountCreditLedger.payerAccountId, payerAccountIds) : undefined))
    .groupBy(accountCreditLedger.payerAccountId);
  return Object.fromEntries(rows.map((r) => [r.payerAccountId, int(r.n)]));
}

/**
 * Staff apply a family's account credit to one of their open invoices. The credit becomes an
 * invoice discount (the total goes down); it is never recorded as a payment. Refused for invoices
 * a provider subscription bills, and while a checkout or bank payment is in flight.
 */
export async function applyAccountCredit(tx: Tx, v: Viewer, input: { invoiceId: string; amountMinor: number; idempotencyKey: string }) {
  assertCan(v, "billing.manage");
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw new UserError("Enter an amount greater than $0.", { amount: "Invalid amount" });
  const [inv] = await tx.select().from(invoices).where(and(eq(invoices.id, input.invoiceId), eq(invoices.orgId, v.orgId))).for("update");
  if (!inv) throw new UserError("Invoice not found.");
  const key = `apply:${inv.id}:${input.idempotencyKey}`;
  const [done] = await tx.select().from(accountCreditLedger).where(and(eq(accountCreditLedger.orgId, v.orgId), eq(accountCreditLedger.idempotencyKey, key)));
  if (done) return { applied: false, alreadyApplied: true };
  if (inv.status !== "open") throw new UserError(`Credit can only be applied to an open invoice (this one is ${inv.status}).`);
  if (inv.membershipId) {
    const [m] = await tx.select({ bp: memberships.billingProvider }).from(memberships).where(eq(memberships.id, inv.membershipId));
    if (m && m.bp !== "manual" && m.bp !== "none") throw new UserError("This invoice is billed by a provider subscription or Zen Planner. Apply the credit to a different invoice.");
  }
  // Serialize balance checks per payer account.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"account-credit:" + inv.payerAccountId}))`);
  const balance = (await accountCreditBalances(tx, v.orgId, [inv.payerAccountId]))[inv.payerAccountId] ?? 0;
  if (input.amountMinor > balance) throw new UserError("That is more than the family's account credit.", { amount: "More than the credit balance" });
  const money = await invoiceMoney(tx, inv.id);
  const inFlight = await tx
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(and(eq(paymentAttempts.invoiceId, inv.id), inArray(paymentAttempts.status, ["created", "requires_action", "processing", "pending"]), gt(paymentAttempts.createdAt, new Date(Date.now() - 24 * 3_600_000))));
  if (money.pendingMinor > 0 || inFlight.length) throw new UserError("A payment for this invoice is in progress. Wait for it to finish before applying credit.");
  if (input.amountMinor > money.balanceMinor) throw new UserError("That is more than the balance due on this invoice.", { amount: "More than the balance due" });
  await tx.insert(accountCreditLedger).values({
    orgId: v.orgId,
    payerAccountId: inv.payerAccountId,
    deltaMinor: -input.amountMinor,
    currency: inv.currency,
    kind: "applied_to_invoice",
    invoiceId: inv.id,
    reason: `Applied to ${inv.number}`,
    actorUserId: v.userId,
    idempotencyKey: key,
    isDemo: inv.isDemo,
  });
  await tx
    .update(invoices)
    .set({ discountMinor: inv.discountMinor + input.amountMinor, totalMinor: inv.totalMinor - input.amountMinor, updatedAt: new Date() })
    .where(eq(invoices.id, inv.id));
  await audit(tx, actorOf(v), "growth.account_credit.apply", "invoice", inv.id, {
    summary: `Applied ${input.amountMinor} ${inv.currency} account credit to ${inv.number}`,
    before: { discountMinor: inv.discountMinor, totalMinor: inv.totalMinor },
    after: { discountMinor: inv.discountMinor + input.amountMinor, totalMinor: inv.totalMinor - input.amountMinor },
  });
  await settleInvoiceIfCovered(tx, inv.id, actorOf(v));
  return { applied: true, alreadyApplied: false };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export type FamilyReferralStage = "inquired" | "started" | "earned";
export const FAMILY_STAGE_LABEL: Record<FamilyReferralStage, string> = { inquired: "Inquired", started: "Started", earned: "Reward earned" };

/**
 * What a family sees on /refer: their link(s), the reward text and each referral as first name,
 * last initial and stage only. Rejected referrals and every other detail stay with staff.
 */
export async function familyReferralView(tx: Tx, v: Viewer, appUrl: string) {
  if (v.role !== "guardian" && v.role !== "athlete") throw new AuthzError();
  const settings = await growthSettings(tx, v.orgId);
  const ids = await payerAccountIdsFor(tx, v, "view");
  const payers = ids.length ? await tx.select().from(payerAccounts).where(and(inArray(payerAccounts.id, ids), eq(payerAccounts.orgId, v.orgId))).orderBy(payerAccounts.name) : [];
  const [org] = await tx.select({ currency: organizations.currency }).from(organizations).where(eq(organizations.id, v.orgId));
  const balances = await accountCreditBalances(tx, v.orgId, payers.map((p) => p.id));
  const accounts = [];
  for (const p of payers) {
    const code = settings.referral.enabled ? await ensureReferralCode(tx, v.orgId, p.id, { actorUserId: v.userId, isDemo: p.isDemo }) : null;
    const rows = await tx
      .select({ id: referrals.id, status: referrals.status, createdAt: referrals.createdAt, first: people.firstName, last: people.lastName })
      .from(referrals)
      .innerJoin(leads, eq(leads.id, referrals.leadId))
      .innerJoin(people, sql`${people.id} = coalesce(${leads.contactPersonId}, ${leads.personId})`)
      .where(and(eq(referrals.orgId, v.orgId), eq(referrals.referrerPayerAccountId, p.id), sql`${referrals.status} <> 'rejected'`))
      .orderBy(desc(referrals.createdAt));
    accounts.push({
      payerAccountId: p.id,
      payerName: p.name,
      code: code?.code ?? null,
      link: code ? `${appUrl.replace(/\/$/, "")}/r/${code.code}` : null,
      creditBalanceMinor: balances[p.id] ?? 0,
      referrals: rows.map((r) => ({ id: r.id, name: `${r.first} ${r.last.trim().charAt(0).toUpperCase()}.`, stage: r.status as FamilyReferralStage, date: r.createdAt })),
    });
  }
  return {
    enabled: settings.referral.enabled,
    currency: org?.currency ?? "USD",
    howItWorks: settings.referral.howItWorks,
    rewardText: describeReward(settings.referral.reward, org?.currency ?? "USD"),
    referredRewardText: describeReward(settings.referral.referredReward, org?.currency ?? "USD"),
    earnedWhen: settings.referral.earnedWhen,
    daysActive: settings.referral.daysActive,
    accounts,
  };
}

/** Staff page: funnel, leaderboard, pending rewards, recent referrals and credit balances. */
export async function staffReferralOverview(tx: Tx, v: Viewer) {
  if (!can(v, "crm.manage")) throw new AuthzError();
  const orgId = v.orgId;
  const funnelRows = (await tx.execute(sql`select status, count(*)::int as n from referrals where org_id = ${orgId} group by status`)).rows as { status: string; n: number }[];
  const count = (st: string) => funnelRows.find((r) => r.status === st)?.n ?? 0;
  const funnel = {
    inquired: count("inquired") + count("started") + count("earned"),
    started: count("started") + count("earned"),
    earned: count("earned"),
    rejected: count("rejected"),
  };
  const leaderboard = (
    await tx.execute(sql`
      select pa.id as payer_account_id, pa.name,
        count(*) filter (where r.status <> 'rejected')::int as referred,
        count(*) filter (where r.status in ('started','earned'))::int as started,
        count(*) filter (where r.status = 'earned')::int as earned
      from referrals r join payer_accounts pa on pa.id = r.referrer_payer_account_id
      where r.org_id = ${orgId}
      group by pa.id, pa.name having count(*) filter (where r.status <> 'rejected') > 0
      order by started desc, referred desc, pa.name limit 25`)
  ).rows as { payer_account_id: string; name: string; referred: number; started: number; earned: number }[];
  const rewards = (
    await tx.execute(sql`
      select rw.id, rw.beneficiary, rw.kind, rw.amount_minor, rw.currency, rw.credits, rw.status, rw.created_at, rw.decided_at, rw.payer_account_id,
        pa.name as payer_name, lp.first_name as lead_first, lp.last_name as lead_last, r.lead_id
      from referral_rewards rw join referrals r on r.id = rw.referral_id join payer_accounts pa on pa.id = rw.payer_account_id
        join leads l on l.id = r.lead_id join people lp on lp.id = l.person_id
      where rw.org_id = ${orgId} order by (rw.status = 'pending') desc, rw.created_at desc limit 50`)
  ).rows as { id: string; beneficiary: string; kind: string; amount_minor: string | null; currency: string | null; credits: number | null; status: string; created_at: Date; decided_at: Date | null; payer_account_id: string; payer_name: string; lead_first: string; lead_last: string; lead_id: string }[];
  const payerIds = [...new Set(rewards.filter((r) => r.kind === "session_credits" && r.status === "pending").map((r) => r.payer_account_id))];
  const athleteOptions = payerIds.length
    ? ((
        await tx.execute(sql`
          select pb.payer_account_id, a.id as athlete_id, p.first_name, p.last_name
          from payer_beneficiaries pb join athletes a on a.id = pb.athlete_id join people p on p.id = a.person_id
          where pb.payer_account_id in ${payerIds} order by p.first_name`)
      ).rows as { payer_account_id: string; athlete_id: string; first_name: string; last_name: string }[])
    : [];
  const recent = (
    await tx.execute(sql`
      select r.id, r.status, r.rejection_reason, r.created_at, r.lead_id, r.attached_via, pa.name as referrer, lp.first_name, lp.last_name
      from referrals r join payer_accounts pa on pa.id = r.referrer_payer_account_id join leads l on l.id = r.lead_id join people lp on lp.id = l.person_id
      where r.org_id = ${orgId} order by r.created_at desc limit 30`)
  ).rows as { id: string; status: string; rejection_reason: string | null; created_at: Date; lead_id: string; attached_via: string; referrer: string; first_name: string; last_name: string }[];
  const balances = await accountCreditBalances(tx, orgId);
  const withCredit = Object.entries(balances).filter(([, n]) => n > 0);
  const creditAccounts = [];
  for (const [payerAccountId, balanceMinor] of withCredit) {
    const [pa] = await tx.select({ name: payerAccounts.name }).from(payerAccounts).where(eq(payerAccounts.id, payerAccountId));
    const open = await tx
      .select({ id: invoices.id, number: invoices.number, totalMinor: invoices.totalMinor, currency: invoices.currency })
      .from(invoices)
      .where(and(eq(invoices.orgId, orgId), eq(invoices.payerAccountId, payerAccountId), eq(invoices.status, "open")))
      .orderBy(invoices.dueDate);
    creditAccounts.push({ payerAccountId, name: pa?.name ?? "", balanceMinor, openInvoices: open });
  }
  return { funnel, leaderboard, rewards, athleteOptions, recent, creditAccounts };
}

/** Lead detail: who referred this lead (staff only). */
export async function referralForLead(tx: Tx, v: Viewer, leadId: string) {
  if (!can(v, "crm.manage")) throw new AuthzError();
  const [row] = await tx
    .select({ id: referrals.id, status: referrals.status, rejectionReason: referrals.rejectionReason, via: referrals.attachedVia, createdAt: referrals.createdAt, referrer: payerAccounts.name, referrerPayerAccountId: payerAccounts.id })
    .from(referrals)
    .innerJoin(payerAccounts, eq(payerAccounts.id, referrals.referrerPayerAccountId))
    .where(and(eq(referrals.leadId, leadId), eq(referrals.orgId, v.orgId)));
  return row ?? null;
}

export const REJECTION_LABEL: Record<ReferralRejection, string> = {
  self_referral: "Self-referral",
  same_household: "Same household",
  existing_member: "Already a member family",
  already_referred: "Already referred by another family",
  code_revoked: "Code was revoked",
};
