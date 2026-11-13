import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { DB, Tx } from "@/db";
import {
  athletes,
  memberships,
  organizations,
  payerAccounts,
  paymentMethods,
  paymentMethodSetups,
  people,
  products,
  productVersions,
  type MandateAcceptance,
  type MethodSetupStatus,
  type PaymentMethodStatus,
  type PaymentMethodType,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { AuthzError, can, type Viewer } from "@/lib/authz/policy";
import { getSavedMethodProvider } from "@/lib/payments";
import type { NormalizedEvent } from "@/lib/payments/provider";
import { addDaysYmd, todayLocal } from "@/lib/time";
import { inScope, payablePayerIds, viewablePayerIds } from "./access";
import { UserError } from "./errors";
import { mandateText, MANDATE_TEXT_VERSION } from "./mandate-text";
import { billingTask } from "./tasks";
import { actorOf } from "./util";

type Method = typeof paymentMethods.$inferSelect;
type Outcome = { outcome: "processed" | "ignored"; detail?: string };
const LIVE = ["pending", "trialing", "active", "on_hold", "past_due"] as const;
const SYSTEM = (orgId: string | null) => ({ orgId, actorUserId: null, actorRole: "webhook" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

/**
 * Saved methods are managed (added, made default, removed) only by people allowed to PAY the account
 * (payer_authorizations.can_pay): Alex yes; Jordan (view only) and Casey (no authorization) no.
 * Staff never manage a family's methods: they see summaries and can hand over a link.
 */
export async function assertCanManageMethods(tx: Tx, v: Viewer, payerAccountId: string) {
  const [p] = await tx.select({ orgId: payerAccounts.orgId }).from(payerAccounts).where(eq(payerAccounts.id, payerAccountId));
  if (!p || p.orgId !== v.orgId) throw new AuthzError();
  if (v.role !== "guardian" && v.role !== "athlete") throw new AuthzError("Payment methods are saved by the family on their own device. Staff can send them a link.");
  if (!inScope(await payablePayerIds(tx, v), payerAccountId)) throw new AuthzError("You can view this account but are not authorized to manage its payment methods.");
}

/** Payer accounts whose methods the viewer may manage. */
export async function manageablePayerIds(tx: Tx, v: Viewer): Promise<string[]> {
  if (v.role !== "guardian" && v.role !== "athlete") return [];
  const ids = await payablePayerIds(tx, v);
  return ids === "all" ? [] : ids;
}

/** "Visa ending 4242, expires 08/28" / "Checking ending 6789, First Example Bank". Display details only. */
export function methodLabel(m: Pick<Method, "type" | "brand" | "bankName" | "last4" | "expMonth" | "expYear">): string {
  const last = m.last4 ? `ending ${m.last4}` : "details pending";
  if (m.type === "us_bank_account") return `Bank account ${last}${m.bankName ? `, ${m.bankName}` : ""}`;
  const brand = m.brand ? m.brand.charAt(0).toUpperCase() + m.brand.slice(1) : "Card";
  const exp = m.expMonth && m.expYear ? `, expires ${String(m.expMonth).padStart(2, "0")}/${String(m.expYear).slice(-2)}` : "";
  return `${brand} ${last}${exp}`;
}

export const METHOD_STATUS_LABEL: Record<PaymentMethodStatus, string> = {
  active: "Active",
  requires_verification: "Waiting for verification",
  failed: "Needs replacing",
  removed: "Removed",
};

// ---------------------------------------------------------------------------
// Start a hosted setup session
// ---------------------------------------------------------------------------

export type SetupEvidence = { ip: string | null; userAgent: string | null };

export type StartSetupOutcome =
  | { ok: true; checkoutUrl: string; setupId: string; reused: boolean }
  | { ok: false; error: string; notConfigured?: { envVars: string[] } };

/**
 * Create the Stripe-hosted page where the payer enters a card or links a bank account. Nothing is saved
 * locally as a method here: the method appears, and becomes active, only through verified webhooks.
 * For a bank account the payer must first accept the recurring debit authorization shown by Teamwork;
 * who, when, IP, user agent and the exact text version are recorded with the setup.
 */
export async function startMethodSetup(
  db: DB,
  v: Viewer,
  input: { payerAccountId: string; type: PaymentMethodType; mandateAccepted?: boolean; evidence: SetupEvidence; appUrl: string; signupFlowId?: string | null; makeDefault?: boolean; now?: Date },
): Promise<StartSetupOutcome> {
  if (input.type !== "card" && input.type !== "us_bank_account") return { ok: false, error: "Choose a card or a bank account." };
  const adapter = getSavedMethodProvider();
  const now = input.now ?? new Date();
  const prep = await db.transaction(async (tx) => {
    await assertCanManageMethods(tx, v, input.payerAccountId);
    const [payer] = await tx.select().from(payerAccounts).where(and(eq(payerAccounts.id, input.payerAccountId), eq(payerAccounts.orgId, v.orgId))).for("update");
    if (!payer) throw new AuthzError();
    if (!adapter.isConfigured()) return { notConfigured: true as const };
    const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, v.orgId));
    let acceptance: MandateAcceptance | null = null;
    if (input.type === "us_bank_account") {
      if (!input.mandateAccepted) throw new UserError("Please read and accept the bank debit authorization first.", { mandateAccepted: "Check the box to authorize bank debits." });
      acceptance = {
        acceptedAt: now.toISOString(),
        userId: v.userId,
        personId: v.personId,
        ip: input.evidence.ip,
        userAgent: input.evidence.userAgent?.slice(0, 500) ?? null,
        textVersion: MANDATE_TEXT_VERSION,
        text: mandateText(org?.name ?? "Teamwork"),
      };
    }
    // A still-open session for the same payer, type and person is reused (double-click / back button).
    const [open] = await tx
      .select()
      .from(paymentMethodSetups)
      .where(
        and(
          eq(paymentMethodSetups.payerAccountId, payer.id),
          eq(paymentMethodSetups.requestedType, input.type),
          eq(paymentMethodSetups.status, "created"),
          eq(paymentMethodSetups.startedBy, v.userId),
          sql`${paymentMethodSetups.createdAt} > ${new Date(now.getTime() - 20 * 3_600_000)}`,
          input.signupFlowId ? eq(paymentMethodSetups.signupFlowId, input.signupFlowId) : sql`${paymentMethodSetups.signupFlowId} is null`,
        ),
      )
      .orderBy(desc(paymentMethodSetups.createdAt))
      .limit(1);
    if (open?.checkoutUrl) return { reuse: open };
    const id = randomUUID();
    const [setup] = await tx
      .insert(paymentMethodSetups)
      .values({
        id,
        orgId: v.orgId,
        payerAccountId: payer.id,
        provider: adapter.name,
        requestedType: input.type,
        mandateAcceptance: acceptance,
        makeDefault: !!input.makeDefault,
        signupFlowId: input.signupFlowId ?? null,
        idempotencyKey: `pmsetup:${id}`,
        startedBy: v.userId,
      })
      .returning();
    await audit(tx, actorOf(v), "billing.method.setup_start", "payment_method_setup", setup.id, {
      summary: `Started saving a ${input.type === "card" ? "card" : "bank account"} on the Stripe-hosted page${acceptance ? ` (bank debit authorization ${acceptance.textVersion} accepted)` : ""}`,
    });
    return { setup, payer };
  });

  if ("notConfigured" in prep) {
    return { ok: false, error: "Saving a card or bank account is not available yet because Stripe is not connected. Nothing was saved. Bills can still be paid at the front desk.", notConfigured: { envVars: adapter.missingEnv() } };
  }
  if ("reuse" in prep && prep.reuse) return { ok: true, checkoutUrl: prep.reuse.checkoutUrl!, setupId: prep.reuse.id, reused: true };
  const { setup, payer } = prep as { setup: typeof paymentMethodSetups.$inferSelect; payer: typeof payerAccounts.$inferSelect };
  try {
    let customerId = payer.providerRefs?.stripeCustomerId ?? null;
    if (!customerId) {
      customerId = await adapter.ensureCustomer({ orgId: v.orgId, payerAccountId: payer.id, name: payer.name, email: payer.billingEmail, idempotencyKey: `customer:${v.orgId}:${payer.id}` });
      await db.execute(sql`update payer_accounts set provider_refs = provider_refs || ${JSON.stringify({ stripeCustomerId: customerId })}::jsonb where id = ${payer.id}`);
    }
    const back = input.signupFlowId ? `${input.appUrl}/billing/signup/${input.signupFlowId}` : `${input.appUrl}/billing/payment-methods`;
    const res = await adapter.createSetupSession({
      setupId: setup.id,
      providerCustomerId: customerId,
      type: input.type,
      successUrl: `${back}?setup=${setup.id}`,
      cancelUrl: `${back}?setup_cancelled=1`,
      idempotencyKey: setup.idempotencyKey,
    });
    await db
      .update(paymentMethodSetups)
      .set({ providerSessionId: res.providerSessionId, providerSetupIntentId: sql`coalesce(${paymentMethodSetups.providerSetupIntentId}, ${res.providerSetupIntentId})`, checkoutUrl: res.url, updatedAt: new Date() })
      .where(eq(paymentMethodSetups.id, setup.id));
    return { ok: true, checkoutUrl: res.url, setupId: setup.id, reused: false };
  } catch (e) {
    await db
      .update(paymentMethodSetups)
      .set({ status: "failed", failureCode: "setup_error", failureMessage: (e as Error).message.slice(0, 500), updatedAt: new Date() })
      .where(and(eq(paymentMethodSetups.id, setup.id), eq(paymentMethodSetups.status, "created")));
    return { ok: false, error: "Stripe did not accept the request, so nothing was saved. Please try again or ask the front desk." };
  }
}

// ---------------------------------------------------------------------------
// Verified webhook application
// ---------------------------------------------------------------------------

async function payerByCustomer(tx: Tx, customerId: string | null) {
  if (!customerId) return null;
  const [p] = await tx.select().from(payerAccounts).where(sql`${payerAccounts.providerRefs}->>'stripeCustomerId' = ${customerId}`);
  return p ?? null;
}

async function lockMethod(tx: Tx, provider: string, providerMethodId: string) {
  const [m] = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.provider, provider), eq(paymentMethods.providerMethodId, providerMethodId))).for("update");
  return m ?? null;
}

