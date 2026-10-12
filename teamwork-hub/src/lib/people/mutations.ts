import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import {
  alerts,
  athletes,
  guardianships,
  householdMembers,
  households,
  notes,
  payerAccounts,
  payerAuthorizations,
  payerBeneficiaries,
  people,
  personTags,
  tags,
  tasks,
  type NoteVisibility,
} from "@/db/schema";
import { assertCan, AuthzError, coachAthleteIds, isStaff, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";

const actor = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

const optStr = z.string().trim().max(200).optional().transform((s) => (s ? s : undefined));
const personInput = z.object({
  firstName: z.string().trim().min(1, "Required").max(80),
  lastName: z.string().trim().min(1, "Required").max(80),
  email: z.string().trim().email("Invalid email").max(200).optional().or(z.literal("").transform(() => undefined)),
  phone: optStr,
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export const newFamilySchema = z.object({
  athlete: personInput.extend({ sport: optStr, school: optStr, gradYear: z.coerce.number().int().min(1990).max(2100).optional().or(z.literal("").transform(() => undefined)) }),
  /** Guardian: either link an existing person by id, create a new one, or none (adult athlete). */
  guardianMode: z.enum(["none", "existing", "new"]),
  existingGuardianId: z.string().uuid().optional(),
  guardian: personInput.partial().optional(),
  relationship: z.string().trim().max(40).default("parent"),
  canViewHealth: z.coerce.boolean().default(false),
  /** Staff must confirm when an email matches existing people — we never merge automatically. */
  confirmDuplicates: z.coerce.boolean().default(false),
  groupId: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
});

export async function findPossibleDuplicates(tx: Tx, orgId: string, p: { firstName?: string; lastName?: string; email?: string; dateOfBirth?: string }) {
  const conds = [];
  if (p.email) conds.push(sql`lower(${people.email}) = lower(${p.email})`);
  if (p.firstName && p.lastName && p.dateOfBirth)
    conds.push(sql`(lower(${people.firstName}) = lower(${p.firstName}) and lower(${people.lastName}) = lower(${p.lastName}) and ${people.dateOfBirth} = ${p.dateOfBirth})`);
  if (!conds.length) return [];
  return tx
    .select({ id: people.id, firstName: people.firstName, lastName: people.lastName, email: people.email, dob: people.dateOfBirth })
    .from(people)
    .where(and(eq(people.orgId, orgId), sql`(${sql.join(conds, sql` or `)})`));
}

/** Staff registration of a new athlete with optional guardian, household, and payer account. */
export async function createAthleteFamily(tx: Tx, v: Viewer, raw: unknown) {
  assertCan(v, "people.manage");
  const input = newFamilySchema.parse(raw);

  const dupes = [
    ...(await findPossibleDuplicates(tx, v.orgId, input.athlete)),
    ...(input.guardianMode === "new" && input.guardian ? await findPossibleDuplicates(tx, v.orgId, input.guardian) : []),
  ];
  if (dupes.length && !input.confirmDuplicates) {
    throw new UserError(
      `Possible existing record${dupes.length > 1 ? "s" : ""}: ${dupes.map((d) => `${d.firstName} ${d.lastName}${d.email ? ` <${d.email}>` : ""}`).join("; ")}. Link the existing person instead, or tick "These are different people" to create new records. Nothing was merged.`,
    );
  }

  const [ap] = await tx
    .insert(people)
    .values({ orgId: v.orgId, firstName: input.athlete.firstName, lastName: input.athlete.lastName, email: input.athlete.email ?? null, phone: input.athlete.phone ?? null, dateOfBirth: input.athlete.dateOfBirth ?? null, status: "active" })
    .returning();
  const [ath] = await tx
    .insert(athletes)
    .values({ orgId: v.orgId, personId: ap.id, sport: input.athlete.sport ?? null, school: input.athlete.school ?? null, gradYear: input.athlete.gradYear ?? null })
    .returning();

  let guardianId: string | null = null;
  if (input.guardianMode === "existing") {
    if (!input.existingGuardianId) throw new UserError("Choose the existing guardian.", { existingGuardianId: "Required" });
    const [g] = await tx.select().from(people).where(and(eq(people.id, input.existingGuardianId), eq(people.orgId, v.orgId)));
    if (!g) throw new UserError("Guardian not found.");
    guardianId = g.id;
  } else if (input.guardianMode === "new") {
    const g = personInput.parse(input.guardian ?? {});
    const [gp] = await tx.insert(people).values({ orgId: v.orgId, firstName: g.firstName, lastName: g.lastName, email: g.email ?? null, phone: g.phone ?? null, status: "active" }).returning();
    guardianId = gp.id;
  }

  if (guardianId) {
    await tx.insert(guardianships).values({ orgId: v.orgId, guardianPersonId: guardianId, athleteId: ath.id, relationship: input.relationship, canViewHealth: input.canViewHealth, createdBy: v.userId });
    // Reuse the guardian's household if they have exactly one; otherwise create one.
    const hh = await tx.select({ id: householdMembers.householdId }).from(householdMembers).where(eq(householdMembers.personId, guardianId));
    let householdId = hh.length === 1 ? hh[0].id : null;
    if (!householdId) {
      const [gp] = await tx.select().from(people).where(eq(people.id, guardianId));
      const [h] = await tx.insert(households).values({ orgId: v.orgId, name: `${gp.lastName} Household (${gp.firstName})` }).returning();
      householdId = h.id;
      await tx.insert(householdMembers).values({ householdId, personId: guardianId, role: "guardian", isPrimaryContact: true });
    }
    await tx.insert(householdMembers).values({ householdId, personId: ap.id, role: "child" }).onConflictDoNothing();
    // Payer: reuse a payer account the guardian can pay on, else create one.
    const [pa] = await tx.select({ id: payerAuthorizations.payerAccountId }).from(payerAuthorizations).where(and(eq(payerAuthorizations.personId, guardianId), eq(payerAuthorizations.canPay, true))).limit(1);
    let payerId = pa?.id;
    if (!payerId) {
      const [gp] = await tx.select().from(people).where(eq(people.id, guardianId));
      const [np] = await tx.insert(payerAccounts).values({ orgId: v.orgId, name: `${gp.firstName} ${gp.lastName}`, householdId, billingEmail: gp.email }).returning();
      payerId = np.id;
      await tx.insert(payerAuthorizations).values({ payerAccountId: payerId, personId: guardianId, canManageMethods: true });
    }
    await tx.insert(payerBeneficiaries).values({ payerAccountId: payerId, athleteId: ath.id }).onConflictDoNothing();
  } else {
    // Adult athlete paying for themselves.
    const [np] = await tx.insert(payerAccounts).values({ orgId: v.orgId, name: `${ap.firstName} ${ap.lastName}`, billingEmail: ap.email }).returning();
    await tx.insert(payerAuthorizations).values({ payerAccountId: np.id, personId: ap.id, canManageMethods: true });
    await tx.insert(payerBeneficiaries).values({ payerAccountId: np.id, athleteId: ath.id });
  }
  if (input.groupId) {
    await tx.execute(sql`insert into group_members (group_id, athlete_id) select ${input.groupId}, ${ath.id} where exists (select 1 from groups where id = ${input.groupId} and org_id = ${v.orgId}) on conflict do nothing`);
  }
  await audit(tx, actor(v), "person.create_athlete", "athlete", ath.id, { summary: `${ap.firstName} ${ap.lastName}`, after: { guardianId, duplicatesConfirmed: dupes.length > 0 } });
  return { personId: ap.id, athleteId: ath.id };
}

export const personUpdateSchema = personInput.extend({ preferredName: optStr });

export async function updatePerson(tx: Tx, v: Viewer, personId: string, raw: unknown) {
  assertCan(v, "people.manage");
  const input = personUpdateSchema.parse(raw);
  const [before] = await tx.select().from(people).where(and(eq(people.id, personId), eq(people.orgId, v.orgId)));
  if (!before) throw new UserError("Person not found.");
  const [after] = await tx
    .update(people)
    .set({ firstName: input.firstName, lastName: input.lastName, preferredName: input.preferredName ?? null, email: input.email ?? null, phone: input.phone ?? null, dateOfBirth: input.dateOfBirth ?? null, updatedAt: new Date() })
    .where(eq(people.id, personId))
    .returning();
  await audit(tx, actor(v), "person.update", "person", personId, {
    before: { firstName: before.firstName, lastName: before.lastName, email: before.email, phone: before.phone, dob: before.dateOfBirth },
    after: { firstName: after.firstName, lastName: after.lastName, email: after.email, phone: after.phone, dob: after.dateOfBirth },
  });
}

export async function updateAthleteProfile(tx: Tx, v: Viewer, athleteId: string, raw: unknown) {
  await requireOnAthlete(tx, v, athleteId, "profile.write");
  const input = z
    .object({ sport: optStr, position: optStr, school: optStr, level: optStr, gradYear: z.coerce.number().int().min(1990).max(2100).optional().or(z.literal("").transform(() => undefined)), active: z.enum(["true", "false"]), inactiveReason: optStr })
    .parse(raw);
  const [before] = await tx.select().from(athletes).where(eq(athletes.id, athleteId));
  await tx
    .update(athletes)
    .set({ sport: input.sport ?? null, position: input.position ?? null, school: input.school ?? null, level: input.level ?? null, gradYear: input.gradYear ?? null, active: input.active === "true", inactiveReason: input.active === "true" ? null : input.inactiveReason ?? null })
    .where(eq(athletes.id, athleteId));
  await tx.update(people).set({ status: input.active === "true" ? "active" : "inactive" }).where(eq(people.id, before.personId));
  await audit(tx, actor(v), "athlete.update", "athlete", athleteId, { before, after: input });
}

export const guardianFlagsSchema = z.object({
  relationship: z.string().trim().min(1).max(40),
  canViewTraining: z.coerce.boolean(),
  canViewHealth: z.coerce.boolean(),
  canBook: z.coerce.boolean(),
  canSignForms: z.coerce.boolean(),
  canMessageStaff: z.coerce.boolean(),
  isEmergencyContact: z.coerce.boolean(),
});

/** Link an existing person (or a new one) as an additional, independent guardian. */
export async function addGuardian(tx: Tx, v: Viewer, athleteId: string, raw: unknown) {
  await requireOnAthlete(tx, v, athleteId, "guardians.manage");
  const input = z
    .object({ mode: z.enum(["existing", "new"]), existingPersonId: z.string().uuid().optional(), guardian: personInput.partial().optional() })
    .and(guardianFlagsSchema)
    .parse(raw);
  let guardianId: string;
  if (input.mode === "existing") {
    const [p] = await tx.select().from(people).where(and(eq(people.id, input.existingPersonId ?? ""), eq(people.orgId, v.orgId)));
    if (!p) throw new UserError("Choose an existing person.");
    guardianId = p.id;
  } else {
    const g = personInput.parse(input.guardian ?? {});
    const [p] = await tx.insert(people).values({ orgId: v.orgId, firstName: g.firstName, lastName: g.lastName, email: g.email ?? null, phone: g.phone ?? null }).returning();
    guardianId = p.id;
  }
  const [ath] = await tx.select().from(athletes).where(eq(athletes.id, athleteId));
  if (ath.personId === guardianId) throw new UserError("An athlete cannot be their own guardian.");
  const existing = await tx.select().from(guardianships).where(and(eq(guardianships.guardianPersonId, guardianId), eq(guardianships.athleteId, athleteId), ne(guardianships.status, "revoked")));
  if (existing.length) throw new UserError("That person is already a guardian of this athlete.");
  const { mode: _m, existingPersonId: _e, guardian: _g, ...flags } = input;
  void _m; void _e; void _g;
  const [row] = await tx.insert(guardianships).values({ orgId: v.orgId, guardianPersonId: guardianId, athleteId, createdBy: v.userId, ...flags }).returning();
  await audit(tx, actor(v), "guardianship.create", "guardianship", row.id, { after: row });
  return row;
}

export async function updateGuardianship(tx: Tx, v: Viewer, guardianshipId: string, raw: unknown) {
  const [g] = await tx.select().from(guardianships).where(and(eq(guardianships.id, guardianshipId), eq(guardianships.orgId, v.orgId)));
  if (!g) throw new UserError("Relationship not found.");
  await requireOnAthlete(tx, v, g.athleteId, "guardians.manage");
  const flags = guardianFlagsSchema.parse(raw);
  const [after] = await tx.update(guardianships).set(flags).where(eq(guardianships.id, guardianshipId)).returning();
  await audit(tx, actor(v), "guardianship.update", "guardianship", guardianshipId, { before: g, after });
}

export async function revokeGuardianship(tx: Tx, v: Viewer, guardianshipId: string, reason: string) {
  const [g] = await tx.select().from(guardianships).where(and(eq(guardianships.id, guardianshipId), eq(guardianships.orgId, v.orgId)));
  if (!g) throw new UserError("Relationship not found.");
  await requireOnAthlete(tx, v, g.athleteId, "guardians.manage");
  if (!reason.trim()) throw new UserError("A reason is required to remove a guardian.", { reason: "Required" });
  await tx.update(guardianships).set({ status: "revoked", revokedAt: new Date(), revokedBy: v.userId }).where(eq(guardianships.id, guardianshipId));
  await audit(tx, actor(v), "guardianship.revoke", "guardianship", guardianshipId, { summary: reason, before: g });
}

export async function addNote(tx: Tx, v: Viewer, personId: string, raw: unknown) {
  if (!isStaff(v)) throw new AuthzError();
  const input = z
    .object({ body: z.string().trim().min(1, "Write a note").max(5000), visibility: z.enum(["staff", "coaches_assigned", "owner_only", "sensitive"]), category: z.string().trim().max(40).default("general") })
    .parse(raw);
  const vis = input.visibility as NoteVisibility;
  if ((vis === "owner_only" && v.role !== "owner") || (vis === "sensitive" && !["owner", "admin"].includes(v.role))) {
    throw new UserError("Only owners/admins can write sensitive or owner-only notes.");
  }
  const [p] = await tx.select().from(people).where(and(eq(people.id, personId), eq(people.orgId, v.orgId)));
  if (!p) throw new UserError("Person not found.");
  if (v.role === "coach") {
    const scope = await coachAthleteIds(tx, v);
    const [a] = await tx.select().from(athletes).where(eq(athletes.personId, personId));
    if (!a || !scope.includes(a.id)) throw new AuthzError();
  }
  const [n] = await tx.insert(notes).values({ orgId: v.orgId, subjectPersonId: personId, authorUserId: v.userId, body: input.body, visibility: vis, category: input.category }).returning();
  await audit(tx, actor(v), "note.create", "note", n.id, { summary: `visibility=${vis}` });
}

export const taskSchema = z.object({
  title: z.string().trim().min(1, "Required").max(200),
  description: z.string().trim().max(2000).optional(),
  dueAt: z.string().optional().or(z.literal("").transform(() => undefined)),
  assigneeUserId: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
  relatedPersonId: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
});

export async function createTask(tx: Tx, v: Viewer, raw: unknown) {
  if (!isStaff(v)) throw new AuthzError();
  const input = taskSchema.parse(raw);
  const [t] = await tx
    .insert(tasks)
    .values({
      orgId: v.orgId,
      title: input.title,
      description: input.description ?? null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      assigneeUserId: input.assigneeUserId ?? v.userId,
      relatedPersonId: input.relatedPersonId ?? null,
      priority: input.priority,
      createdBy: v.userId,
    })
    .returning();
  await audit(tx, actor(v), "task.create", "task", t.id, { summary: t.title });
  return t;
}

export async function setTaskStatus(tx: Tx, v: Viewer, taskId: string, status: "open" | "in_progress" | "done" | "cancelled") {
  if (!isStaff(v)) throw new AuthzError();
  const [t] = await tx.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.orgId, v.orgId)));
  if (!t) throw new UserError("Task not found.");
  if (v.role === "coach" && t.assigneeUserId !== v.userId) throw new AuthzError("Coaches can only update their own tasks.");
  await tx
    .update(tasks)
    .set({ status, completedAt: status === "done" ? new Date() : null, completedBy: status === "done" ? v.userId : null })
    .where(eq(tasks.id, taskId));
  await audit(tx, actor(v), `task.${status}`, "task", taskId);
}

