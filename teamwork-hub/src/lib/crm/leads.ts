import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Tx } from "@/db";
import {
  auditEvents,
  leads,
  notes,
  people,
  personTags,
  scheduleSessions,
  serviceTypes,
  tags,
  tasks,
  threads,
  users,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { DomainError } from "@/lib/messaging/errors";
import { ageOn } from "@/lib/messaging/routing";
import { localToUtc, todayLocal } from "@/lib/time";
import type { PossibleDuplicate } from "./intake";
import { listStages } from "./stages";

export type Lead = typeof leads.$inferSelect;
const actor = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

export type LeadFilters = {
  stage?: string;
  owner?: string; // user id | "me" | "none"
  source?: string;
  tag?: string; // tag id
  minAge?: number;
  maxAge?: number;
  q?: string;
  includeClosed?: boolean;
};

export type LeadRow = {
  id: string;
  stage: string;
  source: string | null;
  interest: string | null;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  age: number | null;
  ownerUserId: string | null;
  ownerName: string | null;
  lastContactedAt: Date | null;
  createdAt: Date;
  convertedAt: Date | null;
  possibleDuplicate: boolean;
  tags: { id: string; name: string }[];
  openTasks: number;
};

/** Lead's age: inquiry age (as of submission) else date of birth. */
export function leadAge(lead: Pick<Lead, "inquiry">, dob: string | null, today: string): number | null {
  if (dob) return ageOn(dob, today);
  const a = (lead.inquiry as Record<string, unknown>)?.athleteAge;
  return typeof a === "number" ? a : null;
}

export function possibleDuplicates(lead: Pick<Lead, "inquiry">): PossibleDuplicate[] {
  const d = (lead.inquiry as Record<string, unknown>)?.possibleDuplicates;
  return Array.isArray(d) ? (d as PossibleDuplicate[]) : [];
}

export async function listLeads(tx: Tx, v: Viewer, f: LeadFilters = {}): Promise<LeadRow[]> {
  assertCan(v, "crm.manage");
  const contact = alias(people, "contact");
  const conds = [eq(leads.orgId, v.orgId)];
  if (f.stage) conds.push(eq(leads.stage, f.stage));
  if (f.owner === "me") conds.push(eq(leads.ownerUserId, v.userId));
  else if (f.owner === "none") conds.push(sql`${leads.ownerUserId} is null`);
  else if (f.owner && z.string().uuid().safeParse(f.owner).success) conds.push(eq(leads.ownerUserId, f.owner));
  if (f.source) conds.push(eq(leads.source, f.source));
  if (f.tag && z.string().uuid().safeParse(f.tag).success) {
    conds.push(
      sql`exists (select 1 from person_tags pt where pt.tag_id = ${f.tag} and (pt.person_id = ${leads.personId} or pt.person_id = ${leads.contactPersonId}))`,
    );
  }
  if (f.q?.trim()) {
    const q = `%${f.q.trim().replace(/[%_]/g, "")}%`;
    conds.push(
      sql`(${people.firstName} || ' ' || ${people.lastName} ilike ${q} or coalesce(${contact.firstName} || ' ' || ${contact.lastName}, '') ilike ${q} or coalesce(${contact.email}, ${people.email}, '') ilike ${q})`,
    );
  }
  const rows = await tx
    .select({
      lead: leads,
      first: people.firstName,
      last: people.lastName,
      dob: people.dateOfBirth,
      pEmail: people.email,
      pPhone: people.phone,
      cFirst: contact.firstName,
      cLast: contact.lastName,
      cEmail: contact.email,
      cPhone: contact.phone,
      ownerName: users.displayName,
      openTasks: sql<number>`(select count(*)::int from tasks tk where tk.related_type = 'lead' and tk.related_id = ${leads.id} and tk.status in ('open','in_progress'))`,
    })
    .from(leads)
    .innerJoin(people, eq(people.id, leads.personId))
    .leftJoin(contact, eq(contact.id, leads.contactPersonId))
    .leftJoin(users, eq(users.id, leads.ownerUserId))
    .where(and(...conds))
    .orderBy(desc(leads.createdAt))
    .limit(500);

  const personIds = [...new Set(rows.flatMap((r) => [r.lead.personId, r.lead.contactPersonId].filter(Boolean) as string[]))];
  const tagRows = personIds.length
    ? await tx
        .select({ personId: personTags.personId, id: tags.id, name: tags.name })
        .from(personTags)
        .innerJoin(tags, eq(tags.id, personTags.tagId))
        .where(inArray(personTags.personId, personIds))
    : [];
  const today = todayLocal();
  return rows
    .map<LeadRow>((r) => {
      const age = leadAge(r.lead, r.dob, today);
      const tagMap = new Map(tagRows.filter((t) => t.personId === r.lead.personId || t.personId === r.lead.contactPersonId).map((t) => [t.id, { id: t.id, name: t.name }]));
      return {
        id: r.lead.id,
        stage: r.lead.stage,
        source: r.lead.source,
        interest: r.lead.interest,
        name: `${r.first} ${r.last}`,
        contactName: r.cFirst ? `${r.cFirst} ${r.cLast}` : null,
        email: r.cEmail ?? r.pEmail,
        phone: r.cPhone ?? r.pPhone,
        age,
        ownerUserId: r.lead.ownerUserId,
        ownerName: r.ownerName,
        lastContactedAt: r.lead.lastContactedAt,
        createdAt: r.lead.createdAt,
        convertedAt: r.lead.convertedAt,
        possibleDuplicate: possibleDuplicates(r.lead).length > 0 && (r.lead.inquiry as Record<string, unknown>).duplicateReview !== "resolved",
        tags: [...tagMap.values()],
        openTasks: r.openTasks,
      };
    })
    .filter((r) => (f.minAge == null || (r.age != null && r.age >= f.minAge)) && (f.maxAge == null || (r.age != null && r.age <= f.maxAge)));
}

export async function leadSources(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await tx.selectDistinct({ s: leads.source }).from(leads).where(and(eq(leads.orgId, orgId), sql`${leads.source} is not null`));
  return rows.map((r) => r.s!).sort();
}

async function loadLead(tx: Tx, v: Viewer, leadId: string, lock = false): Promise<Lead> {
  assertCan(v, "crm.manage");
  if (!z.string().uuid().safeParse(leadId).success) throw new DomainError("Lead not found.");
  const q = tx.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.orgId, v.orgId)));
  const [l] = lock ? await q.for("update") : await q;
  if (!l) throw new DomainError("Lead not found.");
  return l;
}