/** Serialize default/active changes for one payer account. */
async function lockPayer(tx: Tx, payerAccountId: string) {
  const [p] = await tx.select().from(payerAccounts).where(eq(payerAccounts.id, payerAccountId)).for("update");
  return p;
}

/** Make sure exactly one ACTIVE method is the default when any active method exists. */
async function normalizeDefault(tx: Tx, payerAccountId: string, prefer?: string | null) {
  const rows = await tx.select().from(paymentMethods).where(eq(paymentMethods.payerAccountId, payerAccountId)).orderBy(asc(paymentMethods.createdAt));
  const active = rows.filter((r) => r.status === "active");
  const target = (prefer && active.find((r) => r.id === prefer)) || active.find((r) => r.isDefault) || active[0] || null;
  for (const r of rows) {
    const want = !!target && r.id === target.id;
    if (r.isDefault !== want) await tx.update(paymentMethods).set({ isDefault: want, updatedAt: new Date() }).where(eq(paymentMethods.id, r.id));
  }
  return target?.id ?? null;
}

/** A method became active only if the provider confirmed the setup AND told us what it is. */
async function maybeActivate(tx: Tx, m: Method, makeDefault: boolean): Promise<boolean> {
  if (m.status !== "requires_verification" || !m.setupSucceededAt || !m.detailsAt) return false;
  await tx.update(paymentMethods).set({ status: "active", failureCode: null, failureMessage: null, updatedAt: new Date() }).where(eq(paymentMethods.id, m.id));
  await normalizeDefault(tx, m.payerAccountId, makeDefault ? m.id : null);
  const [payer] = await tx.select({ orgId: payerAccounts.orgId }).from(payerAccounts).where(eq(payerAccounts.id, m.payerAccountId));
  await audit(tx, SYSTEM(payer?.orgId ?? null), "billing.method.active", "payment_method", m.id, { summary: `${methodLabel(m)} is now active (verified by ${m.provider})` });
  return true;
}

