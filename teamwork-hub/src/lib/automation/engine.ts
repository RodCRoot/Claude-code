import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import {
  athletes,
  automationRules,
  bookings,
  formRequests,
  formTemplateVersions,
  invoices,
  jobs,
  leads,
  memberships,
  messageTemplates,
  messages,
  payerAuthorizations,
  paymentAttempts,
  people,
  scheduleSessions,
  serviceTypes,
  tasks,
  type AutomationTrigger,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { enqueue } from "@/lib/jobs";
import { formatMoney } from "@/lib/money";
import { planChannel, preferencesFor, type Channel, type ChannelPlan } from "@/lib/messaging/delivery";
import { DomainError } from "@/lib/messaging/errors";
import { messagingSettings, recipientForPerson, routeForAthlete, type MessagingSettings, type Recipient } from "@/lib/messaging/routing";
import { systemSend } from "@/lib/messaging/threads";
import { addDaysYmd, fmt, fmtDate, todayLocal } from "@/lib/time";
import { renderTemplate } from "./templates";
import { getRule, ruleConditions, TRIGGERS, type RuleConditions } from "./rules";

/** Narrows evaluation to one entity. Without a scope, scan-style triggers examine the whole org. */
export type Scope = {
  sessionId?: string;
  sessionVersion?: number;
  leadId?: string;
  athleteId?: string;
  formRequestId?: string;
  paymentAttemptId?: string;
  membershipId?: string;
};

/** One thing that happened, to be told to some people. */
export type Candidate = {
  entityType: string;
  entityId: string;
  /** Distinguishes repeat occurrences of the same entity (e.g. a session's version). */
  period: string;
  label: string;
  athleteId: string | null;
  leadId: string | null;
  recipients: Recipient[];
  vars: Record<string, string | null>;
  taskAssigneeUserId: string | null;
  relatedPersonId: string | null;
};

const SCAN_LIMIT = 500;

export function dedupeKeyFor(ruleId: string, c: Pick<Candidate, "entityType" | "entityId" | "period">, recipientPersonId: string) {
  return `auto:${ruleId}:${c.entityType}:${c.entityId}:${recipientPersonId}:${c.period}`;
}

async function athleteRecipients(tx: Tx, orgId: string, athleteId: string, s: MessagingSettings) {
  const r = await routeForAthlete(tx, orgId, athleteId, s);
  return r ? { recipients: r.recipients, first: r.athleteFirstName, name: `${r.athleteFirstName} ${r.athleteLastName}`, personId: r.athletePersonId } : null;
}

async function athleteSport(tx: Tx, athleteId: string) {
  const [a] = await tx.select({ sport: athletes.sport }).from(athletes).where(eq(athletes.id, athleteId));
  return a?.sport ?? null;
}

/**
 * Finds what a trigger applies to right now. Read-only: used by evaluation, by the
 * delayed dispatch (to re-check the situation still applies) and by previews.
 */
export async function findCandidates(
  tx: Tx,
  orgId: string,
  trigger: AutomationTrigger,
  cond: RuleConditions,
  scope: Scope,
  now = new Date(),
): Promise<Candidate[]> {
  const s = await messagingSettings(tx, orgId);
  const tz = s.timezone;
  const out: Candidate[] = [];
  const sportOk = async (athleteId: string) => !cond.sport || (await athleteSport(tx, athleteId))?.toLowerCase() === cond.sport.toLowerCase();
  const days = cond.days ?? TRIGGERS.find((t) => t.key === trigger)?.defaultDays ?? 7;

  switch (trigger) {
    case "session_cancelled":
    case "session_changed":
    case "assessment_completed": {
      if (!scope.sessionId) return [];
      const [sess] = await tx
        .select({ s: scheduleSessions, kind: serviceTypes.kind })
        .from(scheduleSessions)
        .innerJoin(serviceTypes, eq(serviceTypes.id, scheduleSessions.serviceTypeId))
        .where(and(eq(scheduleSessions.id, scope.sessionId), eq(scheduleSessions.orgId, orgId)));
      if (!sess) return [];
      if (cond.serviceKind && sess.kind !== cond.serviceKind) return [];
      if (trigger === "session_cancelled" && sess.s.status !== "cancelled") return [];
      if (trigger === "assessment_completed" && (sess.kind !== "assessment" || sess.s.status !== "completed")) return [];
      const period = trigger === "session_changed" ? `v${scope.sessionVersion ?? sess.s.version}` : trigger === "session_cancelled" ? "cancelled" : "completed";
      const vars = { session_title: sess.s.title, session_time: fmt(sess.s.startsAt, "EEE MMM d, h:mm a", tz) };
      // Bookings still live, plus those cancelled together with the session (within 10 minutes of its last update).
      const bk = await tx
        .select({ athleteId: bookings.athleteId })
        .from(bookings)
        .where(
          and(
            eq(bookings.sessionId, sess.s.id),
            trigger === "assessment_completed"
              ? inArray(bookings.status, ["attended", "booked"])
              : sql`(${bookings.status} in ('booked','waitlisted') or (${bookings.status} = 'cancelled' and ${bookings.cancelledAt} >= ${sess.s.updatedAt}::timestamptz - interval '10 minutes'))`,
          ),
        );
      for (const b of [...new Set(bk.map((x) => x.athleteId))]) {
        if (!(await sportOk(b))) continue;
        const a = await athleteRecipients(tx, orgId, b, s);
        if (!a) continue;
        out.push({
          entityType: "session",
          entityId: sess.s.id,
          period: `${period}:${b}`,
          label: `${sess.s.title} — ${a.name}`,
          athleteId: b,
          leadId: null,
          recipients: a.recipients,
          vars: { ...vars, athlete_first_name: a.first, athlete_name: a.name },
          taskAssigneeUserId: sess.s.coachUserId,
          relatedPersonId: a.personId,
        });
      }
      if (trigger === "assessment_completed") {
        const ls = await tx.select().from(leads).where(and(eq(leads.orgId, orgId), eq(leads.assessmentSessionId, sess.s.id), sql`${leads.convertedAt} is null`));
        for (const l of ls) {
          const c = await leadCandidate(tx, orgId, l, "completed", vars);
          if (c) out.push({ ...c, entityType: "session", entityId: sess.s.id, period: `completed:lead:${l.id}` });
        }
      }
      return out;
    }

    case "lead_created": {
      const conds = [eq(leads.orgId, orgId), sql`${leads.convertedAt} is null`];
      if (scope.leadId) conds.push(eq(leads.id, scope.leadId));
      else conds.push(sql`${leads.createdAt} >= ${new Date(now.getTime() - 2 * 86_400_000)}`);
      const ls = await tx.select().from(leads).where(and(...conds)).orderBy(desc(leads.createdAt)).limit(SCAN_LIMIT);
      for (const l of ls) {
        if (cond.sport && (l.interest ?? "").toLowerCase() !== cond.sport.toLowerCase()) continue;
        const c = await leadCandidate(tx, orgId, l, "created", {});
        if (c) out.push(c);
      }
      return out;
    }

    case "form_missing": {
      const cutoff = new Date(now.getTime() - days * 86_400_000);
      const conds = [eq(formRequests.orgId, orgId), eq(formRequests.status, "pending"), sql`${formRequests.createdAt} <= ${cutoff}`];
      if (scope.formRequestId) conds.push(eq(formRequests.id, scope.formRequestId));
      if (scope.athleteId) conds.push(eq(formRequests.athleteId, scope.athleteId));
      const rows = await tx
        .select({ f: formRequests, title: formTemplateVersions.title })
        .from(formRequests)
        .innerJoin(formTemplateVersions, eq(formTemplateVersions.id, formRequests.templateVersionId))
        .where(and(...conds))
        .limit(SCAN_LIMIT);
      for (const r of rows) {
        let recipients: Recipient[] = [];
        let athleteVars: Record<string, string> = {};
        if (r.f.athleteId) {
          if (!(await sportOk(r.f.athleteId))) continue;
          const a = await athleteRecipients(tx, orgId, r.f.athleteId, s);
          if (!a) continue;
          recipients = a.recipients;
          athleteVars = { athlete_first_name: a.first, athlete_name: a.name };
        } else {
          const p = await recipientForPerson(tx, orgId, r.f.subjectPersonId, "athlete");
          if (p) recipients = [p];
        }
        out.push({
          entityType: "form_request",
          entityId: r.f.id,
          period: "pending",
          label: `${r.title} — ${athleteVars.athlete_name ?? recipients[0]?.firstName ?? "?"}`,
          athleteId: r.f.athleteId,
          leadId: null,
          recipients,
          vars: { form_name: r.title, ...athleteVars },
          taskAssigneeUserId: null,
          relatedPersonId: r.f.subjectPersonId,
        });
      }
      return out;
    }

    case "payment_failed": {
      const since = new Date(now.getTime() - days * 86_400_000);
      const conds = [eq(paymentAttempts.orgId, orgId), eq(paymentAttempts.status, "failed"), sql`${paymentAttempts.updatedAt} >= ${since}`];
      if (scope.paymentAttemptId) conds.push(eq(paymentAttempts.id, scope.paymentAttemptId));
      const rows = await tx
        .select({ p: paymentAttempts, inv: invoices })
        .from(paymentAttempts)
        .innerJoin(invoices, eq(invoices.id, paymentAttempts.invoiceId))
        .where(and(...conds))
        .limit(SCAN_LIMIT);
      for (const r of rows) {
        // An invoice paid since (e.g. by another method) no longer needs a nudge.
        if (r.inv.status === "paid" || r.inv.status === "void") continue;
        const auths = await tx
          .select({ personId: payerAuthorizations.personId })
          .from(payerAuthorizations)
          .where(and(eq(payerAuthorizations.payerAccountId, r.inv.payerAccountId), eq(payerAuthorizations.canViewInvoices, true)));
        const recipients = (await Promise.all(auths.map((a) => recipientForPerson(tx, orgId, a.personId, "guardian")))).filter(Boolean) as Recipient[];
        out.push({
          entityType: "payment_attempt",
          entityId: r.p.id,
          period: "failed",
          label: `Invoice ${r.inv.number} — ${formatMoney(r.inv.totalMinor, r.inv.currency)}`,
          athleteId: null,
          leadId: null,
          recipients,
          vars: { invoice_number: r.inv.number, invoice_amount: formatMoney(r.inv.totalMinor, r.inv.currency) },
          taskAssigneeUserId: null,
          relatedPersonId: recipients[0]?.personId ?? null,
        });
      }
      return out;
    }

    case "renewal_upcoming": {
      const today = todayLocal(tz, now);
      const until = addDaysYmd(today, days);
      const conds = [
        eq(memberships.orgId, orgId),
        eq(memberships.status, "active"),
        sql`coalesce(${memberships.endDate}, ${memberships.nextBillDate}) between ${today} and ${until}`,
      ];
      if (scope.membershipId) conds.push(eq(memberships.id, scope.membershipId));
      const rows = await tx.select().from(memberships).where(and(...conds)).limit(SCAN_LIMIT);
      for (const m of rows) {
        if (!(await sportOk(m.athleteId))) continue;
        const a = await athleteRecipients(tx, orgId, m.athleteId, s);
        if (!a) continue;
        let recipients = a.recipients;
        if (m.payerAccountId) {
          const auths = await tx
            .select({ personId: payerAuthorizations.personId })
            .from(payerAuthorizations)
            .where(and(eq(payerAuthorizations.payerAccountId, m.payerAccountId), eq(payerAuthorizations.canViewInvoices, true)));
          const payers = (await Promise.all(auths.map((x) => recipientForPerson(tx, orgId, x.personId, "guardian")))).filter(Boolean) as Recipient[];
          if (payers.length) recipients = payers;
        }
        const date = (m.endDate ?? m.nextBillDate)!;
        out.push({
          entityType: "membership",
          entityId: m.id,
          period: date,
          label: `${a.name} — renews ${fmtDate(date)}`,
          athleteId: m.athleteId,
          leadId: null,
          recipients,
          vars: { athlete_first_name: a.first, athlete_name: a.name, renewal_date: fmtDate(date) },
          taskAssigneeUserId: null,
          relatedPersonId: a.personId,
        });
      }
      return out;
    }

    case "membership_restart_upcoming": {
      // A hold / in-season pause whose restart (day after it ends) is ahead. Billing schedules this check per
      // membership at restart − restartNudgeDaysBefore; with a membership scope the day window is not applied.
      const today = todayLocal(tz, now);
      const res = await tx.execute(sql`
        select m.id, m.athlete_id, m.payer_account_id, h.id as hold_id, h.kind, (h.end_date + 1)::text as restart
        from membership_holds h join memberships m on m.id = h.membership_id
        where m.org_id = ${orgId} and m.status in ('active','on_hold','past_due','pending')
          and h.end_date >= ${today}::date
          ${scope.membershipId ? sql`and m.id = ${scope.membershipId}` : sql`and h.end_date + 1 <= ${addDaysYmd(today, days)}::date`}
        limit ${SCAN_LIMIT}`);
      for (const r of res.rows as { id: string; athlete_id: string; payer_account_id: string | null; hold_id: string; kind: string; restart: string }[]) {
        if (!(await sportOk(r.athlete_id))) continue;
        const a = await athleteRecipients(tx, orgId, r.athlete_id, s);
        if (!a) continue;
        let recipients = a.recipients;
        if (r.payer_account_id) {
          const auths = await tx
            .select({ personId: payerAuthorizations.personId })
            .from(payerAuthorizations)
            .where(and(eq(payerAuthorizations.payerAccountId, r.payer_account_id), eq(payerAuthorizations.canViewInvoices, true)));
          const payers = (await Promise.all(auths.map((x) => recipientForPerson(tx, orgId, x.personId, "guardian")))).filter(Boolean) as Recipient[];
          if (payers.length) recipients = payers;
        }
        out.push({
          entityType: "membership",
          entityId: r.id,
          period: `restart:${r.hold_id}`,
          label: `${a.name} restarts ${fmtDate(r.restart)}`,
          athleteId: r.athlete_id,
          leadId: null,
          recipients,
          vars: { athlete_first_name: a.first, athlete_name: a.name, restart_date: fmtDate(r.restart), pause_kind: r.kind === "in_season" ? "in-season term" : "hold" },
          taskAssigneeUserId: null,
          relatedPersonId: a.personId,
        });
      }
      return out;
    }

    case "attendance_lapsed": {
      const cutoff = new Date(now.getTime() - days * 86_400_000);
      const floor = new Date(now.getTime() - 120 * 86_400_000);
      const res = await tx.execute(sql`
        select b.athlete_id, max(s.starts_at) as last_at
        from bookings b join schedule_sessions s on s.id = b.session_id
        join athletes a on a.id = b.athlete_id
        where b.org_id = ${orgId} and b.status = 'attended' and a.active
          ${scope.athleteId ? sql`and b.athlete_id = ${scope.athleteId}` : sql``}
        group by b.athlete_id
        having max(s.starts_at) < ${cutoff} and max(s.starts_at) >= ${floor}
        limit ${SCAN_LIMIT}`);
      for (const row of res.rows as { athlete_id: string; last_at: string | Date }[]) {
        if (!(await sportOk(row.athlete_id))) continue;
        // Upcoming bookings mean they're coming back — no nudge.
        const [up] = await tx
          .select({ id: bookings.id })
          .from(bookings)
          .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
          .where(and(eq(bookings.athleteId, row.athlete_id), eq(bookings.status, "booked"), sql`${scheduleSessions.startsAt} > ${now}`))
          .limit(1);
        if (up) continue;
        const a = await athleteRecipients(tx, orgId, row.athlete_id, s);
        if (!a) continue;
        const last = new Date(row.last_at);
        const lastYmd = todayLocal(tz, last);
        out.push({
          entityType: "athlete",
          entityId: row.athlete_id,
          period: `last:${lastYmd}`,
          label: `${a.name} — last attended ${fmtDate(lastYmd)}`,
          athleteId: row.athlete_id,
          leadId: null,
          recipients: a.recipients,
          vars: {
            athlete_first_name: a.first,
            athlete_name: a.name,
            last_attended_date: fmtDate(lastYmd),
            days_since_attended: String(Math.floor((now.getTime() - last.getTime()) / 86_400_000)),
          },
          taskAssigneeUserId: null,
          relatedPersonId: a.personId,
        });
      }
      return out;
    }
  }
}

async function leadCandidate(tx: Tx, orgId: string, l: typeof leads.$inferSelect, period: string, extra: Record<string, string>): Promise<Candidate | null> {
  const contact = await recipientForPerson(tx, orgId, l.contactPersonId ?? l.personId, "lead_contact");
  const [p] = await tx.select({ first: people.firstName, last: people.lastName }).from(people).where(eq(people.id, l.personId));
  if (!contact || !p) return null;
  return {
    entityType: "lead",
    entityId: l.id,
    period,
    label: `Lead ${p.first} ${p.last}`,
    athleteId: null,
    leadId: l.id,
    recipients: [contact],
    vars: { ...extra, lead_first_name: p.first, athlete_first_name: p.first, athlete_name: `${p.first} ${p.last}` },
    taskAssigneeUserId: l.ownerUserId,
    relatedPersonId: l.personId,
  };
}

function baseVars(r: Recipient, s: MessagingSettings): Record<string, string> {
  return { recipient_first_name: r.firstName, guardian_first_name: r.firstName, org_name: s.orgName };
}

// ---------------------------------------------------------------------------
// Evaluation → dispatch
// ---------------------------------------------------------------------------

export type EvaluatePayload = { orgId: string; trigger?: AutomationTrigger; ruleId?: string } & Scope;

/**
 * Evaluates enabled rules and enqueues one `automation.dispatch` job per
 * (rule, entity, recipient, period). The job dedupe key is unique forever, so
 * evaluating the same situation again never sends twice.
 */
export async function evaluate(tx: Tx, p: EvaluatePayload, now = new Date()) {
  const conds = [eq(automationRules.orgId, p.orgId), eq(automationRules.enabled, true)];
  if (p.trigger) conds.push(eq(automationRules.trigger, p.trigger));
  if (p.ruleId) conds.push(eq(automationRules.id, p.ruleId));
  const rules = await tx.select().from(automationRules).where(and(...conds));
  let enqueued = 0;
  let skipped = 0;
  let tasksCreated = 0;
  for (const rule of rules) {
    if (!rule.templateId) continue;
    const cands = await findCandidates(tx, p.orgId, rule.trigger, ruleConditions(rule), p, now);
    for (const c of cands) {
      for (const r of c.recipients) {
        const key = dedupeKeyFor(rule.id, c, r.personId);
        const id = await enqueue(tx, {
          type: "automation.dispatch",
          orgId: p.orgId,
          dedupeKey: key,
          runAt: new Date(now.getTime() + rule.delayMinutes * 60_000),
          payload: { orgId: p.orgId, ruleId: rule.id, dedupeKey: key, recipientPersonId: r.personId, entityType: c.entityType, entityId: c.entityId, period: c.period, scope: scopeFor(rule.trigger, c, p) },
        });
        if (id) enqueued++;
        else skipped++;
      }
      if (rule.createTask) {
        const inserted = await tx
          .insert(tasks)
          .values({
            orgId: p.orgId,
            title: `${rule.name}: ${c.label}`,
            assigneeUserId: c.taskAssigneeUserId,
            relatedPersonId: c.relatedPersonId,
            relatedType: c.leadId ? "lead" : c.entityType,
            relatedId: c.leadId ?? c.entityId,
            source: "automation",
            dedupeKey: `autotask:${rule.id}:${c.entityType}:${c.entityId}:${c.period}`,
            dueAt: new Date(now.getTime() + 24 * 3_600_000),
          })
          .onConflictDoNothing()
          .returning({ id: tasks.id });
        tasksCreated += inserted.length;
      }
    }
  }
  return { rules: rules.length, enqueued, skipped, tasksCreated };
}

function scopeFor(trigger: AutomationTrigger, c: Candidate, p: Scope): Scope {
  switch (c.entityType) {
    case "session":
      return { sessionId: c.entityId, sessionVersion: p.sessionVersion };
    case "lead":
      return { leadId: c.entityId };
    case "form_request":
      return { formRequestId: c.entityId };
    case "payment_attempt":
      return { paymentAttemptId: c.entityId };
    case "membership":
      return { membershipId: c.entityId };
    case "athlete":
      return { athleteId: c.entityId };
    default:
      return trigger ? p : {};
  }
}

/**
 * Job body for `automation.dispatch`: re-checks that the rule is still enabled and the
 * situation still applies (form not completed meanwhile, guardian still allowed, …),
 * renders the template and sends via systemSend (deduped by message client id).
 */
export async function dispatch(
  tx: Tx,
  p: { orgId: string; ruleId: string; dedupeKey: string; recipientPersonId: string; entityType: string; entityId: string; period: string; scope: Scope },
  now = new Date(),
) {
  const [rule] = await tx.select().from(automationRules).where(and(eq(automationRules.id, p.ruleId), eq(automationRules.orgId, p.orgId)));
  if (!rule) return { skipped: "rule deleted" };
  if (!rule.enabled) return { skipped: "rule disabled" };
  const cands = await findCandidates(tx, p.orgId, rule.trigger, ruleConditions(rule), p.scope, now);
  const c = cands.find((x) => x.entityType === p.entityType && x.entityId === p.entityId && x.period === p.period);
  const r = c?.recipients.find((x) => x.personId === p.recipientPersonId);
  if (!c || !r) return { skipped: "no longer applies" };
  const { templateId } = rule;
  const tpl = templateId ? await loadTemplate(tx, p.orgId, templateId) : null;
  if (!tpl) return { skipped: "template missing" };
  const s = await messagingSettings(tx, p.orgId);
  const vars = { ...baseVars(r, s), ...c.vars };
  const subject = renderTemplate(tpl.subject ?? rule.name, vars).text || rule.name;
  const body = renderTemplate(tpl.body, vars).text;
  const sent = await systemSend(tx, {
    orgId: p.orgId,
    recipient: r,
    subject,
    body,
    channels: rule.channels as Channel[],
    athleteId: c.athleteId,
    leadId: c.leadId,
    automationRuleId: rule.id,
    dedupeKey: p.dedupeKey,
    now,
  });
  if (!sent.duplicate) {
    await audit(tx, { orgId: p.orgId, actorUserId: null, actorRole: "system" }, "automation.sent", "automation_rule", rule.id, {
      summary: `"${rule.name}" → ${r.firstName} ${r.lastName} (${c.label})`,
      after: { messageId: sent.messageId, threadId: sent.threadId, dedupeKey: p.dedupeKey },
    });
  }
  return { messageId: sent.messageId, duplicate: sent.duplicate };
}

async function loadTemplate(tx: Tx, orgId: string, id: string) {
  const [t] = await tx.select().from(messageTemplates).where(and(eq(messageTemplates.id, id), eq(messageTemplates.orgId, orgId)));
  return t ?? null;
}

// ---------------------------------------------------------------------------
// Built-in operational notices (session cancelled / changed)
// ---------------------------------------------------------------------------

/**
 * Handler body for notify.session_cancelled / notify.session_changed. Enabled rules for
 * the trigger are evaluated; when none exist, families still get a plain in-app notice
 * (never email/SMS) so a cancellation is never silent.
 */
export async function notifySession(tx: Tx, kind: "session_cancelled" | "session_changed", payload: { sessionId: string; orgId?: string; version?: number }, now = new Date()) {
  const [sess] = await tx.select().from(scheduleSessions).where(eq(scheduleSessions.id, payload.sessionId));
  if (!sess) return { skipped: "session not found" };
  const orgId = sess.orgId;
  const version = payload.version ?? sess.version;
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(automationRules)
    .where(and(eq(automationRules.orgId, orgId), eq(automationRules.trigger, kind), eq(automationRules.enabled, true)));
  if (n > 0) return { mode: "rules", ...(await evaluate(tx, { orgId, trigger: kind, sessionId: sess.id, sessionVersion: version }, now)) };

  const cands = await findCandidates(tx, orgId, kind, {}, { sessionId: sess.id, sessionVersion: version }, now);
  const s = await messagingSettings(tx, orgId);
  let sent = 0;
  for (const c of cands) {
    for (const r of c.recipients) {
      const subject = kind === "session_cancelled" ? `Cancelled: ${c.vars.session_title}` : `Updated: ${c.vars.session_title}`;
      const body =
        kind === "session_cancelled"
          ? `Hi ${r.firstName}, ${c.vars.session_title} on ${c.vars.session_time} for ${c.vars.athlete_first_name} has been cancelled. Reply here with any questions. — ${s.orgName}`
          : `Hi ${r.firstName}, ${c.vars.session_title} for ${c.vars.athlete_first_name} has changed. It is now ${c.vars.session_time}. Reply here with any questions. — ${s.orgName}`;
      const res = await systemSend(tx, {
        orgId,
        recipient: r,
        subject,
        body,
        channels: ["in_app"],
        athleteId: c.athleteId,
        dedupeKey: `notify:${kind}:${sess.id}:${c.period}:${r.personId}`,
        now,
      });
      if (!res.duplicate) sent++;
    }
  }
  return { mode: "default_in_app", sent };
}

// ---------------------------------------------------------------------------
// Preview (no writes)
// ---------------------------------------------------------------------------

export type PreviewRecipient = {
  personId: string;
  name: string;
  role: string;
  alreadySent: boolean;
  channels: ChannelPlan[];
};

export type PreviewItem = {
  label: string;
  subject: string;
  body: string;
  missing: string[];
  recipients: PreviewRecipient[];
  excludedNote: string | null;
};

/** Sample records an admin can preview a rule against. */
export async function sampleOptions(tx: Tx, orgId: string, trigger: AutomationTrigger): Promise<{ id: string; label: string }[]> {
  switch (trigger) {
    case "session_cancelled":
    case "session_changed":
    case "assessment_completed": {
      const rows = await tx
        .select({ id: scheduleSessions.id, title: scheduleSessions.title, startsAt: scheduleSessions.startsAt, status: scheduleSessions.status, kind: serviceTypes.kind })
        .from(scheduleSessions)
        .innerJoin(serviceTypes, eq(serviceTypes.id, scheduleSessions.serviceTypeId))
        .where(and(eq(scheduleSessions.orgId, orgId), trigger === "assessment_completed" ? eq(serviceTypes.kind, "assessment") : sql`true`))
        .orderBy(desc(scheduleSessions.startsAt))
        .limit(40);
      return rows.map((r) => ({ id: r.id, label: `${r.title} · ${fmt(r.startsAt)} · ${r.status}` }));
    }
    case "lead_created": {
      const rows = await tx
        .select({ id: leads.id, first: people.firstName, last: people.lastName, createdAt: leads.createdAt })
        .from(leads)
        .innerJoin(people, eq(people.id, leads.personId))
        .where(eq(leads.orgId, orgId))
        .orderBy(desc(leads.createdAt))
        .limit(40);
      return rows.map((r) => ({ id: r.id, label: `${r.first} ${r.last} · ${fmtDate(r.createdAt)}` }));
    }
    case "form_missing": {
      const rows = await tx
        .select({ id: formRequests.id, title: formTemplateVersions.title, first: people.firstName, last: people.lastName, status: formRequests.status })
        .from(formRequests)
        .innerJoin(formTemplateVersions, eq(formTemplateVersions.id, formRequests.templateVersionId))
        .innerJoin(people, eq(people.id, formRequests.subjectPersonId))
        .where(eq(formRequests.orgId, orgId))
        .orderBy(desc(formRequests.createdAt))
        .limit(40);
      return rows.map((r) => ({ id: r.id, label: `${r.title} · ${r.first} ${r.last} · ${r.status}` }));
    }
    case "payment_failed": {
      const rows = await tx
        .select({ id: paymentAttempts.id, number: invoices.number, status: paymentAttempts.status, amount: paymentAttempts.amountMinor, currency: paymentAttempts.currency })
        .from(paymentAttempts)
        .innerJoin(invoices, eq(invoices.id, paymentAttempts.invoiceId))
        .where(eq(paymentAttempts.orgId, orgId))
        .orderBy(desc(paymentAttempts.createdAt))
        .limit(40);
      return rows.map((r) => ({ id: r.id, label: `Invoice ${r.number} · ${formatMoney(r.amount, r.currency)} · ${r.status}` }));
    }
    case "renewal_upcoming":
    case "membership_restart_upcoming": {
      const rows = await tx
        .select({ id: memberships.id, first: people.firstName, last: people.lastName, status: memberships.status, end: memberships.endDate, next: memberships.nextBillDate })
        .from(memberships)
        .innerJoin(athletes, eq(athletes.id, memberships.athleteId))
        .innerJoin(people, eq(people.id, athletes.personId))
        .where(eq(memberships.orgId, orgId))
        .limit(40);
      return rows.map((r) => ({ id: r.id, label: `${r.first} ${r.last} · ${r.status} · ${r.end ?? r.next ?? "no date"}` }));
    }
    case "attendance_lapsed": {
      const rows = await tx
        .select({ id: athletes.id, first: people.firstName, last: people.lastName })
        .from(athletes)
        .innerJoin(people, eq(people.id, athletes.personId))
        .where(and(eq(athletes.orgId, orgId), eq(athletes.active, true)))
        .orderBy(people.lastName)
        .limit(60);
      return rows.map((r) => ({ id: r.id, label: `${r.first} ${r.last}` }));
    }
  }
}

function scopeFromSample(trigger: AutomationTrigger, id: string | undefined): Scope {
  if (!id) return {};
  switch (trigger) {
    case "session_cancelled":
    case "session_changed":
    case "assessment_completed":
      return { sessionId: id };
    case "lead_created":
      return { leadId: id };
    case "form_missing":
      return { formRequestId: id };
    case "payment_failed":
      return { paymentAttemptId: id };
    case "renewal_upcoming":
    case "membership_restart_upcoming":
      return { membershipId: id };
    case "attendance_lapsed":
      return { athleteId: id };
  }
}

/**
 * Renders the rule against real (sample) records and lists exactly who would receive it on
 * which channel after routing, consent and quiet hours — without sending or enqueuing.
 * `ignoreConditions` shows the rendering for a sample even if it doesn't currently match.
 */
export async function previewRule(tx: Tx, v: Viewer, ruleId: string, sampleId?: string, now = new Date()) {
  assertCan(v, "crm.manage");
  const rule = await getRule(tx, v, ruleId);
  const tpl = rule.templateId ? await loadTemplate(tx, v.orgId, rule.templateId) : null;
  if (!tpl) throw new DomainError("This rule has no template.");
  const scope = scopeFromSample(rule.trigger, sampleId);
  const cands = (await findCandidates(tx, v.orgId, rule.trigger, ruleConditions(rule), scope, now)).slice(0, 25);
  const s = await messagingSettings(tx, v.orgId);
  const items: PreviewItem[] = [];
  for (const c of cands) {
    const prefs = await preferencesFor(tx, v.orgId, c.recipients.map((r) => r.personId));
    const recips: PreviewRecipient[] = [];
    let first: { subject: string; body: string; missing: string[] } | null = null;
    for (const r of c.recipients) {
      const vars = { ...baseVars(r, s), ...c.vars };
      const subj = renderTemplate(tpl.subject ?? rule.name, vars);
      const body = renderTemplate(tpl.body, vars);
      first ??= { subject: subj.text || rule.name, body: body.text, missing: [...new Set([...subj.missing, ...body.missing])] };
      const key = dedupeKeyFor(rule.id, c, r.personId);
      const [m] = await tx.select({ id: messages.id }).from(messages).where(eq(messages.clientMutationId, key));
      const [j] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.dedupeKey, key));
      recips.push({
        personId: r.personId,
        name: `${r.firstName} ${r.lastName}`,
        role: r.role,
        alreadySent: !!(m || j),
        channels: (rule.channels as Channel[]).map((ch) => planChannel(r, ch, prefs, s, now, rule.delayMinutes)),
      });
    }
    let excludedNote: string | null = null;
    if (c.athleteId) {
      const route = await routeForAthlete(tx, v.orgId, c.athleteId, s);
      if (route?.excluded.length) excludedNote = route.excluded.map((e) => `${e.name}: ${e.reason}`).join("; ");
    }
    items.push({
      label: c.label,
      subject: first?.subject ?? rule.name,
      body: first?.body ?? "(no recipients — nothing would be sent)",
      missing: first?.missing ?? [],
      recipients: recips,
      excludedNote,
    });
  }
  // Show the template rendered against the sample even if the sample doesn't currently match.
  let sampleNote: string | null = null;
  if (sampleId && !cands.length) sampleNote = "This record does not currently match the rule's trigger and conditions, so no one would receive a message for it.";
  if (!sampleId && ["session_cancelled", "session_changed", "assessment_completed"].includes(rule.trigger)) {
    sampleNote = "Session triggers fire per event — choose a session above to see who would be notified.";
  }
  return { rule, template: tpl, items, sampleNote, scanned: !sampleId };
}
