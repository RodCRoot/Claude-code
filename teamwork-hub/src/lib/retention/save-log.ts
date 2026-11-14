import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { athletes, people, retentionActions, tasks, users, RETENTION_OUTCOMES } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { accessibleAthleteIds, assertCan, athleteScopeFilter, AuthzError, canOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { addDaysYmd, localDayBounds, todayLocal } from "@/lib/time";
import { LOSS_REASONS, RETENTION_ACTION_KINDS, retentionContext } from "./common";
import { retentionRadar } from "./radar";

const actor = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

/** Org + scope check for a staff action on one athlete (coaches: assigned athletes only). */
export async function athleteInScope(tx: Tx, v: Viewer, athleteId: string) {
  assertCan(v, "retention.view");
  if (!(await canOnAthlete(tx, v, athleteId, "profile.read"))) throw new AuthzError();
  const [a] = await tx
    .select({ id: athletes.id, personId: athletes.personId, first: people.firstName, last: people.lastName })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.id, athleteId), eq(athletes.orgId, v.orgId)));
  if (!a) throw new AuthzError();
  return { ...a, name: `${a.first} ${a.last}` };
}

export const outcomeSchema = z.object({
  athleteId: z.string().uuid(),
  action: z.enum(RETENTION_ACTION_KINDS.map((a) => a.key) as [string, ...string[]]),
  outcome: z.enum(RETENTION_OUTCOMES),
  reasonCode: z.enum(LOSS_REASONS.map((r) => r.key) as [string, ...string[]]).optional(),
  notes: z.string().trim().max(2000).optional(),
});

/**
 * Save log entry. Snapshots the athlete's current signals and level AS THE LOGGING VIEWER SEES
 * THEM (a coach's entry never stores billing signals or a dollar value). Audited.
 */
export async function logOutcome(tx: Tx, v: Viewer, raw: unknown, opts: { today?: string } = {}) {
  const input = outcomeSchema.parse(raw);
  const a = await athleteInScope(tx, v, input.athleteId);
  if (input.outcome === "lost" && !input.reasonCode) throw new UserError("Choose a reason when the member was lost.", { reasonCode: "Required for a loss" });
  const radar = await retentionRadar(tx, v, { today: opts.today, athleteIds: [a.id] });
  const row = radar.rows[0];
  const [r] = await tx
    .insert(retentionActions)
    .values({
      orgId: v.orgId,
      athleteId: a.id,
      level: row?.level ?? "low",
      signals: row?.signals ?? [],
      valueAtRiskMinor: row?.valueAtRiskMinor ?? null,
      currency: row?.currency ?? radar.summary.currency,
      action: input.action,
      outcome: input.outcome,
      reasonCode: input.outcome === "lost" ? input.reasonCode! : null,
      notes: input.notes || null,
      staffUserId: v.userId,
    })
    .returning();
  await audit(tx, actor(v), "retention.outcome_log", "retention_action", r.id, {
    summary: `${a.name}: ${input.action} → ${input.outcome}${r.reasonCode ? ` (${r.reasonCode})` : ""}`,
    after: { athleteId: a.id, level: r.level, signals: r.signals.map((s) => s.key), action: r.action, outcome: r.outcome, reasonCode: r.reasonCode },
  });
  return r;
}

/**
 * "Create follow-up task" on the radar / winback list. Uses the existing tasks table; one task per
 * athlete, kind and day (dedupe key), assigned to the staff member who clicked. Nothing is sent.
 */
export async function createFollowUpTask(tx: Tx, v: Viewer, input: { athleteId: string; kind: "follow_up" | "winback" }, opts: { today?: string } = {}) {
  if (input.kind === "winback") assertCan(v, "retention.manage");
  const a = await athleteInScope(tx, v, input.athleteId);
  const { tz } = await retentionContext(tx, v.orgId);
  const today = opts.today ?? todayLocal(tz);
  let title = `Winback outreach: ${a.name}`;
  let description = "From the winback list (membership ended in the last 12 months). Reach out personally; nothing is sent automatically.";
  let priority: "normal" | "high" = "normal";
  if (input.kind === "follow_up") {
    const row = (await retentionRadar(tx, v, { today, athleteIds: [a.id] })).rows[0];
    title = `Retention follow-up: ${a.name}`;
    description = row ? [`Recommended: ${row.recommendation.label}.`, ...row.signals.map((s) => `• ${s.label}: ${s.evidence}`)].join("\n") : "From the retention radar.";
    priority = row?.level === "at_risk" ? "high" : "normal";
  }
  const [t] = await tx
    .insert(tasks)
    .values({
      orgId: v.orgId,
      title,
      description: description.slice(0, 2000),
      dueAt: localDayBounds(addDaysYmd(today, 2), tz).end,
      assigneeUserId: v.userId,
      relatedPersonId: a.personId,
      relatedType: "athlete",
      relatedId: a.id,
      priority,
      source: "retention",
      dedupeKey: `retention:${input.kind}:${a.id}:${today}`,
      createdBy: v.userId,
    })
    .onConflictDoNothing({ target: [tasks.orgId, tasks.dedupeKey] })
    .returning();
  if (!t) return { created: false as const };
  await audit(tx, actor(v), "task.create", "task", t.id, { summary: t.title });
  return { created: true as const, task: t };
}

/** Recent save-log entries in the viewer's scope (newest first). */
export async function recentOutcomes(tx: Tx, v: Viewer, limit = 20) {
  assertCan(v, "retention.view");
  const ids = await accessibleAthleteIds(tx, v, "profile.read");
  return tx
    .select({
      id: retentionActions.id,
      athleteId: retentionActions.athleteId,
      personId: athletes.personId,
      name: sql<string>`${people.firstName} || ' ' || ${people.lastName}`,
      action: retentionActions.action,
      outcome: retentionActions.outcome,
      reasonCode: retentionActions.reasonCode,
      notes: retentionActions.notes,
      level: retentionActions.level,
      staff: users.displayName,
      createdAt: retentionActions.createdAt,
    })
    .from(retentionActions)
    .innerJoin(athletes, eq(athletes.id, retentionActions.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .innerJoin(users, eq(users.id, retentionActions.staffUserId))
    .where(and(eq(retentionActions.orgId, v.orgId), athleteScopeFilter(ids, retentionActions.athleteId)))
    .orderBy(desc(retentionActions.createdAt))
    .limit(limit);
}
