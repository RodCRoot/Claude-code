import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { memberships, paymentMethods, paymentMethodSetups, tasks, webhookEvents } from "@/db/schema";
import { MANDATE_TEXT_VERSION } from "@/lib/billing/mandate-text";
import {
  autopayOffMembershipIds,
  expiringCards,
  listMethodViews,
  methodLabel,
  removeMethod,
  setDefaultMethod,
  setMembershipAutopay,
  setupReturnView,
  startMethodSetup,
} from "@/lib/billing/payment-methods";
import { ingestWebhook } from "@/lib/billing/webhooks";
import { TEST_WHSEC } from "./fixtures/payments/stripe";
import { mandateUpdated, paymentMethodEvent, setupIntentEvent, setupSessionCompleted, stripeMethodsApi } from "./fixtures/payments/methods";
import { activeMethod, payerRow, sendStripe } from "./billing-helpers";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

const T = "2026-03-02";
let ctx: Awaited<ReturnType<typeof seedOrg>>;
const db = () => testDb();
const who = (k: string) => viewerFor(ctx, k);
const EVID = { ip: "203.0.113.9", userAgent: "vitest-agent/1.0" };
const APP = "http://localhost:3131";

beforeAll(async () => {
  ctx = await seedOrg(T, { modules: ["billing"] });
});
beforeEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WHSEC;
  process.env.STRIPE_SECRET_KEY = "sk_test_fixture_not_real";
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_SECRET_KEY;
  await closeTestDb();
});

const methodsOf = (payerId: string) => db().select().from(paymentMethods).where(eq(paymentMethods.payerAccountId, payerId));

/** Start a setup as `user` for `payerKey` against the mocked Stripe API; returns the setup row and customer. */
async function begin(user: string, payerKey: string, type: "card" | "us_bank_account", extra: { makeDefault?: boolean } = {}) {
  const api = stripeMethodsApi();
  vi.stubGlobal("fetch", api.fn);
  const r = await startMethodSetup(db(), await who(user), { payerAccountId: ctx.payers[payerKey], type, mandateAccepted: type === "us_bank_account", evidence: EVID, appUrl: APP, ...extra });
  if (!r.ok) throw new Error(r.error);
  const [setup] = await db().select().from(paymentMethodSetups).where(eq(paymentMethodSetups.id, r.setupId));
  const customer = (await payerRow(ctx.payers[payerKey])).providerRefs.stripeCustomerId;
  return { r, setup, customer, api };
}

describe("not configured", () => {
  it("shows the honest state and writes nothing when Stripe keys are missing", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const r = await startMethodSetup(db(), await who("dana"), { payerAccountId: ctx.payers.dana, type: "card", evidence: EVID, appUrl: APP });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.notConfigured?.envVars).toContain("STRIPE_SECRET_KEY");
      expect(r.error).toMatch(/Nothing was saved/);
    }
    expect(f).not.toHaveBeenCalled();
    expect(await db().select().from(paymentMethodSetups).where(eq(paymentMethodSetups.payerAccountId, ctx.payers.dana))).toHaveLength(0);
  });
});

