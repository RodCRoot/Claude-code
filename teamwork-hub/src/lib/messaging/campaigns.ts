import { and, desc, eq, sql } from "drizzle-orm";
import { lintBlockMessage, lintFamilyMessage } from "./family-style";
import { z } from "zod";
import type { Tx } from "@/db";
import { campaignRecipients, campaigns, jobs, messageTemplates, segments, users, type CampaignStatus } from "@/db/schema";
import { audit } from "@/lib/audit";
import { AuthzError, assertCan, isAdmin, type Viewer } from "@/lib/authz/policy";
import { enqueue } from "@/lib/jobs";
import { renderTemplate } from "@/lib/automation/templates";
import { localToUtc } from "@/lib/time";
import { undeliverableSet } from "./addresses";
import { planChannel, preferencesFor, type Channel, type ChannelPlan } from "./delivery";
import { DomainError } from "./errors";
import { messagingSettings, type MessagingSettings } from "./routing";
import { assertFiltersAllowed, joinNames, resolveSegment, type SegmentRecipient } from "./segments";
import { systemSend } from "./threads";

export type Campaign = typeof campaigns.$inferSelect;
export const CAMPAIGN_SEND_JOB = "campaign.send";

const actor = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

const campaignSchema = z.object({
  name: z.string().trim().min(1, "Name the campaign").max(120),
  templateId: z.string().uuid("Choose a template"),
  segmentId: z.string().uuid("Choose a segment"),
  channels: z.array(z.enum(["email", "sms"])).default([]),
  /** Facility-local "YYYY-MM-DDTHH:mm" (datetime-local input); empty = send on approval. */
  scheduledLocal: z.preprocess((x) => (x === "" || x == null ? undefined : x), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Use a valid date and time").optional()),
});

export function vars(r: SegmentRecipient, s: Pick<MessagingSettings, "orgName">): Record<string, string | null> {
  return {
    recipient_first_name: r.recipient.firstName,
    guardian_first_name: r.recipient.firstName,
    athlete_first_name: r.athleteFirstNames.length ? joinNames(r.athleteFirstNames) : r.leadFirstName,
    athlete_name: r.athleteNames.length ? joinNames(r.athleteNames) : null,
    lead_first_name: r.leadFirstName,
    org_name: s.orgName,
  };
}

async function loadTemplate(tx: Tx, orgId: string, id: string) {
  const [t] = await tx.select().from(messageTemplates).where(and(eq(messageTemplates.id, id), eq(messageTemplates.orgId, orgId)));
  return t ?? null;
}

async function loadSegment(tx: Tx, orgId: string, id: string) {
  const [s] = await tx.select().from(segments).where(and(eq(segments.id, id), eq(segments.orgId, orgId)));
  return s ?? null;
}

export async function getCampaign(tx: Tx, v: Viewer, id: string, opts: { lock?: boolean } = {}) {
  assertCan(v, "crm.manage");
  if (!z.string().uuid().safeParse(id).success) throw new DomainError("Campaign not found.");
  const q = tx.select().from(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.orgId, v.orgId)));
  const [c] = opts.lock ? await q.for("update") : await q;
  if (!c) throw new DomainError("Campaign not found.");
  return c;
}

export async function listCampaigns(tx: Tx, v: Viewer) {
  assertCan(v, "crm.manage");
  return tx
    .select({ c: campaigns, segmentName: segments.name, templateName: messageTemplates.name, createdBy: users.displayName })
    .from(campaigns)
    .innerJoin(segments, eq(segments.id, campaigns.segmentId))
    .innerJoin(messageTemplates, eq(messageTemplates.id, campaigns.templateId))
    .leftJoin(users, eq(users.id, campaigns.createdByUserId))
    .where(eq(campaigns.orgId, v.orgId))
    .orderBy(desc(campaigns.createdAt))
    .limit(200);
}