const SETUP_FINAL: MethodSetupStatus[] = ["succeeded"];

export async function applyMethodSetup(tx: Tx, provider: string, ev: Extract<NormalizedEvent, { kind: "method_setup" }>, eventAt: Date): Promise<Outcome> {
  let [setup] = ev.setupId && UUID.test(ev.setupId) ? await tx.select().from(paymentMethodSetups).where(and(eq(paymentMethodSetups.id, ev.setupId), eq(paymentMethodSetups.provider, provider))).for("update") : [];
  if (!setup && ev.providerSetupIntentId) {
    [setup] = await tx.select().from(paymentMethodSetups).where(and(eq(paymentMethodSetups.provider, provider), eq(paymentMethodSetups.providerSetupIntentId, ev.providerSetupIntentId))).for("update");
  }
  if (!setup && ev.providerSessionId) {
    [setup] = await tx.select().from(paymentMethodSetups).where(and(eq(paymentMethodSetups.provider, provider), eq(paymentMethodSetups.providerSessionId, ev.providerSessionId))).for("update");
  }
  if (!setup) return { outcome: "ignored", detail: "unmatched: no local setup session for this event" };
  const payer = await lockPayer(tx, setup.payerAccountId);
  // The customer must be the one we created for this payer: a setup can never land on another family.
  const expectedCustomer = payer?.providerRefs?.stripeCustomerId ?? null;
  if (ev.providerCustomerId && expectedCustomer && ev.providerCustomerId !== expectedCustomer) {
    await billingTask(tx, setup.orgId, {
      title: "Payment method setup arrived for an unexpected Stripe customer",
      description: "A verified setup event named a different customer than the one on this payer account. Nothing was saved. Check the Stripe dashboard.",
      relatedType: "payment_method_setup",
      relatedId: setup.id,
      dedupeKey: `pmsetup-customer:${setup.id}`,
      priority: "high",
    });
    return { outcome: "processed", detail: "customer mismatch flagged" };
  }
  const patch: Partial<typeof paymentMethodSetups.$inferInsert> = { lastEventAt: eventAt, updatedAt: new Date() };
  if (ev.providerSetupIntentId && !setup.providerSetupIntentId) patch.providerSetupIntentId = ev.providerSetupIntentId;
  if (ev.providerSessionId && !setup.providerSessionId) patch.providerSessionId = ev.providerSessionId;
  if (ev.providerMethodId) patch.providerMethodId = ev.providerMethodId;

  if (ev.status === "session_completed") {
    await tx.update(paymentMethodSetups).set(patch).where(eq(paymentMethodSetups.id, setup.id));
    return { outcome: "processed", detail: "session linked" };
  }
  // `succeeded` is final. Before that the newest state wins (a payer can fail once and succeed in the same session).
  const firstSuccess = ev.status === "succeeded" && !SETUP_FINAL.includes(setup.status);
  if (SETUP_FINAL.includes(setup.status)) {
    await tx.update(paymentMethodSetups).set(patch).where(eq(paymentMethodSetups.id, setup.id));
    if (ev.status !== "succeeded") return { outcome: "processed", detail: `ignored ${setup.status}→${ev.status}` };
  } else {
    patch.status = ev.status;
    if (ev.status === "requires_verification") patch.verificationUrl = ev.verificationUrl ?? setup.verificationUrl;
    if (ev.status === "failed" || ev.status === "expired") {
      patch.failureCode = ev.failureCode ?? ev.status;
      patch.failureMessage = ev.failureMessage ?? null;
    } else {
      patch.failureCode = null;
      patch.failureMessage = null;
    }
    await tx.update(paymentMethodSetups).set(patch).where(eq(paymentMethodSetups.id, setup.id));
  }

  const pmId = ev.providerMethodId ?? setup.providerMethodId;
  if (!pmId) return { outcome: "processed", detail: `setup ${ev.status}` };
  let m = await lockMethod(tx, provider, pmId);
  if (m && m.payerAccountId !== setup.payerAccountId) return { outcome: "processed", detail: "method belongs to another payer; ignored" };

  if (ev.status === "failed" || ev.status === "expired") {
    if (m && m.status === "requires_verification") {
      await tx.update(paymentMethods).set({ status: "failed", failureCode: ev.failureCode ?? ev.status, failureMessage: ev.failureMessage ?? null, lastEventAt: eventAt, updatedAt: new Date() }).where(eq(paymentMethods.id, m.id));
    }
    return { outcome: "processed", detail: `setup ${ev.status}` };
  }

  if (!m) {
    [m] = await tx
      .insert(paymentMethods)
      .values({
        payerAccountId: setup.payerAccountId,
        provider,
        providerCustomerId: ev.providerCustomerId ?? expectedCustomer,
        providerMethodId: pmId,
        type: setup.requestedType,
        status: "requires_verification",
        isDefault: false,
        setupId: setup.id,
        lastEventAt: eventAt,
      })
      .returning();
  }
  if (m.status === "removed") return { outcome: "processed", detail: "method was removed; ignored" };
  const set: Partial<typeof paymentMethods.$inferInsert> = { lastEventAt: eventAt, updatedAt: new Date(), setupId: m.setupId ?? setup.id };
  if (!m.providerCustomerId && (ev.providerCustomerId ?? expectedCustomer)) set.providerCustomerId = ev.providerCustomerId ?? expectedCustomer;
  if (!m.mandateAcceptance && setup.mandateAcceptance) set.mandateAcceptance = setup.mandateAcceptance;
  if (ev.mandateRef) {
    set.mandateRef = ev.mandateRef;
    set.mandateStatus = m.mandateStatus ?? "active";
  }
  if (ev.status === "succeeded" && !m.setupSucceededAt) set.setupSucceededAt = eventAt;
  // An earlier failed try inside the same hosted session is superseded by the provider's success.
  if (firstSuccess && m.status === "failed") {
    set.status = "requires_verification";
    set.failureCode = null;
    set.failureMessage = null;
  }
  await tx.update(paymentMethods).set(set).where(eq(paymentMethods.id, m.id));
  const [fresh] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, m.id));
  const activated = await maybeActivate(tx, fresh, setup.makeDefault);
  return { outcome: "processed", detail: activated ? "method active" : `setup ${ev.status}` };
}

