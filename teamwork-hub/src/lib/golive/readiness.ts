import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { auditEvents, formTemplateVersions, formTemplates, importBatches, integrations, messageTemplates, organizations, users, zpReconciliations } from "@/db/schema";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { autopaySettingsOf } from "@/lib/billing/autopay-settings";
import { growthFromSettings } from "@/lib/growth/settings";
import { POLICY_FIELDS, policyFromSettings } from "@/lib/membership-policy";
import { policiesOf } from "@/lib/settings";
import { fmtDate } from "@/lib/time";
import { catalogStatus } from "@/lib/zenplanner/catalog";
import { explain, hubFromSnapshot } from "@/lib/zenplanner/reconcile";
import { ATTESTATIONS, liveAttestations, type Attestation } from "./attestations";
import { OPEN_DECISIONS, decisionKey } from "./decisions";
import { BUILT_IN_WORDINGS } from "./wordings";

/**
 * Go-live readiness: "what is left before real families use this?"
 *
 * Every status here is computed from the environment and the database on each call. Nothing is
 * stored as "done". A person's tick (an attestation) is used only for the few things the hub
 * cannot observe, and those items always carry the person's name and date.
 */
export type GoLiveStatus = "done" | "attention" | "not_started" | "na";
export const STATUS_LABEL: Record<GoLiveStatus, string> = { done: "Done", attention: "Needs attention", not_started: "Not started", na: "Not applicable" };

export type SectionId = "hosting" | "payments" | "messages" | "legal" | "catalog" | "migration" | "people" | "decisions";

export const SECTIONS: { id: SectionId; title: string; intro: string }[] = [
  { id: "hosting", title: "Hosting and safety", intro: "The server, its secrets, backups and who can sign in." },
  { id: "payments", title: "Payments", intro: "Taking money through Stripe. Only blocks going live if the hub bills families." },
  { id: "messages", title: "Messages", intro: "Email and text messages leaving the hub." },
  { id: "legal", title: "Legal text", intro: "Every piece of wording a family agrees to. Sample wording must be replaced with the gym's own." },
  { id: "catalog", title: "Catalog and policy", intro: "Plans, prices, policy numbers, locations and the class schedule." },
  { id: "migration", title: "Data migration", intro: "What has come across from Zen Planner and what is still billed there." },
  { id: "people", title: "People", intro: "Who has a login and whose records are incomplete." },
  { id: "decisions", title: "Open decisions", intro: "Questions with a working default. Confirm each one as it is, or change the setting." },
];

/**
 * What "blocks going live" means. Fixed and documented (docs/modules/go-live.md):
 * - every item in Hosting and safety (this includes the rehearsed backup),
 * - every item in Legal text except the message template count,
 * - every item in Payments, but only when the hub bills families itself (see `billingHere`).
 * Everything else is worth doing but does not block. An item blocks only while it is neither
 * Done nor Not applicable.
 */
export const BLOCKING_SECTIONS: SectionId[] = ["hosting", "legal", "payments"];
export const NON_BLOCKING_ITEM_IDS = ["legal.message_templates"];

export type GoLiveItem = {
  id: string;
  section: SectionId;
  title: string;
  status: GoLiveStatus;
  /** One plain sentence on why it matters. */
  why: string;
  /** What the hub found. */
  detail: string;
  /** Names or lines behind the detail (kept short). */
  list?: string[];
  href: string | null;
  hrefLabel: string | null;
  /** Counts toward "N block going live" right now. */
  blocking: boolean;
  /** A person's statement stands behind this status. */
  attested?: { byName: string; on: string; note: string | null } | null;
  /** This item can be ticked by a person: the attestation key and what they are stating. */
  attestKey?: string;
  attestStatement?: string;
  attestNeedsNote?: boolean;
  /** Decisions: label for the confirm button. */
  attestAction?: string;
};

export type GoLiveSection = { id: SectionId; title: string; intro: string; items: GoLiveItem[]; done: number; total: number };
export type GoLiveReport = {
  sections: GoLiveSection[];
  /** Items that are not "Not applicable". */
  total: number;
  done: number;
  blocking: number;
  blockingItems: GoLiveItem[];
  billingHere: boolean;
  /** "7 of 31 done; 4 block going live" */
  summary: string;
};

/** The parts of the server environment the page reads. Values of secrets never leave this module. */
export type GoLiveEnv = {
  appMode: string;
  sessionSecret: string;
  appUrl: string;
  storageBackend: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  stripePublishableKey: string;
  emailProvider: string;
  emailApiKey: string;
  emailFrom: string;
  smsProvider: string;
  smsAccountSid: string;
  smsAuthToken: string;
  smsFrom: string;
  ghlApiKey: string;
  ghlLocationId: string;
  deliveryEnabled: boolean;
  deliveryTestRecipients: string;
  sentryDsn: string;
};

export const EXAMPLE_SESSION_SECRET = "replace-with-64-random-hex-characters-generated-locally-xxxxxxx";

export function goLiveEnv(e: Record<string, string | undefined> = process.env): GoLiveEnv {
  const s = (k: string) => e[k] ?? "";
  return {
    appMode: s("APP_MODE") || "demo",
    sessionSecret: s("SESSION_SECRET"),
    appUrl: s("APP_URL") || "http://localhost:3000",
    storageBackend: (s("STORAGE_BACKEND") || "local").toLowerCase(),
    stripeSecretKey: s("STRIPE_SECRET_KEY"),
    stripeWebhookSecret: s("STRIPE_WEBHOOK_SECRET"),
    stripePublishableKey: s("STRIPE_PUBLISHABLE_KEY"),
    emailProvider: s("EMAIL_PROVIDER") || "none",
    emailApiKey: s("EMAIL_API_KEY"),
    emailFrom: s("EMAIL_FROM"),
    smsProvider: s("SMS_PROVIDER") || "none",
    smsAccountSid: s("SMS_ACCOUNT_SID"),
    smsAuthToken: s("SMS_AUTH_TOKEN"),
    smsFrom: s("SMS_FROM"),
    ghlApiKey: s("GHL_API_KEY"),
    ghlLocationId: s("GHL_LOCATION_ID"),
    deliveryEnabled: s("DELIVERY_ENABLED") === "true",
    deliveryTestRecipients: s("DELIVERY_TEST_RECIPIENTS"),
    sentryDsn: s("SENTRY_DSN"),
  };
}

export type StripeMode = "none" | "test" | "live" | "unknown";
export function stripeKeyMode(key: string): StripeMode {
  if (!key) return "none";
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  return "unknown";
}

