import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { athletes, leads, messageDeliveries, messages, people, threadParticipants, threads, users } from "@/db/schema";
import { DomainError as UserError } from "./errors";
import { audit } from "@/lib/audit";
import {
  AuthzError,
  accessibleAthleteIds,
  assertCan,
  athleteCapabilities,
  can,
  coachAthleteIds,
  isStaff,
  type Viewer,
} from "@/lib/authz/policy";
import { createDeliveries, type Channel } from "./delivery";
import { ageOn, messagingSettings, recipientForPerson, routeForAthlete, type Recipient } from "./routing";
import { todayLocal } from "@/lib/time";
import { suggestSafely } from "@/lib/member-ops/requests";

export type Thread = typeof threads.$inferSelect;
export type ThreadKind = Thread["kind"];

const actor = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

/** Client mutation ids are namespaced by sender so two users can never collide. */
const cmidFor = (v: Viewer, cmid: string | undefined, suffix = "") => (cmid ? `${v.userId}:${cmid}${suffix}` : null);

export const bodySchema = z.string().trim().min(1, "Write a message").max(5000, "Keep messages under 5,000 characters");
export const subjectSchema = z.string().trim().min(1, "Add a subject").max(200);

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

async function loadThreadRow(tx: Tx, v: Viewer, threadId: string): Promise<Thread> {
  if (!z.string().uuid().safeParse(threadId).success) throw new AuthzError("Conversation not found.");
  const [t] = await tx.select().from(threads).where(and(eq(threads.id, threadId), eq(threads.orgId, v.orgId)));
  if (!t) throw new AuthzError("Conversation not found.");
  return t;
}

/**
 * Staff (messages.inbox): owner/admin/operations see every org thread; coaches only
 * threads about athletes they are assigned to, or athlete-less threads assigned to
 * them / that they participate in.
 * Family: only threads where they are a participant, never staff-only threads, and for
 * athlete-context threads only while they still hold messages.send for that athlete.
 */
