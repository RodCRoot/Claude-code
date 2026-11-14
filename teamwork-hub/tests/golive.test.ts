import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { auditEvents, formTemplateVersions, formTemplates, goLiveAttestations, jobs, memberships, organizations, payerAccounts, paymentMethods, transactions, users, webhookEvents } from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { UserError } from "@/lib/billing/errors";
import { saveAutopaySettings, autopaySettingsOf } from "@/lib/billing/autopay-settings";
import { setApprovedText } from "@/lib/forms/templates";
import { ATTESTATIONS, attest, withdrawAttestation } from "@/lib/golive/attestations";
import { OPEN_DECISIONS, decisionKey } from "@/lib/golive/decisions";
import { EXAMPLE_SESSION_SECRET, goLiveEnv, goLiveReadiness, sessionSecretProblem, stripeKeyMode, type GoLiveEnv, type GoLiveItem, type GoLiveReport } from "@/lib/golive/readiness";
import { checkStorage } from "@/lib/golive/storage-check";
import { BUILT_IN_WORDINGS } from "@/lib/golive/wordings";
import { growthFromSettings } from "@/lib/growth/settings";
import { saveMembershipPolicy, policyFromSettings, POLICY_FIELDS } from "@/lib/membership-policy";
import type { ObjectStore } from "@/lib/storage";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

const db = testDb();
let ctx: Awaited<ReturnType<typeof seedOrg>>;
type V = Awaited<ReturnType<typeof viewerFor>>;
let rod: V;
let erin: V;
let marcus: V;
let alex: V;

const NOW = new Date("2026-03-02T15:00:00Z");
const DEMO_ENV = goLiveEnv({ APP_MODE: "demo", SESSION_SECRET: EXAMPLE_SESSION_SECRET, APP_URL: "http://localhost:3000" });
const PROD_ENV: GoLiveEnv = { ...goLiveEnv({}), appMode: "production", sessionSecret: "f3a91c0d7b2e4a6f8c1d0e9b7a5c3f1e2d4b6a8c0e1f3a5b7c9d1e3f5a7b9c1d", appUrl: "https://hub.example.test", storageBackend: "s3" };

const report = (env: GoLiveEnv = DEMO_ENV, v: V = rod) => goLiveReadiness(db, v, { env, now: NOW });
const item = (r: GoLiveReport, id: string): GoLiveItem => {
  const i = r.sections.flatMap((s) => s.items).find((x) => x.id === id);
  if (!i) throw new Error(`no item ${id}`);
  return i;
};

beforeAll(async () => {
  ctx = await seedOrg("2026-03-02");
  rod = await viewerFor(ctx, "rod");
  erin = await viewerFor(ctx, "erin");
  marcus = await viewerFor(ctx, "marcus");
  alex = await viewerFor(ctx, "alex");
});
afterAll(closeTestDb);