export async function applyMethodUpdate(tx: Tx, provider: string, ev: Extract<NormalizedEvent, { kind: "method_update" }>, eventAt: Date): Promise<Outcome> {
  let m = await lockMethod(tx, provider, ev.providerMethodId);
  if (!m) {
    if (ev.phase === "detached") return { outcome: "ignored", detail: "unmatched: unknown method detached" };
    const payer = await payerByCustomer(tx, ev.providerCustomerId);
    if (!payer) return { outcome: "ignored", detail: "unmatched: no payer account for this customer" };
    if (ev.type !== "card" && ev.type !== "us_bank_account") return { outcome: "ignored", detail: `unsupported method type ${ev.type ?? "unknown"}` };
    await lockPayer(tx, payer.id);
    m = (await lockMethod(tx, provider, ev.providerMethodId)) ??
      (
        await tx
          .insert(paymentMethods)
          .values({ payerAccountId: payer.id, provider, providerCustomerId: ev.providerCustomerId, providerMethodId: ev.providerMethodId, type: ev.type, status: "requires_verification", isDefault: false, lastEventAt: eventAt })
          .returning()
      )[0];
  } else {
    await lockPayer(tx, m.payerAccountId);
  }
  const [payer] = await tx.select({ orgId: payerAccounts.orgId }).from(payerAccounts).where(eq(payerAccounts.id, m.payerAccountId));
  if (ev.phase === "detached") {
    if (m.status === "removed") return { outcome: "processed", detail: "already removed" };
    await tx.update(paymentMethods).set({ status: "removed", isDefault: false, removedAt: eventAt, lastEventAt: eventAt, updatedAt: new Date() }).where(eq(paymentMethods.id, m.id));
    await normalizeDefault(tx, m.payerAccountId);
    await flagDependents(tx, payer.orgId, m, "was removed at Stripe");
    await audit(tx, SYSTEM(payer.orgId), "billing.method.removed", "payment_method", m.id, { summary: `${methodLabel(m)} was detached at ${provider}` });
    return { outcome: "processed", detail: "method removed" };
  }
  if (m.status === "removed") return { outcome: "processed", detail: "method was removed; ignored" };
  const set: Partial<typeof paymentMethods.$inferInsert> = { lastEventAt: eventAt, updatedAt: new Date(), detailsAt: m.detailsAt ?? eventAt };
  if (ev.type === "card" || ev.type === "us_bank_account") set.type = ev.type;
  if (ev.brand != null) set.brand = ev.brand;
  if (ev.bankName != null) set.bankName = ev.bankName;
  if (ev.last4 != null) set.last4 = ev.last4.slice(-4);
  if (ev.expMonth != null) set.expMonth = ev.expMonth;
  if (ev.expYear != null) set.expYear = ev.expYear;
  if (!m.providerCustomerId && ev.providerCustomerId) set.providerCustomerId = ev.providerCustomerId;
  await tx.update(paymentMethods).set(set).where(eq(paymentMethods.id, m.id));
  const [fresh] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, m.id));
  let makeDefault = false;
  if (fresh.setupId) {
    const [s] = await tx.select({ d: paymentMethodSetups.makeDefault }).from(paymentMethodSetups).where(eq(paymentMethodSetups.id, fresh.setupId));
    makeDefault = !!s?.d;
  }
  const activated = await maybeActivate(tx, fresh, makeDefault);
  return { outcome: "processed", detail: activated ? "method active" : "details recorded" };
}

