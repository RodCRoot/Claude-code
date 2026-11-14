import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { inboundMessages, messageDeliveries, messages, organizations, people, threadParticipants, threads } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { publicOrg } from "@/lib/crm/public";
import { suggestSafely } from "@/lib/member-ops/requests";
import { normalizeEmail, phoneKey } from "./addresses";
import { DomainError } from "./errors";
import { threadIdFromToken } from "./reply-token";
import { familyParticipantEligible, postInboundMessage, threadAccess, type Thread } from "./threads";

export type InboundInput = {
  channel: "email" | "sms";
  provider: string;
  providerMessageId: string;
  from: string;
  to: string | null;
  subject: string | null;
  body: string;
  /** Reply token from `reply+<token>@…` (email only). */
  token: string | null;
  /** The org this webhook endpoint serves (see `webhookOrg`). */
  orgId: string;
};

export type PersonMatch = { id: string; orgId: string; name: string };

/**
 * The organization a messaging webhook serves: `?org=<slug>` when given (unknown slug → none),
 * else the first organization (single-tenant deployment). Matching never crosses orgs.
 */
export async function webhookOrg(tx: Tx, slug: string | null | undefined): Promise<{ id: string } | null> {
  if (slug) {
    const [o] = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
    return o ?? null;
  }
  const o = await publicOrg(tx, null);
  return o ? { id: o.id } : null;
}

/** Active (non-archived) people in one org with this email / phone number. */
export async function peopleByAddress(tx: Tx, orgId: string, channel: "email" | "sms", address: string): Promise<PersonMatch[]> {
  let cond;
  if (channel === "email") {
    const e = normalizeEmail(address);
    if (!e) return [];
    cond = sql`lower(trim(${people.email})) = ${e}`;
  } else {
    const k = phoneKey(address);
    if (!k) return [];
    cond = sql`right(regexp_replace(coalesce(${people.phone}, ''), '[^0-9]', '', 'g'), 10) = ${k}`;
  }
  const rows = await tx
    .select({ id: people.id, orgId: people.orgId, first: people.firstName, last: people.lastName })
    .from(people)
    .where(and(eq(people.orgId, orgId), cond, sql`${people.archivedAt} is null`));
  return rows.map((r) => ({ id: r.id, orgId: r.orgId, name: `${r.first} ${r.last}` }));
}

/** Removes quoted history ("On … wrote:", "> …", signature delimiter) from an email reply. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^On .+wrote:\s*$/i.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (line.trim() === "--") break;
    out.push(line);
  }
  return out.join("\n").trim();
}

async function eligibleThread(tx: Tx, t: Thread | undefined, candidates: PersonMatch[]): Promise<{ thread: Thread; personId: string } | null> {
  if (!t) return null;
  for (const c of candidates.filter((x) => x.orgId === t.orgId)) {
    if (await familyParticipantEligible(tx, t, c.id)) return { thread: t, personId: c.id };
  }
  return null;
}

/**
 * Threads an inbound reply into the matching conversation when the sender is a known, still
 * eligible participant (reply token for email, else the latest conversation we actually sent to
 * that address on that channel). Anything else lands in the staff-only unmatched queue.
 * Idempotent per (provider, provider message id).
 */