describe("go-live readiness: access and shape", () => {
  it("is for owners and admins only", async () => {
    for (const v of [erin, marcus, alex]) await expect(report(DEMO_ENV, v)).rejects.toBeInstanceOf(AuthzError);
    await expect(db.transaction((tx) => attest(tx, erin, { key: "sms_not_used" }))).rejects.toBeInstanceOf(AuthzError);
  });

  it("groups items into the eight sections, each with a status, a reason and somewhere to go", async () => {
    const r = await report();
    expect(r.sections.map((s) => s.id)).toEqual(["hosting", "payments", "messages", "legal", "catalog", "migration", "people", "decisions"]);
    const all = r.sections.flatMap((s) => s.items);
    expect(all.length).toBeGreaterThan(30);
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length);
    for (const i of all) {
      expect(["done", "attention", "not_started", "na"]).toContain(i.status);
      expect(i.why.length).toBeGreaterThan(10);
      expect(i.detail.length).toBeGreaterThan(3);
      expect(i.href || i.hrefLabel).toBeTruthy();
      expect(`${i.title} ${i.why} ${i.detail}`).not.toMatch(/[—―]/);
    }
    const counted = all.filter((i) => i.status !== "na");
    expect(r.total).toBe(counted.length);
    expect(r.done).toBe(counted.filter((i) => i.status === "done").length);
    expect(r.blocking).toBe(all.filter((i) => i.blocking).length);
    expect(r.summary).toBe(`${r.done} of ${r.total} done; ${r.blocking} ${r.blocking === 1 ? "blocks" : "block"} going live`);
  });

  it("a freshly seeded demo is far from ready: nothing is green by default", async () => {
    const r = await report();
    expect(r.blocking).toBeGreaterThan(5);
    for (const id of ["hosting.app_mode", "hosting.session_secret", "hosting.app_url_https", "hosting.object_storage", "hosting.staff_mfa_policy", "hosting.admin_mfa_enrolled"]) {
      expect(item(r, id).status, id).toBe("attention");
      expect(item(r, id).blocking, id).toBe(true);
    }
    for (const id of ["hosting.backups_rehearsed", "hosting.error_reporting", "payments.stripe_keys", "payments.test_saved_method", "payments.test_charge", "messages.email_provider", "messages.sms_provider", "messages.rules_reviewed"]) {
      expect(item(r, id).status, id).toBe("not_started");
    }
    expect(item(r, "hosting.demo_data_absent").status).toBe("na");
    expect(item(r, "payments.retry_schedule").status).toBe("attention");
    expect(item(r, "catalog.family_discount").status).toBe("attention");
    for (const d of OPEN_DECISIONS) expect(item(r, `decisions.${d.id}`).status).toBe("not_started");
  });
});

describe("hosting and safety", () => {
  it("reads the environment it is given", async () => {
    const r = await report(PROD_ENV);
    expect(item(r, "hosting.app_mode").status).toBe("done");
    expect(item(r, "hosting.session_secret").status).toBe("done");
    expect(item(r, "hosting.app_url_https").status).toBe("done");
    // Demo logins in a non-demo mode are a blocking problem, with counts.
    const demo = item(r, "hosting.demo_data_absent");
    expect(demo.status).toBe("attention");
    expect(demo.blocking).toBe(true);
    expect(demo.detail).toMatch(/demo login/);
    expect(item(await report({ ...PROD_ENV, sentryDsn: "https://k@o1.ingest.example.test/1" }), "hosting.error_reporting").status).toBe("done");
  });

  it("recognises weak session secrets and key modes without printing them", () => {
    expect(sessionSecretProblem(EXAMPLE_SESSION_SECRET)).toMatch(/example/);
    expect(sessionSecretProblem("short")).toMatch(/shorter/);
    expect(sessionSecretProblem("a".repeat(64))).toMatch(/repeated/);
    expect(sessionSecretProblem(PROD_ENV.sessionSecret)).toBeNull();
    expect(stripeKeyMode("")).toBe("none");
    expect(stripeKeyMode("sk_test_abc")).toBe("test");
    expect(stripeKeyMode("rk_live_abc")).toBe("live");
    expect(stripeKeyMode("whatever")).toBe("unknown");
  });

  it("storage needs a bucket AND a real round trip; a failed check is recorded as failed", async () => {
    const mem = new Map<string, Uint8Array>();
    const good: ObjectStore = { put: async (k, b) => void mem.set(k, b), get: async (k) => mem.get(k)!, delete: async (k) => void mem.delete(k) };
    const bad: ObjectStore = { put: async () => { throw new Error("AccessDenied: secret-bucket-name"); }, get: async () => new Uint8Array(), delete: async () => undefined };
    expect(item(await report(PROD_ENV), "hosting.object_storage").detail).toMatch(/no storage check/);
    await expect(db.transaction((tx) => checkStorage(tx, erin, { store: good, backend: "s3" }))).rejects.toBeInstanceOf(AuthzError);

    const failed = await db.transaction((tx) => checkStorage(tx, rod, { store: bad, backend: "s3", now: NOW }));
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain("secret-bucket-name");
    expect(item(await report(PROD_ENV), "hosting.object_storage").status).toBe("attention");

    const ok = await db.transaction((tx) => checkStorage(tx, rod, { store: good, backend: "s3", now: NOW }));
    expect(ok.ok).toBe(true);
    expect(mem.size).toBe(0); // the probe file is removed
    expect(item(await report(PROD_ENV), "hosting.object_storage").status).toBe("done");
    // A passing check on local disk does not make local disk acceptable, and an s3 probe does not vouch for another backend.
    expect(item(await report({ ...PROD_ENV, storageBackend: "local" }), "hosting.object_storage").status).toBe("attention");
  });

  it("the worker item reads job records: Run now and old runs do not count", async () => {
    const type = `test.golive.${randomUUID()}`;
    const mk = (lockedBy: string, finishedAt: Date) => db.insert(jobs).values({ orgId: ctx.orgId, type, payload: {}, status: "done", lockedBy, finishedAt });
    await mk(`manual-${rod.userId}`, new Date(NOW.getTime() - 3600_000));
    expect(item(await report(), "hosting.worker_recent").status).toBe("not_started");
    await mk("worker-host-1", new Date(NOW.getTime() - 30 * 3600_000));
    expect(item(await report(), "hosting.worker_recent").status).toBe("attention");
    await mk("worker-host-1", new Date(NOW.getTime() - 2 * 3600_000));
    expect(item(await report(), "hosting.worker_recent").status).toBe("done");
  });

  it("two-step verification: the policy and each owner and admin are checked from the user records", async () => {
    const before = item(await report(), "hosting.admin_mfa_enrolled");
    expect(before.status).toBe("attention");
    expect(before.list?.length).toBeGreaterThan(0);
    await db.update(users).set({ mfaEnabled: true }).where(and(eq(users.orgId, ctx.orgId), eq(users.role, "owner")));
    await db.update(users).set({ mfaEnabled: true }).where(and(eq(users.orgId, ctx.orgId), eq(users.role, "admin")));
    expect(item(await report(), "hosting.admin_mfa_enrolled").status).toBe("done");
    const [org] = await db.select().from(organizations).where(eq(organizations.id, ctx.orgId));
    await db.update(organizations).set({ settings: { ...org.settings, requireStaffMfa: true } }).where(eq(organizations.id, ctx.orgId));
    expect(item(await report(), "hosting.staff_mfa_policy").status).toBe("done");
  });
});