export async function getLead(tx: Tx, v: Viewer, leadId: string) {
  const lead = await loadLead(tx, v, leadId);
  const [person] = await tx.select().from(people).where(eq(people.id, lead.personId));
  const [contact] = lead.contactPersonId ? await tx.select().from(people).where(eq(people.id, lead.contactPersonId)) : [];
  const [owner] = lead.ownerUserId ? await tx.select({ id: users.id, name: users.displayName }).from(users).where(eq(users.id, lead.ownerUserId)) : [];
  const personIds = [lead.personId, lead.contactPersonId].filter(Boolean) as string[];
  const leadNotes = await tx
    .select({ id: notes.id, body: notes.body, createdAt: notes.createdAt, author: users.displayName })
    .from(notes)
    .leftJoin(users, eq(users.id, notes.authorUserId))
    .where(and(eq(notes.orgId, v.orgId), inArray(notes.subjectPersonId, personIds), eq(notes.category, "lead")))
    .orderBy(desc(notes.createdAt));
  const leadTasks = await tx
    .select({ t: tasks, assignee: users.displayName })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeUserId))
    .where(and(eq(tasks.orgId, v.orgId), eq(tasks.relatedType, "lead"), eq(tasks.relatedId, lead.id)))
    .orderBy(asc(tasks.status), asc(tasks.dueAt));
  const history = await tx
    .select({ e: auditEvents, actor: users.displayName })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(and(eq(auditEvents.orgId, v.orgId), eq(auditEvents.entityType, "lead"), eq(auditEvents.entityId, lead.id)))
    .orderBy(desc(auditEvents.createdAt))
    .limit(100);
  const personTagRows = await tx
    .select({ id: tags.id, name: tags.name, personId: personTags.personId })
    .from(personTags)
    .innerJoin(tags, eq(tags.id, personTags.tagId))
    .where(inArray(personTags.personId, personIds));
  const allTags = await tx.select().from(tags).where(eq(tags.orgId, v.orgId)).orderBy(asc(tags.name));
  let assessment: { id: string; title: string; startsAt: Date; status: string } | null = null;
  if (lead.assessmentSessionId) {
    const [s] = await tx
      .select({ id: scheduleSessions.id, title: scheduleSessions.title, startsAt: scheduleSessions.startsAt, status: scheduleSessions.status })
      .from(scheduleSessions)
      .where(and(eq(scheduleSessions.id, lead.assessmentSessionId), eq(scheduleSessions.orgId, v.orgId)));
    assessment = s ?? null;
  }
  const leadThreads = await tx
    .select({ id: threads.id, subject: threads.subject, status: threads.status, lastMessageAt: threads.lastMessageAt })
    .from(threads)
    .where(and(eq(threads.orgId, v.orgId), eq(threads.leadId, lead.id)))
    .orderBy(desc(threads.lastMessageAt));
  return {
    lead,
    person,
    contact: contact ?? null,
    owner: owner ?? null,
    age: leadAge(lead, person?.dateOfBirth ?? null, todayLocal()),
    notes: leadNotes,
    tasks: leadTasks.map((r) => ({ ...r.t, assignee: r.assignee })),
    history: history.map((h) => ({ ...h.e, actorName: h.actor ?? (h.e.actorRole === "public" ? "Web inquiry" : h.e.actorRole === "system" ? "System" : null) })),
    tags: [...new Map(personTagRows.map((t) => [t.id, t])).values()],
    allTags,
    assessment,
    threads: leadThreads,
    possibleDuplicates: possibleDuplicates(lead),
    duplicateReview: ((lead.inquiry as Record<string, unknown>).duplicateReview as string) ?? "none",
  };
}

