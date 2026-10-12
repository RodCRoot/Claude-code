import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { automationRules, messageTemplates, type AutomationTrigger } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { DomainError } from "@/lib/messaging/errors";

export type AutomationRule = typeof automationRules.$inferSelect;

export const TRIGGERS: { key: AutomationTrigger; label: string; help: string; daysLabel?: string; defaultDays?: number }[] = [
  { key: "session_changed", label: "Session changed", help: "Time, coach or location of a booked session changed (sent by Schedule via notify.session_changed)." },
  { key: "session_cancelled", label: "Session cancelled", help: "A booked session was cancelled (sent by Schedule via notify.session_cancelled)." },
  { key: "assessment_completed", label: "Assessment completed", help: "An assessment session was marked completed; reaches linked leads and attendees." },
  { key: "form_missing", label: "Form missing", help: "A form request is still pending after N days.", daysLabel: "Pending for at least (days)", defaultDays: 3 },
  { key: "payment_failed", label: "Payment failed", help: "A payment attempt failed in the last N days; reaches people authorized on the payer account.", daysLabel: "Failed within the last (days)", defaultDays: 7 },
  { key: "renewal_upcoming", label: "Renewal upcoming", help: "An active membership renews or ends within N days.", daysLabel: "Renews within (days)", defaultDays: 7 },
  { key: "attendance_lapsed", label: "Attendance lapsed", help: "An active athlete has not attended for N days (but attended within the last 120).", daysLabel: "No attendance for (days)", defaultDays: 14 },
  { key: "lead_created", label: "Lead created", help: "A new lead arrived (web inquiry or staff entry); reaches the lead contact." },
];

export const triggerLabel = (k: string) => TRIGGERS.find((t) => t.key === k)?.label ?? k;

export type RuleConditions = { days?: number; sport?: string; serviceKind?: string };

export function ruleConditions(r: Pick<AutomationRule, "conditions">): RuleConditions {
  const c = (r.conditions ?? {}) as Record<string, unknown>;
  return {
    days: typeof c.days === "number" ? c.days : undefined,
    sport: typeof c.sport === "string" && c.sport ? c.sport : undefined,
    serviceKind: typeof c.serviceKind === "string" && c.serviceKind ? c.serviceKind : undefined,
  };
}

export async function listRules(tx: Tx, orgId: string) {
  return tx
    .select({ rule: automationRules, templateName: messageTemplates.name, templateIsSample: messageTemplates.isSample })
    .from(automationRules)
    .leftJoin(messageTemplates, eq(messageTemplates.id, automationRules.templateId))
    .where(eq(automationRules.orgId, orgId))
    .orderBy(asc(automationRules.trigger), asc(automationRules.name));
}

export async function getRule(tx: Tx, v: Viewer, id: string) {
  assertCan(v, "crm.manage");
  if (!z.string().uuid().safeParse(id).success) throw new DomainError("Rule not found.");
  const [r] = await tx.select().from(automationRules).where(and(eq(automationRules.id, id), eq(automationRules.orgId, v.orgId)));
  if (!r) throw new DomainError("Rule not found.");
  return r;
}

const ruleSchema = z.object({
  name: z.string().trim().min(1, "Name the rule").max(120),
  trigger: z.enum(TRIGGERS.map((t) => t.key) as [AutomationTrigger, ...AutomationTrigger[]]),
  templateId: z.string().uuid("Choose a template"),
  channels: z.array(z.enum(["in_app", "email", "sms"])).default(["in_app"]),
  delayMinutes: z.coerce.number().int().min(0).max(60 * 24 * 30).default(0),
  createTask: z.boolean().default(false),
  days: z.preprocess((x) => (x === "" || x == null ? undefined : Number(x)), z.number().int().min(1).max(365).optional()),
  sport: z.preprocess((x) => (x === "" ? undefined : x), z.string().trim().max(80).optional()),
  serviceKind: z.preprocess((x) => (x === "" ? undefined : x), z.enum(["class", "private", "semi_private", "assessment", "camp", "event"]).optional()),
});

async function checkTemplate(tx: Tx, orgId: string, id: string) {
  const [t] = await tx.select().from(messageTemplates).where(and(eq(messageTemplates.id, id), eq(messageTemplates.orgId, orgId)));
  if (!t) throw new DomainError("Template not found.", { templateId: "Choose a template" });
}

const toRow = (d: z.infer<typeof ruleSchema>) => ({
  name: d.name,
  trigger: d.trigger,
  templateId: d.templateId,
  channels: [...new Set(["in_app" as const, ...d.channels])],
  delayMinutes: d.delayMinutes,
  createTask: d.createTask,
  conditions: { ...(d.days ? { days: d.days } : {}), ...(d.sport ? { sport: d.sport } : {}), ...(d.serviceKind ? { serviceKind: d.serviceKind } : {}) },
});

/** New rules are always created disabled; enabling is a separate, audited step. */
export async function createRule(tx: Tx, v: Viewer, input: z.input<typeof ruleSchema>) {
  assertCan(v, "crm.manage");
  const d = ruleSchema.parse(input);
  await checkTemplate(tx, v.orgId, d.templateId);
  const [row] = await tx.insert(automationRules).values({ orgId: v.orgId, ...toRow(d), enabled: false }).returning();
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "automation.rule_created", "automation_rule", row.id, { after: row });
  return row;
}

export async function updateRule(tx: Tx, v: Viewer, id: string, input: z.input<typeof ruleSchema>) {
  const before = await getRule(tx, v, id);
  const d = ruleSchema.parse(input);
  await checkTemplate(tx, v.orgId, d.templateId);
  const [row] = await tx.update(automationRules).set(toRow(d)).where(eq(automationRules.id, id)).returning();
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "automation.rule_updated", "automation_rule", id, { before, after: row });
}

export async function setRuleEnabled(tx: Tx, v: Viewer, id: string, enabled: boolean) {
  const before = await getRule(tx, v, id);
  if (enabled && !before.templateId) throw new DomainError("Choose a template before enabling.");
  await tx.update(automationRules).set({ enabled }).where(eq(automationRules.id, id));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, enabled ? "automation.rule_enabled" : "automation.rule_disabled", "automation_rule", id, {
    summary: `${enabled ? "Enabled" : "Disabled"} "${before.name}"`,
    before: { enabled: before.enabled },
    after: { enabled },
  });
}

export async function deleteRule(tx: Tx, v: Viewer, id: string) {
  const before = await getRule(tx, v, id);
  await tx.delete(automationRules).where(eq(automationRules.id, id));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "automation.rule_deleted", "automation_rule", id, { before });
}