describe("manual ticks", () => {
  it("cannot be used for anything the system can verify", async () => {
    const r = await report();
    const all = r.sections.flatMap((s) => s.items);
    const allowed = new Set([...ATTESTATIONS.map((a) => a.key), ...OPEN_DECISIONS.map((d) => decisionKey(d.id))]);
    for (const i of all) if (i.attestKey) expect(allowed.has(i.attestKey)).toBe(true);
    // Items with a system check offer no tick at all.
    for (const id of ["hosting.app_mode", "hosting.session_secret", "hosting.staff_mfa_policy", "payments.stripe_keys", "payments.webhook_verified", "payments.test_charge", "messages.email_test_send", "catalog.plan_drafts", "people.staff_accounts"]) {
      expect(item(r, id).attestKey, id).toBeUndefined();
    }
    for (const key of ["hosting.app_mode", "payments.stripe_keys", "stripe", "legal.wording.ach_mandate", ""]) {
      await expect(db.transaction((tx) => attest(tx, rod, { key }))).rejects.toBeInstanceOf(UserError);
    }
    expect(await db.select().from(goLiveAttestations).where(eq(goLiveAttestations.orgId, ctx.orgId))).toHaveLength(0);
  });

  it("a rehearsed restore is attested by a named person on a date, audited, and can be withdrawn", async () => {
    await expect(db.transaction((tx) => attest(tx, rod, { key: "backups_rehearsed", note: "  " }))).rejects.toThrow(/note/);
    await expect(db.transaction((tx) => attest(tx, rod, { key: "backups_rehearsed", note: "x", on: "2026-03-09" }, { today: "2026-03-02" }))).rejects.toThrow(/future/);
    await db.transaction((tx) => attest(tx, rod, { key: "backups_rehearsed", note: "Restored last night's backup into a scratch database; counts matched.", on: "2026-03-01" }, { today: "2026-03-02" }));
    const i = item(await report(), "hosting.backups_rehearsed");
    expect(i.status).toBe("done");
    expect(i.blocking).toBe(false);
    expect(i.attested).toMatchObject({ byName: rod.displayName, on: "2026-03-01" });
    expect(i.detail).toContain(`Attested by ${rod.displayName}`);
    const [a] = await db.select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "golive.attested"))).orderBy(desc(auditEvents.createdAt));
    expect(a.actorUserId).toBe(rod.userId);
    expect(a.summary).toMatch(/restore/i);

    await db.transaction((tx) => withdrawAttestation(tx, rod, "backups_rehearsed"));
    expect(item(await report(), "hosting.backups_rehearsed").status).toBe("not_started");
    await expect(db.transaction((tx) => withdrawAttestation(tx, rod, "backups_rehearsed"))).rejects.toBeInstanceOf(UserError);
    const rows = await db.select().from(goLiveAttestations).where(and(eq(goLiveAttestations.orgId, ctx.orgId), eq(goLiveAttestations.key, "backups_rehearsed")));
    expect(rows).toHaveLength(1); // kept for the record
    expect(rows[0].withdrawnAt).not.toBeNull();
  });

  it("error reporting skipped and SMS not used are conscious, named choices; a configured provider wins over the tick", async () => {
    await db.transaction((tx) => attest(tx, rod, { key: "error_reporting_skipped" }));
    await db.transaction((tx) => attest(tx, rod, { key: "sms_not_used" }));
    const r = await report();
    expect(item(r, "hosting.error_reporting")).toMatchObject({ status: "done", attested: { byName: rod.displayName } });
    expect(item(r, "messages.sms_provider").status).toBe("na");
    // SMS provider chosen but incomplete: the tick no longer hides it.
    const half = await report({ ...DEMO_ENV, smsProvider: "twilio" });
    expect(item(half, "messages.sms_provider").status).toBe("attention");
    expect(item(half, "messages.sms_provider").attested).toBeNull();
  });

  it("a decision is confirmed with its current value and reopens when the setting changes", async () => {
    const key = decisionKey("family_discount_percent");
    await db.transaction((tx) => attest(tx, rod, { key }));
    let i = item(await report(), "decisions.family_discount_percent");
    expect(i.status).toBe("done");
    expect(i.detail).toMatch(/Current setting: 10%\. Confirmed as is by/);
    const [a] = await db.select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "golive.decision_confirmed")));
    expect(a.summary).toContain("10%");

    const [org] = await db.select().from(organizations).where(eq(organizations.id, ctx.orgId));
    const cur = policyFromSettings(org.settings);
    const raw: Record<string, unknown> = { ...cur, familyDiscountPercent: 15, confirm: ["familyDiscountPercent"] };
    for (const f of POLICY_FIELDS) if (f.kind === "bool") raw[f.key] = cur[f.key];
    const saved = await db.transaction((tx) => saveMembershipPolicy(tx, rod, raw));
    expect(saved.ok).toBe(true);
    const r = await report();
    i = item(r, "decisions.family_discount_percent");
    expect(i.status).toBe("attention");
    expect(i.detail).toMatch(/15%.*It was "10%"/);
    // The catalog item follows the policy's own flag, not the tick.
    expect(item(r, "catalog.family_discount").status).toBe("done");
  });
});

