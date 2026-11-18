import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import {
  athletes,
  guardianships,
  inboundMessages,
  memberRequestAthletes,
  memberRequests,
  messages,
  people,
  threads,
  users,
  type MemberRequestChannel,
  type MemberRequestStatus,
  type MemberRequestType,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { AuthzError, can, type Viewer } from "@/lib/authz/policy";
import { DomainError } from "@/lib/messaging/errors";
import { localYmd, todayLocal } from "@/lib/time";
import {
  daysUnprocessed,
  matchRequestKeyword,
  OPEN_REQUEST_STATUSES,
  REQUEST_CHANNELS,
  REQUEST_STATUSES,
  REQUEST_TYPES,
  requestSettings,
  slaLevel,
  type MemberRequestSettings,
  type SlaLevel,
} from "./common";

/** Staff who run the requests log: people.manage or crm.manage (owner, admin, operations). */
export function canManageRequests(v: Viewer): boolean {
  return can(v, "people.manage") || can(v, "crm.manage");
}

export function assertCanManageRequests(v: Viewer) {
  if (!canManageRequests(v)) throw new AuthzError();
}

const actor = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date");
const optYmd = z.preprocess((x) => (x === "" || x == null ? null : x), ymd.nullable());
const optUuid = z.preprocess((x) => (x === "" || x == null ? null : x), z.string().uuid().nullable());
const optText = (max: number) => z.preprocess((x) => (typeof x === "string" && x.trim() === "" ? null : x), z.string().trim().max(max).nullable().optional());
const typeEnum = z.enum(REQUEST_TYPES.map((t) => t.key) as [MemberRequestType, ...MemberRequestType[]]);
const channelEnum = z.enum(REQUEST_CHANNELS.map((t) => t.key) as [MemberRequestChannel, ...MemberRequestChannel[]]);

export const createRequestSchema = z.object({
  type: typeEnum,
  channel: channelEnum,
  athleteIds: z.array(z.string().uuid()).min(1, "Choose at least one athlete"),
  requesterPersonId: optUuid.optional(),
  sentOn: ymd,
  receivedOn: optYmd.optional(),
  summary: optText(2000),
  requestedEffectiveOn: optYmd.optional(),
  threadId: optUuid.optional(),
  pastedText: optText(20_000),
  ownerUserId: optUuid.optional(),
  status: z.enum(["new", "in_progress"]).default("new"),
});

async function validateRefs(
  tx: Tx,
  v: Viewer,
  d: { athleteIds?: string[]; requesterPersonId?: string | null; threadId?: string | null; ownerUserId?: string | null },
) {
  if (d.athleteIds) {
    const ids = [...new Set(d.athleteIds)];
    const found = await tx.select({ id: athletes.id }).from(athletes).where(and(eq(athletes.orgId, v.orgId), inArray(athletes.id, ids)));
    if (found.length !== ids.length) throw new DomainError("Athlete not found.", { athleteIds: "Not found" });
  }
  if (d.requesterPersonId) {
    const [p] = await tx.select({ id: people.id }).from(people).where(and(eq(people.id, d.requesterPersonId), eq(people.orgId, v.orgId)));
    if (!p) throw new DomainError("Requester not found.", { requesterPersonId: "Not found" });
  }
  if (d.threadId) {
    const [t] = await tx.select({ id: threads.id }).from(threads).where(and(eq(threads.id, d.threadId), eq(threads.orgId, v.orgId)));
    if (!t) throw new DomainError("Conversation not found.", { threadId: "Not found" });
  }
  if (d.ownerUserId) {
    const [u] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, d.ownerUserId), eq(users.orgId, v.orgId), inArray(users.role, ["owner", "admin", "operations", "coach"])));
    if (!u) throw new DomainError("Owner must be a staff member.", { ownerUserId: "Not staff" });
  }
}

