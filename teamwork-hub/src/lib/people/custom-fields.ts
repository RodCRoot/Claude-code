import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { customFieldDefs, people, type CustomFieldAppliesTo, type CustomFieldType } from "@/db/schema";
import { assertCan, AuthzError, isStaff, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";

export type CustomFieldDef = typeof customFieldDefs.$inferSelect;
export type CustomValue = string | number | boolean;

const actor = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

export const FIELD_TYPES: CustomFieldType[] = ["text", "number", "date", "select", "boolean"];
export const APPLIES_TO: CustomFieldAppliesTo[] = ["person", "athlete", "lead"];
export const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** Form field name for a custom value on the person page. */
export const cfName = (key: string) => `cf_${key}`;

export function slugKey(label: string) {
  const s = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return /^[a-z]/.test(s) ? s : `f_${s}`.slice(0, 40);
}

const optionsSchema = z
  .string()
  .optional()
  .transform((s) => [...new Set((s ?? "").split(/\r?\n|,/).map((o) => o.trim()).filter(Boolean))]);

const bool = z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean());

const defInput = z.object({
  label: z.string().trim().min(1, "Required").max(80),
  required: bool,
  visibility: z.enum(["staff", "family"]),
  showInList: bool,
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
  options: optionsSchema,
});

const createInput = defInput.extend({
  key: z
    .string()
    .trim()
    .optional()
    .transform((s) => (s ? s : undefined)),
  fieldType: z.enum(["text", "number", "date", "select", "boolean"]),
  appliesTo: z.enum(["person", "athlete", "lead"]),
});

function checkOptions(type: CustomFieldType, options: string[]) {
  if (type !== "select") return null;
  if (options.length < 2) throw new UserError("A select field needs at least two options.", { options: "Add at least two options, one per line" });
  if (options.length > 50) throw new UserError("Up to 50 options.", { options: "Too many options" });
  if (options.some((o) => o.length > 80)) throw new UserError("Options are limited to 80 characters.", { options: "Option too long" });
  return options;
}

/** All definitions for the org (archived last). */
export async function listFieldDefs(tx: Tx, orgId: string, opts: { includeArchived?: boolean } = {}) {
  return tx
    .select()
    .from(customFieldDefs)
    .where(and(eq(customFieldDefs.orgId, orgId), opts.includeArchived ? sql`true` : isNull(customFieldDefs.archivedAt)))
    .orderBy(sql`${customFieldDefs.archivedAt} is not null`, asc(customFieldDefs.sortOrder), asc(customFieldDefs.label));
}

export async function createFieldDef(tx: Tx, v: Viewer, raw: unknown) {
  assertCan(v, "settings.manage");
  const input = createInput.parse(raw);
  const key = input.key ?? slugKey(input.label);
  if (!KEY_RE.test(key)) throw new UserError("Key must start with a letter and use lowercase letters, digits and underscores (max 40).", { key: "Invalid key" });
  const options = checkOptions(input.fieldType, input.options);
  const [dupe] = await tx.select({ id: customFieldDefs.id }).from(customFieldDefs).where(and(eq(customFieldDefs.orgId, v.orgId), eq(customFieldDefs.key, key)));
  if (dupe) throw new UserError(`A field with key "${key}" already exists (keys are never reused, even after archiving).`, { key: "Already used" });
  const [row] = await tx
    .insert(customFieldDefs)
    .values({
      orgId: v.orgId,
      key,
      label: input.label,
      fieldType: input.fieldType,
      options,
      appliesTo: input.appliesTo,
      required: input.required,
      visibility: input.visibility,
      showInList: input.showInList,
      sortOrder: input.sortOrder,
    })
    .returning();
  await audit(tx, actor(v), "custom_field.create", "custom_field_def", row.id, { summary: `${row.label} (${row.key})`, after: row });
  return row;
}

/** Label, flags, order and select options can change; key, type and target are fixed so stored values stay meaningful. */
export async function updateFieldDef(tx: Tx, v: Viewer, id: string, raw: unknown) {
  assertCan(v, "settings.manage");
  const input = defInput.parse(raw);
  const [before] = await tx.select().from(customFieldDefs).where(and(eq(customFieldDefs.id, id), eq(customFieldDefs.orgId, v.orgId)));
  if (!before) throw new UserError("Field not found.");
  const options = checkOptions(before.fieldType, input.options);
  const [after] = await tx
    .update(customFieldDefs)
    .set({ label: input.label, required: input.required, visibility: input.visibility, showInList: input.showInList, sortOrder: input.sortOrder, options })
    .where(eq(customFieldDefs.id, id))
    .returning();
  await audit(tx, actor(v), "custom_field.update", "custom_field_def", id, { summary: after.label, before, after });
  return after;
}

/** Archive hides the field everywhere but keeps stored values (and the key reserved). */
export async function setFieldDefArchived(tx: Tx, v: Viewer, id: string, archived: boolean) {
  assertCan(v, "settings.manage");
  const [before] = await tx.select().from(customFieldDefs).where(and(eq(customFieldDefs.id, id), eq(customFieldDefs.orgId, v.orgId)));
  if (!before) throw new UserError("Field not found.");
  await tx.update(customFieldDefs).set({ archivedAt: archived ? new Date() : null }).where(eq(customFieldDefs.id, id));
  await audit(tx, actor(v), archived ? "custom_field.archive" : "custom_field.restore", "custom_field_def", id, { summary: before.label });
}