export async function applyMandate(tx: Tx, provider: string, ev: Extract<NormalizedEvent, { kind: "mandate" }>, eventAt: Date): Promise<Outcome> {
  let [m] = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.provider, provider), eq(paymentMethods.mandateRef, ev.mandateRef))).for("update");
  if (!m && ev.providerMethodId) m = (await lockMethod(tx, provider, ev.providerMethodId)) ?? undefined!;
  if (!m) return { outcome: "ignored", detail: "unmatched: no saved method for this mandate" };
  await lockPayer(tx, m.payerAccountId);
  const [payer] = await tx.select({ orgId: payerAccounts.orgId }).from(payerAccounts).where(eq(payerAccounts.id, m.payerAccountId));
  await tx.update(paymentMethods).set({ mandateRef: m.mandateRef ?? ev.mandateRef, mandateStatus: ev.status, lastEventAt: eventAt, updatedAt: new Date() }).where(eq(paymentMethods.id, m.id));
  if (ev.status === "inactive" && m.status !== "removed" && m.status !== "failed") {
    await markMethodFailed(tx, payer.orgId, m, "mandate_inactive", "The bank debit authorization is no longer active.");
    return { outcome: "processed", detail: "mandate inactive; method failed" };
  }
  return { outcome: "processed", detail: `mandate ${ev.status}` };
}

/** Live autopay memberships that are charged with this method (explicitly, or because it is the default). */
export async function membershipsUsingMethod(tx: Tx, m: Pick<Method, "id" | "payerAccountId" | "isDefault">) {
  const rows = await tx
    .select({ id: memberships.id, athleteId: memberships.athleteId, autopayMethodId: memberships.autopayMethodId, first: people.firstName, last: people.lastName, product: products.name })
    .from(memberships)
    .innerJoin(athletes, eq(athletes.id, memberships.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .innerJoin(productVersions, eq(productVersions.id, memberships.productVersionId))
    .innerJoin(products, eq(products.id, productVersions.productId))
    .where(and(eq(memberships.payerAccountId, m.payerAccountId), eq(memberships.autopay, true), inArray(memberships.status, [...LIVE]), inArray(memberships.billingProvider, ["manual", "external_zenplanner"])));
  return rows.filter((r) => r.autopayMethodId === m.id || (r.autopayMethodId == null && m.isDefault));
}

async function flagDependents(tx: Tx, orgId: string, m: Method, why: string) {
  const deps = await membershipsUsingMethod(tx, m);
  const [other] = await tx.select({ id: paymentMethods.id }).from(paymentMethods).where(and(eq(paymentMethods.payerAccountId, m.payerAccountId), eq(paymentMethods.status, "active"), ne(paymentMethods.id, m.id))).limit(1);
  if (!deps.length || other) return;
  await billingTask(tx, orgId, {
    title: `Autopay has no working payment method (${deps.map((d) => `${d.first} ${d.last}`).join(", ")})`,
    description: `${methodLabel(m)} ${why}. The family sees a notice under Payment Methods asking for a new one. Until then bills are not charged automatically.`,
    relatedType: "payer_account",
    relatedId: m.payerAccountId,
    dedupeKey: `method-gone:${m.id}`,
    priority: "high",
  });
}

/** Mark a method unusable (account closed, authorization revoked, …) and raise the staff follow-up. */
export async function markMethodFailed(tx: Tx, orgId: string, m: Method, code: string, message: string | null) {
  if (m.status === "removed" || m.status === "failed") return;
  await tx.update(paymentMethods).set({ status: "failed", isDefault: false, failureCode: code, failureMessage: message, updatedAt: new Date() }).where(eq(paymentMethods.id, m.id));
  await flagDependents(tx, orgId, m, "can no longer be charged");
  await normalizeDefault(tx, m.payerAccountId);
  await audit(tx, SYSTEM(orgId), "billing.method.failed", "payment_method", m.id, { summary: `${methodLabel(m)} marked as needing replacement (${code})` });
}

// ---------------------------------------------------------------------------
// Family actions
// ---------------------------------------------------------------------------

async function loadMethodFor(tx: Tx, v: Viewer, methodId: string) {
  if (!UUID.test(methodId)) throw new AuthzError();
  const [row] = await tx
    .select({ m: paymentMethods, orgId: payerAccounts.orgId })
    .from(paymentMethods)
    .innerJoin(payerAccounts, eq(payerAccounts.id, paymentMethods.payerAccountId))
    .where(and(eq(paymentMethods.id, methodId), eq(payerAccounts.orgId, v.orgId)));
  if (!row) throw new AuthzError();
  await assertCanManageMethods(tx, v, row.m.payerAccountId);
  await lockPayer(tx, row.m.payerAccountId);
  const [m] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, methodId)).for("update");
  return m;
}