/** Record a family request. The sent date is the family's date, never a future date. */
export async function createRequest(tx: Tx, v: Viewer, input: z.input<typeof createRequestSchema>, today?: string) {
  assertCanManageRequests(v);
  const d = createRequestSchema.parse(input);
  const { tz } = await requestSettings(tx, v.orgId);
  const t = today ?? todayLocal(tz);
  if (d.sentOn > t) throw new DomainError("The sent date can't be in the future.", { sentOn: "In the future" });
  if (d.receivedOn && d.receivedOn < d.sentOn) throw new DomainError("Received date can't be before the family sent it.", { receivedOn: "Before sent date" });
  if (!d.threadId && !d.pastedText && !d.summary) throw new DomainError("Link a conversation, paste the message, or summarize the request.", { pastedText: "Required" });
  await validateRefs(tx, v, d);
  const [row] = await tx
    .insert(memberRequests)
    .values({
      orgId: v.orgId,
      type: d.type,
      channel: d.channel,
      requesterPersonId: d.requesterPersonId ?? null,
      sentOn: d.sentOn,
      receivedOn: d.receivedOn ?? null,
      summary: d.summary ?? null,
      requestedEffectiveOn: d.requestedEffectiveOn ?? null,
      threadId: d.threadId ?? null,
      pastedText: d.pastedText ?? null,
      status: d.status,
      ownerUserId: d.ownerUserId ?? null,
      createdByUserId: v.userId,
    })
    .returning();
  await tx.insert(memberRequestAthletes).values([...new Set(d.athleteIds)].map((athleteId) => ({ requestId: row.id, athleteId })));
  await audit(tx, actor(v), "member_request.create", "member_request", row.id, {
    summary: `Logged ${d.type} request (${d.channel}) sent ${d.sentOn}`,
    after: { ...row, athleteIds: d.athleteIds },
  });
  return row;
}

export const updateRequestSchema = z.object({
  status: z.enum(REQUEST_STATUSES.filter((s) => s.key !== "dismissed").map((s) => s.key) as [MemberRequestStatus, ...MemberRequestStatus[]]).optional(),
  ownerUserId: optUuid.optional(),
  resolutionNotes: optText(5000),
  type: typeEnum.optional(),
  sentOn: ymd.optional(),
  receivedOn: optYmd.optional(),
  threadId: optUuid.optional(),
  summary: optText(2000),
  requestedEffectiveOn: optYmd.optional(),
});

async function loadForUpdate(tx: Tx, v: Viewer, id: string) {
  assertCanManageRequests(v);
  if (!z.string().uuid().safeParse(id).success) throw new DomainError("Request not found.");
  const [r] = await tx
    .select()
    .from(memberRequests)
    .where(and(eq(memberRequests.id, id), eq(memberRequests.orgId, v.orgId)))
    .for("update");
  if (!r) throw new DomainError("Request not found.");
  return r;
}

/**
 * Move a request through new → in progress → resolved/declined, reassign it, or correct its
 * dates. Resolving or declining requires resolution notes. Every change is audited with before/after.
 */
export async function updateRequest(tx: Tx, v: Viewer, id: string, input: z.input<typeof updateRequestSchema>, now = new Date()) {
  const r = await loadForUpdate(tx, v, id);
  if (r.status === "dismissed") throw new DomainError("This suggestion was dismissed. Log a new request instead.");
  const d = updateRequestSchema.parse(input);
  await validateRefs(tx, v, { ownerUserId: d.ownerUserId, threadId: d.threadId });
  const { tz } = await requestSettings(tx, v.orgId);
  const today = localYmd(now, tz);
  const sentOn = d.sentOn ?? r.sentOn;
  if (sentOn > today) throw new DomainError("The sent date can't be in the future.", { sentOn: "In the future" });
  const receivedOn = d.receivedOn === undefined ? r.receivedOn : d.receivedOn;
  if (receivedOn && receivedOn < sentOn) throw new DomainError("Received date can't be before the family sent it.", { receivedOn: "Before sent date" });
  const status = d.status ?? r.status;
  const notes = d.resolutionNotes === undefined ? r.resolutionNotes : d.resolutionNotes;
  const closing = (status === "resolved" || status === "declined") && !(r.status === "resolved" || r.status === "declined");
  if ((status === "resolved" || status === "declined") && !notes?.trim()) throw new DomainError("Add resolution notes before closing the request.", { resolutionNotes: "Required" });
  const reopening = (status === "new" || status === "in_progress") && (r.status === "resolved" || r.status === "declined");
  const patch = {
    status,
    ownerUserId: d.ownerUserId === undefined ? r.ownerUserId : d.ownerUserId,
    resolutionNotes: notes ?? null,
    type: d.type ?? r.type,
    sentOn,
    receivedOn,
    threadId: d.threadId === undefined ? r.threadId : d.threadId,
    summary: d.summary === undefined ? r.summary : d.summary,
    requestedEffectiveOn: d.requestedEffectiveOn === undefined ? r.requestedEffectiveOn : d.requestedEffectiveOn,
    resolvedAt: closing ? now : reopening ? null : r.resolvedAt,
    resolvedByUserId: closing ? v.userId : reopening ? null : r.resolvedByUserId,
    // Working a suggestion (any edit) confirms it.
    suggested: false,
    confirmedAt: r.suggested ? now : r.confirmedAt,
    confirmedByUserId: r.suggested ? v.userId : r.confirmedByUserId,
    updatedAt: now,
  };
  const [after] = await tx.update(memberRequests).set(patch).where(eq(memberRequests.id, r.id)).returning();
  const changed = Object.fromEntries(Object.keys(patch).filter((k) => k !== "updatedAt" && String((r as Record<string, unknown>)[k]) !== String((after as Record<string, unknown>)[k])).map((k) => [k, (after as Record<string, unknown>)[k]]));
  await audit(tx, actor(v), closing ? `member_request.${status}` : "member_request.update", "member_request", r.id, {
    summary: closing ? `${status === "resolved" ? "Resolved" : "Declined"} ${r.type} request sent ${sentOn}` : `Updated request (${Object.keys(changed).join(", ") || "no changes"})`,
    before: Object.fromEntries(Object.keys(changed).map((k) => [k, (r as Record<string, unknown>)[k]])),
    after: changed,
  });
  return after;
}