describe("payments", () => {
  const evt = (type: string, object: Record<string, unknown>, livemode: boolean, verified = true) =>
    db.insert(webhookEvents).values({
      provider: "stripe",
      providerEventId: verified ? `evt_${randomUUID()}` : `rejected:${randomUUID()}`,
      type,
      payload: { id: "evt", type, livemode, data: { object: { ...object, metadata: { org_id: ctx.orgId } } } },
      signatureVerified: verified,
      status: verified ? "processed" : "rejected",
    });

  it("shows the key mode, and live keys are not ready until test mode was proven first", async () => {
    const keys = { stripeWebhookSecret: "whsec_x", stripePublishableKey: "pk_test_x" };
    expect(item(await report({ ...DEMO_ENV, stripeSecretKey: "sk_test_x" }), "payments.stripe_keys").detail).toMatch(/1 of 3/);
    const test = item(await report({ ...DEMO_ENV, ...keys, stripeSecretKey: "sk_test_x" }), "payments.stripe_keys");
    expect(test.status).toBe("done");
    expect(test.detail).toContain("TEST");
    const liveInDemo = item(await report({ ...DEMO_ENV, ...keys, stripeSecretKey: "sk_live_x" }), "payments.stripe_keys");
    expect(liveInDemo.status).toBe("attention");
    const live = item(await report({ ...PROD_ENV, ...keys, stripeSecretKey: "sk_live_x" }), "payments.stripe_keys");
    expect(live.status).toBe("attention");
    expect(live.detail).toMatch(/LIVE.*not accepted as ready/);
    expect(JSON.stringify(live)).not.toContain("sk_live_x");
  });

  it("webhook, saved method and charge count only from verified Stripe events, and test mode only from test-mode events", async () => {
    await evt("setup_intent.succeeded", { id: "seti_bad", payment_method: "pm_x" }, false, false);
    let r = await report();
    expect(item(r, "payments.webhook_verified").status).toBe("not_started");

    const [payer] = await db.select().from(payerAccounts).where(eq(payerAccounts.orgId, ctx.orgId)).limit(1);
    const pmId = `pm_${randomUUID()}`;
    const piLive = `pi_${randomUUID()}`;
    const piTest = `pi_${randomUUID()}`;
    await db.insert(paymentMethods).values({ payerAccountId: payer.id, provider: "stripe", providerMethodId: pmId, type: "card", status: "active", setupSucceededAt: NOW });
    const txn = (providerTxnId: string) =>
      db.insert(transactions).values({ orgId: ctx.orgId, payerAccountId: payer.id, kind: "charge", status: "settled", amountMinor: 1000, currency: "USD", provider: "stripe", providerTxnId, verification: "provider_verified", occurredAt: NOW });
    await txn(piLive);
    // Live-mode events prove the webhook works, but are not test-mode evidence.
    await evt("setup_intent.succeeded", { id: "seti_live", payment_method: pmId }, true);
    await evt("payment_intent.succeeded", { id: piLive }, true);
    r = await report();
    expect(item(r, "payments.webhook_verified").status).toBe("done");
    expect(item(r, "payments.test_saved_method").status).toBe("not_started");
    expect(item(r, "payments.test_charge").status).toBe("not_started");

    await evt("setup_intent.succeeded", { id: "seti_test", payment_method: pmId }, false);
    await txn(piTest);
    await evt("payment_intent.succeeded", { id: piTest }, false);
    r = await report({ ...PROD_ENV, stripeSecretKey: "sk_live_x", stripeWebhookSecret: "whsec_x", stripePublishableKey: "pk_live_x" });
    expect(item(r, "payments.test_saved_method").status).toBe("done");
    expect(item(r, "payments.test_charge").status).toBe("done");
    expect(item(r, "payments.stripe_keys").status).toBe("done");
    expect(item(r, "payments.stripe_keys").detail).toContain("LIVE");
  });

  it("the retry schedule is confirmed by saving the payments settings, with the person named", async () => {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, ctx.orgId));
    const cur = autopaySettingsOf(org.settings);
    await db.transaction((tx) => saveAutopaySettings(tx, rod, { cardRetryDays: [3, 7], achRetryWaitDays: 5, bankPayDiscount: cur.bankPayDiscount, feeEstimates: cur.feeEstimates }));
    const i = item(await report(), "payments.retry_schedule");
    expect(i.status).toBe("done");
    expect(i.detail).toContain(`Saved by ${rod.displayName}`);
  });

  it("payments block going live only when the hub bills families", async () => {
    const bare = await seedOrg("2026-03-02", { modules: [] });
    const owner = await viewerFor(bare, "rod");
    const r = await goLiveReadiness(db, owner, { env: DEMO_ENV, now: NOW });
    expect(r.billingHere).toBe(false);
    expect(r.sections.find((s) => s.id === "payments")!.items.some((i) => i.blocking)).toBe(false);
    expect(item(r, "payments.stripe_keys").status).toBe("not_started");
    const withKeys = await goLiveReadiness(db, owner, { env: { ...DEMO_ENV, stripeSecretKey: "sk_test_x" }, now: NOW });
    expect(withKeys.billingHere).toBe(true);
    expect(item(withKeys, "payments.webhook_verified").blocking).toBe(true);
    // Legal text and safety always block.
    expect(item(r, "legal.waiver_missing")).toMatchObject({ status: "not_started", blocking: true });
    expect(item(r, "legal.agreement_missing").blocking).toBe(true);
    expect(await db.select({ id: memberships.id }).from(memberships).where(eq(memberships.orgId, bare.orgId))).toHaveLength(0);
  });
});

