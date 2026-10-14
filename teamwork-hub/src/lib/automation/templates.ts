import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { automationRules, messageTemplates } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { DomainError } from "@/lib/messaging/errors";
import { lintBlockMessage, lintFamilyMessage, replaceEmDashes } from "@/lib/messaging/family-style";

export type MessageTemplate = typeof messageTemplates.$inferSelect;

/** Variables a template may use. Each trigger fills the subset that applies to it. */
export const TEMPLATE_VARIABLES: Record<string, string> = {
  recipient_first_name: "First name of the person receiving the message",
  guardian_first_name: "Same as recipient_first_name (the guardian, for minors)",
  athlete_first_name: "Athlete's first name",
  athlete_name: "Athlete's full name",
  lead_first_name: "Lead's first name",
  session_title: "Session title",
  session_time: "Session start, facility time (e.g. Tue Mar 3, 6:00 PM)",
  form_name: "Form title",
  invoice_number: "Invoice number",
  invoice_amount: "Invoice total (e.g. $120.00)",
  renewal_date: "Membership renewal / end date",
  last_attended_date: "Date of the athlete's last attended session",
  days_since_attended: "Whole days since last attendance",
  org_name: "Facility display name",
};

const VAR = /\{\{\s*([a-z_]+)\s*\}\}/g;

export function templateVariables(text: string): string[] {
  return [...new Set([...text.matchAll(VAR)].map((m) => m[1]))];
}

/** Renders `{{var}}` placeholders. Missing values render as empty and are reported. */
export function renderTemplate(text: string, vars: Record<string, string | null | undefined>): { text: string; missing: string[]; unknown: string[] } {
  const missing = new Set<string>();
  const unknown = new Set<string>();
  const out = text.replace(VAR, (_, name: string) => {
    if (!(name in TEMPLATE_VARIABLES)) {
      unknown.add(name);
      return "";
    }
    const val = vars[name];
    if (val == null || val === "") {
      missing.add(name);
      return "";
    }
    return val;
  });
  return { text: out.replace(/[ \t]{2,}/g, " ").trim(), missing: [...missing], unknown: [...unknown] };
}

export async function listTemplates(tx: Tx, orgId: string) {
  return tx.select().from(messageTemplates).where(eq(messageTemplates.orgId, orgId)).orderBy(asc(messageTemplates.name));
}

const templateSchema = z.object({
  name: z.string().trim().min(1, "Name the template").max(120),
  channel: z.enum(["in_app", "email", "sms"]),
  subject: z.preprocess((x) => (x === "" ? undefined : x), z.string().trim().max(200).optional()),
  body: z.string().trim().min(1, "Write the message").max(5000),
  isSample: z.boolean().default(false),
  /** Staff accepted the offer to replace em dashes ("comma" | "period") before saving. */
  fixDashes: z.enum(["comma", "period"]).optional(),
});

/** Templates go to families: apply an accepted dash fix, then block on the family style lint. */
function applyFamilyStyle(d: z.infer<typeof templateSchema>) {
  if (d.fixDashes) {
    d.body = replaceEmDashes(d.body, d.fixDashes);
    if (d.subject) d.subject = replaceEmDashes(d.subject, d.fixDashes);
  }
  const r = lintFamilyMessage(`${d.subject ? `${d.subject}\n` : ""}${d.body}`, { requireSignOff: false });
  if (!r.ok) throw new DomainError(lintBlockMessage(r, "This template"), { body: r.blocks.map((b) => b.message).join(" ") });
}

function validateVars(d: z.infer<typeof templateSchema>) {
  applyFamilyStyle(d);
  const unknown = templateVariables(`${d.subject ?? ""} ${d.body}`).filter((v) => !(v in TEMPLATE_VARIABLES));
  if (unknown.length) throw new DomainError(`Unknown variable(s): ${unknown.map((u) => `{{${u}}}`).join(", ")}`, { body: "Use only the listed variables" });
  if (d.channel === "sms" && d.body.length > 480) throw new DomainError("SMS templates should stay under 480 characters (3 segments).", { body: "Too long for SMS" });
}

const keyFrom = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 50) || "template";

export async function createTemplate(tx: Tx, v: Viewer, input: z.input<typeof templateSchema>) {
  assertCan(v, "crm.manage");
  const d = templateSchema.parse(input);
  validateVars(d);
  const existing = await listTemplates(tx, v.orgId);
  let key = keyFrom(d.name);
  for (let i = 2; existing.some((t) => t.key === key); i++) key = `${keyFrom(d.name)}_${i}`;
  const [row] = await tx
    .insert(messageTemplates)
    .values({ orgId: v.orgId, key, name: d.name, channel: d.channel, subject: d.subject ?? null, body: d.body, isSample: d.isSample })
    .returning();
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "automation.template_created", "message_template", row.id, { after: row });
  return row;
}

export async function updateTemplate(tx: Tx, v: Viewer, id: string, input: z.input<typeof templateSchema>) {
  assertCan(v, "crm.manage");
  const d = templateSchema.parse(input);
  validateVars(d);
  const [before] = await tx.select().from(messageTemplates).where(and(eq(messageTemplates.id, id), eq(messageTemplates.orgId, v.orgId)));
  if (!before) throw new DomainError("Template not found.");
  const [row] = await tx
    .update(messageTemplates)
    .set({ name: d.name, channel: d.channel, subject: d.subject ?? null, body: d.body, isSample: d.isSample, updatedAt: new Date() })
    .where(eq(messageTemplates.id, id))
    .returning();
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "automation.template_updated", "message_template", id, { before, after: row });
}

export async function deleteTemplate(tx: Tx, v: Viewer, id: string) {
  assertCan(v, "crm.manage");
  const [t] = await tx.select().from(messageTemplates).where(and(eq(messageTemplates.id, id), eq(messageTemplates.orgId, v.orgId)));
  if (!t) throw new DomainError("Template not found.");
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(automationRules).where(eq(automationRules.templateId, id));
  if (n) throw new DomainError(`${n} automation rule(s) use this template. Point them at another template first.`);
  await tx.delete(messageTemplates).where(eq(messageTemplates.id, id));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "automation.template_deleted", "message_template", id, { before: t });
}
