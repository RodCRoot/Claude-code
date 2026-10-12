import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { commPreferences, messageDeliveries, messages, threads, type DeliveryStatus } from "@/db/schema";
import { enqueue } from "@/lib/jobs";
import { sendEmail } from "./channels/email";
import { sendSms } from "./channels/sms";
import { parseQuietHours, quietHoursEnd } from "./quiet-hours";
import { messagingSettings, type MessagingSettings, type Recipient } from "./routing";

export type Channel = "in_app" | "email" | "sms";
export const CHANNELS: Channel[] = ["in_app", "email", "sms"];

type Pref = typeof commPreferences.$inferSelect;

export type ChannelPlan = {
  channel: Channel;
  status: Extract<DeliveryStatus, "queued" | "suppressed" | "delivered">;
  address: string | null;
  reason: string | null;
  /** When an external delivery will be attempted (deferred past quiet hours). */
  runAt: Date | null;
};

export async function preferencesFor(tx: Tx, orgId: string, personIds: string[]): Promise<Pref[]> {
  if (!personIds.length) return [];
  return tx.select().from(commPreferences).where(and(eq(commPreferences.orgId, orgId), inArray(commPreferences.personId, personIds)));
}

/**
 * Consent + quiet-hours decision for one recipient on one channel. Pure (no I/O).
 * - in_app: always delivered (visible in the portal; requires no consent).
 * - email: suppressed when opted out or no address; "unknown" consent is allowed (transactional).
 * - sms: requires explicit opt-in (TCPA-style); suppressed otherwise.
 * - quiet hours: per-person window (on that channel's preference row) overrides the org window;
 *   delivery is deferred to the end of the window in the facility timezone.
 */
export function planChannel(
  recipient: Pick<Recipient, "personId" | "email" | "phone">,
  channel: Channel,
  prefs: Pref[],
  settings: Pick<MessagingSettings, "quietHours" | "timezone">,
  now: Date,
  delayMinutes = 0,
): ChannelPlan {
  if (channel === "in_app") return { channel, status: "delivered", address: null, reason: null, runAt: null };
  const pref = prefs.find((p) => p.personId === recipient.personId && p.channel === channel);
  const consent = pref?.consent ?? "unknown";
  const address = channel === "email" ? recipient.email : recipient.phone;
  if (consent === "opted_out") return { channel, status: "suppressed", address, reason: `Recipient opted out of ${channel}${pref?.consentSource ? ` (${pref.consentSource})` : ""}`, runAt: null };
  if (channel === "sms" && consent !== "opted_in") return { channel, status: "suppressed", address, reason: "SMS requires explicit opt-in; none on file", runAt: null };
  if (!address) return { channel, status: "suppressed", address: null, reason: `No ${channel === "email" ? "email address" : "mobile number"} on file`, runAt: null };

  const personal = pref?.quietStartLocal && pref?.quietEndLocal ? parseQuietHours({ start: pref.quietStartLocal, end: pref.quietEndLocal }) : null;
  const window = personal ?? settings.quietHours;
  const earliest = new Date(now.getTime() + delayMinutes * 60_000);
  const deferTo = quietHoursEnd(earliest, window, settings.timezone);
  const runAt = deferTo ?? earliest;
  return {
    channel,
    status: "queued",
    address,
    reason: deferTo ? `Deferred until quiet hours end (${personal ? "personal" : "facility"} window ${window!.start}–${window!.end})` : null,
    runAt,
  };
}

/**
 * Create one message_deliveries row per recipient per channel and enqueue
 * `messaging.deliver` jobs for external channels (inside the caller's transaction).
 */