const stageSchema = z.object({ stage: z.string().min(1), lostReason: z.string().trim().max(500).optional() });

export async function changeStage(tx: Tx, v: Viewer, leadId: string, input: z.input<typeof stageSchema>) {
  const data = stageSchema.parse(input);
  const lead = await loadLead(tx, v, leadId, true);
  const stages = await listStages(tx, v.orgId);
  const target = stages.find((s) => s.key === data.stage);
  if (!target) throw new DomainError("Unknown stage.");
  if (target.key === lead.stage) return;
  if (target.isWon && !lead.convertedAt) throw new DomainError('Use "Convert to athlete" to mark a lead as won — it creates the athlete record through a review screen.');
  if (lead.convertedAt) throw new DomainError("This lead was already converted; its stage is locked.");
  if (target.isLost && !data.lostReason) throw new DomainError("Give a lost reason.", { lostReason: "Required when marking a lead lost" });
  await tx
    .update(leads)
    .set({ stage: target.key, lostReason: target.isLost ? data.lostReason! : null, updatedAt: new Date() })
    .where(eq(leads.id, lead.id));
  await audit(tx, actor(v), "crm.lead_stage_changed", "lead", lead.id, {
    summary: `Stage ${stages.find((s) => s.key === lead.stage)?.label ?? lead.stage} → ${target.label}${target.isLost ? ` (lost: ${data.lostReason})` : ""}`,
    before: { stage: lead.stage, lostReason: lead.lostReason },
    after: { stage: target.key, lostReason: target.isLost ? data.lostReason : null },
  });
}

export async function assignOwner(tx: Tx, v: Viewer, leadId: string, ownerUserId: string | null) {
  const lead = await loadLead(tx, v, leadId, true);
  if (ownerUserId) {
    const [u] = await tx.select().from(users).where(and(eq(users.id, ownerUserId), eq(users.orgId, v.orgId)));
    if (!u || !["owner", "admin", "operations", "coach"].includes(u.role) || u.disabledAt) throw new DomainError("Choose an active staff member.");
  }
  await tx.update(leads).set({ ownerUserId, updatedAt: new Date() }).where(eq(leads.id, lead.id));
  await audit(tx, actor(v), "crm.lead_owner_changed", "lead", lead.id, { before: { ownerUserId: lead.ownerUserId }, after: { ownerUserId } });
}

