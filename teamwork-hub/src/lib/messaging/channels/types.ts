import type { DeliveryStatus } from "@/db/schema";

export type OutboundMessage = { to: string; subject: string; body: string; replyTo?: string | null };

/** What an adapter reports. Adapters never claim success they did not get from a provider. */
export type ChannelResult = {
  status: Extract<DeliveryStatus, "sent" | "test_redirected" | "not_configured" | "failed">;
  /** The address actually used (the test recipient when redirected). */
  address: string | null;
  reason?: string;
  providerMessageId?: string;
  /** True when a later retry might succeed (network/5xx). */
  retryable?: boolean;
};

/** Low-level provider call. Throws on transport errors; returns the provider's message id. */
export type Transport = (msg: OutboundMessage) => Promise<{ providerMessageId: string }>;

export type ChannelConfig = { configured: boolean; missing: string[]; provider: string | null };

/**
 * Delivery env is read from process.env at call time (not the cached env()) so an
 * operator change takes effect on the next worker start and tests can toggle it.
 */
export function deliveryEnabled(): boolean {
  return process.env.DELIVERY_ENABLED === "true";
}

export function testRecipients(): string[] {
  return (process.env.DELIVERY_TEST_RECIPIENTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