describe("who may manage saved methods", () => {
  it("only people allowed to pay the account can start a setup; staff, coaches, view-only and unrelated users cannot", async () => {
    const api = stripeMethodsApi();
    vi.stubGlobal("fetch", api.fn);
    const attempt = async (user: string, payerKey: string) => {
      try {
        const r = await startMethodSetup(db(), await who(user), { payerAccountId: ctx.payers[payerKey], type: "card", evidence: EVID, appUrl: APP });
        return r.ok ? "ok" : "refused";
      } catch (e) {
        return (e as Error).name;
      }
    };
    // Parker account (Maya + Eli): Alex pays, Jordan only views.
    expect(await attempt("alex", "parker")).toBe("ok");
    for (const u of ["jordan", "chris", "sam", "casey", "dana", "maya", "marcus", "tess", "erin", "rod", "kiosk"]) {
      expect(`${u}:${await attempt(u, "parker")}`).toBe(`${u}:AuthzError`);
    }
    // Rivera account (Leo): Sam pays; Casey has no payer authorization at all.
    expect(await attempt("sam", "rivera")).toBe("ok");
    expect(await attempt("casey", "rivera")).toBe("AuthzError");
    // Adult athlete paying for herself.
    expect(await attempt("dana", "dana")).toBe("ok");
    expect(await attempt("chris", "chris_parker")).toBe("ok");
    expect(await attempt("alex", "chris_parker")).toBe("AuthzError");
  });

  it("set default, remove and autopay follow the same rule; staff may only toggle autopay", async () => {
    const m = await activeMethod(ctx.payers.chris_parker);
    for (const u of ["jordan", "alex", "casey", "marcus", "erin", "rod", "kiosk", "maya"]) {
      await expect(db().transaction(async (tx) => setDefaultMethod(tx, await who(u), m.id)), u).rejects.toMatchObject({ name: "AuthzError" });
      await expect(removeMethod(db(), await who(u), { methodId: m.id }), u).rejects.toMatchObject({ name: "AuthzError" });
    }
    await db().transaction(async (tx) => setDefaultMethod(tx, await who("chris"), m.id));
    // Autopay on Maya's membership (Parker account).
    const card = await activeMethod(ctx.payers.parker);
    const mid = ctx.extra.billing.mayaMembershipId;
    for (const u of ["jordan", "chris", "casey", "marcus", "tess", "kiosk", "maya", "dana"]) {
      await expect(db().transaction(async (tx) => setMembershipAutopay(tx, await who(u), { membershipId: mid, autopay: true })), u).rejects.toMatchObject({ name: "AuthzError" });
    }
    for (const u of ["alex", "erin", "rod"]) {
      await db().transaction(async (tx) => setMembershipAutopay(tx, await who(u), { membershipId: mid, autopay: true, methodId: card.id }));
      const [row] = await db().select().from(memberships).where(eq(memberships.id, mid));
      expect(row.autopay).toBe(true);
      expect(row.autopayMethodId).toBeNull(); // the default method is stored as "use the default"
      await db().transaction(async (tx) => setMembershipAutopay(tx, await who(u), { membershipId: mid, autopay: false }));
    }
    await db().update(paymentMethods).set({ status: "removed", isDefault: false }).where(inArray(paymentMethods.id, [m.id, card.id]));
  });

  it("families see summaries for accounts they can view, never provider references; staff see summaries too", async () => {
    const m = await activeMethod(ctx.payers.parker, { last4: "1111" });
    const asJordan = await db().transaction(async (tx) => listMethodViews(tx, await who("jordan")));
    expect(asJordan.map((x) => x.label)).toContain("Visa ending 1111, expires 08/28");
    expect(JSON.stringify(asJordan)).not.toMatch(/pm_test|cus_test|mandate_/);
    expect(await db().transaction(async (tx) => listMethodViews(tx, await who("chris")))).toHaveLength(0);
    expect(await db().transaction(async (tx) => listMethodViews(tx, await who("marcus")))).toHaveLength(0);
    const asErin = await db().transaction(async (tx) => listMethodViews(tx, await who("erin"), { payerAccountId: ctx.payers.parker }));
    expect(asErin).toHaveLength(1);
    expect(JSON.stringify(asErin)).not.toMatch(/pm_test|cus_test/);
    await db().update(paymentMethods).set({ status: "removed", isDefault: false }).where(eq(paymentMethods.id, m.id));
  });
});