export async function createDeliveries(
  tx: Tx,
  input: { orgId: string; messageId: string; recipients: Recipient[]; channels: Channel[]; now?: Date; delayMinutes?: number; settings?: MessagingSettings },
) {
  const now = input.now ?? new Date();
  const settings = input.settings ?? (await messagingSettings(tx, input.orgId));
  const channels: Channel[] = ["in_app", ...input.channels.filter((c) => c !== "in_app")];
  const seen = new Set<string>();
  const recipients = input.recipients.filter((r) => (seen.has(r.personId) ? false : (seen.add(r.personId), true)));
  const prefs = await preferencesFor(tx, input.orgId, recipients.map((r) => r.personId));
  const created: (typeof messageDeliveries.$inferSelect)[] = [];
  for (const r of recipients) {
    for (const ch of channels) {
      const plan = planChannel(r, ch, prefs, settings, now, input.delayMinutes ?? 0);
      const [d] = await tx
        .insert(messageDeliveries)
        .values({ messageId: input.messageId, recipientPersonId: r.personId, channel: ch, address: plan.address, status: plan.status, statusReason: plan.reason })
        .returning();
      created.push(d);
      if (plan.status === "queued") {
        await enqueue(tx, {
          type: "messaging.deliver",
          orgId: input.orgId,
          payload: { deliveryId: d.id },
          dedupeKey: `messaging.deliver:${d.id}`,
          runAt: plan.runAt ?? now,
        });
      }
    }
  }
  return created;
}

/**
 * Job handler body for `messaging.deliver`: performs exactly one delivery attempt.
 * Idempotent: anything not in `queued` is left alone. Consent is re-checked at send time.
 */
export async function deliverOne(
  tx: Tx,
  deliveryId: string,
  job: { attempts: number; maxAttempts: number },
): Promise<{ status?: string; skipped?: string; error?: string }> {
  const [row] = await tx
    .select({ d: messageDeliveries, m: messages, orgId: threads.orgId, subject: threads.subject })
    .from(messageDeliveries)
    .innerJoin(messages, eq(messages.id, messageDeliveries.messageId))
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(eq(messageDeliveries.id, deliveryId))
    .for("update", { of: messageDeliveries });
  if (!row) return { skipped: "missing" };
  const { d, m } = row;
  if (d.status !== "queued") return { skipped: d.status };
  if (m.isInternalNote) {
    await tx.update(messageDeliveries).set({ status: "suppressed", statusReason: "Internal notes are never delivered", updatedAt: new Date() }).where(eq(messageDeliveries.id, d.id));
    return { status: "suppressed" };
  }
  if (d.channel === "in_app") {
    await tx.update(messageDeliveries).set({ status: "delivered", updatedAt: new Date() }).where(eq(messageDeliveries.id, d.id));
    return { status: "delivered" };
  }
  if (d.recipientPersonId) {
    const [pref] = await tx
      .select()
      .from(commPreferences)
      .where(and(eq(commPreferences.personId, d.recipientPersonId), eq(commPreferences.channel, d.channel)));
    const consent = pref?.consent ?? "unknown";
    if (consent === "opted_out" || (d.channel === "sms" && consent !== "opted_in")) {
      await tx
        .update(messageDeliveries)
        .set({ status: "suppressed", statusReason: consent === "opted_out" ? `Recipient opted out of ${d.channel} before sending` : "SMS opt-in no longer on file", updatedAt: new Date() })
        .where(eq(messageDeliveries.id, d.id));
      return { status: "suppressed" };
    }
  }
  if (!d.address) {
    await tx.update(messageDeliveries).set({ status: "suppressed", statusReason: "No address", updatedAt: new Date() }).where(eq(messageDeliveries.id, d.id));
    return { status: "suppressed" };
  }
  const out = { to: d.address, subject: row.subject, body: m.body };
  const res = d.channel === "email" ? await sendEmail(out) : await sendSms(out);
  const attempts = d.attempts + 1;
  if (res.status === "failed") {
    const final = job.attempts >= job.maxAttempts;
    await tx
      .update(messageDeliveries)
      .set({ attempts, status: final ? "failed" : "queued", statusReason: `${final ? "Gave up" : "Will retry"}: ${res.reason ?? "provider error"}`, updatedAt: new Date() })
      .where(eq(messageDeliveries.id, d.id));
    // The caller throws AFTER committing this update so the job queue applies
    // exponential backoff (and dead-letters after maxAttempts).
    return { status: "failed", error: res.reason ?? "delivery failed" };
  }
  await tx
    .update(messageDeliveries)
    .set({
      attempts,
      status: res.status,
      // Keep the original address on the row; record the redirect target in the reason.
      statusReason: res.status === "test_redirected" ? `Redirected to test recipient ${res.address}` : (res.reason ?? null),
      providerMessageId: res.providerMessageId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(messageDeliveries.id, d.id));
  return { status: res.status };
}