describe("legal text", () => {
  it("lists every form template and built-in wording still carrying the sample flag", async () => {
    const r = await report();
    const tpls = await db.select().from(formTemplates).where(and(eq(formTemplates.orgId, ctx.orgId), eq(formTemplates.active, true)));
    expect(tpls.length).toBeGreaterThan(3);
    expect(tpls.some((t) => t.kind === "membership_agreement")).toBe(true);
    for (const t of tpls) {
      const i = item(r, `legal.form.${t.id}`);
      expect(["attention", "not_started"]).toContain(i.status);
      expect(i.blocking).toBe(true);
    }
    expect(BUILT_IN_WORDINGS.map((w) => w.id).sort()).toEqual(["ach_mandate", "card_update_instructions", "esign_consent", "newswatch_optin", "showcase_consent", "wins_marketing_consent"]);
    for (const w of BUILT_IN_WORDINGS) {
      expect(w.isSample).toBe(true);
      expect(item(r, `legal.wording.${w.id}`)).toMatchObject({ status: "attention", blocking: true });
    }
    const msgs = item(r, "legal.message_templates");
    expect(msgs.status).toBe("attention");
    expect(msgs.blocking).toBe(false);
    expect(msgs.list!.length).toBeGreaterThan(0);
  });

  it("follows the flag, not the prose: approving a version clears it even though the body still says SAMPLE", async () => {
    const [t] = await db.select().from(formTemplates).where(and(eq(formTemplates.orgId, ctx.orgId), eq(formTemplates.kind, "waiver")));
    const [ver] = await db.select().from(formTemplateVersions).where(and(eq(formTemplateVersions.templateId, t.id), eq(formTemplateVersions.status, "published"))).orderBy(desc(formTemplateVersions.version));
    expect(ver.bodyMarkdown).toMatch(/SAMPLE/);
    await db.transaction((tx) => setApprovedText(tx, rod, ver.id, true));
    expect(item(await report(), `legal.form.${t.id}`)).toMatchObject({ status: "done", blocking: false });
  });

  it("the referral wording carries the same flag in settings", async () => {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, ctx.orgId));
    expect(growthFromSettings(org.settings).referral.howItWorksIsSample).toBe(true);
    expect(item(await report(), "legal.referral_wording").status).toBe("attention");
    const growth = growthFromSettings(org.settings);
    const [fresh] = await db.select().from(organizations).where(eq(organizations.id, ctx.orgId));
    await db.update(organizations).set({ settings: { ...fresh.settings, growth: { ...growth, referral: { ...growth.referral, howItWorksIsSample: false } } } }).where(eq(organizations.id, ctx.orgId));
    expect(item(await report(), "legal.referral_wording").status).toBe("done");
  });
});

describe("catalog, migration and people", () => {
  it("reports what the data says", async () => {
    const r = await report();
    expect(item(r, "catalog.locations").status).toBe("done");
    expect(["done", "attention"]).toContain(item(r, "catalog.class_schedule").status);
    for (const id of ["people", "memberships", "bills", "attendance"]) expect(item(r, `migration.import_${id}`).status).toBe("not_started");
    expect(item(r, "migration.identity_reviews").status).toBe("na");
    expect(item(r, "migration.reconciliation").status).toBe("na");
    expect(item(r, "people.guardians_invited").detail).toMatch(/\d+ of \d+ guardians have a login/);
    expect(["done", "attention"]).toContain(item(r, "people.athletes_without_birthday").status);
    // Demo staff logins do not count as real staff accounts.
    expect(item(r, "people.staff_accounts").status).toBe("not_started");
  });
});