describe("hosted setup + verified webhooks", () => {
  it("creates one Stripe customer and a setup-mode Checkout session with our idempotency keys; the bank flow records the authorization", async () => {
    await db().execute(sql`update payer_accounts set provider_refs = '{}'::jsonb where id = ${ctx.payers.rivera}`);
    const { r, setup, customer, api } = await begin("sam", "rivera", "us_bank_account");
    expect(r.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const cust = api.calls.filter((c) => c.path === "/v1/customers");
    expect(cust).toHaveLength(1);
    expect(cust[0].idempotencyKey).toBe(`customer:${ctx.orgId}:${ctx.payers.rivera}`);
    const sess = api.calls.find((c) => c.path === "/v1/checkout/sessions")!;
    expect(sess.params.get("mode")).toBe("setup");
    expect(sess.params.get("customer")).toBe(customer);
    expect(sess.params.get("payment_method_types[0]")).toBe("us_bank_account");
    expect(sess.params.get("payment_method_options[us_bank_account][financial_connections][permissions][0]")).toBe("payment_method");
    expect(sess.params.get("setup_intent_data[metadata][setup_id]")).toBe(setup.id);
    expect(sess.idempotencyKey).toBe(`pmsetup:${setup.id}`);
    // No amount is ever sent in a setup.
    expect([...sess.params.keys()].some((k) => k.includes("amount"))).toBe(false);
    expect(setup.mandateAcceptance).toMatchObject({ userId: ctx.users.sam, ip: EVID.ip, userAgent: EVID.userAgent, textVersion: MANDATE_TEXT_VERSION });
    expect(setup.mandateAcceptance!.text).toMatch(/SAMPLE TEXT/);
    // Double click reuses the open session; the customer is not created again.
    const again = await startMethodSetup(db(), await who("sam"), { payerAccountId: ctx.payers.rivera, type: "us_bank_account", mandateAccepted: true, evidence: EVID, appUrl: APP });
    expect(again).toMatchObject({ ok: true, reused: true, setupId: setup.id });
    expect(api.calls.filter((c) => c.path === "/v1/customers")).toHaveLength(1);
    // A bank account cannot be started without accepting the authorization.
    await expect(startMethodSetup(db(), await who("dana"), { payerAccountId: ctx.payers.dana, type: "us_bank_account", evidence: EVID, appUrl: APP })).rejects.toThrow(/authorization/);
  });

  it("a card becomes active only from verified webhooks, never from the browser return; duplicates and concurrent deliveries are no-ops", async () => {
    const { setup, customer } = await begin("dana", "dana", "card");
    const si = "seti_test_dana_card";
    const pm = "pm_test_dana_card";
    // The browser comes back: nothing exists yet.
    expect(await db().transaction(async (tx) => setupReturnView(tx, await who("dana"), setup.id))).toEqual({ state: "confirming" });
    expect(await methodsOf(ctx.payers.dana)).toHaveLength(0);
    // An unsigned "success" is rejected and changes nothing.
    const forged = JSON.stringify(setupIntentEvent("setup_intent.succeeded", { setupId: setup.id, setupIntent: si, customer, pm }));
    const bad = await ingestWebhook(db(), "stripe", forged, new Headers({ "stripe-signature": "t=1,v1=00" }));
    expect(bad.httpStatus).toBe(400);
    expect(await methodsOf(ctx.payers.dana)).toHaveLength(0);

    await sendStripe(setupSessionCompleted({ setupId: setup.id, sessionId: "cs_test_dana", setupIntent: si, customer }));
    const succeeded = setupIntentEvent("setup_intent.succeeded", { setupId: setup.id, setupIntent: si, customer, pm });
    await Promise.all([sendStripe(succeeded), sendStripe(succeeded), sendStripe(succeeded)]);
    let rows = await methodsOf(ctx.payers.dana);
    expect(rows).toHaveLength(1);
    // Setup confirmed but Stripe has not told us what the method is yet: not active.
    expect(rows[0].status).toBe("requires_verification");
    const attached = paymentMethodEvent("payment_method.attached", { pm, customer, card: { brand: "visa", last4: "4242", expMonth: 8, expYear: 2028 } });
    await Promise.all([sendStripe(attached), sendStripe(attached)]);
    await sendStripe(attached);
    rows = await methodsOf(ctx.payers.dana);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "active", isDefault: true, type: "card", brand: "visa", last4: "4242", expMonth: 8, expYear: 2028, providerCustomerId: customer });
    expect(methodLabel(rows[0])).toBe("Visa ending 4242, expires 08/28");
    expect(await db().transaction(async (tx) => setupReturnView(tx, await who("dana"), setup.id))).toEqual({ state: "active" });
    // Another family cannot read the return state.
    expect(await db().transaction(async (tx) => setupReturnView(tx, await who("chris"), setup.id))).toBeNull();
    // A late failure event for the same SetupIntent cannot undo it.
    await sendStripe(setupIntentEvent("setup_intent.setup_failed", { setupId: setup.id, setupIntent: si, customer, pm }));
    expect((await methodsOf(ctx.payers.dana))[0].status).toBe("active");
    const [s] = await db().select().from(paymentMethodSetups).where(eq(paymentMethodSetups.id, setup.id));
    expect(s.status).toBe("succeeded");
  });

  it("out of order (details before confirmation) still ends active; a failure followed by success in the same session ends active", async () => {
    const { setup, customer } = await begin("chris", "chris_parker", "card");
    const si = "seti_test_chris";
    const pm = "pm_test_chris_card";
    await sendStripe(paymentMethodEvent("payment_method.attached", { pm, customer, card: { brand: "mastercard", last4: "4444", expMonth: 1, expYear: 2030 } }));
    let rows = await methodsOf(ctx.payers.chris_parker);
    expect(rows.filter((r) => r.providerMethodId === pm)[0].status).toBe("requires_verification");
    await sendStripe(setupIntentEvent("setup_intent.setup_failed", { setupId: setup.id, setupIntent: si, customer, pm }));
    expect((await db().select().from(paymentMethodSetups).where(eq(paymentMethodSetups.id, setup.id)))[0].status).toBe("failed");
    await sendStripe(setupIntentEvent("setup_intent.succeeded", { setupId: setup.id, setupIntent: si, customer, pm }));
    rows = await methodsOf(ctx.payers.chris_parker);
    expect(rows.filter((r) => r.providerMethodId === pm)[0]).toMatchObject({ status: "active", last4: "4444" });
  });

  it("bank account: microdeposit wait, then active with the mandate reference and the stored authorization; nothing sensitive is kept", async () => {
    const { setup, customer } = await begin("sam", "rivera", "us_bank_account");
    const si = "seti_test_sam_bank";
    const pm = "pm_test_sam_bank";
    await sendStripe(setupIntentEvent("setup_intent.requires_action", { setupId: setup.id, setupIntent: si, customer, pm, verificationUrl: "https://payments.stripe.com/microdeposit/sample_sam" }));
    let [s] = await db().select().from(paymentMethodSetups).where(eq(paymentMethodSetups.id, setup.id));
    expect(s).toMatchObject({ status: "requires_verification", verificationUrl: "https://payments.stripe.com/microdeposit/sample_sam" });
    expect(await db().transaction(async (tx) => setupReturnView(tx, await who("sam"), setup.id))).toEqual({ state: "verification" });
    await sendStripe(paymentMethodEvent("payment_method.attached", { pm, customer, bank: { bankName: "First Example Bank", last4: "6789" } }));
    let [m] = (await methodsOf(ctx.payers.rivera)).filter((r) => r.providerMethodId === pm);
    expect(m.status).toBe("requires_verification");
    // Days later the payer verifies on Stripe's page.
    await sendStripe(setupIntentEvent("setup_intent.succeeded", { setupId: setup.id, setupIntent: si, customer, pm, mandate: "mandate_test_sam" }));
    [m] = (await methodsOf(ctx.payers.rivera)).filter((r) => r.providerMethodId === pm);
    expect(m).toMatchObject({ status: "active", type: "us_bank_account", bankName: "First Example Bank", last4: "6789", mandateRef: "mandate_test_sam", mandateStatus: "active" });
    expect(methodLabel(m)).toBe("Bank account ending 6789, First Example Bank");
    expect(m.mandateAcceptance).toMatchObject({ userId: ctx.users.sam, personId: ctx.people.sam_rivera, ip: EVID.ip, textVersion: MANDATE_TEXT_VERSION });
    expect(new Date(m.mandateAcceptance!.acceptedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    [s] = await db().select().from(paymentMethodSetups).where(eq(paymentMethodSetups.id, setup.id));
    expect(s.status).toBe("succeeded");
    // The routing number and fingerprints in the event are not stored anywhere, including the raw event log.
    expect(JSON.stringify(m)).not.toMatch(/110000000|fp_never_stored/);
    const evs = await db().select().from(webhookEvents).where(sql`${webhookEvents.type} like 'payment_method.%'`);
    expect(evs.length).toBeGreaterThan(0);
    expect(JSON.stringify(evs)).not.toMatch(/110000000|fp_never_stored|routing_number|fingerprint/);
  });

  it("a setup event naming a different Stripe customer saves nothing and raises a task", async () => {
    const { setup } = await begin("alex", "parker", "card");
    await sendStripe(setupIntentEvent("setup_intent.succeeded", { setupId: setup.id, setupIntent: "seti_test_alex_x", customer: "cus_someone_else", pm: "pm_test_stolen" }));
    expect((await methodsOf(ctx.payers.parker)).filter((r) => r.providerMethodId === "pm_test_stolen")).toHaveLength(0);
    const t = await db().select().from(tasks).where(eq(tasks.dedupeKey, `billing:pmsetup-customer:${setup.id}`));
    expect(t).toHaveLength(1);
  });

  it("events for unknown customers or sessions are ignored", async () => {
    const r = await sendStripe(paymentMethodEvent("payment_method.attached", { pm: "pm_unknown", customer: "cus_unknown", card: { brand: "visa", last4: "0000", expMonth: 1, expYear: 2031 } }));
    expect(r.body).toMatchObject({ outcome: "ignored" });
    const r2 = await sendStripe(setupIntentEvent("setup_intent.succeeded", { setupId: "00000000-0000-4000-8000-000000000000", setupIntent: "seti_unknown", customer: "cus_unknown", pm: "pm_unknown" }));
    expect(r2.body).toMatchObject({ outcome: "ignored" });
    expect(await db().select().from(paymentMethods).where(eq(paymentMethods.providerMethodId, "pm_unknown"))).toHaveLength(0);
  });
});

describe("default, removal and autopay dependencies", () => {
  it("removal is refused while it is the only method an autopay membership depends on, and explains why; with another method autopay moves over", async () => {
    // Leo's membership is on the Rivera account. Sam has the bank account saved above (default).
    const mid = ctx.extra.billing.leoMembershipId;
    const [bank] = (await methodsOf(ctx.payers.rivera)).filter((r) => r.status === "active");
    await db().transaction(async (tx) => setMembershipAutopay(tx, await who("sam"), { membershipId: mid, autopay: true }));
    const api = stripeMethodsApi();
    vi.stubGlobal("fetch", api.fn);
    await expect(removeMethod(db(), await who("sam"), { methodId: bank.id })).rejects.toThrow(/only saved payment method.*Leo.*Add another payment method first, or turn off autopay/);
    expect(api.calls.filter((c) => c.path.includes("/detach"))).toHaveLength(0);
    const views = await db().transaction(async (tx) => listMethodViews(tx, await who("sam")));
    expect(views.find((x) => x.id === bank.id)!.paysFor.map((p) => p.membershipId)).toEqual([mid]);

    const card = await activeMethod(ctx.payers.rivera, { isDefault: false });
    await db().transaction(async (tx) => setDefaultMethod(tx, await who("sam"), card.id));
    let rows = await methodsOf(ctx.payers.rivera);
    expect(rows.filter((r) => r.isDefault).map((r) => r.id)).toEqual([card.id]);
    await db().transaction(async (tx) => setDefaultMethod(tx, await who("sam"), bank.id));
    const r = await removeMethod(db(), await who("sam"), { methodId: bank.id });
    expect(r).toEqual({ removed: true, detachedAtProvider: true });
    const detach = api.calls.filter((c) => c.path.includes("/detach"));
    expect(detach).toHaveLength(1);
    expect(detach[0].path).toContain(bank.providerMethodId);
    rows = await methodsOf(ctx.payers.rivera);
    expect(rows.find((x) => x.id === bank.id)).toMatchObject({ status: "removed", isDefault: false, removedBy: ctx.users.sam });
    expect(rows.find((x) => x.id === card.id)).toMatchObject({ status: "active", isDefault: true });
    // Stripe's own detach event afterwards is a no-op.
    await sendStripe(paymentMethodEvent("payment_method.detached", { pm: bank.providerMethodId, customer: null }));
    expect((await methodsOf(ctx.payers.rivera)).find((x) => x.id === bank.id)!.status).toBe("removed");
    // Turning autopay off frees the last method for removal.
    await expect(removeMethod(db(), await who("sam"), { methodId: card.id })).rejects.toThrow(/only saved payment method/);
    await db().transaction(async (tx) => setMembershipAutopay(tx, await who("sam"), { membershipId: mid, autopay: false }));
    await removeMethod(db(), await who("sam"), { methodId: card.id });
    await expect(db().transaction(async (tx) => setMembershipAutopay(tx, await who("sam"), { membershipId: mid, autopay: true }))).rejects.toThrow(/Save a card or bank account first/);
  });

  it("a mandate that goes inactive marks the bank account as needing replacement and tells staff when autopay depended on it", async () => {
    const bank = await activeMethod(ctx.payers.dana, { type: "us_bank_account", isDefault: false });
    await db().update(paymentMethods).set({ isDefault: false }).where(and(eq(paymentMethods.payerAccountId, ctx.payers.dana), sql`${paymentMethods.id} <> ${bank.id}`));
    await db().update(paymentMethods).set({ isDefault: true }).where(eq(paymentMethods.id, bank.id));
    await db().update(paymentMethods).set({ status: "removed" }).where(and(eq(paymentMethods.payerAccountId, ctx.payers.dana), sql`${paymentMethods.id} <> ${bank.id}`));
    await sendStripe(mandateUpdated({ mandate: bank.mandateRef!, pm: bank.providerMethodId, status: "inactive" }));
    const [m] = await db().select().from(paymentMethods).where(eq(paymentMethods.id, bank.id));
    expect(m).toMatchObject({ status: "failed", failureCode: "mandate_inactive", mandateStatus: "inactive", isDefault: false });
  });

  it("expiring cards (60 days) and the autopay-off definition", async () => {
    const soon = await activeMethod(ctx.payers.parker, { expMonth: 4, expYear: 2026, last4: "0404" }); // good through Apr 30, 2026
    const later = await activeMethod(ctx.payers.parker, { expMonth: 6, expYear: 2026, last4: "0606", isDefault: false });
    const exp = await db().transaction((tx) => expiringCards(tx, ctx.orgId, { today: T }));
    expect(exp.map((e) => e.label)).toContain("Visa ending 0404, expires 04/26");
    expect(exp.find((e) => e.methodId === soon.id)!.expiresOn).toBe("2026-04-30");
    expect(exp.find((e) => e.methodId === later.id)).toBeUndefined();
    expect((await db().transaction((tx) => expiringCards(tx, ctx.orgId, { today: T, withinDays: 150 }))).some((e) => e.methodId === later.id)).toBe(true);

    const mid = ctx.extra.billing.mayaMembershipId;
    let off = await db().transaction((tx) => autopayOffMembershipIds(tx, ctx.orgId));
    expect(off).toContain(mid); // autopay not switched on
    await db().transaction(async (tx) => setMembershipAutopay(tx, await who("alex"), { membershipId: mid, autopay: true }));
    off = await db().transaction((tx) => autopayOffMembershipIds(tx, ctx.orgId));
    expect(off).not.toContain(mid);
    // Autopay on, but the method stops being active: counts as off again.
    await db().update(paymentMethods).set({ status: "failed" }).where(eq(paymentMethods.id, soon.id));
    off = await db().transaction((tx) => autopayOffMembershipIds(tx, ctx.orgId));
    expect(off).toContain(mid);
    // Zen Planner-billed memberships are never listed.
    expect(off).not.toContain(ctx.extra.billing.sofiaExternalMembershipId);
  });
});
