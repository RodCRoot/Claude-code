import { and, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import {
  athletes,
  formAuditEvents,
  formRequests,
  formTemplates,
  formTemplateVersions,
  groupMembers,
  groups,
  people,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { enqueue } from "@/lib/jobs";
import { UserError } from "@/lib/actions";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { localYmd } from "@/lib/time";
import { athleteFormStatus } from "./status";
import { isOpen, OPEN_STATUSES, signingGuardians } from "./context";

export async function formEvent(tx: Tx, formRequestId: string, event: string, actorUserId: string | null, details: Record<string, unknown> = {}) {
  await tx.insert(formAuditEvents).values({ formRequestId, event, actorUserId, details });
}

export async function currentPublishedVersion(tx: Tx, templateId: string) {
  const [v] = await tx
    .select()
    .from(formTemplateVersions)
    .where(and(eq(formTemplateVersions.templateId, templateId), eq(formTemplateVersions.status, "published")))
    .orderBy(desc(formTemplateVersions.version))
    .limit(1);
  return v ?? null;
}

/** Low-level insert used by issuing, superseding, renewals and the seed. */
export async function createRequest(
  tx: Tx,
  input: {
    orgId: string;
    versionId: string;
    athleteId: string;
    subjectPersonId: string;
    requestedBy: string | null;
    dueDate?: string | null;
    isDemo?: boolean;
    reason?: string;
    notify?: boolean;
  },
) {
  const [r] = await tx
    .insert(formRequests)
    .values({
      orgId: input.orgId,
      templateVersionId: input.versionId,
      subjectPersonId: input.subjectPersonId,
      athleteId: input.athleteId,
      requestedBy: input.requestedBy,
      dueDate: input.dueDate ?? null,
      isDemo: input.isDemo ?? false,
    })
    .returning();
  await formEvent(tx, r.id, "issued", input.requestedBy, { reason: input.reason ?? "staff_issue", versionId: input.versionId, dueDate: input.dueDate ?? null });
  if (input.notify !== false) await enqueueReminder(tx, r, "new_request");
  return r;
}

/**
 * Job contract — type "forms.reminder" (delivered by the messaging module):
 * payload = { orgId, formRequestId, athleteId, subjectPersonId, templateName, versionTitle,
 *             dueDate (YYYY-MM-DD|null), reason ("new_request"|"reminder"|"renewal"|"resign_required"),
 *             recipientPersonIds: string[]  // guardians with forms.sign, or the adult/self subject
 *             link: "/documents/requests/<id>" }
 * dedupeKey = "forms.reminder:<requestId>:<reason>:<YYYY-MM-DD>" (at most one per request/reason/day).
 */
export async function enqueueReminder(tx: Tx, r: typeof formRequests.$inferSelect, reason: string, now = new Date()) {
  const [info] = await tx
    .select({ templateName: formTemplates.name, versionTitle: formTemplateVersions.title })
    .from(formTemplateVersions)
    .innerJoin(formTemplates, eq(formTemplates.id, formTemplateVersions.templateId))
    .where(eq(formTemplateVersions.id, r.templateVersionId));
  const recipients = new Set<string>();
  if (r.athleteId) for (const g of await signingGuardians(tx, r.orgId, r.athleteId)) recipients.add(g.personId);
  recipients.add(r.subjectPersonId);
  return enqueue(tx, {
    type: "forms.reminder",
    orgId: r.orgId,
    dedupeKey: `forms.reminder:${r.id}:${reason}:${localYmd(now)}`,
    payload: {
      orgId: r.orgId,
      formRequestId: r.id,
      athleteId: r.athleteId,
      subjectPersonId: r.subjectPersonId,
      templateName: info?.templateName ?? null,
      versionTitle: info?.versionTitle ?? null,
      dueDate: r.dueDate,
      reason,
      recipientPersonIds: [...recipients],
      link: `/documents/requests/${r.id}`,
    },
  });
}

export type IssueTarget = { kind: "athlete"; athleteId: string } | { kind: "group"; groupId: string } | { kind: "missing" };

/**
 * Issue requests for a template's current published version. Skips athletes that
 * already have an open request for the template (and, for "missing", those whose
 * form is currently valid).
 */
export async function issueRequests(tx: Tx, v: Viewer, input: { templateId: string; target: IssueTarget; dueDate?: string | null }, now = new Date()) {
  assertCan(v, "forms.manage");
  const [tpl] = await tx.select().from(formTemplates).where(and(eq(formTemplates.id, input.templateId), eq(formTemplates.orgId, v.orgId)));
  if (!tpl) throw new UserError("Form template not found.");
  if (!tpl.active) throw new UserError("This template is inactive. Reactivate it before issuing requests.");
  const version = await currentPublishedVersion(tx, tpl.id);
  if (!version) throw new UserError("Publish a version of this template before issuing requests.");

  let candidates: { id: string; personId: string }[] = [];
  if (input.target.kind === "athlete") {
    candidates = await tx
      .select({ id: athletes.id, personId: athletes.personId })
      .from(athletes)
      .where(and(eq(athletes.id, input.target.athleteId), eq(athletes.orgId, v.orgId)));
    if (!candidates.length) throw new UserError("Athlete not found.");
  } else if (input.target.kind === "group") {
    const [g] = await tx.select().from(groups).where(and(eq(groups.id, input.target.groupId), eq(groups.orgId, v.orgId)));
    if (!g) throw new UserError("Group not found.");
    candidates = await tx
      .select({ id: athletes.id, personId: athletes.personId })
      .from(groupMembers)
      .innerJoin(athletes, eq(athletes.id, groupMembers.athleteId))
      .where(and(eq(groupMembers.groupId, g.id), eq(athletes.active, true)));
  } else {
    candidates = await tx
      .select({ id: athletes.id, personId: athletes.personId })
      .from(athletes)
      .where(and(eq(athletes.orgId, v.orgId), eq(athletes.active, true)));
  }
  const status = await athleteFormStatus(
    tx,
    v.orgId,
    candidates.map((c) => c.id),
    [{ id: tpl.id, name: tpl.name }],
    now,
  );
  let created = 0;
  let skipped = 0;
  const ids: string[] = [];
  for (const c of candidates) {
    const st = status.get(c.id)?.[0];
    const hasOpen = st && (st.state === "pending" || st.state === "partially_signed");
    const valid = st?.state === "valid";
    if (hasOpen || (input.target.kind === "missing" && valid)) {
      skipped++;
      continue;
    }
    const r = await createRequest(tx, {
      orgId: v.orgId,
      versionId: version.id,
      athleteId: c.id,
      subjectPersonId: c.personId,
      requestedBy: v.userId,
      dueDate: input.dueDate ?? null,
      reason: `issue_${input.target.kind}`,
    });
    ids.push(r.id);
    created++;
  }
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "forms.issue", "form_template", tpl.id, {
    summary: `Issued ${created} request(s) for ${tpl.name} v${version.version} (${input.target.kind}); skipped ${skipped}`,
    after: { created, skipped, target: input.target, dueDate: input.dueDate ?? null },
  });
  return { created, skipped, ids };
}

export async function voidRequest(tx: Tx, v: Viewer, requestId: string, reason: string, opts: { reissue?: boolean } = {}) {
  assertCan(v, "forms.manage");
  if (!reason.trim()) throw new UserError("A reason is required.");
  const [r] = await tx
    .select()
    .from(formRequests)
    .where(and(eq(formRequests.id, requestId), eq(formRequests.orgId, v.orgId)))
    .for("update");
  if (!r) throw new UserError("Request not found.");
  if (!isOpen(r.status)) throw new UserError("Only pending or partially signed requests can be voided. Completed forms are permanent records.");
  let newId: string | null = null;
  if (opts.reissue) {
    const [ver] = await tx.select().from(formTemplateVersions).where(eq(formTemplateVersions.id, r.templateVersionId));
    const cur = await currentPublishedVersion(tx, ver.templateId);
    if (!cur) throw new UserError("No published version to reissue.");
    const n = await createRequest(tx, {
      orgId: r.orgId,
      versionId: cur.id,
      athleteId: r.athleteId!,
      subjectPersonId: r.subjectPersonId,
      requestedBy: v.userId,
      dueDate: r.dueDate,
      isDemo: r.isDemo,
      reason: "reissue_after_void",
    });
    newId = n.id;
  }
  await tx.update(formRequests).set({ status: "voided", supersededById: newId }).where(eq(formRequests.id, r.id));
  await formEvent(tx, r.id, "voided", v.userId, { reason, from: r.status, reissuedAs: newId });
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "forms.void", "form_request", r.id, {
    summary: `Voided form request${newId ? " and reissued" : ""}: ${reason}`,
    before: { status: r.status },
    after: { status: "voided", reissuedAs: newId },
  });
  return { newId };
}

