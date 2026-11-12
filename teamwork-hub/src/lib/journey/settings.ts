/** Owner/admin edits of the journey templates, generation numbers and scorecard targets (validated, audited). */
import { eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { organizations, JOURNEY_KINDS, type JourneyKind } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { DEFAULT_TEMPLATES, NUMBER_FIELDS, TARGET_FIELDS, cleanStep, journeySettingsFrom, type TemplateStep } from "./templates";

const actor = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

async function lockOrg(tx: Tx, v: Viewer) {
  assertCan(v, "settings.manage");
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  return org;
}

/**
 * Replace one template. `rawSteps` is the full list in order; a row without a key is a new custom
 * step. Journeys that already started keep the steps they were created with.
 */
export async function saveJourneyTemplate(tx: Tx, v: Viewer, kind: string, rawSteps: Record<string, unknown>[]) {
  const org = await lockOrg(tx, v);
  if (!JOURNEY_KINDS.includes(kind as JourneyKind)) throw new UserError("Unknown checklist.");
  const k = kind as JourneyKind;
  const steps: TemplateStep[] = [];
  const seen = new Set<string>();
  rawSteps.forEach((raw, i) => {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!raw.key && !name) return; // the blank "add a step" row
    if (!name) throw new UserError(`Step ${i + 1} needs a name.`);
    const visits = k === "visit_milestones" ? Number(raw.visits) : null;
    if (k === "visit_milestones" && (!Number.isInteger(visits) || visits! < 1)) throw new UserError(`"${name}" needs a whole number of visits.`);
    const key = typeof raw.key === "string" && raw.key ? raw.key : k === "visit_milestones" ? `visits_${visits}` : `custom_${Date.now().toString(36)}${i}`;
    const step = cleanStep({ ...raw, key, name, visits }, k);
    if (!step) throw new UserError(`"${name}": the offset must be a whole number.`);
    if (k === "visit_milestones" && step.key !== `visits_${step.visits}`) step.key = `visits_${step.visits}`;
    if (seen.has(step.key)) throw new UserError(`"${name}" is listed twice.`);
    seen.add(step.key);
    steps.push(step);
  });
  if (!steps.length) throw new UserError("A checklist needs at least one step. Turn steps off instead of removing them all.");
  const before = journeySettingsFrom(org.settings).templates[k];
  const journey = { ...((org.settings.journey ?? {}) as Record<string, unknown>) };
  journey.templates = { ...((journey.templates ?? {}) as Record<string, unknown>), [k]: steps };
  await tx.update(organizations).set({ settings: { ...org.settings, journey } }).where(eq(organizations.id, v.orgId));
  await audit(tx, actor(v), "org.journey_template_update", "organization", v.orgId, { summary: `Member journey template saved: ${k}`, before, after: steps });
  return steps;
}

/** Put one template back to the shipped defaults. */
export async function resetJourneyTemplate(tx: Tx, v: Viewer, kind: string) {
  const org = await lockOrg(tx, v);
  if (!JOURNEY_KINDS.includes(kind as JourneyKind)) throw new UserError("Unknown checklist.");
  const k = kind as JourneyKind;
  const before = journeySettingsFrom(org.settings).templates[k];
  const journey = { ...((org.settings.journey ?? {}) as Record<string, unknown>) };
  const templates = { ...((journey.templates ?? {}) as Record<string, unknown>) };
  delete templates[k];
  journey.templates = templates;
  await tx.update(organizations).set({ settings: { ...org.settings, journey } }).where(eq(organizations.id, v.orgId));
  await audit(tx, actor(v), "org.journey_template_reset", "organization", v.orgId, { summary: `Member journey template reset to defaults: ${k}`, before, after: DEFAULT_TEMPLATES[k] });
}

/** Generation numbers and scorecard targets. */
export async function saveJourneyNumbers(tx: Tx, v: Viewer, raw: Record<string, unknown>) {
  const org = await lockOrg(tx, v);
  const before = journeySettingsFrom(org.settings);
  const errors: Record<string, string> = {};
  const read = (key: string, min: number, max: number) => {
    const n = Number(raw[key]);
    if (typeof raw[key] !== "string" || raw[key] === "" || !Number.isInteger(n)) errors[key] = "Enter a whole number.";
    else if (n < min || n > max) errors[key] = `Must be ${min} to ${max}.`;
    return n;
  };
  const journey = { ...((org.settings.journey ?? {}) as Record<string, unknown>) };
  for (const f of NUMBER_FIELDS) journey[f.key] = read(f.key, f.min, f.max);
  const targets: Record<string, number> = {};
  for (const f of TARGET_FIELDS) targets[f.key] = read(f.key, f.min, f.max);
  journey.targets = targets;
  if (Object.keys(errors).length) throw new UserError("Please fix the highlighted fields.", errors);
  await tx.update(organizations).set({ settings: { ...org.settings, journey } }).where(eq(organizations.id, v.orgId));
  const after = journeySettingsFrom({ journey });
  await audit(tx, actor(v), "org.journey_settings_update", "organization", v.orgId, {
    summary: "Member journey numbers and scorecard targets saved",
    before: { ...before, templates: undefined },
    after: { ...after, templates: undefined },
  });
}