async function validate(tx: Tx, v: Viewer, d: z.infer<typeof campaignSchema>, tz: string) {
  const tpl = await loadTemplate(tx, v.orgId, d.templateId);
  if (!tpl) throw new DomainError("Template not found.", { templateId: "Choose a template" });
  const seg = await loadSegment(tx, v.orgId, d.segmentId);
  if (!seg || seg.archivedAt) throw new DomainError("Segment not found.", { segmentId: "Choose a segment" });
  await assertFiltersAllowed(tx, v, seg.filters);
  const scheduledAt = d.scheduledLocal ? localToUtc(d.scheduledLocal.slice(0, 10), d.scheduledLocal.slice(11, 16), tz) : null;
  return { tpl, seg, scheduledAt };
}

/** New campaigns start as drafts; nothing is sent until an owner/admin approves. */
export async function createCampaign(tx: Tx, v: Viewer, input: z.input<typeof campaignSchema>) {
  assertCan(v, "crm.manage");
  const d = campaignSchema.parse(input);
  const s = await messagingSettings(tx, v.orgId);
  const { scheduledAt } = await validate(tx, v, d, s.timezone);
  const [row] = await tx
    .insert(campaigns)
    .values({
      orgId: v.orgId,
      name: d.name,
      templateId: d.templateId,
      segmentId: d.segmentId,
      channels: ["in_app", ...d.channels],
      scheduledAt,
      status: "draft",
      createdByUserId: v.userId,
    })
    .returning();
  await audit(tx, actor(v), "messaging.campaign_created", "campaign", row.id, { summary: `Created campaign "${row.name}"`, after: { templateId: row.templateId, segmentId: row.segmentId, channels: row.channels, scheduledAt } });
  return row;
}

/** Editing a submitted campaign sends it back to draft (it must be approved again). */
export async function updateCampaign(tx: Tx, v: Viewer, id: string, input: z.input<typeof campaignSchema>) {
  const before = await getCampaign(tx, v, id, { lock: true });
  if (!["draft", "pending_approval"].includes(before.status)) throw new DomainError(`A ${before.status.replace("_", " ")} campaign can't be edited.`);
  const d = campaignSchema.parse(input);
  const s = await messagingSettings(tx, v.orgId);
  const { scheduledAt } = await validate(tx, v, d, s.timezone);
  await tx
    .update(campaigns)
    .set({
      name: d.name,
      templateId: d.templateId,
      segmentId: d.segmentId,
      channels: ["in_app", ...d.channels],
      scheduledAt,
      status: "draft",
      submittedAt: null,
      submittedByUserId: null,
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, id));
  await audit(tx, actor(v), "messaging.campaign_updated", "campaign", id, {
    summary: before.status === "pending_approval" ? "Edited — returned to draft for re-approval" : "Edited draft",
    before: { name: before.name, templateId: before.templateId, segmentId: before.segmentId, channels: before.channels, scheduledAt: before.scheduledAt, status: before.status },
    after: { name: d.name, templateId: d.templateId, segmentId: d.segmentId, channels: ["in_app", ...d.channels], scheduledAt, status: "draft" },
  });
}

/** Checks shared by submit and approve. */
async function readyToSend(tx: Tx, v: Viewer, c: Campaign, now: Date) {
  const tpl = await loadTemplate(tx, v.orgId, c.templateId);
  if (!tpl) throw new DomainError("The template no longer exists.");
  if (tpl.isSample) throw new DomainError(`"${tpl.name}" is marked SAMPLE. Replace the sample text and clear the SAMPLE flag before broadcasting it.`);
  const style = lintFamilyMessage(`${tpl.subject ? `${tpl.subject}\n` : ""}${tpl.body}`, { requireSignOff: false });
  if (!style.ok) throw new DomainError(lintBlockMessage(style, `Template "${tpl.name}"`));
  const seg = await loadSegment(tx, v.orgId, c.segmentId);
  if (!seg || seg.archivedAt) throw new DomainError("The segment no longer exists.");
  await assertFiltersAllowed(tx, v, seg.filters);
  if (c.scheduledAt && c.scheduledAt.getTime() < now.getTime() - 60_000) throw new DomainError("The scheduled time has passed. Choose a new time or clear it to send on approval.");
  const res = await resolveSegment(tx, v.orgId, seg.filters, now);
  if (!res.recipients.length) throw new DomainError("This segment currently reaches no one.");
  return { recipients: res.recipients.length };
}

