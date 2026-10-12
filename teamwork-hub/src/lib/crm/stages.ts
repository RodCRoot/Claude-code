import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { leads, leadStages } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { DomainError } from "@/lib/messaging/errors";

export type LeadStage = typeof leadStages.$inferSelect;

export const DEFAULT_STAGES: { key: string; label: string; isWon?: boolean; isLost?: boolean }[] = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "assessment_booked", label: "Assessment Booked" },
  { key: "assessment_done", label: "Assessment Done" },
  { key: "won", label: "Won", isWon: true },
  { key: "lost", label: "Lost", isLost: true },
];

export async function listStages(tx: Tx, orgId: string): Promise<LeadStage[]> {
  return tx.select().from(leadStages).where(eq(leadStages.orgId, orgId)).orderBy(asc(leadStages.sortOrder), asc(leadStages.label));
}

/** Creates the default pipeline when an org has none (idempotent). */
export async function ensureStages(tx: Tx, orgId: string): Promise<LeadStage[]> {
  const existing = await listStages(tx, orgId);
  if (existing.length) return existing;
  await tx.insert(leadStages).values(
    DEFAULT_STAGES.map((s, i) => ({ orgId, key: s.key, label: s.label, sortOrder: (i + 1) * 10, isWon: !!s.isWon, isLost: !!s.isLost })),
  );
  return listStages(tx, orgId);
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40) || "stage";

const actor = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

const stageInput = z.object({
  label: z.string().trim().min(1, "Name the stage").max(60),
  kind: z.enum(["open", "won", "lost"]).default("open"),
});

export async function createStage(tx: Tx, v: Viewer, input: z.input<typeof stageInput>) {
  assertCan(v, "crm.manage");
  const data = stageInput.parse(input);
  const stages = await listStages(tx, v.orgId);
  let key = slug(data.label);
  for (let i = 2; stages.some((s) => s.key === key); i++) key = `${slug(data.label)}_${i}`;
  // New open stages go before the first won/lost stage; won/lost go to the end.
  const terminal = stages.find((s) => s.isWon || s.isLost);
  const sortOrder = data.kind === "open" && terminal ? terminal.sortOrder - 1 : (stages.at(-1)?.sortOrder ?? 0) + 10;
  const [row] = await tx
    .insert(leadStages)
    .values({ orgId: v.orgId, key, label: data.label, sortOrder, isWon: data.kind === "won", isLost: data.kind === "lost" })
    .returning();
  await audit(tx, actor(v), "crm.stage_created", "lead_stage", row.id, { after: row });
  return row;
}

export async function updateStage(tx: Tx, v: Viewer, id: string, input: z.input<typeof stageInput>) {
  assertCan(v, "crm.manage");
  const data = stageInput.parse(input);
  const [before] = await tx.select().from(leadStages).where(and(eq(leadStages.id, id), eq(leadStages.orgId, v.orgId)));
  if (!before) throw new DomainError("Stage not found.");
  const [row] = await tx
    .update(leadStages)
    .set({ label: data.label, isWon: data.kind === "won", isLost: data.kind === "lost" })
    .where(eq(leadStages.id, id))
    .returning();
  await audit(tx, actor(v), "crm.stage_updated", "lead_stage", id, { before, after: row });
}

export async function moveStage(tx: Tx, v: Viewer, id: string, dir: "up" | "down") {
  assertCan(v, "crm.manage");
  const stages = await listStages(tx, v.orgId);
  const i = stages.findIndex((s) => s.id === id);
  if (i < 0) throw new DomainError("Stage not found.");
  const j = dir === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= stages.length) return;
  const order = [...stages];
  [order[i], order[j]] = [order[j], order[i]];
  for (const [n, s] of order.entries()) await tx.update(leadStages).set({ sortOrder: (n + 1) * 10 }).where(eq(leadStages.id, s.id));
  await audit(tx, actor(v), "crm.stage_reordered", "lead_stage", id, { summary: `Moved ${stages[i].label} ${dir}` });
}

export async function deleteStage(tx: Tx, v: Viewer, id: string) {
  assertCan(v, "crm.manage");
  const [s] = await tx.select().from(leadStages).where(and(eq(leadStages.id, id), eq(leadStages.orgId, v.orgId)));
  if (!s) throw new DomainError("Stage not found.");
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.orgId, v.orgId), eq(leads.stage, s.key)));
  if (n > 0) throw new DomainError(`${n} lead(s) are in "${s.label}". Move them to another stage first.`);
  const all = await listStages(tx, v.orgId);
  if (s.key === "new") throw new DomainError('The "new" stage receives web inquiries and cannot be deleted. Rename it instead.');
  if (s.isWon && all.filter((x) => x.isWon).length === 1) throw new DomainError("Keep at least one Won stage (used by lead conversion).");
  if (s.isLost && all.filter((x) => x.isLost).length === 1) throw new DomainError("Keep at least one Lost stage.");
  await tx.delete(leadStages).where(eq(leadStages.id, id));
  await audit(tx, actor(v), "crm.stage_deleted", "lead_stage", id, { before: s });
}