/** Replace the athletes a request concerns. */
export async function setRequestAthletes(tx: Tx, v: Viewer, id: string, athleteIds: string[]) {
  const r = await loadForUpdate(tx, v, id);
  const ids = [...new Set(athleteIds)];
  if (!ids.length) throw new DomainError("Choose at least one athlete.", { athleteIds: "Required" });
  await validateRefs(tx, v, { athleteIds: ids });
  const before = (await tx.select({ id: memberRequestAthletes.athleteId }).from(memberRequestAthletes).where(eq(memberRequestAthletes.requestId, r.id))).map((x) => x.id);
  if (before.length === ids.length && ids.every((i) => before.includes(i))) return;
  await tx.delete(memberRequestAthletes).where(eq(memberRequestAthletes.requestId, r.id));
  await tx.insert(memberRequestAthletes).values(ids.map((athleteId) => ({ requestId: r.id, athleteId })));
  await audit(tx, actor(v), "member_request.athletes", "member_request", r.id, { summary: "Changed athletes on request", before: { athleteIds: before }, after: { athleteIds: ids } });
}

/** Staff confirm a keyword suggestion is a real request (it stays `new` until worked). */
export async function confirmSuggestion(tx: Tx, v: Viewer, id: string, input: { type?: MemberRequestType } = {}, now = new Date()) {
  const r = await loadForUpdate(tx, v, id);
  if (!r.suggested || r.status !== "new") throw new DomainError("This request is not an unconfirmed suggestion.");
  const type = input.type ? typeEnum.parse(input.type) : r.type;
  const [after] = await tx
    .update(memberRequests)
    .set({ suggested: false, confirmedAt: now, confirmedByUserId: v.userId, type, ownerUserId: r.ownerUserId ?? v.userId, updatedAt: now })
    .where(eq(memberRequests.id, r.id))
    .returning();
  await audit(tx, actor(v), "member_request.confirm_suggestion", "member_request", r.id, {
    summary: `Confirmed suggested ${type} request (keyword "${r.matchedKeyword ?? ""}")`,
    before: { suggested: true, type: r.type },
    after: { suggested: false, type },
  });
  return after;
}

/** Staff mark a keyword suggestion as not a request. Kept (status dismissed) for the audit trail. */
export async function dismissSuggestion(tx: Tx, v: Viewer, id: string, reason: string | null, now = new Date()) {
  const r = await loadForUpdate(tx, v, id);
  if (!r.suggested || r.status !== "new") throw new DomainError("Only unconfirmed suggestions can be dismissed.");
  await tx
    .update(memberRequests)
    .set({ status: "dismissed", resolutionNotes: reason?.trim() || "Not a membership request", resolvedAt: now, resolvedByUserId: v.userId, updatedAt: now })
    .where(eq(memberRequests.id, r.id));
  await audit(tx, actor(v), "member_request.dismiss_suggestion", "member_request", r.id, { summary: `Dismissed suggested ${r.type} request: ${reason?.trim() || "not a request"}` });
}