export async function threadAccess(tx: Tx, v: Viewer, t: Thread): Promise<"staff" | "family"> {
  if (t.orgId !== v.orgId) throw new AuthzError("Conversation not found.");
  if (isStaff(v) && can(v, "messages.inbox")) {
    if (v.role !== "coach") return "staff";
    if (t.athleteId) {
      const ids = await coachAthleteIds(tx, v);
      if (ids.includes(t.athleteId)) return "staff";
      throw new AuthzError("This conversation is about an athlete you are not assigned to.");
    }
    if (t.assignedUserId === v.userId) return "staff";
    const [p] = await tx
      .select({ id: threadParticipants.id })
      .from(threadParticipants)
      .where(and(eq(threadParticipants.threadId, t.id), eq(threadParticipants.userId, v.userId)));
    if (p) return "staff";
    throw new AuthzError("Conversation not found.");
  }
  if (v.role !== "guardian" && v.role !== "athlete") throw new AuthzError("Conversation not found.");
  if (t.kind === "staff" || !v.personId) throw new AuthzError("Conversation not found.");
  const [p] = await tx
    .select({ id: threadParticipants.id })
    .from(threadParticipants)
    .where(and(eq(threadParticipants.threadId, t.id), eq(threadParticipants.personId, v.personId)));
  if (!p) throw new AuthzError("Conversation not found.");
  if (t.athleteId) {
    const caps = await athleteCapabilities(tx, v, t.athleteId);
    if (!caps.has("messages.send")) throw new AuthzError("Conversation not found.");
  }
  return "family";
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export type ThreadFilters = {
  view?: "all" | "mine" | "unassigned";
  status?: "open" | "closed" | "all";
  kind?: ThreadKind | "all";
  athleteId?: string;
  q?: string;
};

export type ThreadListRow = {
  id: string;
  subject: string;
  kind: ThreadKind;
  status: Thread["status"];
  athleteId: string | null;
  athleteName: string | null;
  leadId: string | null;
  assignedUserId: string | null;
  assignedName: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  unread: number;
  lastBody: string | null;
  lastIsInternal: boolean;
  participantNames: string | null;
};

const uuidOk = (s?: string) => !!s && z.string().uuid().safeParse(s).success;

export async function listThreadsForStaff(tx: Tx, v: Viewer, f: ThreadFilters = {}): Promise<ThreadListRow[]> {
  assertCan(v, "messages.inbox");
  const conds = [sql`t.org_id = ${v.orgId}`];
  if (v.role === "coach") {
    const ids = await coachAthleteIds(tx, v);
    const scope = ids.length ? sql`t.athlete_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})` : sql`false`;
    conds.push(sql`(${scope} or (t.athlete_id is null and (t.assigned_user_id = ${v.userId} or exists (select 1 from thread_participants p where p.thread_id = t.id and p.user_id = ${v.userId}))))`);
  }
  if (f.view === "mine") conds.push(sql`t.assigned_user_id = ${v.userId}`);
  if (f.view === "unassigned") conds.push(sql`t.assigned_user_id is null`);
  if (f.status === "open") conds.push(sql`t.status <> 'closed'`);
  if (f.status === "closed") conds.push(sql`t.status = 'closed'`);
  if (f.kind && f.kind !== "all") conds.push(sql`t.kind = ${f.kind}`);
  if (uuidOk(f.athleteId)) conds.push(sql`t.athlete_id = ${f.athleteId}`);
  if (f.q?.trim()) conds.push(sql`t.subject ilike ${"%" + f.q.trim().replace(/[%_]/g, "") + "%"}`);
  return runList(tx, v, conds, true);
}

export async function listThreadsForFamily(tx: Tx, v: Viewer): Promise<ThreadListRow[]> {
  if (!v.personId || (v.role !== "guardian" && v.role !== "athlete")) return [];
  const allowed = await accessibleAthleteIds(tx, v, "messages.send");
  const allowedIds = allowed === "all" ? [] : allowed;
  const athleteCond = allowedIds.length
    ? sql`(t.athlete_id is null or t.athlete_id in (${sql.join(allowedIds.map((i) => sql`${i}::uuid`), sql`, `)}))`
    : sql`t.athlete_id is null`;
  const conds = [
    sql`t.org_id = ${v.orgId}`,
    sql`t.kind <> 'staff'`,
    sql`exists (select 1 from thread_participants p where p.thread_id = t.id and p.person_id = ${v.personId})`,
    athleteCond,
  ];
  return runList(tx, v, conds, false);
}

async function runList(tx: Tx, v: Viewer, conds: ReturnType<typeof sql>[], staffView: boolean): Promise<ThreadListRow[]> {
  const me = staffView ? sql`tp.user_id = ${v.userId}` : sql`tp.person_id = ${v.personId}`;
  const internalFilter = staffView ? sql`true` : sql`m.is_internal_note = false`;
  const res = await tx.execute(sql`
    select t.id, t.subject, t.kind, t.status, t.athlete_id, t.lead_id, t.assigned_user_id, t.last_message_at, t.created_at,
      ap.first_name || ' ' || ap.last_name as athlete_name,
      au.display_name as assigned_name,
      (select count(*) from messages m where m.thread_id = t.id and ${internalFilter}
         and m.created_at > coalesce((select max(tp.last_read_at) from thread_participants tp where tp.thread_id = t.id and ${me}), '-infinity'::timestamptz)
         and m.sender_user_id is distinct from ${v.userId}::uuid)::int as unread,
      (select m.body from messages m where m.thread_id = t.id and ${internalFilter} order by m.created_at desc limit 1) as last_body,
      (select m.is_internal_note from messages m where m.thread_id = t.id and ${internalFilter} order by m.created_at desc limit 1) as last_internal,
      (select string_agg(pp.first_name || ' ' || pp.last_name, ', ' order by pp.last_name) from thread_participants p join people pp on pp.id = p.person_id
         where p.thread_id = t.id and p.role <> 'staff') as participant_names
    from threads t
    left join athletes a on a.id = t.athlete_id
    left join people ap on ap.id = a.person_id
    left join users au on au.id = t.assigned_user_id
    where ${sql.join(conds, sql` and `)}
    order by coalesce(t.last_message_at, t.created_at) desc
    limit 200`);
  return res.rows.map((r) => {
    const x = r as Record<string, unknown>;
    return {
      id: x.id as string,
      subject: x.subject as string,
      kind: x.kind as ThreadKind,
      status: x.status as Thread["status"],
      athleteId: (x.athlete_id as string) ?? null,
      athleteName: (x.athlete_name as string) ?? null,
      leadId: (x.lead_id as string) ?? null,
      assignedUserId: (x.assigned_user_id as string) ?? null,
      assignedName: (x.assigned_name as string) ?? null,
      lastMessageAt: x.last_message_at ? new Date(x.last_message_at as string) : null,
      createdAt: new Date(x.created_at as string),
      unread: Number(x.unread ?? 0),
      lastBody: (x.last_body as string) ?? null,
      lastIsInternal: x.last_internal === true,
      participantNames: (x.participant_names as string) ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export type ThreadView = Awaited<ReturnType<typeof loadThread>>;

export async function loadThread(tx: Tx, v: Viewer, threadId: string) {
  const t = await loadThreadRow(tx, v, threadId);
  const mode = await threadAccess(tx, v, t);
  const staff = mode === "staff";

  const msgRows = await tx
    .select({
      m: messages,
      senderName: sql<string | null>`coalesce(${users.displayName}, ${people.firstName} || ' ' || ${people.lastName})`,
      senderRole: users.role,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.senderUserId))
    .leftJoin(people, eq(people.id, messages.senderPersonId))
    .where(staff ? eq(messages.threadId, t.id) : and(eq(messages.threadId, t.id), eq(messages.isInternalNote, false)))
    .orderBy(asc(messages.createdAt));

  const participants = await tx
    .select({
      id: threadParticipants.id,
      role: threadParticipants.role,
      personId: threadParticipants.personId,
      userId: threadParticipants.userId,
      lastReadAt: threadParticipants.lastReadAt,
      name: sql<string>`coalesce(${people.firstName} || ' ' || ${people.lastName}, ${users.displayName}, 'Unknown')`,
    })
    .from(threadParticipants)
    .leftJoin(people, eq(people.id, threadParticipants.personId))
    .leftJoin(users, eq(users.id, threadParticipants.userId))
    .where(eq(threadParticipants.threadId, t.id));

  // Families see only their own copies' status; staff see every recipient/channel.
  const msgIds = msgRows.map((r) => r.m.id);
  const deliveries = msgIds.length
    ? await tx
        .select({
          d: messageDeliveries,
          recipientName: sql<string | null>`${people.firstName} || ' ' || ${people.lastName}`,
        })
        .from(messageDeliveries)
        .leftJoin(people, eq(people.id, messageDeliveries.recipientPersonId))
        .where(inArray(messageDeliveries.messageId, msgIds))
    : [];

  let athlete: { id: string; name: string; sport: string | null } | null = null;
  if (t.athleteId) {
    const [a] = await tx
      .select({ id: athletes.id, first: people.firstName, last: people.lastName, sport: athletes.sport })
      .from(athletes)
      .innerJoin(people, eq(people.id, athletes.personId))
      .where(eq(athletes.id, t.athleteId));
    if (a) athlete = { id: a.id, name: `${a.first} ${a.last}`, sport: a.sport };
  }
  let lead: { id: string; name: string } | null = null;
  if (t.leadId && staff) {
    const [l] = await tx
      .select({ id: leads.id, first: people.firstName, last: people.lastName })
      .from(leads)
      .innerJoin(people, eq(people.id, leads.personId))
      .where(and(eq(leads.id, t.leadId), eq(leads.orgId, v.orgId)));
    if (l) lead = { id: l.id, name: `${l.first} ${l.last}` };
  }

  const visibleDeliveries = staff
    ? deliveries
    : deliveries.filter((x) => x.d.recipientPersonId === v.personId && x.d.channel === "in_app");

  return {
    thread: t,
    mode,
    athlete,
    lead,
    participants: staff ? participants : participants.map((p) => ({ ...p, lastReadAt: null })),
    messages: msgRows.map((r) => ({
      ...r.m,
      senderName: r.senderName ?? (r.m.automationRuleId ? "Automated message" : r.m.campaignId ? "Teamwork (announcement)" : "Teamwork"),
      fromStaff: !!r.senderRole && ["owner", "admin", "operations", "coach"].includes(r.senderRole),
      mine: r.m.senderUserId === v.userId,
      deliveries: visibleDeliveries.filter((x) => x.d.messageId === r.m.id).map((x) => ({ ...x.d, recipientName: x.recipientName })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

async function addParticipant(tx: Tx, threadId: string, p: { personId?: string | null; userId?: string | null; role: (typeof threadParticipants.$inferSelect)["role"]; read?: boolean }) {
  const existing = await tx
    .select()
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threadId),
        p.userId ? eq(threadParticipants.userId, p.userId) : eq(threadParticipants.personId, p.personId!),
      ),
    );
  if (existing.length) return existing[0];
  const [row] = await tx
    .insert(threadParticipants)
    .values({ threadId, personId: p.personId ?? null, userId: p.userId ?? null, role: p.role, lastReadAt: p.read ? new Date() : null })
    .returning();
  return row;
}

async function staffParticipant(tx: Tx, v: Viewer, threadId: string) {
  return addParticipant(tx, threadId, { userId: v.userId, personId: v.personId, role: "staff", read: true });
}

async function existingByCmid(tx: Tx, key: string | null) {
  if (!key) return null;
  const [m] = await tx.select().from(messages).where(eq(messages.clientMutationId, key));
  return m ?? null;
}

const startStaffSchema = z.object({
  athleteId: z.string().uuid("Choose an athlete"),
  subject: subjectSchema,
  body: bodySchema,
  channels: z.array(z.enum(["email", "sms"])).default([]),
  mode: z.enum(["separate", "group"]).default("separate"),
  clientMutationId: z.string().min(8).max(100).optional(),
});

/**
 * Staff starts a conversation with a family about an athlete. Recipients follow
 * guardian routing rules; by default each recipient gets their own conversation
 * ("separate") so co-parents never see each other's replies.
 */
export async function startStaffThread(tx: Tx, v: Viewer, input: z.input<typeof startStaffSchema>, now = new Date()) {
  assertCan(v, "messages.inbox");
  const data = startStaffSchema.parse(input);
  const caps = await athleteCapabilities(tx, v, data.athleteId);
  if (!caps.has("messages.send")) throw new AuthzError("You can only message families of athletes you are assigned to.");

  const prior = await existingByCmid(tx, cmidFor(v, data.clientMutationId, ":0"));
  if (prior) {
    const all = await tx.select({ threadId: messages.threadId }).from(messages).where(like(messages.clientMutationId, `${v.userId}:${data.clientMutationId}:%`));
    return { threadIds: [...new Set(all.map((r) => r.threadId))], duplicate: true };
  }

  const settings = await messagingSettings(tx, v.orgId);
  const route = await routeForAthlete(tx, v.orgId, data.athleteId, settings);
  if (!route) throw new UserError("Athlete not found.");
  if (!route.recipients.length) {
    throw new UserError(
      `No one can receive messages about ${route.athleteFirstName}: ${route.excluded.map((e) => `${e.name} — ${e.reason}`).join("; ") || "no active guardians"}.`,
    );
  }
  const groups: Recipient[][] = data.mode === "group" ? [route.recipients] : route.recipients.map((r) => [r]);
  const threadIds: string[] = [];
  for (const [i, group] of groups.entries()) {
    const [t] = await tx
      .insert(threads)
      .values({
        orgId: v.orgId,
        subject: data.subject,
        athleteId: data.athleteId,
        kind: route.isMinor ? "family" : "athlete",
        assignedUserId: v.userId,
        status: "open",
        lastMessageAt: now,
      })
      .returning();
    await staffParticipant(tx, v, t.id);
    for (const r of group) await addParticipant(tx, t.id, { personId: r.personId, userId: r.userId, role: r.role });
    const [m] = await tx
      .insert(messages)
      .values({ threadId: t.id, senderUserId: v.userId, senderPersonId: v.personId, body: data.body, clientMutationId: cmidFor(v, data.clientMutationId, `:${i}`), createdAt: now })
      .returning();
    await createDeliveries(tx, { orgId: v.orgId, messageId: m.id, recipients: group, channels: data.channels, now, settings });
    await audit(tx, actor(v), "messaging.thread_started", "thread", t.id, {
      summary: `Started "${data.subject}" with ${group.map((r) => `${r.firstName} ${r.lastName}`).join(", ")}`,
      after: { athleteId: data.athleteId, recipients: group.map((r) => r.personId), channels: ["in_app", ...data.channels] },
    });
    threadIds.push(t.id);
  }
  return { threadIds, duplicate: false };
}

const startFamilySchema = z.object({
  athleteId: z.string().uuid("Choose an athlete"),
  subject: subjectSchema,
  body: bodySchema,
  clientMutationId: z.string().min(8).max(100).optional(),
});

/** Guardian/athlete starts a conversation with staff about an athlete they may message about. */
export async function startFamilyThread(tx: Tx, v: Viewer, input: z.input<typeof startFamilySchema>, now = new Date()) {
  if ((v.role !== "guardian" && v.role !== "athlete") || !v.personId) throw new AuthzError();
  const data = startFamilySchema.parse(input);
  const caps = await athleteCapabilities(tx, v, data.athleteId);
  if (!caps.has("messages.send")) throw new AuthzError("You are not permitted to message staff about this athlete.");
  const settings = await messagingSettings(tx, v.orgId);
  const route = await routeForAthlete(tx, v.orgId, data.athleteId, settings);
  if (!route) throw new AuthzError();
  if (v.role === "athlete" && route.isMinor && !settings.minorAthletesMayMessage) {
    throw new AuthzError("Messages about minors go through a parent or guardian. Ask them to message the team.");
  }

  const prior = await existingByCmid(tx, cmidFor(v, data.clientMutationId));
  if (prior) return { threadId: prior.threadId, duplicate: true };

  const [t] = await tx
    .insert(threads)
    .values({ orgId: v.orgId, subject: data.subject, athleteId: data.athleteId, kind: route.isMinor ? "family" : "athlete", status: "open", lastMessageAt: now })
    .returning();
  await addParticipant(tx, t.id, { personId: v.personId, userId: v.userId, role: v.role === "guardian" ? "guardian" : "athlete", read: true });
  const [first] = await tx
    .insert(messages)
    .values({ threadId: t.id, senderUserId: v.userId, senderPersonId: v.personId, body: data.body, clientMutationId: cmidFor(v, data.clientMutationId), createdAt: now })
    .returning({ id: messages.id });
  await audit(tx, actor(v), "messaging.thread_started", "thread", t.id, { summary: `Family started "${data.subject}"`, after: { athleteId: data.athleteId } });
  await suggestSafely(tx, { orgId: v.orgId, body: `${data.subject}\n${data.body}`, sentAt: now, channel: "in_app", senderPersonId: v.personId, threadId: t.id, messageId: first.id });
  return { threadId: t.id, duplicate: false };
}

const postSchema = z.object({
  threadId: z.string().uuid(),
  body: bodySchema,
  internal: z.boolean().default(false),
  channels: z.array(z.enum(["email", "sms"])).default([]),
  clientMutationId: z.string().min(8).max(100).optional(),
});

/** Re-validates a family participant against current guardian links before delivering. */
async function stillEligible(tx: Tx, orgId: string, t: Thread, p: { personId: string | null; role: string }, routeCache: Map<string, Set<string>>) {
  if (!p.personId) return false;
  if (!t.athleteId) return true;
  if (!routeCache.has(t.athleteId)) {
    const r = await routeForAthlete(tx, orgId, t.athleteId);
    routeCache.set(t.athleteId, new Set(r?.recipients.map((x) => x.personId) ?? []));
  }
  return routeCache.get(t.athleteId)!.has(p.personId);
}

/**
 * Reply in a thread. Internal notes (staff only) are stored but never delivered.
 * Idempotent per (sender, clientMutationId).
 */
export async function postMessage(tx: Tx, v: Viewer, input: z.input<typeof postSchema>, now = new Date()) {
  const data = postSchema.parse(input);
  const t = await loadThreadRow(tx, v, data.threadId);
  const mode = await threadAccess(tx, v, t);
  if (data.internal && mode !== "staff") throw new AuthzError("Only staff can add internal notes.");
  if (mode === "staff" && t.athleteId && !data.internal) {
    const caps = await athleteCapabilities(tx, v, t.athleteId);
    if (!caps.has("messages.send")) throw new AuthzError();
  }
  const key = cmidFor(v, data.clientMutationId);
  const prior = await existingByCmid(tx, key);
  if (prior) {
    if (prior.threadId !== t.id) throw new UserError("Duplicate submission id.");
    return { messageId: prior.id, duplicate: true };
  }

  if (mode === "staff") await staffParticipant(tx, v, t.id);
  const [m] = await tx
    .insert(messages)
    .values({ threadId: t.id, senderUserId: v.userId, senderPersonId: v.personId, body: data.body, isInternalNote: data.internal, clientMutationId: key, createdAt: now })
    .returning();

  if (!data.internal) {
    const parts = await tx.select().from(threadParticipants).where(eq(threadParticipants.threadId, t.id));
    const cache = new Map<string, Set<string>>();
    const recipients: Recipient[] = [];
    for (const p of parts) {
      if (p.personId && p.personId === v.personId) continue;
      if (p.userId && p.userId === v.userId) continue;
      if (p.role === "staff") {
        // Family → staff: in-app only. Staff → staff copies are not needed (shared inbox).
        if (mode === "family" && p.personId) {
          const r = await recipientForPerson(tx, v.orgId, p.personId, "staff");
          if (r) recipients.push(r);
        }
        continue;
      }
      if (!(await stillEligible(tx, v.orgId, t, p, cache))) continue;
      const r = await recipientForPerson(tx, v.orgId, p.personId!, p.role);
      if (r) recipients.push(r);
    }
    await createDeliveries(tx, { orgId: v.orgId, messageId: m.id, recipients, channels: mode === "staff" ? data.channels : [], now });
    await tx.update(threads).set({ lastMessageAt: now, status: t.status === "closed" && mode === "family" ? "open" : t.status }).where(eq(threads.id, t.id));
    if (t.leadId && mode === "staff") await tx.update(leads).set({ lastContactedAt: now, updatedAt: now }).where(and(eq(leads.id, t.leadId), eq(leads.orgId, v.orgId)));
  }
  await audit(tx, actor(v), data.internal ? "messaging.internal_note" : "messaging.message_sent", "thread", t.id, {
    summary: data.internal ? "Added internal note" : `Message sent (${mode})`,
    after: { messageId: m.id },
  });
  // Family asks (hold / pause / cancel / in season / card) become suggestions for staff to confirm.
  if (mode === "family" && !data.internal) {
    await suggestSafely(tx, { orgId: v.orgId, body: data.body, sentAt: now, channel: "in_app", senderPersonId: v.personId, threadId: t.id, messageId: m.id });
  }
  return { messageId: m.id, duplicate: false };
}

export async function markRead(tx: Tx, v: Viewer, threadId: string, now = new Date()) {
  const t = await loadThreadRow(tx, v, threadId);
  const mode = await threadAccess(tx, v, t);
  if (mode === "staff") {
    const p = await staffParticipant(tx, v, t.id);
    await tx.update(threadParticipants).set({ lastReadAt: now }).where(eq(threadParticipants.id, p.id));
  } else {
    await tx
      .update(threadParticipants)
      .set({ lastReadAt: now })
      .where(and(eq(threadParticipants.threadId, t.id), eq(threadParticipants.personId, v.personId!)));
  }
}

export async function assignThread(tx: Tx, v: Viewer, threadId: string, userId: string | null) {
  const t = await loadThreadRow(tx, v, threadId);
  if ((await threadAccess(tx, v, t)) !== "staff") throw new AuthzError();
  if (userId) {
    const [u] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.orgId, v.orgId)));
    if (!u || !["owner", "admin", "operations", "coach"].includes(u.role) || u.disabledAt) throw new UserError("Choose an active staff member.");
    if (u.role === "coach" && t.athleteId) {
      const ids = await coachAthleteIds(tx, { ...v, userId: u.id, role: "coach" });
      if (!ids.includes(t.athleteId)) throw new UserError("That coach is not assigned to this athlete.");
    }
  }
  await tx.update(threads).set({ assignedUserId: userId }).where(eq(threads.id, t.id));
  await audit(tx, actor(v), "messaging.thread_assigned", "thread", t.id, { before: { assignedUserId: t.assignedUserId }, after: { assignedUserId: userId } });
}

export async function setThreadStatus(tx: Tx, v: Viewer, threadId: string, status: "open" | "closed") {
  const t = await loadThreadRow(tx, v, threadId);
  if ((await threadAccess(tx, v, t)) !== "staff") throw new AuthzError();
  await tx.update(threads).set({ status }).where(eq(threads.id, t.id));
  await audit(tx, actor(v), status === "closed" ? "messaging.thread_closed" : "messaging.thread_reopened", "thread", t.id, { before: { status: t.status }, after: { status } });
}

const leadThreadSchema = z.object({
  leadId: z.string().uuid(),
  subject: subjectSchema,
  body: bodySchema,
  channels: z.array(z.enum(["email", "sms"])).default(["email"]),
  clientMutationId: z.string().min(8).max(100).optional(),
});

/** Staff messages a lead's contact (no login yet — external channels per consent). */
export async function startLeadThread(tx: Tx, v: Viewer, input: z.input<typeof leadThreadSchema>, now = new Date()) {
  assertCan(v, "crm.manage");
  const data = leadThreadSchema.parse(input);
  const [l] = await tx.select().from(leads).where(and(eq(leads.id, data.leadId), eq(leads.orgId, v.orgId)));
  if (!l) throw new UserError("Lead not found.");
  const prior = await existingByCmid(tx, cmidFor(v, data.clientMutationId));
  if (prior) return { threadId: prior.threadId, duplicate: true };
  const contact = await recipientForPerson(tx, v.orgId, l.contactPersonId ?? l.personId, "lead_contact");
  if (!contact) throw new UserError("Lead contact not found.");
  const [t] = await tx
    .insert(threads)
    .values({ orgId: v.orgId, subject: data.subject, leadId: l.id, kind: "lead", assignedUserId: v.userId, lastMessageAt: now })
    .returning();
  await staffParticipant(tx, v, t.id);
  await addParticipant(tx, t.id, { personId: contact.personId, userId: contact.userId, role: "lead_contact" });
  const [m] = await tx
    .insert(messages)
    .values({ threadId: t.id, senderUserId: v.userId, senderPersonId: v.personId, body: data.body, clientMutationId: cmidFor(v, data.clientMutationId), createdAt: now })
    .returning();
  await createDeliveries(tx, { orgId: v.orgId, messageId: m.id, recipients: [contact], channels: data.channels, now });
  await tx.update(leads).set({ lastContactedAt: now, updatedAt: now }).where(eq(leads.id, l.id));
  await audit(tx, actor(v), "messaging.thread_started", "thread", t.id, { summary: `Messaged lead contact ${contact.firstName} ${contact.lastName}`, after: { leadId: l.id } });
  return { threadId: t.id, duplicate: false };
}

/**
 * System/automation send to ONE recipient, in its own thread. `dedupeKey` is stored as
 * the message client mutation id (unique), so the same automation never sends twice.
 */
export async function systemSend(
  tx: Tx,
  input: {
    orgId: string;
    recipient: Recipient;
    subject: string;
    body: string;
    channels: Channel[];
    athleteId?: string | null;
    leadId?: string | null;
    automationRuleId?: string | null;
    /** Broadcast campaign: email then requires explicit opt-in (re-checked at send time). */
    campaignId?: string | null;
    dedupeKey: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const [prior] = await tx.select({ id: messages.id, threadId: messages.threadId }).from(messages).where(eq(messages.clientMutationId, input.dedupeKey));
  if (prior) return { messageId: prior.id, threadId: prior.threadId, duplicate: true };
  const kind: ThreadKind = input.leadId && !input.athleteId ? "lead" : input.recipient.role === "athlete" ? "athlete" : "family";
  const [t] = await tx
    .insert(threads)
    .values({ orgId: input.orgId, subject: input.subject, athleteId: input.athleteId ?? null, leadId: input.leadId ?? null, kind, lastMessageAt: now })
    .returning();
  await addParticipant(tx, t.id, { personId: input.recipient.personId, userId: input.recipient.userId, role: input.recipient.role });
  const [m] = await tx
    .insert(messages)
    .values({ threadId: t.id, body: input.body, automationRuleId: input.automationRuleId ?? null, campaignId: input.campaignId ?? null, clientMutationId: input.dedupeKey, createdAt: now })
    .onConflictDoNothing({ target: messages.clientMutationId })
    .returning();
  if (!m) throw new Error("dedupe race"); // caller's transaction rolls back the empty thread
  await createDeliveries(tx, { orgId: input.orgId, messageId: m.id, recipients: [input.recipient], channels: input.channels, now, requireEmailOptIn: !!input.campaignId });
  return { messageId: m.id, threadId: t.id, duplicate: false };
}

/**
 * May this (non-staff) person still take part in the thread? They must be a participant and,
 * for athlete threads, still be routed for that athlete (active link that allows messaging).
 */
export async function familyParticipantEligible(tx: Tx, t: Thread, personId: string): Promise<boolean> {
  if (t.kind === "staff") return false;
  const [p] = await tx
    .select()
    .from(threadParticipants)
    .where(and(eq(threadParticipants.threadId, t.id), eq(threadParticipants.personId, personId), sql`${threadParticipants.role} <> 'staff'`));
  if (!p) return false;
  return stillEligible(tx, t.orgId, t, p, new Map());
}

/**
 * Records a reply that arrived by email/SMS (provider webhook or staff attaching an unmatched
 * inbound message). Staff participants get an in-app copy; nothing is sent externally.
 */
export async function postInboundMessage(
  tx: Tx,
  input: { thread: Thread; senderPersonId: string | null; body: string; channel: "email" | "sms"; now?: Date; actor?: { userId: string; role: string } },
) {
  const now = input.now ?? new Date();
  const t = input.thread;
  let senderUserId: string | null = null;
  if (input.senderPersonId) {
    const [u] = await tx.select({ id: users.id }).from(users).where(and(eq(users.personId, input.senderPersonId), eq(users.orgId, t.orgId)));
    senderUserId = u?.id ?? null;
  }
  const [m] = await tx
    .insert(messages)
    .values({ threadId: t.id, senderUserId, senderPersonId: input.senderPersonId, body: input.body.slice(0, 5000), inboundChannel: input.channel, createdAt: now })
    .returning();
  const parts = await tx.select().from(threadParticipants).where(eq(threadParticipants.threadId, t.id));
  const recipients: Recipient[] = [];
  for (const p of parts) {
    if (p.role !== "staff" || !p.personId) continue;
    const r = await recipientForPerson(tx, t.orgId, p.personId, "staff");
    if (r) recipients.push(r);
  }
  await createDeliveries(tx, { orgId: t.orgId, messageId: m.id, recipients, channels: [], now });
  await tx.update(threads).set({ lastMessageAt: now, status: t.status === "closed" ? "open" : t.status }).where(eq(threads.id, t.id));
  await audit(tx, { orgId: t.orgId, actorUserId: input.actor?.userId ?? null, actorRole: input.actor?.role ?? "webhook" }, "messaging.inbound_threaded", "thread", t.id, {
    summary: `${input.channel === "sms" ? "Text" : "Email"} reply added to the conversation${input.actor ? " by staff" : ""}`,
    after: { messageId: m.id },
  });
  return m;
}

/** Athletes the family viewer may start a conversation about. */
export async function messageableAthletes(tx: Tx, v: Viewer) {
  const ids = await accessibleAthleteIds(tx, v, "messages.send");
  if (ids !== "all" && !ids.length) return [];
  const rows = await tx
    .select({ id: athletes.id, first: people.firstName, last: people.lastName, dob: people.dateOfBirth })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.orgId, v.orgId), eq(athletes.active, true), ids === "all" ? sql`true` : inArray(athletes.id, ids)))
    .orderBy(asc(people.lastName), asc(people.firstName));
  if (v.role === "athlete") {
    const s = await messagingSettings(tx, v.orgId);
    if (!s.minorAthletesMayMessage) {
      return rows.filter((r) => r.dob && ageOn(r.dob, todayLocal(s.timezone)) >= 18).map((r) => ({ id: r.id, name: `${r.first} ${r.last}` }));
    }
  }
  return rows.map((r) => ({ id: r.id, name: `${r.first} ${r.last}` }));
}

export async function staffDirectory(tx: Tx, orgId: string) {
  return tx
    .select({ id: users.id, name: users.displayName, role: users.role })
    .from(users)
    .where(and(eq(users.orgId, orgId), or(eq(users.role, "owner"), eq(users.role, "admin"), eq(users.role, "operations"), eq(users.role, "coach")), sql`${users.disabledAt} is null`))
    .orderBy(asc(users.displayName));
}