export async function addLeadNote(tx: Tx, v: Viewer, leadId: string, body: string) {
  const lead = await loadLead(tx, v, leadId);
  const text = z.string().trim().min(1, "Write a note").max(4000).parse(body);
  await tx.insert(notes).values({ orgId: v.orgId, subjectPersonId: lead.personId, authorUserId: v.userId, body: text, category: "lead", visibility: "staff" });
  await audit(tx, actor(v), "crm.lead_note_added", "lead", lead.id, { summary: "Note added" });
}

const taskSchema = z.object({
  title: z.string().trim().min(1, "Describe the task").max(200),
  dueDate: z.preprocess((x) => (x === "" ? undefined : x), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  assigneeUserId: z.preprocess((x) => (x === "" ? undefined : x), z.string().uuid().optional()),
});

export async function addLeadTask(tx: Tx, v: Viewer, leadId: string, input: z.input<typeof taskSchema>) {
  const lead = await loadLead(tx, v, leadId);
  const d = taskSchema.parse(input);
  if (d.assigneeUserId) {
    const [u] = await tx.select().from(users).where(and(eq(users.id, d.assigneeUserId), eq(users.orgId, v.orgId)));
    if (!u || !["owner", "admin", "operations", "coach"].includes(u.role)) throw new DomainError("Choose a staff member.");
  }
  const [t] = await tx
    .insert(tasks)
    .values({
      orgId: v.orgId,
      title: d.title,
      dueAt: d.dueDate ? localToUtc(d.dueDate, "17:00") : null,
      assigneeUserId: d.assigneeUserId ?? lead.ownerUserId ?? v.userId,
      relatedPersonId: lead.personId,
      relatedType: "lead",
      relatedId: lead.id,
      source: "crm",
      createdBy: v.userId,
    })
    .returning();
  await audit(tx, actor(v), "crm.lead_task_added", "lead", lead.id, { summary: `Task: ${d.title}`, after: { taskId: t.id } });
}

export async function completeLeadTask(tx: Tx, v: Viewer, taskId: string, done = true) {
  assertCan(v, "crm.manage");
  const [t] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.orgId, v.orgId), eq(tasks.relatedType, "lead")));
  if (!t) throw new DomainError("Task not found.");
  await tx
    .update(tasks)
    .set(done ? { status: "done", completedAt: new Date(), completedBy: v.userId } : { status: "open", completedAt: null, completedBy: null })
    .where(eq(tasks.id, t.id));
  await audit(tx, actor(v), done ? "crm.lead_task_done" : "crm.lead_task_reopened", "lead", t.relatedId, { summary: `${done ? "Completed" : "Reopened"} task: ${t.title}` });
}

export async function markContacted(tx: Tx, v: Viewer, leadId: string, method: string, now = new Date()) {
  const lead = await loadLead(tx, v, leadId, true);
  const m = z.enum(["phone", "email", "text", "in_person"]).parse(method);
  const stages = await listStages(tx, v.orgId);
  const contacted = stages.find((s) => s.key === "contacted");
  const moveStage = lead.stage === "new" && contacted;
  await tx
    .update(leads)
    .set({ lastContactedAt: now, stage: moveStage ? "contacted" : lead.stage, updatedAt: now })
    .where(eq(leads.id, lead.id));
  await audit(tx, actor(v), "crm.lead_contacted", "lead", lead.id, {
    summary: `Contacted by ${m.replace("_", " ")}${moveStage ? " · Stage New → Contacted" : ""}`,
    before: { stage: lead.stage },
    after: { stage: moveStage ? "contacted" : lead.stage, method: m },
  });
}