export function sessionSecretProblem(secret: string): string | null {
  if (!secret) return "No session secret is set.";
  if (secret === EXAMPLE_SESSION_SECRET || /replace-with|changeme|example/i.test(secret)) return "The session secret is still the example value from .env.example.";
  if (secret.length < 32) return "The session secret is shorter than 32 characters.";
  if (new Set(secret).size < 8) return "The session secret is a repeated pattern, not a random value.";
  return null;
}

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);
const plural = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;
const cap = (xs: string[], max = 12) => (xs.length > max ? [...xs.slice(0, max), `and ${xs.length - max} more`] : xs);

const ZP_IMPORTS: { id: string; title: string; schemas: string[] }[] = [
  { id: "people", title: "Zen Planner people imported", schemas: ["zenplanner.person_grid", "zenplanner.members"] },
  { id: "memberships", title: "Zen Planner memberships imported", schemas: ["zenplanner.membership_grid", "zenplanner.memberships"] },
  { id: "bills", title: "Zen Planner bills imported", schemas: ["zenplanner.bill_grid"] },
  { id: "attendance", title: "Zen Planner attendance imported", schemas: ["zenplanner.attendance_grid", "zenplanner.attendance"] },
];

export async function goLiveReadiness(tx: Tx, v: Viewer, opts: { env?: GoLiveEnv; now?: Date } = {}): Promise<GoLiveReport> {
  assertCan(v, "settings.manage");
  const env = opts.env ?? goLiveEnv();
  const now = opts.now ?? new Date();
  const orgId = v.orgId;
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
  const settings = org?.settings ?? {};
  const tz = org?.timezone;
  const day = (d: Date | string | null | undefined) => (d ? fmtDate(d, tz) : "");
  const one = async (q: ReturnType<typeof sql>): Promise<Row> => ((await tx.execute(q)).rows[0] ?? {}) as Row;
  const many = async (q: ReturnType<typeof sql>): Promise<Row[]> => (await tx.execute(q)).rows as Row[];
  const att = await liveAttestations(tx, orgId);
  const attested = (a: Attestation | undefined) => (a ? { byName: a.byName, on: a.on, note: a.note } : null);
  const attestLine = (a: Attestation) => `Attested by ${a.byName} on ${day(a.on)}${a.note ? `: ${a.note}` : "."}`;
  const attestProps = (key: string) => {
    const d = ATTESTATIONS.find((x) => x.key === key)!;
    return { attestKey: key, attestStatement: d.statement, attestNeedsNote: d.needsNote };
  };
  const demo = env.appMode === "demo";

  const items: Omit<GoLiveItem, "blocking">[] = [];
  const add = (i: Omit<GoLiveItem, "blocking">) => items.push(i);

  // ------------------------------------------------------------------ Hosting and safety
  add({
    id: "hosting.app_mode",
    section: "hosting",
    title: "The server is not in demo mode",
    status: demo ? "attention" : "done",
    why: "Demo mode allows the sample logins and the role switcher, which must never exist next to real families.",
    detail: demo ? "APP_MODE is demo." : `APP_MODE is ${env.appMode}.`,
    href: null,
    hrefLabel: "Set APP_MODE in the hosting environment (docs/DEPLOY.md)",
  });
  const secretProblem = sessionSecretProblem(env.sessionSecret);
  add({
    id: "hosting.session_secret",
    section: "hosting",
    title: "The session secret is a private random value",
    status: secretProblem ? "attention" : "done",
    why: "Anyone who knows this value can forge sign-in tokens and one-time links.",
    detail: secretProblem ?? "A session secret of 32 or more characters is set and it is not the example value.",
    href: null,
    hrefLabel: "Set SESSION_SECRET in the hosting environment (docs/DEPLOY.md)",
  });
  const https = /^https:\/\//i.test(env.appUrl);
  add({
    id: "hosting.app_url_https",
    section: "hosting",
    title: "The site address uses https",
    status: https ? "done" : "attention",
    why: "Without https, passwords and health details travel unencrypted and sign-in cookies are not protected.",
    detail: `APP_URL is ${env.appUrl}.`,
    href: null,
    hrefLabel: "Set APP_URL in the hosting environment (docs/DEPLOY.md)",
  });

  const [storageRow] = await tx
    .select()
    .from(integrations)
    .where(and(eq(integrations.orgId, orgId), eq(integrations.provider, "object_storage")));
  const probe = (storageRow?.checkpoint?.probe ?? null) as { ok?: boolean; at?: string; backend?: string; error?: string } | null;
  const probeGood = !!probe?.ok && probe.backend === env.storageBackend;
  add({
    id: "hosting.object_storage",
    section: "hosting",
    title: "Files are kept in a private storage bucket that works",
    status: env.storageBackend !== "s3" ? "attention" : probeGood ? "done" : "attention",
    why: "Signed forms, imports and exports are files; on a server's own disk they disappear when the server is replaced.",
    detail:
      env.storageBackend !== "s3"
        ? "Files are stored on the server's local disk (STORAGE_BACKEND=local)."
        : probeGood
          ? `A test file was written, read back and removed on ${day(probe!.at!)}.`
          : probe && probe.ok === false
            ? `The last storage check failed on ${day(probe.at ?? null)}. Run it again after fixing the bucket settings.`
            : "A bucket is configured but no storage check has been run yet. Use the Check storage button.",
    href: "/settings/integrations",
    hrefLabel: "Integrations, File storage",
  });

  const backups = att.get("backups_rehearsed");
  add({
    id: "hosting.backups_rehearsed",
    section: "hosting",
    title: "A database restore has been rehearsed",
    status: backups ? "done" : "not_started",
    why: "A backup that has never been restored is not known to work.",
    detail: backups ? attestLine(backups) : "Nobody has recorded a restore rehearsal. The hub cannot see the hosting provider's backups, so a person has to say when it was done.",
    href: null,
    hrefLabel: "Steps are in docs/BACKUP-RESTORE.md",
    attested: attested(backups),
    ...attestProps("backups_rehearsed"),
  });

  const worker = await one(sql`
    select max(finished_at) as last from jobs
    where org_id = ${orgId} and status = 'done' and locked_by like 'worker-%' and finished_at > ${new Date(now.getTime() - 24 * 3600_000)}`);
  const lastAny = await one(sql`select max(finished_at) as last from jobs where org_id = ${orgId} and status = 'done' and locked_by like 'worker-%'`);
  add({
    id: "hosting.worker_recent",
    section: "hosting",
    title: "The background worker has run in the last 24 hours",
    status: worker.last ? "done" : lastAny.last ? "attention" : "not_started",
    why: "Renewal bills, autopay, reminders and the nightly jobs only happen when the worker is running.",
    detail: worker.last
      ? `The worker last finished a job on ${day(worker.last as string)}.`
      : lastAny.last
        ? `The worker last finished a job on ${day(lastAny.last as string)}, more than 24 hours ago.`
        : "No job has been finished by a worker for this organization. Jobs started with Run now do not count.",
    href: "/settings/jobs",
    hrefLabel: "Settings, Scheduled jobs",
  });

  const sentrySkip = att.get("error_reporting_skipped");
  add({
    id: "hosting.error_reporting",
    section: "hosting",
    title: "Error reporting is set up, or skipped on purpose",
    status: env.sentryDsn ? "done" : sentrySkip ? "done" : "not_started",
    why: "Without it, a failed payment job or a crashing page is only noticed when a family complains.",
    detail: env.sentryDsn ? "SENTRY_DSN is set." : sentrySkip ? `Skipped on purpose. ${attestLine(sentrySkip)}` : "SENTRY_DSN is not set and nobody has recorded a decision to go without it.",
    href: null,
    hrefLabel: "Set SENTRY_DSN in the hosting environment (docs/DEPLOY.md)",
    attested: env.sentryDsn ? null : attested(sentrySkip),
    ...(env.sentryDsn ? {} : attestProps("error_reporting_skipped")),
  });

  const pol = policiesOf(settings);
  add({
    id: "hosting.staff_mfa_policy",
    section: "hosting",
    title: "Two-step verification is required for staff",
    status: pol.requireStaffMfa ? "done" : "attention",
    why: "Staff logins open health details and billing for every family; a password alone is not enough.",
    detail: pol.requireStaffMfa ? "The policy is on." : "The policy is off: staff can sign in with only a password.",
    href: "/settings",
    hrefLabel: "Settings, Security & payments policy",
  });
  const admins = await tx
    .select({ name: users.displayName, mfa: users.mfaEnabled })
    .from(users)
    .where(and(eq(users.orgId, orgId), inArray(users.role, ["owner", "admin"]), sql`${users.disabledAt} is null`));
  const noMfa = admins.filter((a) => !a.mfa).map((a) => a.name);
  add({
    id: "hosting.admin_mfa_enrolled",
    section: "hosting",
    title: "Every owner and admin has two-step verification",
    status: admins.length === 0 ? "not_started" : noMfa.length ? "attention" : "done",
    why: "Owner and admin logins can change settings, refund money and export everything.",
    detail: admins.length === 0 ? "There is no owner or admin login." : noMfa.length ? `${noMfa.length} of ${admins.length} have not set it up.` : `All ${admins.length} have it.`,
    list: cap(noMfa),
    href: "/settings/users",
    hrefLabel: "Settings, Users & roles",
  });

  const demoRows = await one(sql`
    select
      (select count(*) from users where org_id = ${orgId} and is_demo)::int as users,
      (select count(*) from people where org_id = ${orgId} and is_demo)::int as people,
      (select count(*) from products where org_id = ${orgId} and is_demo)::int as products`);
  const demoTotal = n(demoRows.users) + n(demoRows.people) + n(demoRows.products) + (org?.isDemo ? 1 : 0);
  const demoDetail = `${plural(n(demoRows.users), "demo login")}, ${plural(n(demoRows.people), "demo person", "demo people")} and ${plural(n(demoRows.products), "demo product")}${org?.isDemo ? "; the organization itself is marked as a demo" : ""}.`;
  add({
    id: "hosting.demo_data_absent",
    section: "hosting",
    title: "No demo logins or demo data",
    status: demo ? "na" : demoTotal ? "attention" : "done",
    why: "Demo logins share one published password, and demo families would be mixed into real reports and bills.",
    detail: demo ? `Checked once the server leaves demo mode. Right now there are ${demoDetail}` : demoTotal ? `Found ${demoDetail}` : "None found.",
    href: demoTotal && !demo ? "/settings/users" : null,
    hrefLabel: demoTotal && !demo ? "Settings, Users & roles" : "Production starts from an empty database (docs/DEPLOY.md)",
  });

  // ------------------------------------------------------------------ Payments
  const mode = stripeKeyMode(env.stripeSecretKey);
  const keysPresent = [env.stripeSecretKey, env.stripeWebhookSecret, env.stripePublishableKey].filter(Boolean).length;
  const hubBilled = await one(sql`
    select count(*)::int as c from memberships
    where org_id = ${orgId} and status in ('pending','trialing','active','past_due','on_hold') and billing_provider in ('stripe','paypal','manual')`);
  const billingHere = keysPresent > 0 || n(hubBilled.c) > 0;

  const orgCount = n((await one(sql`select count(*)::int as c from organizations`)).c);
  // webhook_events has no org column. An event counts for this org when its metadata names the org,
  // or when this is the only organization in the database (the deployed, single-tenant case).
  const orgEvent = sql`(payload #>> '{data,object,metadata,org_id}' = ${orgId} or (${orgCount} = 1 and payload #>> '{data,object,metadata,org_id}' is null))`;
  const hook = await one(sql`
    select max(received_at) as last, count(*)::int as c from webhook_events
    where provider = 'stripe' and signature_verified and status <> 'rejected' and ${orgEvent}`);
  const testMethod = await one(sql`
    select max(pm.setup_succeeded_at) as last from payment_methods pm
    join payer_accounts pa on pa.id = pm.payer_account_id
    where pa.org_id = ${orgId} and pm.provider = 'stripe' and pm.setup_succeeded_at is not null
      and exists (select 1 from webhook_events we where we.provider = 'stripe' and we.signature_verified and we.status = 'processed'
        and we.type = 'setup_intent.succeeded' and we.payload ->> 'livemode' = 'false'
        and we.payload #>> '{data,object,payment_method}' = pm.provider_method_id)`);
  const testCharge = await one(sql`
    select max(t.occurred_at) as last from transactions t
    where t.org_id = ${orgId} and t.provider = 'stripe' and t.kind = 'charge' and t.status = 'settled' and t.verification = 'provider_verified'
      and exists (select 1 from webhook_events we where we.provider = 'stripe' and we.signature_verified and we.status = 'processed'
        and we.payload ->> 'livemode' = 'false'
        and (we.payload #>> '{data,object,id}' = t.provider_txn_id or we.payload #>> '{data,object,payment_intent}' = t.provider_txn_id))`);
  const testProven = !!testMethod.last && !!testCharge.last;

  const liveOutsideProd = mode === "live" && env.appMode !== "production";
  add({
    id: "payments.stripe_keys",
    section: "payments",
    title: "Stripe keys are set",
    status: keysPresent === 0 ? "not_started" : keysPresent < 3 || mode === "unknown" || liveOutsideProd || (mode === "live" && !testProven) ? "attention" : "done",
    why: "Without the three Stripe values the hub cannot take a card, save a payment method or hear back from Stripe.",
    detail:
      keysPresent === 0
        ? "No Stripe keys are set."
        : keysPresent < 3
          ? `${keysPresent} of 3 Stripe values are set (secret key, webhook secret, publishable key).`
          : mode === "unknown"
            ? "The Stripe secret key does not look like a test or live key."
            : liveOutsideProd
              ? "Live keys are set but the server is not in production mode, so the hub refuses to use them."
              : mode === "live" && !testProven
                ? "Mode: LIVE. Live keys are not accepted as ready until a test-mode saved payment method and a test-mode charge have been recorded (the next two items)."
                : mode === "live"
                  ? "Mode: LIVE. Real cards are charged."
                  : "Mode: TEST. No real money moves.",
    href: "/settings/integrations",
    hrefLabel: "Integrations, Stripe",
  });
  add({
    id: "payments.webhook_verified",
    section: "payments",
    title: "Stripe has reached the hub with a verified event",
    status: hook.last ? "done" : "not_started",
    why: "A payment only counts when Stripe tells the hub so; if that message cannot arrive, paid bills stay open.",
    detail: hook.last ? `${plural(n(hook.c), "verified event")} received, the latest on ${day(hook.last as string)}.` : "No event with a valid signature has arrived at the webhook address.",
    href: "/billing/providers",
    hrefLabel: "Billing, Providers",
  });
  add({
    id: "payments.test_saved_method",
    section: "payments",
    title: "A payment method was saved in test mode",
    status: testMethod.last ? "done" : "not_started",
    why: "Saving a card or bank account end to end with Stripe's test numbers proves autopay can work before a real family tries it.",
    detail: testMethod.last ? `Stripe confirmed a test-mode saved method on ${day(testMethod.last as string)}.` : "No saved method confirmed by a test-mode Stripe event is on record.",
    href: "/billing/payment-methods",
    hrefLabel: "Billing, Payment methods",
  });
  add({
    id: "payments.test_charge",
    section: "payments",
    title: "A charge succeeded in test mode",
    status: testCharge.last ? "done" : "not_started",
    why: "One test payment that settles and closes its bill proves the whole path before real money is involved.",
    detail: testCharge.last ? `Stripe confirmed a test-mode charge on ${day(testCharge.last as string)}.` : "No settled charge confirmed by a test-mode Stripe event is on record.",
    href: "/billing",
    hrefLabel: "Memberships & Billing",
  });
  const autopay = autopaySettingsOf(settings);
  const fees = await one(sql`select count(*)::int as c from transactions where org_id = ${orgId} and fee_reported_at is not null`);
  const estimates = [autopay.feeEstimates.card, autopay.feeEstimates.us_bank_account].filter(Boolean).length;
  add({
    id: "payments.fee_data",
    section: "payments",
    title: "Processing fees are known",
    status: n(fees.c) > 0 ? "done" : estimates === 2 ? "done" : estimates === 1 ? "attention" : "not_started",
    why: "The scoreboard and the card versus bank comparison are wrong without what each payment costs.",
    detail:
      n(fees.c) > 0
        ? `Stripe has reported the fee on ${plural(n(fees.c), "payment")}.`
        : estimates === 2
          ? "Fee estimates for card and bank are entered. Real fees replace them as payments settle."
          : estimates === 1
            ? "A fee estimate is entered for only one of card and bank."
            : "No fee has been reported by Stripe and no estimates are entered.",
    href: "/settings/payments",
    hrefLabel: "Settings, Payments & agreements",
  });
  const retryOpen = autopay.unconfirmed.filter((k) => k === "cardRetryDays" || k === "achRetryWaitDays");
  const who = async (action: string) => {
    const [a] = await tx
      .select({ at: auditEvents.createdAt, name: users.displayName })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, action)))
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);
    return a ? `Saved by ${a.name ?? "a staff member"} on ${day(a.at)}.` : "";
  };
  add({
    id: "payments.retry_schedule",
    section: "payments",
    title: "The retry schedule for failed payments is confirmed",
    status: retryOpen.length ? "attention" : "done",
    why: "It decides how many times, and how soon, a family's card is charged again after a decline.",
    detail: retryOpen.length
      ? `Still on the sample default: card retries on day ${autopay.cardRetryDays.join(", ")}, bank retry after ${autopay.achRetryWaitDays} days. Saving the payments settings confirms it.`
      : `Card retries on day ${autopay.cardRetryDays.join(", ") || "none"}, bank retry after ${autopay.achRetryWaitDays} days. ${await who("billing.autopay_settings")}`,
    href: "/settings/payments",
    hrefLabel: "Settings, Payments & agreements",
  });

  // ------------------------------------------------------------------ Messages
  const emailOn = env.emailProvider !== "none";
  const emailMissing = [!env.emailFrom ? "EMAIL_FROM" : null, env.emailProvider !== "smtp" && !env.emailApiKey ? "EMAIL_API_KEY" : null, !env.deliveryEnabled ? "DELIVERY_ENABLED=true" : null].filter(Boolean) as string[];
  add({
    id: "messages.email_provider",
    section: "messages",
    title: "An email provider is connected",
    status: !emailOn ? "not_started" : emailMissing.length ? "attention" : "done",
    why: "Invites, password resets, receipts and form reminders reach families by email.",
    detail: !emailOn
      ? "No email provider is set. Messages stay inside the app and invite links have to be copied by hand."
      : emailMissing.length
        ? `Provider ${env.emailProvider} is chosen but these are missing: ${emailMissing.join(", ")}.`
        : `Provider ${env.emailProvider}, sending from ${env.emailFrom}.${env.deliveryTestRecipients ? " All email is still redirected to the test recipients." : ""}`,
    href: "/settings/integrations",
    hrefLabel: "Integrations, Email delivery",
  });
  const sent = await one(sql`
    select
      max(md.updated_at) filter (where md.status = 'delivered') as delivered,
      max(md.updated_at) filter (where md.status = 'sent' and md.provider_message_id is not null) as sent
    from message_deliveries md
    join messages m on m.id = md.message_id
    join threads t on t.id = m.thread_id
    where t.org_id = ${orgId} and md.channel = 'email'`);
  const smtp = env.emailProvider === "smtp";
  add({
    id: "messages.email_test_send",
    section: "messages",
    title: "A real email has been sent and confirmed",
    status: sent.delivered || (smtp && sent.sent) ? "done" : sent.sent ? "attention" : "not_started",
    why: "Keys can look right and still fail; one delivered email proves the sender address and domain are accepted.",
    detail: sent.delivered
      ? `The provider confirmed delivery of an email on ${day(sent.delivered as string)}.`
      : sent.sent
        ? smtp
          ? `The mail server accepted an email on ${day(sent.sent as string)}. SMTP gives no further confirmation.`
          : `The provider accepted an email on ${day(sent.sent as string)} but no delivery confirmation has come back. Check the provider's webhook.`
        : "No email accepted by a provider is on record. Send yourself a message once the provider is connected.",
    href: "/messages",
    hrefLabel: "Messages",
  });
  const smsNotUsed = att.get("sms_not_used");
  const smsOn = env.smsProvider !== "none";
  const smsMissing =
    env.smsProvider === "gohighlevel"
      ? ([!env.ghlApiKey ? "GHL_API_KEY" : null, !env.ghlLocationId ? "GHL_LOCATION_ID" : null, !env.deliveryEnabled ? "DELIVERY_ENABLED=true" : null].filter(Boolean) as string[])
      : ([!env.smsAccountSid ? "SMS_ACCOUNT_SID" : null, !env.smsAuthToken ? "SMS_AUTH_TOKEN" : null, !env.smsFrom ? "SMS_FROM" : null, !env.deliveryEnabled ? "DELIVERY_ENABLED=true" : null].filter(Boolean) as string[]);
  add({
    id: "messages.sms_provider",
    section: "messages",
    title: "Text messages are connected, or marked as not used",
    status: smsOn ? (smsMissing.length ? "attention" : "done") : smsNotUsed ? "na" : "not_started",
    why: "Families who chose texts get nothing if no text provider is connected.",
    detail: smsOn
      ? smsMissing.length
        ? `Provider ${env.smsProvider} is chosen but these are missing: ${smsMissing.join(", ")}.`
        : `Provider ${env.smsProvider} is connected.`
      : smsNotUsed
        ? `Not used. ${attestLine(smsNotUsed)}`
        : "No text message provider is set and nobody has said texts are not used.",
    href: "/settings/integrations",
    hrefLabel: "Integrations, SMS delivery",
    attested: smsOn ? null : attested(smsNotUsed),
    ...(smsOn ? {} : attestProps("sms_not_used")),
  });
  const reviewed = att.get("messaging_rules_reviewed");
  add({
    id: "messages.rules_reviewed",
    section: "messages",
    title: "Quiet hours and consent settings have been reviewed",
    status: reviewed ? "done" : "not_started",
    why: "These decide when a family can be contacted and whether a child is ever messaged directly.",
    detail: `Quiet hours ${pol.quietHours.start} to ${pol.quietHours.end}; minors ${pol.minorsReceiveDirectMessages ? "may" : "do not"} receive messages directly. ${reviewed ? attestLine(reviewed) : "Nobody has recorded a review."}`,
    href: "/settings",
    hrefLabel: "Settings, Messaging policy",
    attested: attested(reviewed),
    ...attestProps("messaging_rules_reviewed"),
  });

  // ------------------------------------------------------------------ Legal text
  const tpls = await tx
    .select({ id: formTemplates.id, name: formTemplates.name, kind: formTemplates.kind })
    .from(formTemplates)
    .where(and(eq(formTemplates.orgId, orgId), eq(formTemplates.active, true)));
  const versions = tpls.length
    ? await tx
        .select({ templateId: formTemplateVersions.templateId, version: formTemplateVersions.version, isSampleText: formTemplateVersions.isSampleText })
        .from(formTemplateVersions)
        .where(and(inArray(formTemplateVersions.templateId, tpls.map((t) => t.id)), eq(formTemplateVersions.status, "published")))
        .orderBy(desc(formTemplateVersions.version))
    : [];
  const currentOf = (id: string) => versions.find((x) => x.templateId === id) ?? null;
  const formWhy = (kind: string) =>
    kind === "waiver"
      ? "A waiver signed on placeholder wording may not protect the gym."
      : kind === "membership_agreement" || kind === "agreement"
        ? "Families are bound by, and billed under, the wording they sign."
        : "Families sign this wording; it should be the gym's own.";
  if (!tpls.some((t) => t.kind === "waiver")) {
    add({ id: "legal.waiver_missing", section: "legal", title: "Liability waiver", status: "not_started", why: formWhy("waiver"), detail: "There is no waiver template.", href: "/documents", hrefLabel: "Documents, Form templates" });
  }
  if (!tpls.some((t) => t.kind === "membership_agreement")) {
    add({ id: "legal.agreement_missing", section: "legal", title: "Membership agreement", status: "not_started", why: formWhy("membership_agreement"), detail: "There is no membership agreement template.", href: "/settings/payments", hrefLabel: "Settings, Payments & agreements" });
  }
  for (const t of tpls) {
    const cur = currentOf(t.id);
    add({
      id: `legal.form.${t.id}`,
      section: "legal",
      title: `Form: ${t.name}`,
      status: !cur ? "not_started" : cur.isSampleText ? "attention" : "done",
      why: formWhy(t.kind),
      detail: !cur ? "No version is published yet." : cur.isSampleText ? `Published version ${cur.version} is still marked as sample text.` : `Published version ${cur.version} is marked as approved wording.`,
      href: `/documents/templates/${t.id}`,
      hrefLabel: "Open the template",
    });
  }
  for (const w of BUILT_IN_WORDINGS) {
    add({
      id: `legal.wording.${w.id}`,
      section: "legal",
      title: w.label,
      status: w.isSample ? "attention" : "done",
      why: w.shownAt,
      detail: w.isSample
        ? `Version ${w.version} is sample wording built into the app. Send the approved wording to whoever maintains the hub; it is replaced in ${w.source}.`
        : `Version ${w.version} is approved wording.`,
      href: w.href,
      hrefLabel: "Where it is used",
    });
  }
  const growth = growthFromSettings(settings);
  add({
    id: "legal.referral_wording",
    section: "legal",
    title: "Referral page wording",
    status: !growth.referral.enabled ? "na" : growth.referral.howItWorksIsSample ? "attention" : growth.referral.howItWorks ? "done" : "attention",
    why: "It is a promise of a reward to families, in the gym's name.",
    detail: !growth.referral.enabled
      ? "The referral program is off."
      : growth.referral.howItWorksIsSample
        ? "The \"How it works\" text is still marked as sample wording."
        : growth.referral.howItWorks
          ? "The \"How it works\" text is the gym's own."
          : "The referral program is on but has no \"How it works\" text.",
    href: "/settings/growth",
    hrefLabel: "Settings, Growth",
  });
  const sampleMsgs = await tx
    .select({ name: messageTemplates.name })
    .from(messageTemplates)
    .where(and(eq(messageTemplates.orgId, orgId), eq(messageTemplates.isSample, true)));
  const msgTotal = n((await one(sql`select count(*)::int as c from message_templates where org_id = ${orgId}`)).c);
  add({
    id: "legal.message_templates",
    section: "legal",
    title: "Message templates",
    status: msgTotal === 0 ? "na" : sampleMsgs.length ? "attention" : "done",
    why: "Automatic messages go out in the gym's voice; sample templates cannot be broadcast until they are rewritten.",
    detail: msgTotal === 0 ? "There are no message templates." : sampleMsgs.length ? `${sampleMsgs.length} of ${msgTotal} are still marked as sample text.` : `All ${msgTotal} are the gym's own wording.`,
    list: cap(sampleMsgs.map((m) => m.name)),
    href: "/messages/templates",
    hrefLabel: "Messages, Templates",
  });

  // ------------------------------------------------------------------ Catalog and policy
  const cat = await catalogStatus(tx, orgId);
  const loaded = cat.filter((c) => c.productId);
  const drafts = loaded.filter((c) => c.active === false);
  const otherPlans = n((await one(sql`select count(*)::int as c from products where org_id = ${orgId} and kind = 'recurring_membership' and active and not is_demo`)).c);
  add({
    id: "catalog.plans_loaded",
    section: "catalog",
    title: "The plan catalog is loaded",
    status: loaded.length ? "done" : otherPlans ? "done" : "not_started",
    why: "Members can only be signed up or cut over onto plans that exist here.",
    detail: loaded.length ? `${loaded.length} of ${cat.length} Teamwork catalog plans exist.` : otherPlans ? `${plural(otherPlans, "membership plan")} entered by hand; the Teamwork catalog was not loaded.` : "No membership plans have been loaded or entered.",
    href: "/imports/zenplanner",
    hrefLabel: "Imports, Zen Planner",
  });
  add({
    id: "catalog.plan_drafts",
    section: "catalog",
    title: "Catalog plans are confirmed",
    status: !loaded.length ? "na" : drafts.length ? "attention" : "done",
    why: "A draft plan carries a price nobody has confirmed, and it cannot be sold until it is switched on.",
    detail: !loaded.length ? "No catalog plans are loaded." : drafts.length ? `${drafts.length} of ${loaded.length} are still unconfirmed drafts.` : `All ${loaded.length} are switched on.`,
    list: cap(drafts.map((d) => d.plan.name)),
    href: "/billing/products",
    hrefLabel: "Billing, Products & prices",
  });
  const mp = policyFromSettings(settings);
  const labelOf = (k: string) => POLICY_FIELDS.find((f) => f.key === k)?.label ?? k;
  const otherUnconfirmed = mp.unconfirmed.filter((k) => k !== "familyDiscountPercent");
  add({
    id: "catalog.family_discount",
    section: "catalog",
    title: "The family discount percent is confirmed",
    status: mp.unconfirmed.includes("familyDiscountPercent") ? "attention" : "done",
    why: "It comes off every bill for a family with two or more athletes, and the sources disagree on 10% or 15%.",
    detail: mp.unconfirmed.includes("familyDiscountPercent") ? `${mp.familyDiscountPercent}% is in use and still flagged "Needs confirmation".` : `${mp.familyDiscountPercent}%. ${await who("org.membership_policy_update")}`.trim(),
    href: "/settings",
    hrefLabel: "Settings, Membership policy",
  });
  add({
    id: "catalog.policy_confirmed",
    section: "catalog",
    title: "Membership policy settings are confirmed",
    status: otherUnconfirmed.length ? "attention" : "done",
    why: "Holds, cancellations and first-month pricing follow these numbers for every member.",
    detail: otherUnconfirmed.length ? `${plural(otherUnconfirmed.length, "setting")} still flagged "Needs confirmation".` : "No other setting is flagged \"Needs confirmation\".",
    list: cap(otherUnconfirmed.map(labelOf)),
    href: "/settings",
    hrefLabel: "Settings, Membership policy",
  });
  const sched = await one(sql`
    select
      (select count(*) from locations where org_id = ${orgId} and active)::int as locations,
      (select count(*) from class_series where org_id = ${orgId} and active)::int as series,
      (select count(*) from schedule_sessions where org_id = ${orgId} and starts_at > ${now} and status = 'scheduled')::int as upcoming`);
  add({
    id: "catalog.locations",
    section: "catalog",
    title: "Locations exist",
    status: n(sched.locations) ? "done" : "not_started",
    why: "Sessions, kiosks and plans are tied to a location.",
    detail: n(sched.locations) ? `${plural(n(sched.locations), "active location")}.` : "No location has been entered.",
    href: "/schedule/settings",
    hrefLabel: "Schedule, Settings",
  });
  add({
    id: "catalog.class_schedule",
    section: "catalog",
    title: "A class schedule exists",
    status: n(sched.upcoming) ? "done" : n(sched.series) ? "attention" : "not_started",
    why: "Families cannot reserve a class that is not on the calendar.",
    detail: n(sched.upcoming) ? `${plural(n(sched.series), "repeating class", "repeating classes")} and ${plural(n(sched.upcoming), "upcoming session")}.` : n(sched.series) ? `${plural(n(sched.series), "repeating class", "repeating classes")} but no upcoming session.` : "No repeating class or upcoming session.",
    href: "/schedule",
    hrefLabel: "Calendar",
  });

  // ------------------------------------------------------------------ Data migration
  const batches = await tx
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.orgId, orgId), eq(importBatches.source, "zenplanner")))
    .orderBy(desc(importBatches.createdAt));
  for (const z of ZP_IMPORTS) {
    const mine = batches.filter((b) => z.schemas.includes(b.entityType));
    const committed = mine.filter((b) => b.status === "committed");
    const open = mine.filter((b) => ["uploaded", "mapped", "validated"].includes(b.status));
    const rows = (b: (typeof batches)[number]) => b.stats.rows ?? b.stats.fileRows ?? 0;
    add({
      id: `migration.import_${z.id}`,
      section: "migration",
      title: z.title,
      status: committed.length ? "done" : open.length ? "attention" : "not_started",
      why:
        z.id === "people"
          ? "Families and athletes have to exist here before anything else can be attached to them."
          : z.id === "memberships"
            ? "The hub needs each member's plan and price to know who is billed where."
            : z.id === "bills"
              ? "Past bills explain what each family has been paying and who is behind."
              : "Attendance history keeps streaks, retention signals and the audit honest from day one.",
      detail: committed.length
        ? `${plural(committed.length, "import")} committed.`
        : open.length
          ? `${plural(open.length, "upload")} waiting to be reviewed and committed.`
          : "Not imported.",
      list: cap(
        committed.map((b) => `${day(b.committedAt)}: ${rows(b)} rows${b.stats.committed_create != null ? `, ${b.stats.committed_create} created, ${b.stats.committed_link ?? 0} linked, ${b.stats.committed_update ?? 0} updated` : ""}`),
        6,
      ),
      href: "/imports",
      hrefLabel: "Imports",
    });
  }
  const review = await one(sql`
    select count(*)::int as c from import_rows r join import_batches b on b.id = r.batch_id
    where b.org_id = ${orgId} and b.source = 'zenplanner' and b.status in ('uploaded','mapped','validated') and r.status = 'needs_review'`);
  add({
    id: "migration.identity_reviews",
    section: "migration",
    title: "Identity reviews are finished",
    status: !batches.length ? "na" : n(review.c) ? "attention" : "done",
    why: "The hub never merges two people on its own; a person has to say whether an imported row is someone already here.",
    detail: !batches.length ? "Nothing has been imported from Zen Planner." : n(review.c) ? `${plural(n(review.c), "imported row")} waiting for a decision.` : "No imported row is waiting for a decision.",
    href: "/imports",
    hrefLabel: "Imports",
  });
  const [recon] = await tx.select().from(zpReconciliations).where(eq(zpReconciliations.orgId, orgId)).orderBy(desc(zpReconciliations.createdAt)).limit(1);
  const lines = recon ? explain(recon.entered, hubFromSnapshot(recon.hub)).filter((l) => l.entered != null) : [];
  const diffs = lines.filter((l) => l.difference != null && l.difference !== 0);
  const fmtNum = (l: (typeof lines)[number], x: number) => (l.money ? `$${(x / 100).toFixed(2)}` : String(x));
  add({
    id: "migration.reconciliation",
    section: "migration",
    title: "The hub's counts match Zen Planner's",
    status: !recon ? (batches.length ? "not_started" : "na") : diffs.length ? "attention" : "done",
    why: "If the totals differ, some members or bills did not come across, or came across twice.",
    detail: !recon
      ? batches.length
        ? "No reconciliation has been saved. Type Zen Planner's dashboard numbers into the reconciliation form."
        : "Nothing has been imported from Zen Planner."
      : diffs.length
        ? `The reconciliation as of ${day(recon.asOf)} has ${plural(diffs.length, "difference")}.`
        : `The reconciliation as of ${day(recon.asOf)} matched on all ${lines.length} numbers entered.`,
    list: diffs.map((l) => `${l.label}: Zen Planner ${fmtNum(l, l.entered!)}, hub ${fmtNum(l, l.hub ?? 0)}`),
    href: "/imports/zenplanner",
    hrefLabel: "Imports, Zen Planner",
  });
  const cut = await one(sql`
    select
      count(*) filter (where m.billing_provider = 'external_zenplanner' and m.status in ('active','trialing','past_due','on_hold'))::int as external,
      count(*) filter (where m.billing_provider <> 'external_zenplanner' and m.source = 'zenplanner' and m.status in ('active','trialing','past_due','on_hold'))::int as cut_over
    from memberships m where m.org_id = ${orgId}`);
  add({
    id: "migration.cutover_progress",
    section: "migration",
    title: "Members are cut over from Zen Planner billing",
    status: n(cut.external) + n(cut.cut_over) === 0 ? "na" : n(cut.external) ? "attention" : "done",
    why: "A member still billed in Zen Planner pays there; cancelling Zen Planner before they are cut over stops their payments.",
    detail: n(cut.external) + n(cut.cut_over) === 0 ? "No imported Zen Planner memberships." : `${plural(n(cut.external), "membership")} still billed in Zen Planner; ${n(cut.cut_over)} cut over to the hub.`,
    href: "/billing/signup",
    hrefLabel: "Billing, Sign-ups and conversions",
  });
  const gaps = await many(sql`
    select p.first_name || ' ' || p.last_name as name,
      (m.agreement_state <> 'signed') as no_agreement,
      not exists (select 1 from payment_methods pm where pm.payer_account_id = m.payer_account_id and pm.status = 'active' and pm.removed_at is null) as no_method
    from memberships m join athletes a on a.id = m.athlete_id join people p on p.id = a.person_id
    where m.org_id = ${orgId} and m.source = 'zenplanner' and m.billing_provider <> 'external_zenplanner' and m.status in ('active','trialing','past_due','on_hold')
    order by p.last_name, p.first_name`);
  const gapRows = gaps.filter((g) => g.no_agreement || g.no_method);
  add({
    id: "migration.cutover_gaps",
    section: "migration",
    title: "Cut-over members have an agreement and a saved payment method",
    status: n(cut.cut_over) === 0 ? "na" : gapRows.length ? "attention" : "done",
    why: "Without a signed agreement there is nothing to bill under, and without a saved method every bill has to be chased.",
    detail: n(cut.cut_over) === 0 ? "No member has been cut over yet." : gapRows.length ? `${gapRows.length} of ${n(cut.cut_over)} cut-over memberships are missing one or both.` : `All ${n(cut.cut_over)} have both.`,
    list: cap(gapRows.map((g) => `${g.name}: ${[g.no_agreement ? "no signed agreement" : null, g.no_method ? "no saved payment method" : null].filter(Boolean).join(", ")}`)),
    href: "/billing/signup",
    hrefLabel: "Billing, Sign-ups and conversions",
  });

  // ------------------------------------------------------------------ People
  const staff = await one(sql`
    select
      count(*) filter (where password_hash is not null and disabled_at is null)::int as active,
      count(*) filter (where password_hash is null and disabled_at is null and invite_token_hash is not null and invite_expires_at > ${now})::int as invited,
      count(*) filter (where password_hash is null and disabled_at is null and (invite_token_hash is null or invite_expires_at <= ${now}))::int as stale
    from users where org_id = ${orgId} and role in ('owner','admin','operations','coach') and not is_demo`);
  const staffTotal = n(staff.active) + n(staff.invited) + n(staff.stale);
  add({
    id: "people.staff_accounts",
    section: "people",
    title: "Staff have their own logins",
    status: staffTotal === 0 ? "not_started" : n(staff.invited) + n(staff.stale) ? "attention" : "done",
    why: "Shared logins make the audit log useless and cannot be switched off for one person.",
    detail: staffTotal === 0 ? "No staff login exists apart from demo logins." : `${n(staff.active)} active, ${n(staff.invited)} invited and not yet accepted, ${n(staff.stale)} with an expired or missing invite.`,
    href: "/settings/users",
    hrefLabel: "Settings, Users & roles",
  });
  const guardians = await one(sql`
    select count(*)::int as total, count(*) filter (where u.id is not null)::int as with_login,
      count(*) filter (where u.id is not null and u.password_hash is not null)::int as active
    from (select distinct guardian_person_id from guardianships where org_id = ${orgId} and status = 'active') g
    left join users u on u.person_id = g.guardian_person_id and u.disabled_at is null`);
  add({
    id: "people.guardians_invited",
    section: "people",
    title: "Parents and guardians are invited",
    status: n(guardians.total) === 0 ? "not_started" : n(guardians.with_login) < n(guardians.total) ? "attention" : "done",
    why: "A parent without a login cannot book, sign forms, see bills or save a payment method.",
    detail: n(guardians.total) === 0 ? "No guardian is linked to an athlete yet." : `${n(guardians.with_login)} of ${n(guardians.total)} guardians have a login (${n(guardians.active)} have signed in or set a password); ${n(guardians.total) - n(guardians.with_login)} are not invited.`,
    href: "/people",
    hrefLabel: "People",
  });
  const minors = await many(sql`
    select p.first_name || ' ' || p.last_name as name from athletes a join people p on p.id = a.person_id
    where a.org_id = ${orgId} and a.active and p.date_of_birth is not null and p.date_of_birth > (${now}::date - interval '18 years')
      and not exists (select 1 from guardianships g where g.athlete_id = a.id and g.status = 'active')
    order by p.last_name, p.first_name`);
  const athleteCount = n((await one(sql`select count(*)::int as c from athletes where org_id = ${orgId} and active`)).c);
  add({
    id: "people.minors_without_guardian",
    section: "people",
    title: "Every athlete under 18 has a guardian on file",
    status: athleteCount === 0 ? "na" : minors.length ? "attention" : "done",
    why: "A child cannot sign a waiver or be billed; without a guardian link nobody can do it for them.",
    detail: athleteCount === 0 ? "There are no active athletes." : minors.length ? `${plural(minors.length, "athlete")} under 18 with no guardian linked.` : "None found among athletes with a birthday on file.",
    list: cap(minors.map((m) => String(m.name))),
    href: "/people",
    hrefLabel: "People",
  });
  const noDob = await many(sql`
    select p.first_name || ' ' || p.last_name as name from athletes a join people p on p.id = a.person_id
    where a.org_id = ${orgId} and a.active and p.date_of_birth is null order by p.last_name, p.first_name`);
  add({
    id: "people.athletes_without_birthday",
    section: "people",
    title: "Every athlete has a birthday on file",
    status: athleteCount === 0 ? "na" : noDob.length ? "attention" : "done",
    why: "Age decides who must have a guardian, what a child may see and where they rank; with no birthday the hub cannot tell.",
    detail: athleteCount === 0 ? "There are no active athletes." : noDob.length ? `${noDob.length} of ${athleteCount} active athletes have no birthday.` : `All ${athleteCount} active athletes have one.`,
    list: cap(noDob.map((m) => String(m.name))),
    href: "/people",
    hrefLabel: "People",
  });

  // ------------------------------------------------------------------ Open decisions
  for (const d of OPEN_DECISIONS) {
    const value = d.value(settings);
    const a = att.get(decisionKey(d.id));
    const changed = !!a && a.valueSnapshot !== value;
    add({
      id: `decisions.${d.id}`,
      section: "decisions",
      title: d.question,
      status: !a ? "not_started" : changed ? "attention" : "done",
      why: d.currentBehaviour,
      detail: `Current setting: ${value}. ${!a ? "Not confirmed yet." : changed ? `It was "${a.valueSnapshot}" when ${a.byName} confirmed it on ${day(a.on)}; confirm the new value.` : `Confirmed as is by ${a.byName} on ${day(a.on)}${a.note ? `: ${a.note}` : "."}`}`,
      href: d.changeHref,
      hrefLabel: d.changeLabel,
      attested: a && !changed ? { byName: a.byName, on: a.on, note: a.note } : null,
      attestKey: decisionKey(d.id),
      attestStatement: `I confirm this as it is: ${value}.`,
      attestNeedsNote: false,
      attestAction: "Confirm as is",
    });
  }

  // ------------------------------------------------------------------ Totals
  const final: GoLiveItem[] = items.map((i) => ({
    ...i,
    blocking:
      i.status !== "done" &&
      i.status !== "na" &&
      BLOCKING_SECTIONS.includes(i.section) &&
      !NON_BLOCKING_ITEM_IDS.includes(i.id) &&
      (i.section !== "payments" || billingHere),
  }));
  const sections: GoLiveSection[] = SECTIONS.map((s) => {
    const its = final.filter((i) => i.section === s.id);
    const counted = its.filter((i) => i.status !== "na");
    return { ...s, items: its, done: counted.filter((i) => i.status === "done").length, total: counted.length };
  });
  const counted = final.filter((i) => i.status !== "na");
  const done = counted.filter((i) => i.status === "done").length;
  const blockingItems = final.filter((i) => i.blocking);
  return {
    sections,
    total: counted.length,
    done,
    blocking: blockingItems.length,
    blockingItems,
    billingHere,
    summary: `${done} of ${counted.length} done; ${blockingItems.length} ${blockingItems.length === 1 ? "blocks" : "block"} going live`,
  };
}

/** Just the number for the Today card. Null when the viewer may not see the page. */
export async function goLiveBlockingCount(tx: Tx, v: Viewer): Promise<number | null> {
  if (v.role !== "owner" && v.role !== "admin") return null;
  return (await goLiveReadiness(tx, v)).blocking;
}