export async function setDefaultMethod(tx: Tx, v: Viewer, methodId: string) {
  const m = await loadMethodFor(tx, v, methodId);
  if (m.status !== "active") throw new UserError("Only an active payment method can be the default.");
  await normalizeDefault(tx, m.payerAccountId, m.id);
  await audit(tx, actorOf(v), "billing.method.default", "payment_method", m.id, { summary: `Default payment method set to ${methodLabel(m)}` });
}

/**
 * Remove a saved method. If it is the only working method an autopay membership depends on, the payer
 * must first pick another method (replacementMethodId) or turn autopay off: we never leave autopay
 * silently pointing at nothing.
 */
export async function removeMethod(db: DB, v: Viewer, input: { methodId: string; replacementMethodId?: string | null }) {
  const adapter = getSavedMethodProvider();
  const plan = await db.transaction(async (tx) => {
    const m = await loadMethodFor(tx, v, input.methodId);
    if (m.status === "removed") return { m, already: true as const };
    await checkRemoval(tx, m, input.replacementMethodId ?? null);
    return { m, already: false as const };
  });
  if (plan.already) return { removed: true, detachedAtProvider: false };
  // Detach in the provider's vault first, so a method we show as removed is really gone there.
  let detached = false;
  if (adapter.isConfigured() && plan.m.provider === adapter.name) {
    try {
      await adapter.detachMethod({ providerMethodId: plan.m.providerMethodId, idempotencyKey: `detach:${plan.m.id}` });
      detached = true;
    } catch {
      throw new UserError("Stripe did not confirm the removal, so the payment method was kept. Please try again or ask the front desk.");
    }
  }
  await db.transaction(async (tx) => {
    const m = await loadMethodFor(tx, v, input.methodId);
    if (m.status === "removed") return;
    const replacement = await checkRemoval(tx, m, input.replacementMethodId ?? null);
    if (replacement) await tx.update(memberships).set({ autopayMethodId: replacement.id, updatedAt: new Date() }).where(and(eq(memberships.payerAccountId, m.payerAccountId), eq(memberships.autopayMethodId, m.id)));
    else await tx.update(memberships).set({ autopayMethodId: null, updatedAt: new Date() }).where(and(eq(memberships.payerAccountId, m.payerAccountId), eq(memberships.autopayMethodId, m.id)));
    await tx.update(paymentMethods).set({ status: "removed", isDefault: false, removedAt: new Date(), removedBy: v.userId, updatedAt: new Date() }).where(eq(paymentMethods.id, m.id));
    await normalizeDefault(tx, m.payerAccountId, m.isDefault ? replacement?.id : null);
    await audit(tx, actorOf(v), "billing.method.remove", "payment_method", m.id, {
      summary: `Removed ${methodLabel(m)}${detached ? " (detached at Stripe)" : " (Stripe not connected: removed here only)"}${replacement ? `; autopay moved to ${methodLabel(replacement)}` : ""}`,
    });
  });
  return { removed: true, detachedAtProvider: detached };
}

async function checkRemoval(tx: Tx, m: Method, replacementMethodId: string | null): Promise<Method | null> {
  const deps = await membershipsUsingMethod(tx, m);
  if (!deps.length) return null;
  const others = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.payerAccountId, m.payerAccountId), eq(paymentMethods.status, "active"), ne(paymentMethods.id, m.id)));
  const names = deps.map((d) => `${d.first}'s ${d.product}`).join(", ");
  if (!others.length) {
    throw new UserError(`This is the only saved payment method, and it pays automatically for ${names}. Add another payment method first, or turn off autopay for that membership. Then you can remove this one.`);
  }
  const replacement = replacementMethodId ? others.find((o) => o.id === replacementMethodId) : others.length === 1 ? others[0] : null;
  if (!replacement) throw new UserError(`This payment method pays automatically for ${names}. Choose which of your other payment methods should take over, then remove this one.`, { replacementMethodId: "Choose a payment method" });
  return replacement;
}

// ---------------------------------------------------------------------------
// Autopay per membership
// ---------------------------------------------------------------------------

/** The saved method autopay would charge for a membership right now, or null when there is none. */
export async function resolveAutopayMethod(tx: Tx, m: Pick<typeof memberships.$inferSelect, "autopay" | "autopayMethodId" | "payerAccountId" | "billingProvider">): Promise<Method | null> {
  if (!m.autopay || m.billingProvider !== "manual" || !m.payerAccountId) return null;
  const rows = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.payerAccountId, m.payerAccountId), eq(paymentMethods.status, "active")));
  return (m.autopayMethodId ? rows.find((r) => r.id === m.autopayMethodId) : rows.find((r) => r.isDefault)) ?? null;
}

