import { paypalAdapter, venmoAdapter } from "./paypal";
import {
  ProviderUnsupportedError,
  type PaymentProviderAdapter,
  type ProviderCapabilities,
  type ProviderName,
} from "./provider";
import { stripeAdapter } from "./stripe";

/** Offline payments (cash, check, personal Venmo/Zelle). Always staff_attested; never provider_verified. */
export const manualAdapter: PaymentProviderAdapter = {
  name: "manual",
  isConfigured: () => true,
  missingEnv: () => [],
  capabilities: manualCapabilities,
  async createCheckout() {
    throw new ProviderUnsupportedError("Manual payments are recorded by staff with a reference, not via checkout.");
  },
  async verifyWebhook() {
    return { ok: false, reason: "manual payments have no webhooks" };
  },
  parseEvent() {
    throw new ProviderUnsupportedError("manual payments have no webhooks");
  },
  async refund() {
    throw new ProviderUnsupportedError("Manual refunds are recorded by staff (staff_attested).");
  },
};

const ADAPTERS: Record<ProviderName, PaymentProviderAdapter> = {
  stripe: stripeAdapter,
  paypal: paypalAdapter,
  venmo: venmoAdapter,
  manual: manualAdapter,
};

export function getProvider(name: ProviderName): PaymentProviderAdapter {
  const a = ADAPTERS[name];
  if (!a) throw new ProviderUnsupportedError(`Unknown provider ${name}`);
  return a;
}

export const ONLINE_PROVIDERS: ProviderName[] = ["stripe", "paypal", "venmo"];

export function providerStatuses() {
  return (Object.keys(ADAPTERS) as ProviderName[]).map((name) => {
    const a = ADAPTERS[name];
    return { name, configured: a.isConfigured(), missing: a.missingEnv(), capabilities: a.capabilities() };
  });
}

export function manualCapabilities(): ProviderCapabilities {
  return {
    label: "Manual / offline (cash, check, personal Venmo, Zelle)",
    oneTimeCheckout: { supported: false, evidence: "not_supported", note: "Recorded by staff with a required reference." },
    recurring: { supported: false, evidence: "not_supported", note: "Renewal invoices can be paid manually each period." },
    savedMethods: { supported: false, evidence: "not_supported", note: "—" },
    bankDebit: { supported: false, evidence: "not_supported", note: "—" },
    refundsViaApi: { supported: false, evidence: "not_supported", note: "Manual refunds are recorded as staff_attested." },
    disputesViaWebhook: { supported: false, evidence: "not_supported", note: "—" },
    webhookVerification: { supported: false, evidence: "not_supported", note: "A screenshot, QR code or personal Venmo link is never provider-verified." },
    currencies: ["USD"],
    regions: "In person",
    envVars: [],
  };
}

export { ProviderNotConfiguredError, ProviderUnsupportedError } from "./provider";
export type { ProviderName } from "./provider";