// ---------------------------------------------------------------------------
// Keyword suggestions from inbound family messages (never auto-acted on)
// ---------------------------------------------------------------------------

export type SuggestSource = {
  orgId: string;
  body: string;
  sentAt: Date;
  channel: MemberRequestChannel;
  senderPersonId: string | null;
  threadId?: string | null;
  messageId?: string | null;
  inboundId?: string | null;
};

/** Athletes a family sender is connected to: the thread's athlete, else their active wards / themselves. */
async function athletesForSender(tx: Tx, orgId: string, threadId: string | null | undefined, personId: string | null): Promise<string[]> {
  if (threadId) {
    const [t] = await tx.select({ athleteId: threads.athleteId }).from(threads).where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)));
    if (t?.athleteId) return [t.athleteId];
  }
  if (!personId) return [];
  const wards = await tx
    .select({ id: guardianships.athleteId })
    .from(guardianships)
    .innerJoin(athletes, eq(athletes.id, guardianships.athleteId))
    .where(and(eq(guardianships.orgId, orgId), eq(guardianships.guardianPersonId, personId), eq(guardianships.status, "active"), eq(athletes.active, true)));
  const self = await tx.select({ id: athletes.id }).from(athletes).where(and(eq(athletes.orgId, orgId), eq(athletes.personId, personId)));
  return [...new Set([...wards, ...self].map((x) => x.id))];
}

/**
 * If a family message mentions hold / pause / cancel / in season / card, record a `new`,
 * `suggested` request for staff to confirm or dismiss. Idempotent per source message.
 * Returns the suggestion id, or null when nothing matched / it already exists.
 */
export async function suggestFromMessage(tx: Tx, src: SuggestSource): Promise<string | null> {
  const hit = matchRequestKeyword(src.body);
  if (!hit) return null;
  const { tz } = await requestSettings(tx, src.orgId);
  const athleteIds = await athletesForSender(tx, src.orgId, src.threadId, src.senderPersonId);
  const [row] = await tx
    .insert(memberRequests)
    .values({
      orgId: src.orgId,
      type: hit.type,
      channel: src.channel,
      requesterPersonId: src.senderPersonId,
      sentOn: localYmd(src.sentAt, tz),
      summary: hit.excerpt.slice(0, 2000),
      threadId: src.threadId ?? null,
      sourceMessageId: src.messageId ?? null,
      sourceInboundId: src.inboundId ?? null,
      pastedText: src.threadId ? null : src.body.slice(0, 20_000),
      status: "new",
      suggested: true,
      matchedKeyword: hit.keyword,
    })
    .onConflictDoNothing()
    .returning({ id: memberRequests.id });
  if (!row) return null;
  if (athleteIds.length) await tx.insert(memberRequestAthletes).values(athleteIds.map((athleteId) => ({ requestId: row.id, athleteId })));
  await audit(tx, { orgId: src.orgId, actorUserId: null, actorRole: "system" }, "member_request.suggested", "member_request", row.id, {
    summary: `Suggested ${hit.type} request from a ${src.channel} message (keyword "${hit.keyword}") — awaiting staff confirmation`,
  });
  return row.id;
}

/**
 * Hook used by message ingestion: runs `suggestFromMessage` in a savepoint so a failure here can
 * never block or roll back the message itself.
 */
export async function suggestSafely(tx: Tx, src: SuggestSource): Promise<string | null> {
  if (!matchRequestKeyword(src.body)) return null;
  try {
    return await tx.transaction((sp) => suggestFromMessage(sp, src));
  } catch (e) {
    console.error(JSON.stringify({ level: "warn", msg: "member_request.suggest_failed", error: (e as Error)?.message }));
    return null;
  }
}

/**
 * Backfill: screen family messages and unmatched inbound email/SMS received in the last `days`
 * days and create suggestions for keyword matches not already suggested.
 */