export async function sendReminder(tx: Tx, v: Viewer, requestId: string, now = new Date()) {
  assertCan(v, "forms.manage");
  const [r] = await tx
    .select()
    .from(formRequests)
    .where(and(eq(formRequests.id, requestId), eq(formRequests.orgId, v.orgId)))
    .for("update");
  if (!r) throw new UserError("Request not found.");
  if (!isOpen(r.status)) throw new UserError("Reminders are only sent for open requests.");
  const jobId = await enqueueReminder(tx, r, "reminder", now);
  if (!jobId) return { queued: false };
  await tx
    .update(formRequests)
    .set({ lastReminderAt: now, reminderCount: sql`${formRequests.reminderCount} + 1` })
    .where(eq(formRequests.id, r.id));
  await formEvent(tx, r.id, "reminder_queued", v.userId, { jobId });
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "forms.remind", "form_request", r.id, { summary: "Queued form reminder" });
  return { queued: true };
}

/** Remind every open request that is past due (or has no due date and is > 7 days old). */
export async function remindOverdue(tx: Tx, v: Viewer, now = new Date()) {
  assertCan(v, "forms.manage");
  const today = localYmd(now);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const open = await tx
    .select()
    .from(formRequests)
    .where(
      and(
        eq(formRequests.orgId, v.orgId),
        inArray(formRequests.status, [...OPEN_STATUSES]),
        sql`((${formRequests.dueDate} is not null and ${formRequests.dueDate} <= ${today}) or (${formRequests.dueDate} is null and ${formRequests.createdAt} <= ${weekAgo.toISOString()}))`,
      ),
    );
  let queued = 0;
  for (const r of open) if ((await sendReminder(tx, v, r.id, now)).queued) queued++;
  return { queued, considered: open.length };
}