export async function submitCampaign(tx: Tx, v: Viewer, id: string, now = new Date()) {
  const c = await getCampaign(tx, v, id, { lock: true });
  if (c.status !== "draft") throw new DomainError("Only drafts can be submitted for approval.");
  const { recipients } = await readyToSend(tx, v, c, now);
  await tx.update(campaigns).set({ status: "pending_approval", submittedAt: now, submittedByUserId: v.userId, reviewNote: null, updatedAt: now }).where(eq(campaigns.id, c.id));
  await audit(tx, actor(v), "messaging.campaign_submitted", "campaign", c.id, { summary: `Submitted for approval (${recipients} recipients right now)`, before: { status: c.status }, after: { status: "pending_approval" } });
}

/** Owner/admin approval. Queues the send at the scheduled time (or now) through the job outbox. */
export async function approveCampaign(tx: Tx, v: Viewer, id: string, now = new Date()) {
  if (!isAdmin(v)) throw new AuthzError("Only an owner or admin can approve a broadcast.");
  const c = await getCampaign(tx, v, id, { lock: true });
  if (c.status !== "pending_approval") throw new DomainError("Only campaigns awaiting approval can be approved.");
  const { recipients } = await readyToSend(tx, v, c, now);
  const runAt = c.scheduledAt && c.scheduledAt > now ? c.scheduledAt : now;
  await tx.update(campaigns).set({ status: "approved", approvedAt: now, approvedByUserId: v.userId, updatedAt: now }).where(eq(campaigns.id, c.id));
  await enqueue(tx, { type: CAMPAIGN_SEND_JOB, orgId: v.orgId, payload: { orgId: v.orgId, campaignId: c.id }, dedupeKey: `${CAMPAIGN_SEND_JOB}:${c.id}`, runAt, maxAttempts: 3 });
  await audit(tx, actor(v), "messaging.campaign_approved", "campaign", c.id, {
    summary: `Approved — ${recipients} recipients right now; sends ${c.scheduledAt && c.scheduledAt > now ? "at the scheduled time" : "now"}`,
    before: { status: c.status },
    after: { status: "approved", runAt },
  });
}

export async function rejectCampaign(tx: Tx, v: Viewer, id: string, note: string, now = new Date()) {
  if (!isAdmin(v)) throw new AuthzError("Only an owner or admin can review a broadcast.");
  const c = await getCampaign(tx, v, id, { lock: true });
  if (c.status !== "pending_approval") throw new DomainError("Only campaigns awaiting approval can be returned.");
  const reviewNote = z.string().trim().min(3, "Say what needs to change").max(500).parse(note);
  await tx.update(campaigns).set({ status: "draft", reviewNote, updatedAt: now }).where(eq(campaigns.id, c.id));
  await audit(tx, actor(v), "messaging.campaign_returned", "campaign", c.id, { summary: `Returned to draft: ${reviewNote}`, before: { status: c.status }, after: { status: "draft" } });
}

export async function cancelCampaign(tx: Tx, v: Viewer, id: string, now = new Date()) {
  const c = await getCampaign(tx, v, id, { lock: true });
  if (!["draft", "pending_approval", "approved"].includes(c.status)) throw new DomainError(`A ${c.status} campaign can't be cancelled.`);
  await tx.update(campaigns).set({ status: "cancelled", cancelledAt: now, updatedAt: now }).where(eq(campaigns.id, c.id));
  await tx
    .update(jobs)
    .set({ status: "cancelled", finishedAt: now })
    .where(and(eq(jobs.dedupeKey, `${CAMPAIGN_SEND_JOB}:${c.id}`), eq(jobs.status, "pending")));
  await audit(tx, actor(v), "messaging.campaign_cancelled", "campaign", c.id, { summary: "Cancelled before sending", before: { status: c.status }, after: { status: "cancelled" } });
}