export async function scanForSuggestions(tx: Tx, v: Viewer, days = 30, now = new Date()) {
  assertCanManageRequests(v);
  const since = new Date(now.getTime() - Math.max(1, Math.min(days, 365)) * 86_400_000);
  const famMsgs = await tx.execute(sql`
    select m.id, m.thread_id, m.body, m.created_at, m.sender_person_id, m.inbound_channel
    from messages m join threads t on t.id = m.thread_id
    left join users u on u.id = m.sender_user_id
    where t.org_id = ${v.orgId} and t.kind <> 'staff' and not m.is_internal_note and m.sender_person_id is not null
      and (u.id is null or u.role in ('guardian','athlete')) and m.created_at >= ${since.toISOString()}
      and not exists (select 1 from member_requests r where r.org_id = ${v.orgId} and r.source_message_id = m.id)`);
  let created = 0;
  for (const m of famMsgs.rows as { id: string; thread_id: string; body: string; created_at: string | Date; sender_person_id: string; inbound_channel: string | null }[]) {
    const id = await suggestFromMessage(tx, {
      orgId: v.orgId,
      body: m.body,
      sentAt: new Date(m.created_at),
      channel: m.inbound_channel === "sms" ? "sms" : m.inbound_channel === "email" ? "email_direct" : "in_app",
      senderPersonId: m.sender_person_id,
      threadId: m.thread_id,
      messageId: m.id,
    });
    if (id) created++;
  }
  const inbound = await tx
    .select()
    .from(inboundMessages)
    .where(and(eq(inboundMessages.orgId, v.orgId), eq(inboundMessages.status, "unmatched"), sql`${inboundMessages.receivedAt} >= ${since.toISOString()}`));
  for (const i of inbound) {
    const id = await suggestFromMessage(tx, {
      orgId: v.orgId,
      body: [i.subject, i.body].filter(Boolean).join("\n"),
      sentAt: i.receivedAt,
      channel: i.channel === "sms" ? "sms" : "email_direct",
      senderPersonId: i.matchedPersonId,
      inboundId: i.id,
    });
    if (id) created++;
  }
  await audit(tx, actor(v), "member_request.scan", "member_request", null, { summary: `Scanned ${famMsgs.rows.length + inbound.length} messages from the last ${days} days; ${created} new suggestion(s)` });
  return { scanned: famMsgs.rows.length + inbound.length, created };
}

// ---------------------------------------------------------------------------
// Listing with derived fields
// ---------------------------------------------------------------------------

export type RequestFilter = {
  view?: "open" | "suggested" | "closed" | "all";
  type?: MemberRequestType;
  athleteId?: string;
  ownerUserId?: string;
};

export type RequestRow = {
  id: string;
  type: MemberRequestType;
  channel: MemberRequestChannel;
  status: MemberRequestStatus;
  suggested: boolean;
  matchedKeyword: string | null;
  sentOn: string;
  receivedOn: string | null;
  requestedEffectiveOn: string | null;
  summary: string | null;
  pastedText: string | null;
  resolutionNotes: string | null;
  resolvedAt: Date | null;
  threadId: string | null;
  threadSubject: string | null;
  sourceInboundId: string | null;
  requesterPersonId: string | null;
  requesterName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  athletes: { athleteId: string; personId: string; name: string }[];
  /** sent → resolved (closed) or → today. */
  daysUnprocessed: number;
  /** received → sent gap: how long it sat before staff even saw it. */
  daysBeforeSeen: number | null;
  sla: SlaLevel;
  /** Asks of the same kind (hold≈pause) for the same athlete within the repeat window, including this one. */
  asks: number;
  firstAskedOn: string;
  /** First non-internal staff message after the sent date in a related conversation. */
  reply: { messageId: string; threadId: string; at: Date } | null;
  /** Non-void membership invoices for the athlete(s) with a bill date after the sent date (and before resolution). */
  billedSince: { count: number; totalMinor: number };
};