/**
 * Renewal sweep: completed requests whose renewal period has passed become
 * "expired", and a new request on the template's current published version is
 * issued (unless one is already open). Idempotent.
 */
export async function processRenewals(tx: Tx, orgId: string, opts: { now?: Date; actorUserId?: string | null } = {}) {
  const now = opts.now ?? new Date();
  const due = await tx
    .select({ r: formRequests, templateId: formTemplateVersions.templateId, active: formTemplates.active })
    .from(formRequests)
    .innerJoin(formTemplateVersions, eq(formTemplateVersions.id, formRequests.templateVersionId))
    .innerJoin(formTemplates, eq(formTemplates.id, formTemplateVersions.templateId))
    .where(and(eq(formRequests.orgId, orgId), eq(formRequests.status, "completed"), isNotNull(formRequests.expiresAt), lte(formRequests.expiresAt, now)))
    .for("update", { of: formRequests });
  let expired = 0;
  let renewed = 0;
  for (const { r, templateId, active } of due) {
    await tx.update(formRequests).set({ status: "expired" }).where(eq(formRequests.id, r.id));
    await formEvent(tx, r.id, "expired", opts.actorUserId ?? null, { expiresAt: r.expiresAt?.toISOString() });
    expired++;
    if (!active || !r.athleteId) continue;
    const openExisting = await tx
      .select({ id: formRequests.id })
      .from(formRequests)
      .innerJoin(formTemplateVersions, eq(formTemplateVersions.id, formRequests.templateVersionId))
      .where(and(eq(formRequests.athleteId, r.athleteId), eq(formTemplateVersions.templateId, templateId), inArray(formRequests.status, [...OPEN_STATUSES])));
    if (openExisting.length) continue;
    const cur = await currentPublishedVersion(tx, templateId);
    if (!cur) continue;
    const n = await createRequest(tx, {
      orgId,
      versionId: cur.id,
      athleteId: r.athleteId,
      subjectPersonId: r.subjectPersonId,
      requestedBy: opts.actorUserId ?? null,
      dueDate: localYmd(new Date(now.getTime() + 14 * 86_400_000)),
      isDemo: r.isDemo,
      reason: "renewal",
      notify: false,
    });
    await enqueueReminder(tx, n, "renewal", now);
    await formEvent(tx, r.id, "renewal_issued", opts.actorUserId ?? null, { newRequestId: n.id });
    renewed++;
  }
  if (expired) {
    await audit(tx, { orgId, actorUserId: opts.actorUserId ?? null }, "forms.renewals", "organization", orgId, {
      summary: `Renewal sweep: ${expired} expired, ${renewed} renewal request(s) issued`,
    });
  }
  return { expired, renewed };
}

/** Name helper for list pages. */
export async function personName(tx: Tx, personId: string) {
  const [p] = await tx.select({ f: people.firstName, l: people.lastName }).from(people).where(eq(people.id, personId));
  return p ? `${p.f} ${p.l}` : "Unknown";
}