// ---------------------------------------------------------------------------
// Preview (no writes)
// ---------------------------------------------------------------------------

export type CampaignPreviewRow = {
  personId: string;
  name: string;
  role: string;
  about: string;
  alreadySent: boolean;
  channels: ChannelPlan[];
};

/**
 * The exact recipient list as it stands now: segment → guardian routing → per-channel consent,
 * undeliverable addresses and quiet hours (evaluated at the scheduled time, or now).
 */
export async function previewCampaign(tx: Tx, v: Viewer, id: string, now = new Date()) {
  const c = await getCampaign(tx, v, id);
  const seg = await loadSegment(tx, v.orgId, c.segmentId);
  const tpl = await loadTemplate(tx, v.orgId, c.templateId);
  if (!seg || !tpl) throw new DomainError("The segment or template no longer exists.");
  await assertFiltersAllowed(tx, v, seg.filters);
  const s = await messagingSettings(tx, v.orgId);
  const at = c.scheduledAt && c.scheduledAt > now ? c.scheduledAt : now;
  const res = await resolveSegment(tx, v.orgId, seg.filters, now);
  const recips = res.recipients.map((r) => r.recipient);
  const prefs = await preferencesFor(tx, v.orgId, recips.map((r) => r.personId));
  const undeliverable = await undeliverableSet(tx, v.orgId, recips.flatMap((r) => [{ channel: "email" as const, address: r.email }, { channel: "sms" as const, address: r.phone }]));
  const done = new Set(
    (await tx.select({ personId: campaignRecipients.personId }).from(campaignRecipients).where(eq(campaignRecipients.campaignId, c.id))).map((r) => r.personId),
  );
  const channels = c.channels as Channel[];
  const rows: CampaignPreviewRow[] = res.recipients.map((r) => ({
    personId: r.recipient.personId,
    name: `${r.recipient.firstName} ${r.recipient.lastName}`,
    role: r.recipient.role,
    about: r.athleteNames.length ? joinNames(r.athleteNames) : r.leadFirstName ? `Lead: ${r.leadFirstName}` : "",
    alreadySent: done.has(r.recipient.personId),
    channels: channels.map((ch) => planChannel(r.recipient, ch, prefs, s, at, 0, { undeliverable, requireEmailOptIn: true })),
  }));
  const totals: Record<string, { queued: number; deferred: number; suppressed: number }> = {};
  for (const ch of channels) {
    const plans = rows.map((r) => r.channels.find((x) => x.channel === ch)!);
    totals[ch] = {
      queued: plans.filter((p) => p.status !== "suppressed").length,
      deferred: plans.filter((p) => p.status === "queued" && p.runAt && p.runAt.getTime() > at.getTime()).length,
      suppressed: plans.filter((p) => p.status === "suppressed").length,
    };
  }
  const first = res.recipients[0];
  const sample = first ? vars(first, s) : { org_name: s.orgName };
  const subject = renderTemplate(tpl.subject ?? c.name, sample);
  const body = renderTemplate(tpl.body, sample);
  return {
    campaign: c,
    at,
    matched: res.matched,
    audience: res.audience,
    rows,
    excluded: res.excluded,
    totals,
    sample: { subject: subject.text || c.name, body: body.text, missing: [...new Set([...subject.missing, ...body.missing])], forName: first ? `${first.recipient.firstName} ${first.recipient.lastName}` : null },
    templateIsSample: tpl.isSample,
  };
}

// ---------------------------------------------------------------------------
// Send (job handler body)
// ---------------------------------------------------------------------------

/**
 * Body of the `campaign.send` job. Re-resolves the segment at send time (consent and routing are
 * always current), then sends one message per person through systemSend + the delivery outbox.
 * Per-recipient dedupe: campaign_recipients (campaign, person) is unique and the message client id
 * is `campaign:<id>:<person>`, so a retried job never messages anyone twice.
 */