/** Requests with days unprocessed, SLA, repeat asks, "already replied?" and billed-since. */
export async function listRequests(tx: Tx, v: Viewer, f: RequestFilter = {}, today?: string): Promise<{ rows: RequestRow[]; settings: MemberRequestSettings; today: string }> {
  assertCanManageRequests(v);
  const { settings, tz } = await requestSettings(tx, v.orgId);
  const t = today ?? todayLocal(tz);
  const view = f.view ?? "open";
  const viewCond =
    view === "open"
      ? sql`r.status in ('new','in_progress') and not r.suggested`
      : view === "suggested"
        ? sql`r.status = 'new' and r.suggested`
        : view === "closed"
          ? sql`r.status in ('resolved','declined','dismissed')`
          : sql`true`;
  const uuidOk = (s?: string) => !!s && z.string().uuid().safeParse(s).success;
  const res = await tx.execute(sql`
    select r.*, th.subject as thread_subject,
      rp.first_name || ' ' || rp.last_name as requester_name, ou.display_name as owner_name,
      coalesce((select json_agg(json_build_object('athleteId', a.id, 'personId', p.id, 'name', p.first_name || ' ' || p.last_name) order by p.last_name, p.first_name)
        from member_request_athletes ra join athletes a on a.id = ra.athlete_id join people p on p.id = a.person_id where ra.request_id = r.id), '[]'::json) as athletes,
      (select count(distinct r2.id) from member_requests r2 join member_request_athletes a2 on a2.request_id = r2.id
        where r2.org_id = r.org_id and r2.status <> 'dismissed'
          and (case when r2.type in ('hold','pause') then 'hold' else r2.type end) = (case when r.type in ('hold','pause') then 'hold' else r.type end)
          and a2.athlete_id in (select athlete_id from member_request_athletes where request_id = r.id)
          and r2.sent_on between r.sent_on - ${settings.repeatWindowDays}::int and r.sent_on + ${settings.repeatWindowDays}::int)::int as asks,
      (select min(r2.sent_on) from member_requests r2 join member_request_athletes a2 on a2.request_id = r2.id
        where r2.org_id = r.org_id and r2.status <> 'dismissed'
          and (case when r2.type in ('hold','pause') then 'hold' else r2.type end) = (case when r.type in ('hold','pause') then 'hold' else r.type end)
          and a2.athlete_id in (select athlete_id from member_request_athletes where request_id = r.id)
          and r2.sent_on between r.sent_on - ${settings.repeatWindowDays}::int and r.sent_on) as first_asked_on,
      rep.id as reply_id, rep.thread_id as reply_thread_id, rep.created_at as reply_at,
      coalesce(bill.n, 0)::int as billed_count, coalesce(bill.total, 0)::bigint as billed_total
    from member_requests r
    left join threads th on th.id = r.thread_id
    left join people rp on rp.id = r.requester_person_id
    left join users ou on ou.id = r.owner_user_id
    left join lateral (
      select m.id, m.thread_id, m.created_at from messages m
      join threads t2 on t2.id = m.thread_id
      join users su on su.id = m.sender_user_id and su.role in ('owner','admin','operations','coach')
      where t2.org_id = r.org_id and not m.is_internal_note
        and m.created_at >= (r.sent_on::timestamp at time zone ${tz})
        and (t2.id = r.thread_id
          or t2.athlete_id in (select athlete_id from member_request_athletes where request_id = r.id)
          or exists (select 1 from thread_participants tp where tp.thread_id = t2.id and tp.person_id = r.requester_person_id))
      order by m.created_at asc limit 1) rep on true
    left join lateral (
      select count(*) as n, sum(i.total_minor) as total from invoices i join memberships ms on ms.id = i.membership_id
      where ms.org_id = r.org_id and i.status <> 'void'
        and ms.athlete_id in (select athlete_id from member_request_athletes where request_id = r.id)
        and i.period_start > r.sent_on
        and i.period_start <= coalesce((r.resolved_at at time zone ${tz})::date, ${t}::date)) bill on true
    where r.org_id = ${v.orgId} and ${viewCond}
      ${f.type ? sql`and r.type = ${f.type}` : sql``}
      ${uuidOk(f.ownerUserId) ? sql`and r.owner_user_id = ${f.ownerUserId}` : sql``}
      ${uuidOk(f.athleteId) ? sql`and exists (select 1 from member_request_athletes x where x.request_id = r.id and x.athlete_id = ${f.athleteId})` : sql``}
    order by case when r.status in ('new','in_progress') then 0 else 1 end, r.sent_on asc, r.created_at asc
    limit 300`);
  const ymdOf = (x: unknown) => (x == null ? null : x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));
  const rows: RequestRow[] = (res.rows as Record<string, unknown>[]).map((r) => {
    const status = r.status as MemberRequestStatus;
    const open = OPEN_REQUEST_STATUSES.includes(status);
    const resolvedAt = r.resolved_at ? new Date(r.resolved_at as string) : null;
    const sentOn = ymdOf(r.sent_on)!;
    const receivedOn = ymdOf(r.received_on);
    const days = daysUnprocessed(sentOn, open || !resolvedAt ? null : localYmd(resolvedAt, tz), t);
    return {
      id: r.id as string,
      type: r.type as MemberRequestType,
      channel: r.channel as MemberRequestChannel,
      status,
      suggested: !!r.suggested,
      matchedKeyword: (r.matched_keyword as string) ?? null,
      sentOn,
      receivedOn,
      requestedEffectiveOn: ymdOf(r.requested_effective_on),
      summary: (r.summary as string) ?? null,
      pastedText: (r.pasted_text as string) ?? null,
      resolutionNotes: (r.resolution_notes as string) ?? null,
      resolvedAt,
      threadId: (r.thread_id as string) ?? null,
      threadSubject: (r.thread_subject as string) ?? null,
      sourceInboundId: (r.source_inbound_id as string) ?? null,
      requesterPersonId: (r.requester_person_id as string) ?? null,
      requesterName: (r.requester_name as string) ?? null,
      ownerUserId: (r.owner_user_id as string) ?? null,
      ownerName: (r.owner_name as string) ?? null,
      athletes: (r.athletes as RequestRow["athletes"]) ?? [],
      daysUnprocessed: days,
      daysBeforeSeen: receivedOn ? daysUnprocessed(sentOn, receivedOn, t) : null,
      sla: slaLevel(days, open, settings),
      asks: Math.max(1, Number(r.asks ?? 1)),
      firstAskedOn: ymdOf(r.first_asked_on) ?? sentOn,
      reply: r.reply_id ? { messageId: r.reply_id as string, threadId: r.reply_thread_id as string, at: new Date(r.reply_at as string) } : null,
      billedSince: { count: Number(r.billed_count ?? 0), totalMinor: Number(r.billed_total ?? 0) },
    };
  });
  return { rows, settings, today: t };
}