/**
 * Turn autopay on or off for one membership and choose the method (null = the payer's default).
 * Payers allowed to pay the account and billing staff may do this; staff choose only among methods the
 * family already saved.
 */
export async function setMembershipAutopay(tx: Tx, v: Viewer, input: { membershipId: string; autopay: boolean; methodId?: string | null }) {
  const [m] = await tx.select().from(memberships).where(and(eq(memberships.id, input.membershipId), eq(memberships.orgId, v.orgId))).for("update");
  if (!m || !m.payerAccountId) throw new AuthzError();
  if (!can(v, "billing.manage")) await assertCanManageMethods(tx, v, m.payerAccountId);
  if (m.billingProvider !== "manual" && m.billingProvider !== "external_zenplanner") {
    throw new UserError(m.billingProvider === "none" ? "This membership is not billed, so there is nothing to pay automatically." : "This membership is billed by a Stripe or PayPal subscription, which already charges automatically.");
  }
  let methodId: string | null = null;
  if (input.autopay) {
    const active = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.payerAccountId, m.payerAccountId), eq(paymentMethods.status, "active")));
    if (!active.length) throw new UserError("Save a card or bank account first. Autopay needs an active payment method.");
    if (input.methodId) {
      const chosen = active.find((a) => a.id === input.methodId);
      if (!chosen) throw new UserError("Choose one of the active payment methods on this account.", { methodId: "Not available" });
      methodId = chosen.isDefault ? null : chosen.id;
    }
  }
  await tx.update(memberships).set({ autopay: input.autopay, autopayMethodId: input.autopay ? methodId : null, updatedAt: new Date() }).where(eq(memberships.id, m.id));
  const { membershipEvents } = await import("@/db/schema");
  await tx.insert(membershipEvents).values({ membershipId: m.id, type: input.autopay ? "autopay_on" : "autopay_off", actorUserId: v.userId, effectiveOn: todayLocal(), details: { methodId, by: v.role } });
  await audit(tx, actorOf(v), "billing.membership.autopay", "membership", m.id, {
    summary: input.autopay ? `Autopay turned on (${methodId ? "specific method" : "default payment method"})` : "Autopay turned off",
    before: { autopay: m.autopay, autopayMethodId: m.autopayMethodId },
    after: { autopay: input.autopay, autopayMethodId: methodId },
  });
  // Paying by bank account can require a new agreement (ACH authorization paragraph).
  const { onAutopayChanged } = await import("@/lib/agreements/issue");
  await onAutopayChanged(tx, v, m.id);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type MethodView = {
  id: string;
  payerAccountId: string;
  type: string;
  label: string;
  status: PaymentMethodStatus;
  statusLabel: string;
  isDefault: boolean;
  failureCode: string | null;
  mandateAcceptedAt: string | null;
  mandateTextVersion: string | null;
  paysFor: { membershipId: string; label: string }[];
  createdAt: Date;
};

/**
 * Saved methods for the payer accounts the viewer may see (families) or one payer (staff summaries).
 * Never returns provider ids, customer ids or mandate references.
 */
export async function listMethodViews(tx: Tx, v: Viewer, opts: { payerAccountId?: string; includeRemoved?: boolean } = {}): Promise<MethodView[]> {
  const scope = await viewablePayerIds(tx, v);
  if (scope !== "all" && !scope.length) return [];
  const conds = [eq(payerAccounts.orgId, v.orgId)];
  if (scope !== "all") conds.push(inArray(paymentMethods.payerAccountId, scope));
  if (opts.payerAccountId) conds.push(eq(paymentMethods.payerAccountId, opts.payerAccountId));
  if (!opts.includeRemoved) conds.push(ne(paymentMethods.status, "removed"));
  const rows = await tx
    .select({ m: paymentMethods })
    .from(paymentMethods)
    .innerJoin(payerAccounts, eq(payerAccounts.id, paymentMethods.payerAccountId))
    .where(and(...conds))
    .orderBy(desc(paymentMethods.isDefault), desc(paymentMethods.createdAt));
  const out: MethodView[] = [];
  for (const { m } of rows) {
    const deps = m.status === "active" ? await membershipsUsingMethod(tx, m) : [];
    out.push({
      id: m.id,
      payerAccountId: m.payerAccountId,
      type: m.type,
      label: methodLabel(m),
      status: m.status,
      statusLabel: METHOD_STATUS_LABEL[m.status] ?? m.status,
      isDefault: m.isDefault,
      failureCode: m.failureCode,
      mandateAcceptedAt: m.mandateAcceptance?.acceptedAt ?? null,
      mandateTextVersion: m.mandateAcceptance?.textVersion ?? null,
      paysFor: deps.map((d) => ({ membershipId: d.id, label: `${d.first} ${d.last}, ${d.product}` })),
      createdAt: m.createdAt,
    });
  }
  return out;
}

