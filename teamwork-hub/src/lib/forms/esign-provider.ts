/**
 * Adapter boundary for an established e-signature provider (e.g. Dropbox Sign,
 * DocuSign). Not configured in this build: the internal typed-name pilot is used
 * instead and the UI says so. A real adapter must:
 *  - create an envelope from the exact published version (content hash attached),
 *  - map Teamwork signer roles to provider recipients (guardian, second guardian,
 *    adult athlete, athlete assent, staff witness),
 *  - verify provider webhooks (signature header) before changing any state,
 *  - store the provider's completed PDF + audit certificate via saveObject
 *    (kind "completed_form_pdf", access "subject_and_guardians"),
 *  - never mark a request completed without the provider's completion event.
 */
import type { SignerRole } from "./fields";

export type EsignRecipient = { role: SignerRole; personId: string; name: string; email: string | null };

export type EsignEnvelopeRequest = {
  formRequestId: string;
  templateContentHash: string;
  title: string;
  bodyMarkdown: string;
  fieldValues: Record<string, unknown>;
  recipients: EsignRecipient[];
};

export type EsignEnvelope = { providerEnvelopeId: string; signingUrls: Record<string, string> };

export type EsignWebhookEvent =
  | { kind: "signed"; providerEnvelopeId: string; role: SignerRole; signedAt: Date }
  | { kind: "completed"; providerEnvelopeId: string; completedPdf: Uint8Array; auditTrailPdf?: Uint8Array }
  | { kind: "declined" | "voided"; providerEnvelopeId: string; reason?: string };

export interface EsignProvider {
  readonly id: string;
  readonly displayName: string;
  isConfigured(): boolean;
  /** Env vars the adapter needs (names only, never values). */
  requiredEnv(): string[];
  createEnvelope(req: EsignEnvelopeRequest): Promise<EsignEnvelope>;
  /** Verifies the webhook signature and parses it; throws on an invalid signature. */
  parseWebhook(headers: Headers, rawBody: string): Promise<EsignWebhookEvent>;
}

export class ProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`${provider} is not configured. Nothing was sent.`);
    this.name = "ProviderNotConfiguredError";
  }
}

/** Placeholder adapter: honest "not configured" — never fakes success. */
export class UnconfiguredEsignProvider implements EsignProvider {
  readonly id = "external_esign";
  readonly displayName = "External e-signature provider (Dropbox Sign / DocuSign)";
  isConfigured() {
    return false;
  }
  requiredEnv() {
    return ["ESIGN_PROVIDER", "ESIGN_API_KEY", "ESIGN_WEBHOOK_SECRET"];
  }
  async createEnvelope(): Promise<EsignEnvelope> {
    throw new ProviderNotConfiguredError(this.displayName);
  }
  async parseWebhook(): Promise<EsignWebhookEvent> {
    throw new ProviderNotConfiguredError(this.displayName);
  }
}

export function esignProvider(): EsignProvider {
  return new UnconfiguredEsignProvider();
}