/** Options for the request form: athletes, possible requesters (guardians + athletes), staff, recent threads. */
export async function requestFormOptions(tx: Tx, v: Viewer) {
  assertCanManageRequests(v);
  const athleteRows = await tx
    .select({ id: athletes.id, first: people.firstName, last: people.lastName, active: athletes.active })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.orgId, v.orgId), sql`${people.archivedAt} is null`))
    .orderBy(people.lastName, people.firstName);
  const requesterRows = await tx.execute(sql`
    select p.id, p.first_name || ' ' || p.last_name as name from people p
    where p.org_id = ${v.orgId} and p.archived_at is null
      and (exists (select 1 from guardianships g where g.guardian_person_id = p.id and g.status = 'active')
        or exists (select 1 from athletes a where a.person_id = p.id)
        or exists (select 1 from payer_authorizations pa where pa.person_id = p.id))
    order by p.last_name, p.first_name limit 1000`);
  const staff = await tx
    .select({ id: users.id, name: users.displayName })
    .from(users)
    .where(and(eq(users.orgId, v.orgId), inArray(users.role, ["owner", "admin", "operations", "coach"]), sql`${users.disabledAt} is null`))
    .orderBy(users.displayName);
  const threadRows = await tx
    .select({ id: threads.id, subject: threads.subject, lastMessageAt: threads.lastMessageAt })
    .from(threads)
    .where(and(eq(threads.orgId, v.orgId), sql`${threads.kind} <> 'staff'`))
    .orderBy(sql`${threads.lastMessageAt} desc nulls last`)
    .limit(100);
  return {
    athletes: athleteRows.map((a) => ({ id: a.id, name: `${a.first} ${a.last}${a.active ? "" : " (inactive)"}` })),
    requesters: requesterRows.rows as { id: string; name: string }[],
    staff,
    threads: threadRows,
  };
}

/** Body of the source message for a suggestion (for staff review). */
export async function sourceMessageBody(tx: Tx, v: Viewer, messageId: string) {
  assertCanManageRequests(v);
  const [m] = await tx
    .select({ body: messages.body })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(and(eq(messages.id, messageId), eq(threads.orgId, v.orgId)));
  return m?.body ?? null;
}
