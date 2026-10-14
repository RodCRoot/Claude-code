import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { integrations, organizations, type IntegrationProvider } from "@/db/schema";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { integrationEnvVars } from "@/lib/env";

export type OrgPolicies = {
  requireStaffMfa: boolean;
  pendingBankPaymentPolicy: "grant_on_settlement" | "grant_on_pending";
  bookingWindowDays: number;
  familyBookingCutoffMinutes: number;
  quietHours: { start: string; end: string };
  minorsReceiveDirectMessages: boolean;
  /** Kiosk shows no name list; athletes check in with their PIN only. */
  kioskPinOnly: boolean;
};

export const DEFAULT_POLICIES: OrgPolicies = {
  requireStaffMfa: false,
  pendingBankPaymentPolicy: "grant_on_settlement",
  bookingWindowDays: 21,
  familyBookingCutoffMinutes: 60,
  quietHours: { start: "21:00", end: "07:30" },
  minorsReceiveDirectMessages: false,
  kioskPinOnly: false,
};

export function policiesOf(settings: Record<string, unknown> | null | undefined): OrgPolicies {
  return { ...DEFAULT_POLICIES, ...(settings ?? {}) } as OrgPolicies;
}

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM");

export const orgSettingsSchema = z.object({
  displayName: z.string().trim().min(1).max(60),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #1d4ed8"),
  logoUrl: z.string().trim().url().optional().or(z.literal("").transform(() => undefined)),
  requireStaffMfa: z.coerce.boolean(),
  pendingBankPaymentPolicy: z.enum(["grant_on_settlement", "grant_on_pending"]),
  bookingWindowDays: z.coerce.number().int().min(1).max(365),
  familyBookingCutoffMinutes: z.coerce.number().int().min(0).max(10080),
  quietStart: hhmm,
  quietEnd: hhmm,
  minorsReceiveDirectMessages: z.coerce.boolean(),
  kioskPinOnly: z.coerce.boolean().default(false),
  headline: z.string().trim().max(160).optional(),
  intro: z.string().trim().max(800).optional(),
});

export async function updateOrgSettings(tx: Tx, v: Viewer, raw: unknown) {
  assertCan(v, "settings.manage");
  const input = orgSettingsSchema.parse(raw);
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, v.orgId));
  const settings = {
    ...org.settings,
    requireStaffMfa: input.requireStaffMfa,
    pendingBankPaymentPolicy: input.pendingBankPaymentPolicy,
    bookingWindowDays: input.bookingWindowDays,
    familyBookingCutoffMinutes: input.familyBookingCutoffMinutes,
    quietHours: { start: input.quietStart, end: input.quietEnd },
    minorsReceiveDirectMessages: input.minorsReceiveDirectMessages,
    kioskPinOnly: input.kioskPinOnly,
    ...(input.headline || input.intro
      ? { publicSite: { ...((org.settings?.publicSite as object) ?? {}), ...(input.headline ? { headline: input.headline } : {}), ...(input.intro ? { intro: input.intro } : {}), draft: false } }
      : {}),
  };
  const branding = { ...org.branding, displayName: input.displayName, primaryColor: input.primaryColor, ...(input.logoUrl ? { logoUrl: input.logoUrl } : {}) };
  await tx.update(organizations).set({ settings, branding }).where(eq(organizations.id, v.orgId));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "org.settings_update", "organization", v.orgId, {
    before: { settings: org.settings, branding: org.branding },
    after: { settings, branding },
  });
}

/**
 * Re-check integration configuration. This only verifies that required server
 * environment variables are present — it NEVER marks a provider as verified or
 * connected. Sandbox verification happens in each provider module.
 */
export async function recheckIntegrations(tx: Tx, v: Viewer) {
  assertCan(v, "integrations.manage");
  const rows = await tx.select().from(integrations).where(eq(integrations.orgId, v.orgId));
  for (const r of rows) {
    const envVars = r.provider === "sms" && process.env.SMS_PROVIDER === "gohighlevel" ? ["SMS_PROVIDER", "GHL_API_KEY", "GHL_LOCATION_ID", "DELIVERY_ENABLED"] : (integrationEnvVars[r.provider] ?? []);
    const vars = envVars.map((s) => s.split(" ")[0]).filter((n) => !["PAYPAL_ENV", "HAWKIN_API_BASE", "HAWKIN_ORG_SCOPE", "DELIVERY_TEST_RECIPIENTS", "STRIPE_PUBLISHABLE_KEY", "GHL_FROM_NUMBER"].includes(n));
    if (!vars.length) continue;
    let present = vars.every((n) => !!process.env[n] && process.env[n] !== "none");
    if ((r.provider === "email" || r.provider === "sms") && process.env.DELIVERY_ENABLED !== "true") present = false;
    const keepVerified = ["verified_sandbox", "connected"].includes(r.status) && present;
    await tx
      .update(integrations)
      .set({
        status: keepVerified ? r.status : present ? "configured_unverified" : "not_configured",
        lastCheckedAt: new Date(),
        lastError: present ? null : `Missing: ${vars.filter((n) => !process.env[n] || process.env[n] === "none").join(", ") || "DELIVERY_ENABLED=true"}`,
      })
      .where(eq(integrations.id, r.id));
  }
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "integrations.recheck", "organization", v.orgId);
}

export const INTEGRATION_INFO: Record<IntegrationProvider, { label: string; purpose: string; module: string }> = {
  stripe: { label: "Stripe", purpose: "Card & US bank payments, recurring memberships (Stripe Billing), refunds, disputes, payouts.", module: "/billing/providers" },
  paypal: { label: "PayPal", purpose: "PayPal Checkout and PayPal Subscriptions.", module: "/billing/providers" },
  venmo: { label: "Venmo (via PayPal)", purpose: "Merchant Venmo through PayPal Checkout. Eligibility depends on merchant, currency, and buyer device.", module: "/billing/providers" },
  hawkin: { label: "Hawkin Dynamics", purpose: "Force-plate test history and incremental sync via the Hawkin Cloud API.", module: "/imports" },
  google_calendar: { label: "Google Calendar", purpose: "Push Teamwork sessions to coach calendars; import free/busy.", module: "/schedule/settings" },
  email: { label: "Email delivery", purpose: "Transactional and automation email. Off unless DELIVERY_ENABLED=true.", module: "/messages" },
  sms: { label: "SMS delivery", purpose: "Text messages with consent, opt-out, and quiet hours. Off unless DELIVERY_ENABLED=true.", module: "/messages" },
  teambuildr: { label: "TeamBuildr", purpose: "Historical import from TeamBuildr exports (no live API assumed).", module: "/imports" },
  zenplanner: { label: "Zen Planner", purpose: "Historical import from Zen Planner exports (no live API assumed).", module: "/imports" },
  gohighlevel: {
    label: "GoHighLevel (LeadConnector)",
    purpose: "Send SMS through Teamwork's existing GHL sub-account (SMS_PROVIDER=gohighlevel), look up GHL contacts by phone/email, and import GHL contact exports in the Import Center. Contacts are filed under the athlete's name; phone/email belong to the parent.",
    module: "/imports",
  },
  object_storage: { label: "File storage", purpose: "Original imports, completed form PDFs, raw force-plate signals, exports.", module: "/settings/integrations" },
};