/** Upcoming scheduled sessions whose service type kind is `assessment` (owned by the Schedule module). */
export async function upcomingAssessmentSessions(tx: Tx, orgId: string, now = new Date()) {
  return tx
    .select({
      id: scheduleSessions.id,
      title: scheduleSessions.title,
      startsAt: scheduleSessions.startsAt,
      capacity: scheduleSessions.capacity,
      serviceName: serviceTypes.name,
      linkedLeads: sql<number>`(select count(*)::int from leads l where l.assessment_session_id = ${scheduleSessions.id} and l.converted_at is null)`,
      booked: sql<number>`(select count(*)::int from bookings b where b.session_id = ${scheduleSessions.id} and b.status in ('booked','attended'))`,
    })
    .from(scheduleSessions)
    .innerJoin(serviceTypes, eq(serviceTypes.id, scheduleSessions.serviceTypeId))
    .where(
      and(
        eq(scheduleSessions.orgId, orgId),
        eq(serviceTypes.kind, "assessment"),
        eq(scheduleSessions.status, "scheduled"),
        gt(scheduleSessions.startsAt, now),
      ),
    )
    .orderBy(asc(scheduleSessions.startsAt))
    .limit(50);
}

export async function scheduleAssessment(tx: Tx, v: Viewer, leadId: string, sessionId: string | null, now = new Date()) {
  const lead = await loadLead(tx, v, leadId, true);
  if (lead.convertedAt) throw new DomainError("This lead was already converted.");
  let label = "cleared";
  if (sessionId) {
    const options = await upcomingAssessmentSessions(tx, v.orgId, now);
    const s = options.find((o) => o.id === sessionId);
    if (!s) throw new DomainError("Choose an upcoming assessment session.");
    if (s.linkedLeads + s.booked >= s.capacity && lead.assessmentSessionId !== s.id) throw new DomainError("That assessment session is full.");
    label = `${s.title} (${s.startsAt.toISOString()})`;
  }
  const stages = await listStages(tx, v.orgId);
  const booked = stages.find((s) => s.key === "assessment_booked");
  const order = (k: string) => stages.find((s) => s.key === k)?.sortOrder ?? 0;
  const advance = sessionId && booked && !stages.find((s) => s.key === lead.stage)?.isLost && order(lead.stage) < booked.sortOrder;
  await tx
    .update(leads)
    .set({ assessmentSessionId: sessionId, stage: advance ? booked!.key : lead.stage, updatedAt: now })
    .where(eq(leads.id, lead.id));
  await audit(tx, actor(v), "crm.lead_assessment_scheduled", "lead", lead.id, {
    summary: sessionId ? `Assessment scheduled: ${label}${advance ? ` · Stage → ${booked!.label}` : ""}` : "Assessment cleared",
    before: { assessmentSessionId: lead.assessmentSessionId, stage: lead.stage },
    after: { assessmentSessionId: sessionId, stage: advance ? booked!.key : lead.stage },
  });
}

export async function setLeadTag(tx: Tx, v: Viewer, leadId: string, tagId: string, on: boolean) {
  const lead = await loadLead(tx, v, leadId);
  const [t] = await tx.select().from(tags).where(and(eq(tags.id, tagId), eq(tags.orgId, v.orgId)));
  if (!t) throw new DomainError("Tag not found.");
  if (on) await tx.insert(personTags).values({ personId: lead.personId, tagId }).onConflictDoNothing();
  else await tx.delete(personTags).where(and(eq(personTags.personId, lead.personId), eq(personTags.tagId, tagId)));
  await audit(tx, actor(v), on ? "crm.lead_tagged" : "crm.lead_untagged", "lead", lead.id, { summary: `${on ? "Tagged" : "Untagged"} ${t.name}` });
}

/** Staff acknowledges the duplicate flag without converting (e.g. different people sharing a family email). */
export async function resolveDuplicateFlag(tx: Tx, v: Viewer, leadId: string, note: string) {
  const lead = await loadLead(tx, v, leadId, true);
  const text = z.string().trim().min(1, "Say why these are different people").max(500).parse(note);
  await tx
    .update(leads)
    .set({ inquiry: { ...lead.inquiry, duplicateReview: "resolved", duplicateReviewNote: text }, updatedAt: new Date() })
    .where(eq(leads.id, lead.id));
  await audit(tx, actor(v), "crm.lead_duplicate_reviewed", "lead", lead.id, { summary: `Duplicate flag reviewed: ${text}` });
}