export async function receiveInbound(tx: Tx, input: InboundInput, now = new Date()) {
  const [dupe] = await tx
    .select()
    .from(inboundMessages)
    .where(and(eq(inboundMessages.provider, input.provider), eq(inboundMessages.providerMessageId, input.providerMessageId)));
  if (dupe) return { status: "duplicate" as const, inboundId: dupe.id };

  const body = (input.channel === "email" ? stripQuoted(input.body) : input.body.trim()) || input.body.trim() || "(empty message)";
  const candidates = await peopleByAddress(tx, input.orgId, input.channel, input.from);
  let match: { thread: Thread; personId: string } | null = null;
  let reason: string | null = null;

  const tokenThreadId = input.channel === "email" ? threadIdFromToken(input.token) : null;
  if (tokenThreadId) {
    const [t] = await tx.select().from(threads).where(eq(threads.id, tokenThreadId));
    match = await eligibleThread(tx, t, candidates);
    if (!match) reason = candidates.length ? "Reply address points to a conversation this sender is no longer part of" : "Sender's address does not match anyone in that conversation";
  }
  if (!match && !tokenThreadId && candidates.length) {
    // Latest conversation where we (provider-accepted) sent this person something on this channel.
    const rows = await tx
      .select({ threadId: messages.threadId, personId: messageDeliveries.recipientPersonId })
      .from(messageDeliveries)
      .innerJoin(messages, eq(messages.id, messageDeliveries.messageId))
      .where(
        and(
          eq(messageDeliveries.channel, input.channel),
          inArray(messageDeliveries.status, ["sent", "test_redirected", "delivered"]),
          inArray(
            messageDeliveries.recipientPersonId,
            candidates.map((c) => c.id),
          ),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(5);
    for (const r of rows) {
      const [t] = await tx.select().from(threads).where(eq(threads.id, r.threadId));
      match = await eligibleThread(
        tx,
        t,
        candidates.filter((c) => c.id === r.personId),
      );
      if (match) break;
    }
    if (!match) reason = rows.length ? "Sender is no longer allowed in the conversation they last received" : `Known contact, but no ${input.channel === "sms" ? "text" : "email"} conversation was sent to this address`;
  }
  if (!match && !reason) reason = "Sender not recognized";

  const subject = input.subject?.slice(0, 300) ?? null;
  if (match) {
    const m = await postInboundMessage(tx, { thread: match.thread, senderPersonId: match.personId, body, channel: input.channel, now });
    const [row] = await tx
      .insert(inboundMessages)
      .values({
        orgId: match.thread.orgId,
        channel: input.channel,
        provider: input.provider,
        providerMessageId: input.providerMessageId,
        fromAddress: input.from.slice(0, 300),
        toAddress: input.to?.slice(0, 300) ?? null,
        subject,
        body,
        status: "threaded",
        matchedPersonId: match.personId,
        threadId: match.thread.id,
        messageId: m.id,
        receivedAt: now,
      })
      .returning();
    await suggestSafely(tx, {
      orgId: match.thread.orgId,
      body: [subject, body].filter(Boolean).join("\n"),
      sentAt: now,
      channel: input.channel === "sms" ? "sms" : "email_direct",
      senderPersonId: match.personId,
      threadId: match.thread.id,
      messageId: m.id,
      inboundId: row.id,
    });
    return { status: "threaded" as const, inboundId: row.id, threadId: match.thread.id, messageId: m.id };
  }

  const sameOrg = candidates;
  const [row] = await tx
    .insert(inboundMessages)
    .values({
      orgId: input.orgId,
      channel: input.channel,
      provider: input.provider,
      providerMessageId: input.providerMessageId,
      fromAddress: input.from.slice(0, 300),
      toAddress: input.to?.slice(0, 300) ?? null,
      subject,
      body: body.slice(0, 10_000),
      status: "unmatched",
      reason,
      matchedPersonId: sameOrg.length === 1 ? sameOrg[0].id : null,
      receivedAt: now,
    })
    .returning();
  await audit(tx, { orgId: input.orgId, actorUserId: null, actorRole: "webhook" }, "messaging.inbound_unmatched", "inbound_message", row.id, { summary: `Unmatched ${input.channel} reply: ${reason}` });
  await suggestSafely(tx, {
    orgId: input.orgId,
    body: [subject, row.body].filter(Boolean).join("\n"),
    sentAt: now,
    channel: input.channel === "sms" ? "sms" : "email_direct",
    senderPersonId: row.matchedPersonId,
    inboundId: row.id,
  });
  return { status: "unmatched" as const, inboundId: row.id };
}

// ---------------------------------------------------------------------------
// Staff queue (crm.manage — unmatched messages may concern any family)
// ---------------------------------------------------------------------------

export async function listInbound(tx: Tx, v: Viewer, status: "unmatched" | "resolved" = "unmatched") {
  assertCan(v, "crm.manage");
  const rows = await tx
    .select({ i: inboundMessages, first: people.firstName, last: people.lastName })
    .from(inboundMessages)
    .leftJoin(people, eq(people.id, inboundMessages.matchedPersonId))
    .where(
      and(
        eq(inboundMessages.orgId, v.orgId),
        status === "unmatched" ? eq(inboundMessages.status, "unmatched") : inArray(inboundMessages.status, ["attached", "dismissed", "threaded"]),
      ),
    )
    .orderBy(desc(inboundMessages.receivedAt))
    .limit(200);
  return rows.map((r) => ({ ...r.i, matchedName: r.first ? `${r.first} ${r.last}` : null }));
}

export async function countUnmatched(tx: Tx, v: Viewer): Promise<number> {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(inboundMessages)
    .where(and(eq(inboundMessages.orgId, v.orgId), eq(inboundMessages.status, "unmatched")));
  return n;
}

/** Recent conversations of the matched person, to attach an unmatched reply to. */
export async function suggestedThreads(tx: Tx, v: Viewer, personId: string | null) {
  assertCan(v, "crm.manage");
  if (!personId) return [];
  return tx
    .select({ id: threads.id, subject: threads.subject, lastMessageAt: threads.lastMessageAt })
    .from(threads)
    .innerJoin(threadParticipants, eq(threadParticipants.threadId, threads.id))
    .where(and(eq(threads.orgId, v.orgId), eq(threadParticipants.personId, personId), sql`${threads.kind} <> 'staff'`))
    .orderBy(desc(threads.lastMessageAt))
    .limit(10);
}

async function loadInbound(tx: Tx, v: Viewer, id: string) {
  assertCan(v, "crm.manage");
  if (!z.string().uuid().safeParse(id).success) throw new DomainError("Message not found.");
  const [i] = await tx
    .select()
    .from(inboundMessages)
    .where(and(eq(inboundMessages.id, id), eq(inboundMessages.orgId, v.orgId)))
    .for("update");
  if (!i) throw new DomainError("Message not found.");
  if (i.status !== "unmatched") throw new DomainError("This message was already handled.");
  return i;
}

/**
 * Staff attach an unmatched reply to a conversation they can access. The sender is credited
 * only when they are an eligible participant of that conversation; otherwise the message is
 * recorded as coming from the raw address (still never sent anywhere).
 */
export async function attachInbound(tx: Tx, v: Viewer, inboundId: string, threadId: string, now = new Date()) {
  const i = await loadInbound(tx, v, inboundId);
  if (!z.string().uuid().safeParse(threadId).success) throw new DomainError("Choose a conversation.", { threadId: "Required" });
  const [t] = await tx.select().from(threads).where(and(eq(threads.id, threadId), eq(threads.orgId, v.orgId)));
  if (!t) throw new DomainError("Conversation not found.", { threadId: "Not found" });
  if ((await threadAccess(tx, v, t)) !== "staff") throw new DomainError("Conversation not found.");
  const credited = i.matchedPersonId && (await familyParticipantEligible(tx, t, i.matchedPersonId)) ? i.matchedPersonId : null;
  const body = credited ? i.body : `[${i.channel === "sms" ? "Text" : "Email"} from ${i.fromAddress}] ${i.body}`;
  const m = await postInboundMessage(tx, { thread: t, senderPersonId: credited, body, channel: i.channel, now, actor: { userId: v.userId, role: v.role } });
  await tx
    .update(inboundMessages)
    .set({ status: "attached", threadId: t.id, messageId: m.id, resolvedByUserId: v.userId, resolvedAt: now })
    .where(eq(inboundMessages.id, i.id));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "messaging.inbound_attached", "inbound_message", i.id, {
    summary: `Attached ${i.channel} reply to "${t.subject}"`,
    after: { threadId: t.id, messageId: m.id, creditedPersonId: credited },
  });
  return { threadId: t.id, messageId: m.id };
}

export async function dismissInbound(tx: Tx, v: Viewer, inboundId: string, now = new Date()) {
  const i = await loadInbound(tx, v, inboundId);
  await tx.update(inboundMessages).set({ status: "dismissed", resolvedByUserId: v.userId, resolvedAt: now }).where(eq(inboundMessages.id, i.id));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "messaging.inbound_dismissed", "inbound_message", i.id, { summary: `Dismissed ${i.channel} message from ${i.fromAddress}` });
}