export async function sendCampaign(tx: Tx, p: { orgId: string; campaignId: string }, now = new Date()) {
  const [c] = await tx
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, p.campaignId), eq(campaigns.orgId, p.orgId)))
    .for("update");
  if (!c) return { skipped: "missing" };
  if (c.status !== "approved" && c.status !== "sending") return { skipped: c.status };
  if (c.scheduledAt && c.scheduledAt.getTime() > now.getTime() + 60_000) return { skipped: "not yet due" };
  const tpl = await loadTemplate(tx, c.orgId, c.templateId);
  const seg = await loadSegment(tx, c.orgId, c.segmentId);
  if (!tpl || !seg) throw new Error("campaign template or segment missing");
  await tx.update(campaigns).set({ status: "sending", startedAt: c.startedAt ?? now, updatedAt: now }).where(eq(campaigns.id, c.id));
  const s = await messagingSettings(tx, c.orgId);
  const res = await resolveSegment(tx, c.orgId, seg.filters, now);
  let sent = 0;
  for (const r of res.recipients) {
    const [row] = await tx
      .insert(campaignRecipients)
      .values({ orgId: c.orgId, campaignId: c.id, personId: r.recipient.personId, role: r.recipient.role, athleteIds: r.athleteIds, leadId: r.leadId })
      .onConflictDoNothing()
      .returning();
    if (!row) continue;
    const vv = vars(r, s);
    const msg = await systemSend(tx, {
      orgId: c.orgId,
      recipient: r.recipient,
      subject: renderTemplate(tpl.subject ?? c.name, vv).text || c.name,
      body: renderTemplate(tpl.body, vv).text,
      channels: c.channels as Channel[],
      athleteId: r.athleteIds.length === 1 ? r.athleteIds[0] : null,
      leadId: r.leadId,
      campaignId: c.id,
      dedupeKey: `campaign:${c.id}:${r.recipient.personId}`,
      now,
    });
    await tx.update(campaignRecipients).set({ messageId: msg.messageId, threadId: msg.threadId }).where(eq(campaignRecipients.id, row.id));
    if (!msg.duplicate) sent++;
  }
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(campaignRecipients).where(eq(campaignRecipients.campaignId, c.id));
  await tx.update(campaigns).set({ status: "sent", completedAt: now, recipientCount: n, updatedAt: now }).where(eq(campaigns.id, c.id));
  await audit(tx, { orgId: c.orgId, actorUserId: null, actorRole: "system" }, "messaging.campaign_sent", "campaign", c.id, { summary: `Sent to ${n} recipients`, after: { recipients: n, newThisRun: sent } });
  return { sent, recipients: n };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export const REPORT_STATUSES = ["queued", "suppressed", "not_configured", "test_redirected", "sent", "delivered", "failed"] as const;

/** Per-channel delivery outcome counts for a campaign's messages. */
export async function campaignReport(tx: Tx, v: Viewer, id: string) {
  const c = await getCampaign(tx, v, id);
  const res = await tx.execute(sql`
    select d.channel, d.status, count(*)::int as n
    from message_deliveries d join messages m on m.id = d.message_id
    where m.campaign_id = ${c.id}
    group by d.channel, d.status`);
  const byChannel: Record<string, Record<string, number>> = {};
  for (const r of res.rows as { channel: string; status: string; n: number }[]) {
    byChannel[r.channel] ??= {};
    byChannel[r.channel][r.status] = Number(r.n);
  }
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(campaignRecipients).where(eq(campaignRecipients.campaignId, c.id));
  const reasons = await tx.execute(sql`
    select d.channel, d.status_reason as reason, count(*)::int as n
    from message_deliveries d join messages m on m.id = d.message_id
    where m.campaign_id = ${c.id} and d.status in ('suppressed','failed','not_configured')
    group by d.channel, d.status_reason order by n desc limit 20`);
  return { recipients: n, byChannel, reasons: reasons.rows as { channel: string; reason: string | null; n: number }[] };
}

export function statusLabel(s: CampaignStatus): string {
  return s === "pending_approval" ? "awaiting approval" : s;
}

/** Campaigns whose status means they are still in play (used to protect segments/templates). */
export const OPEN_STATUSES: CampaignStatus[] = ["draft", "pending_approval", "approved", "sending"];