export async function createAlert(tx: Tx, v: Viewer, personId: string, raw: unknown) {
  assertCan(v, "people.manage");
  const input = z.object({ message: z.string().trim().min(1).max(200), level: z.enum(["info", "warning", "critical"]), showAtKiosk: z.coerce.boolean().default(false) }).parse(raw);
  const [p] = await tx.select().from(people).where(and(eq(people.id, personId), eq(people.orgId, v.orgId)));
  if (!p) throw new UserError("Person not found.");
  const [a] = await tx.insert(alerts).values({ orgId: v.orgId, personId, ...input, createdBy: v.userId }).returning();
  await audit(tx, actor(v), "alert.create", "alert", a.id, { summary: input.message });
}

export async function deactivateAlert(tx: Tx, v: Viewer, alertId: string) {
  assertCan(v, "people.manage");
  await tx.update(alerts).set({ active: false }).where(and(eq(alerts.id, alertId), eq(alerts.orgId, v.orgId)));
  await audit(tx, actor(v), "alert.deactivate", "alert", alertId);
}

export async function setTag(tx: Tx, v: Viewer, personId: string, tagName: string, on: boolean) {
  assertCan(v, "people.manage");
  const name = tagName.trim();
  if (!name) throw new UserError("Tag name required.");
  let [t] = await tx.select().from(tags).where(and(eq(tags.orgId, v.orgId), eq(tags.name, name)));
  if (!t && on) [t] = await tx.insert(tags).values({ orgId: v.orgId, name }).returning();
  if (!t) return;
  if (on) await tx.insert(personTags).values({ personId, tagId: t.id }).onConflictDoNothing();
  else await tx.delete(personTags).where(and(eq(personTags.personId, personId), eq(personTags.tagId, t.id)));
  await audit(tx, actor(v), on ? "tag.add" : "tag.remove", "person", personId, { summary: name });
}