export type PersonKinds = { isAthlete: boolean; isLead: boolean };

/** Which definitions apply to a person: "person" fields apply to everyone. */
export function applicableDefs(defs: CustomFieldDef[], k: PersonKinds) {
  return defs.filter((d) => !d.archivedAt && (d.appliesTo === "person" || (d.appliesTo === "athlete" && k.isAthlete) || (d.appliesTo === "lead" && k.isLead)));
}

/** Staff see every field; families see only family-visible ones. */
export function visibleDefs(defs: CustomFieldDef[], v: Viewer) {
  return isStaff(v) ? defs : defs.filter((d) => d.visibility === "family");
}

export async function personKinds(tx: Tx, personId: string): Promise<PersonKinds> {
  const [r] = (
    await tx.execute(
      sql`select exists (select 1 from athletes a where a.person_id = ${personId}) as is_athlete,
                 exists (select 1 from people p where p.id = ${personId} and p.status in ('lead','prospect'))
                   or exists (select 1 from leads l where l.person_id = ${personId} and l.converted_at is null) as is_lead`,
    )
  ).rows as { is_athlete: boolean; is_lead: boolean }[];
  return { isAthlete: !!r?.is_athlete, isLead: !!r?.is_lead };
}

const isRealDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/**
 * Validate raw form strings against each definition. Returns typed values (null = cleared)
 * and per-field errors keyed by the form field name (cf_<key>).
 */
export function validateCustomValues(defs: CustomFieldDef[], raw: Record<string, unknown>) {
  const values: Record<string, CustomValue | null> = {};
  const errors: Record<string, string> = {};
  for (const d of defs) {
    const name = cfName(d.key);
    const rv = raw[name];
    const s = typeof rv === "string" ? rv.trim() : rv == null ? "" : String(rv).trim();
    if (s === "") {
      if (d.required) errors[name] = `${d.label} is required`;
      values[d.key] = null;
      continue;
    }
    switch (d.fieldType) {
      case "text":
        if (s.length > 500) errors[name] = "Max 500 characters";
        else values[d.key] = s;
        break;
      case "number": {
        const num = Number(s);
        if (!/^-?\d+(\.\d+)?$/.test(s) || !Number.isFinite(num)) errors[name] = "Enter a number";
        else values[d.key] = num;
        break;
      }
      case "date":
        if (!isRealDate(s)) errors[name] = "Use a valid date (YYYY-MM-DD)";
        else values[d.key] = s;
        break;
      case "select":
        if (!(d.options ?? []).includes(s)) errors[name] = "Choose one of the listed options";
        else values[d.key] = s;
        break;
      case "boolean":
        if (s !== "true" && s !== "false") errors[name] = "Choose yes or no";
        else values[d.key] = s === "true";
        break;
    }
  }
  return { values, errors };
}

/** Staff edit of a person's custom values. Only applicable, non-archived fields are touched; other keys are preserved. */
export async function updatePersonCustomFields(tx: Tx, v: Viewer, personId: string, raw: Record<string, unknown>) {
  assertCan(v, "people.manage");
  const [p] = await tx.select().from(people).where(and(eq(people.id, personId), eq(people.orgId, v.orgId))).for("update");
  if (!p) throw new UserError("Person not found.");
  const defs = applicableDefs(await listFieldDefs(tx, v.orgId), await personKinds(tx, personId));
  if (!defs.length) throw new UserError("No custom fields apply to this person.");
  const { values, errors } = validateCustomValues(defs, raw);
  if (Object.keys(errors).length) throw new UserError("Please fix the highlighted fields.", errors);
  const prev = (p.customFields ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...prev };
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const d of defs) {
    const nv = values[d.key];
    const ov = prev[d.key] ?? null;
    if (nv === null) delete next[d.key];
    else next[d.key] = nv;
    if (ov !== nv) {
      before[d.key] = ov;
      after[d.key] = nv;
    }
  }
  if (!Object.keys(after).length) return { changed: 0 };
  await tx.update(people).set({ customFields: next, updatedAt: new Date() }).where(eq(people.id, personId));
  await audit(tx, actor(v), "person.custom_fields.update", "person", personId, { summary: Object.keys(after).join(", "), before, after });
  return { changed: Object.keys(after).length };
}

/** Values a viewer may see on a person page (assumes the caller already authorized the page). */
export async function customFieldsForView(tx: Tx, v: Viewer, personId: string) {
  if (!isStaff(v) && v.role !== "guardian" && v.role !== "athlete") throw new AuthzError();
  const [p] = await tx.select({ cf: people.customFields }).from(people).where(and(eq(people.id, personId), eq(people.orgId, v.orgId)));
  if (!p) return [];
  const defs = visibleDefs(applicableDefs(await listFieldDefs(tx, v.orgId), await personKinds(tx, personId)), v);
  const cf = (p.cf ?? {}) as Record<string, unknown>;
  return defs.map((d) => ({ def: d, value: (cf[d.key] ?? null) as CustomValue | null }));
}

export function formatCustomValue(d: Pick<CustomFieldDef, "fieldType">, val: unknown): string | null {
  if (val === null || val === undefined || val === "") return null;
  if (d.fieldType === "boolean") return val === true ? "Yes" : val === false ? "No" : String(val);
  if (d.fieldType === "number" && typeof val === "number") return val.toLocaleString("en-US");
  return String(val);
}