/** Setup sessions still in flight for the viewer's payers (e.g. waiting for microdeposit verification). */
export async function openSetups(tx: Tx, v: Viewer) {
  const scope = await viewablePayerIds(tx, v);
  if (scope !== "all" && !scope.length) return [];
  const conds = [eq(paymentMethodSetups.orgId, v.orgId), inArray(paymentMethodSetups.status, ["requires_verification", "failed"]), sql`${paymentMethodSetups.updatedAt} > now() - interval '14 days'`];
  if (scope !== "all") conds.push(inArray(paymentMethodSetups.payerAccountId, scope));
  return tx
    .select({ id: paymentMethodSetups.id, payerAccountId: paymentMethodSetups.payerAccountId, type: paymentMethodSetups.requestedType, status: paymentMethodSetups.status, verificationUrl: paymentMethodSetups.verificationUrl, failureMessage: paymentMethodSetups.failureMessage, updatedAt: paymentMethodSetups.updatedAt })
    .from(paymentMethodSetups)
    .where(and(...conds))
    .orderBy(desc(paymentMethodSetups.updatedAt))
    .limit(10);
}

/** What the browser return from the hosted page may show. Read-only: the redirect never changes anything. */
export async function setupReturnView(tx: Tx, v: Viewer, setupId: string): Promise<{ state: "confirming" | "active" | "verification" | "failed" } | null> {
  if (!UUID.test(setupId)) return null;
  const [s] = await tx.select().from(paymentMethodSetups).where(and(eq(paymentMethodSetups.id, setupId), eq(paymentMethodSetups.orgId, v.orgId)));
  if (!s) return null;
  const scope = await viewablePayerIds(tx, v);
  if (!inScope(scope, s.payerAccountId)) return null;
  if (s.status === "failed" || s.status === "expired") return { state: "failed" };
  if (s.status === "requires_verification") return { state: "verification" };
  if (s.status === "succeeded" && s.providerMethodId) {
    const [m] = await tx.select({ status: paymentMethods.status }).from(paymentMethods).where(and(eq(paymentMethods.provider, s.provider), eq(paymentMethods.providerMethodId, s.providerMethodId)));
    if (m?.status === "active") return { state: "active" };
  }
  return { state: "confirming" };
}

export type ExpiringCard = { methodId: string; payerAccountId: string; payerName: string; label: string; expMonth: number; expYear: number; expiresOn: string; isDefault: boolean; autopayMemberships: number };

/**
 * Active cards whose expiry month ends within `withinDays` of `today` (default 60), soonest first.
 * A card is good through the last day of its expiry month. Exposed for the scoreboard / dashboards.
 */
export async function expiringCards(tx: Tx, orgId: string, opts: { today?: string; withinDays?: number } = {}): Promise<ExpiringCard[]> {
  const today = opts.today ?? todayLocal();
  const until = addDaysYmd(today, opts.withinDays ?? 60);
  const rows = await tx.execute(sql`
    select pm.id, pm.payer_account_id, pa.name as payer_name, pm.type, pm.brand, pm.bank_name, pm.last4, pm.exp_month, pm.exp_year, pm.is_default,
      (make_date(pm.exp_year, pm.exp_month, 1) + interval '1 month' - interval '1 day')::date::text as expires_on,
      (select count(*)::int from memberships m where m.payer_account_id = pm.payer_account_id and m.autopay and m.billing_provider = 'manual'
         and m.status in ('pending','trialing','active','on_hold','past_due') and (m.autopay_method_id = pm.id or (m.autopay_method_id is null and pm.is_default))) as autopay_memberships
    from payment_methods pm join payer_accounts pa on pa.id = pm.payer_account_id
    where pa.org_id = ${orgId} and pm.status = 'active' and pm.type = 'card' and pm.exp_month between 1 and 12 and pm.exp_year is not null
      and (make_date(pm.exp_year, pm.exp_month, 1) + interval '1 month' - interval '1 day')::date <= ${until}::date
    order by expires_on, pa.name`);
  return (rows.rows as Record<string, unknown>[]).map((r) => ({
    methodId: String(r.id),
    payerAccountId: String(r.payer_account_id),
    payerName: String(r.payer_name),
    label: methodLabel({ type: String(r.type), brand: r.brand as string | null, bankName: r.bank_name as string | null, last4: r.last4 as string | null, expMonth: Number(r.exp_month), expYear: Number(r.exp_year) }),
    expMonth: Number(r.exp_month),
    expYear: Number(r.exp_year),
    expiresOn: String(r.expires_on),
    isDefault: !!r.is_default,
    autopayMemberships: Number(r.autopay_memberships),
  }));
}

/**
 * "Autopay off": a live Teamwork-invoiced membership that will NOT be charged automatically, because autopay
 * is off or there is no active saved method to charge. Provider subscriptions charge themselves and are
 * never listed; Zen Planner / unbilled memberships are out of scope.
 */
export async function autopayOffMembershipIds(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await tx.execute(sql`select m.id from memberships m where m.org_id = ${orgId} and m.billing_provider = 'manual'
    and m.status in ('pending','trialing','active','on_hold','past_due') and not (${AUTOPAY_READY_SQL})`);
  return (rows.rows as { id: string }[]).map((r) => r.id);
}

/** SQL predicate over a `memberships` row aliased `m`: autopay is on and an active saved method exists for it. */
export const AUTOPAY_READY_SQL = sql`m.autopay and exists (
  select 1 from payment_methods pm where pm.payer_account_id = m.payer_account_id and pm.status = 'active'
    and (pm.id = m.autopay_method_id or (m.autopay_method_id is null and pm.is_default)))`;
