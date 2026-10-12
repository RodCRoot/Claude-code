import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import {
  archivedDocuments,
  athletes,
  bookings,
  exercises,
  externalIds,
  guardianships,
  householdMembers,
  households,
  importRows,
  maxes,
  memberships,
  metricDefinitions,
  metricValues,
  people,
  products,
  productVersions,
  questionnaireResponses,
  questionnaires,
  questionnaireVersions,
  scheduleSessions,
  serviceTypes,
  setLogs,
  testSessions,
  testTypes,
  trials,
  wearableObservations,
  workoutItems,
  workouts,
  type QuestionDef,
} from "@/db/schema";
import type { Viewer } from "@/lib/authz/policy";
import { saveObject } from "@/lib/storage";
import { DEFAULT_TZ, localToUtc } from "@/lib/time";
import { slug, syntheticId } from "./normalize";
import type { IdentityInput, ImportSchemaDef, MetricCell, RowAction } from "./types";

export type Created = { type: string; id: string };
export type UpdateRecord = { type: string; id: string; before: Record<string, unknown> };

export type RowRecord = typeof importRows.$inferSelect;

export type CommitCtx = {
  tx: Tx;
  viewer: Viewer;
  orgId: string;
  batchId: string;
  schema: ImportSchemaDef;
  tz: string;
  attachments: Map<string, Uint8Array>;
  cache: Map<string, string>;
  /** Pre-computed per-batch data (e.g. questionnaire questions by name). */
  extra: Record<string, unknown>;
};

export type RowOutcome = { action: RowAction; created: Created[]; updates: UpdateRecord[]; warnings: string[] };

// ---------------------------------------------------------------------------
// External id registry
// ---------------------------------------------------------------------------

export async function findExternal(tx: Tx, orgId: string, source: string, entityType: string, sourceId: string): Promise<string | null> {
  const [r] = await tx
    .select({ localId: externalIds.localId })
    .from(externalIds)
    .where(and(eq(externalIds.orgId, orgId), eq(externalIds.source, source), eq(externalIds.sourceEntityType, entityType), eq(externalIds.sourceId, sourceId)));
  return r?.localId ?? null;
}

/** Record source → local identity. Rows inserted here are owned (and reverted) by this batch. */
export async function linkExternal(c: CommitCtx, entityType: string, sourceId: string, localType: string, localId: string, source = c.schema.idSource) {
  const inserted = await c.tx
    .insert(externalIds)
    .values({ orgId: c.orgId, source, sourceEntityType: entityType, sourceId, localEntityType: localType, localId, firstImportBatchId: c.batchId })
    .onConflictDoNothing()
    .returning({ id: externalIds.id });
  if (!inserted.length) {
    await c.tx
      .update(externalIds)
      .set({ lastSeenAt: new Date() })
      .where(and(eq(externalIds.orgId, c.orgId), eq(externalIds.source, source), eq(externalIds.sourceEntityType, entityType), eq(externalIds.sourceId, sourceId)));
  }
}

async function cached(c: CommitCtx, key: string, make: () => Promise<string>): Promise<string> {
  const hit = c.cache.get(key);
  if (hit) return hit;
  const v = await make();
  c.cache.set(key, v);
  return v;
}

// ---------------------------------------------------------------------------
// People / athletes
// ---------------------------------------------------------------------------

type PersonData = { firstName?: unknown; lastName?: unknown; dob?: unknown; email?: unknown; phone?: unknown; status?: unknown };

/** Resolve (or create) the row's person and, when needed, athlete. */
export async function ensurePerson(
  c: CommitCtx,
  row: RowRecord,
  out: RowOutcome,
  opts: { athleteActive?: boolean | null; sport?: string | null } = {},
): Promise<{ personId: string; athleteId: string | null; createdPerson: boolean }> {
  const n = row.normalized as Record<string, unknown>;
  const identity = n._identity as IdentityInput;
  const key = n._identityKey as string;
  const decision = n._action as RowAction;
  let personId: string | null = row.matchPersonId;
  let createdPerson = false;
  if (!personId) {
    const fromBatch = c.cache.get(`person:${key}`);
    if (fromBatch) personId = fromBatch;
    else if (decision === "create") {
      const d = n as PersonData;
      const [p] = await c.tx
        .insert(people)
        .values({
          orgId: c.orgId,
          firstName: String(identity.firstName ?? d.firstName ?? ""),
          lastName: String(identity.lastName ?? d.lastName ?? ""),
          dateOfBirth: (identity.dob ?? (d.dob as string | null)) || null,
          email: (identity.email ?? (d.email as string | null)) || null,
          phone: (identity.phone ?? (d.phone as string | null)) || null,
          status: ((d.status as string | null) ?? "active") as "active",
          source: c.schema.idSource,
        })
        .returning({ id: people.id });
      personId = p.id;
      createdPerson = true;
      out.created.push({ type: "person", id: p.id });
    } else {
      throw new Error(`Row ${row.rowNumber}: no person resolved`);
    }
  }
  c.cache.set(`person:${key}`, personId);
  if (identity.sourceId) await linkExternal(c, identity.sourceEntityType, identity.sourceId, "person", personId);

  let athleteId: string | null = null;
  if (identity.needsAthlete) {
    athleteId = await cached(c, `athlete:${personId}`, async () => {
      const [a] = await c.tx.select({ id: athletes.id }).from(athletes).where(and(eq(athletes.personId, personId!), eq(athletes.orgId, c.orgId)));
      if (a) return a.id;
      const inactive = opts.athleteActive === false;
      const [na] = await c.tx
        .insert(athletes)
        .values({ orgId: c.orgId, personId: personId!, sport: opts.sport ?? null, active: !inactive, inactiveReason: inactive ? `Inactive in ${c.schema.idSource}` : null })
        .returning({ id: athletes.id });
      out.created.push({ type: "athlete", id: na.id });
      return na.id;
    });
  }
  return { personId, athleteId, createdPerson };
}

/** Fill empty fields on a pre-existing person; never overwrite. Conflicts become warnings. */
async function fillPerson(c: CommitCtx, personId: string, d: PersonData, out: RowOutcome) {
  const [p] = await c.tx.select().from(people).where(and(eq(people.id, personId), eq(people.orgId, c.orgId)));
  if (!p) return;
  const patch: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const pairs: [keyof typeof p, unknown][] = [
    ["dateOfBirth", d.dob],
    ["email", d.email],
    ["phone", d.phone],
  ];
  for (const [col, v] of pairs) {
    if (v === null || v === undefined || v === "") continue;
    const cur = p[col];
    if (cur === null || cur === "") {
      patch[col] = v;
      before[col] = cur;
    } else if (String(cur).toLowerCase() !== String(v).toLowerCase()) {
      out.warnings.push(`Kept existing ${String(col)} "${String(cur)}" (file had "${String(v)}").`);
    }
  }
  if (Object.keys(patch).length) {
    await c.tx.update(people).set({ ...patch, updatedAt: new Date() }).where(eq(people.id, personId));
    out.updates.push({ type: "person", id: personId, before });
  }
}

// ---------------------------------------------------------------------------
// Per-schema committers
// ---------------------------------------------------------------------------

type Committer = (c: CommitCtx, row: RowRecord, out: RowOutcome) => Promise<void>;

const commitPerson: Committer = async (c, row, out) => {
  const n = row.normalized as Record<string, unknown>;
  const { personId, athleteId, createdPerson } = await ensurePerson(c, row, out, { sport: (n.sport as string) ?? null });
  if (!createdPerson) await fillPerson(c, personId, n, out);
  if (athleteId && !createdPerson && out.created.some((x) => x.type === "athlete")) out.warnings.push("Added an athlete record to an existing person.");
  await linkExternal(c, c.schema.recordEntityType, row.sourceRecordId!, "person", personId);
  out.action = createdPerson ? "create" : out.updates.length ? "update" : "link";
};

const commitFamilyLink: Committer = async (c, row, out) => {
  const n = row.normalized as Record<string, unknown>;
  const { personId: childId, athleteId } = await ensurePerson(c, row, out);
  const gid = await linkGuardian(c, out, { guardianId: n._guardianPersonId as string, childId, athleteId: athleteId!, householdKey: String(n.householdKey), householdName: String(n.householdName), relationship: String(n.relationship ?? "parent") });
  await linkExternal(c, c.schema.recordEntityType, row.sourceRecordId!, "guardianship", gid);
};

/** Household (+ members) and an active guardianship with conservative defaults. Returns the guardianship id. */
async function linkGuardian(
  c: CommitCtx,
  out: RowOutcome,
  input: { guardianId: string; childId: string; athleteId: string; householdKey: string; householdName: string; relationship: string },
): Promise<string> {
  const { guardianId, childId, athleteId } = input;
  const hhKey = input.householdKey;
  const n = { householdName: input.householdName, relationship: input.relationship };
  const householdId = await cached(c, `household:${hhKey}`, async () => {
    const existing = await findExternal(c.tx, c.orgId, c.schema.idSource, "household", hhKey);
    if (existing) return existing;
    const [h] = await c.tx.insert(households).values({ orgId: c.orgId, name: String(n.householdName) }).returning({ id: households.id });
    out.created.push({ type: "household", id: h.id });
    await linkExternal(c, "household", hhKey, "household", h.id);
    return h.id;
  });
  for (const [pid, role] of [
    [guardianId, "guardian"],
    [childId, "child"],
  ] as const) {
    const ins = await c.tx.insert(householdMembers).values({ householdId, personId: pid, role }).onConflictDoNothing().returning({ p: householdMembers.personId });
    if (ins.length) out.created.push({ type: "household_member", id: `${householdId}:${pid}` });
  }
  const [g] = await c.tx
    .select({ id: guardianships.id })
    .from(guardianships)
    .where(and(eq(guardianships.guardianPersonId, guardianId), eq(guardianships.athleteId, athleteId!), sql`${guardianships.status} <> 'revoked'`));
  let gid = g?.id;
  if (!gid) {
    const [ng] = await c.tx
      .insert(guardianships)
      .values({
        orgId: c.orgId,
        guardianPersonId: guardianId,
        athleteId: athleteId!,
        relationship: String(n.relationship ?? "parent"),
        canViewHealth: false,
        isEmergencyContact: false,
        createdBy: c.viewer.userId,
      })
      .returning({ id: guardianships.id });
    gid = ng.id;
    out.created.push({ type: "guardianship", id: gid });
    out.action = "create";
  } else out.action = "link";
  return gid;
}

/**
 * GoHighLevel contact row = one athlete named on the contact. The contact's phone/email belong to
 * the parent: link the person staff confirmed in review, or create one placeholder guardian per
 * contact ("Parent/guardian <Surname>") carrying the phone/email for staff to complete.
 */
const commitGhlContact: Committer = async (c, row, out) => {
  const n = row.normalized as Record<string, unknown>;
  const { personId: childId, athleteId, createdPerson } = await ensurePerson(c, row, out);
  const gc = (n.guardianContact ?? {}) as { phone?: string | null; email?: string | null };
  const hhKey = String(n.householdKey);
  let guardianId = (n._guardianPersonId as string | null) ?? null;
  if (!n._guardianSkip && !guardianId && (gc.phone || gc.email)) {
    guardianId = await cached(c, `ghl-guardian:${hhKey}`, async () => {
      const existing = await findExternal(c.tx, c.orgId, c.schema.idSource, "contact_guardian", hhKey);
      if (existing) return existing;
      const [g] = await c.tx
        .insert(people)
        .values({
          orgId: c.orgId,
          firstName: "Parent/guardian",
          lastName: String(n.lastName ?? "Unknown"),
          email: gc.email || null,
          phone: gc.phone || null,
          status: "active",
          source: c.schema.idSource,
        })
        .returning({ id: people.id });
      out.created.push({ type: "person", id: g.id });
      out.warnings.push("Created a placeholder parent/guardian (name unknown in GHL). Add their real name in People.");
      await linkExternal(c, "contact_guardian", hhKey, "person", g.id);
      return g.id;
    });
  }
  if (guardianId && guardianId !== childId && athleteId) {
    await linkGuardian(c, out, { guardianId, childId, athleteId, householdKey: `ghl:${hhKey}`, householdName: String(n.householdName), relationship: "parent" });
  } else if (n._guardianSkip) {
    out.warnings.push("Parent phone/email matched several people; no guardian linked.");
  }
  await linkExternal(c, c.schema.recordEntityType, row.sourceRecordId!, "person", childId);
  out.action = createdPerson ? "create" : "link";
};

const commitMembership: Committer = async (c, row, out) => {
  const n = row.normalized as Record<string, unknown>;
  const { athleteId } = await ensurePerson(c, row, out);
  const plan = String(n.plan);
  const versionId = await cached(c, `plan:${plan.toLowerCase()}`, async () => {
    const existing = await findExternal(c.tx, c.orgId, c.schema.idSource, "plan_version", plan.toLowerCase());
    if (existing) return existing;
    const [p] = await c.tx
      .insert(products)
      .values({
        orgId: c.orgId,
        name: `${plan} (Zen Planner)`,
        kind: "recurring_membership",
        description:
          n.priceMinor === null
            ? "Imported Zen Planner plan — price not imported (billed in Zen Planner). Not sold in Teamwork."
            : "Imported Zen Planner plan (billed in Zen Planner). Not sold in Teamwork.",
        category: "imported",
        active: false,
        publiclyListed: false,
      })
      .returning({ id: products.id });
    out.created.push({ type: "product", id: p.id });
    const [v] = await c.tx
      .insert(productVersions)
      .values({ productId: p.id, version: 1, priceMinor: (n.priceMinor as number | null) ?? 0, currency: "USD", interval: "month", effectiveFrom: String(n.startDate) })
      .returning({ id: productVersions.id });
    out.created.push({ type: "product_version", id: v.id });
    await linkExternal(c, "plan_version", plan.toLowerCase(), "product_version", v.id);
    return v.id;
  });
  const [m] = await c.tx
    .insert(memberships)
    .values({
      orgId: c.orgId,
      athleteId: athleteId!,
      productVersionId: versionId,
      status: n.status as "active",
      startDate: String(n.startDate),
      endDate: (n.endDate as string) ?? null,
      nextBillDate: (n.nextBillDate as string) ?? null,
      billingProvider: "external_zenplanner",
      providerSubscriptionId: null,
      source: "zenplanner",
      createdBy: c.viewer.userId,
    })
    .returning({ id: memberships.id });
  out.created.push({ type: "membership", id: m.id });
  await linkExternal(c, c.schema.recordEntityType, row.sourceRecordId!, "membership", m.id);
  out.action = "create";
};

const commitAttendance: Committer = async (c, row, out) => {
  const n = row.normalized as Record<string, unknown>;
  const { athleteId } = await ensurePerson(c, row, out);
  const serviceTypeId = await cached(c, "service_type", async () => {
    const existing = await findExternal(c.tx, c.orgId, c.schema.idSource, "service_type", "imported_attendance");
    if (existing) return existing;
    const [s] = await c.tx
      .insert(serviceTypes)
      .values({
        orgId: c.orgId,
        name: "Imported (Zen Planner)",
        kind: "class",
        description: "Historical attendance imported from Zen Planner. Not bookable.",
        creditCost: 0,
        active: false,
        publicBookable: false,
      })
      .returning({ id: serviceTypes.id });
    out.created.push({ type: "service_type", id: s.id });
    await linkExternal(c, "service_type", "imported_attendance", "service_type", s.id);
    return s.id;
  });
  const startsAt = new Date(String(n.startsAt));
  const sessionKey = syntheticId(c.orgId, "zp-session", String(n.className).toLowerCase(), startsAt.toISOString());
  const sessionId = await cached(c, `session:${sessionKey}`, async () => {
    const existing = await findExternal(c.tx, c.orgId, c.schema.idSource, "session", sessionKey);
    if (existing) return existing;
    const [s] = await c.tx
      .insert(scheduleSessions)
      .values({
        orgId: c.orgId,
        serviceTypeId,
        title: String(n.className),
        startsAt,
        endsAt: new Date(startsAt.getTime() + Math.max(1, Number(n.durationMinutes ?? 60)) * 60_000),
        timezone: c.tz,
        capacity: 0,
        status: "completed",
        visibility: "private",
        notes: `Imported from Zen Planner (import batch ${c.batchId}). Source time: ${String(n.sourceTimestamp)}`,
      })
      .returning({ id: scheduleSessions.id });
    out.created.push({ type: "schedule_session", id: s.id });
    await linkExternal(c, "session", sessionKey, "schedule_session", s.id);
    return s.id;
  });
  const status = n.status === "no_show" ? "no_show" : "attended";
  const [b] = await c.tx
    .insert(bookings)
    .values({
      orgId: c.orgId,
      sessionId,
      athleteId: athleteId!,
      status,
      checkedInAt: status === "attended" ? startsAt : null,
      checkInMethod: status === "attended" ? "staff" : null,
      idempotencyKey: `import:${row.sourceRecordId}`,
      source: "zenplanner",
    })
    .onConflictDoNothing()
    .returning({ id: bookings.id });
  if (!b) {
    out.action = "skip";
    out.warnings.push("Athlete already has a booking on this session; not duplicated.");
    return;
  }
  await c.tx.update(scheduleSessions).set({ capacity: sql`${scheduleSessions.capacity} + 1` }).where(eq(scheduleSessions.id, sessionId));
  out.created.push({ type: "booking", id: b.id });
  await linkExternal(c, c.schema.recordEntityType, row.sourceRecordId!, "booking", b.id);
  out.action = "create";
};

const commitDocument: Committer = async (c, row, out) => {
  const n = row.normalized as Record<string, unknown>;
  const { personId } = await ensurePerson(c, row, out);
  const file = String(n.file);
  const bytes = c.attachments.get(file.toLowerCase()) ?? c.attachments.get(file.split("/").pop()!.toLowerCase());
  if (!bytes) throw new Error(`File ${file} missing from upload`);
  const obj = await saveObject(c.tx, {
    orgId: c.orgId,
    bytes,
    filename: file.split("/").pop()!,
    mimeType: file.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
    kind: "imported_archive",
    ownerPersonId: personId,
    accessLevel: "staff",
    uploadedBy: c.viewer.userId,
  });
  out.created.push({ type: "stored_object", id: obj.id });
  const [d] = await c.tx
    .insert(archivedDocuments)
    .values({
      orgId: c.orgId,
      personId,
      objectId: obj.id,
      title: String(n.title),
      originalSystem: "zenplanner",
      originalSignedAt: n.signedAt ? new Date(String(n.signedAt)) : null,
      originalEvidence: { signer: n.signer ?? null, sourceTimestamp: n.sourceTimestamp ?? null, sha256: obj.sha256, filename: file, sourceRecordId: row.sourceRecordId },
      importBatchId: c.batchId,
    })
    .returning({ id: archivedDocuments.id });
  out.created.push({ type: "archived_document", id: d.id });
  await linkExternal(c, c.schema.recordEntityType, row.sourceRecordId!, "archived_document", d.id);
  out.action = "create";
};

async function ensureExercise(c: CommitCtx, name: string, unit: string | null, out: RowOutcome) {
  return cached(c, `exercise:${name.toLowerCase()}`, async () => {
    const [e] = await c.tx.select({ id: exercises.id }).from(exercises).where(and(eq(exercises.orgId, c.orgId), sql`lower(${exercises.name}) = ${name.toLowerCase()}`));
    if (e) return e.id;
    const [ne] = await c.tx
      .insert(exercises)
      .values({ orgId: c.orgId, name, category: "imported", trackingType: "weight_reps", defaultUnit: (unit as "lb") ?? "lb", coachingNotes: `Created by ${c.schema.label} import.` })
      .returning({ id: exercises.id });
    out.created.push({ type: "exercise", id: ne.id });
    return ne.id;
  });
}

const commitMax: Committer = async (c, row, out) => {
  const n = row.normalized as Record<string, unknown>;
  const { athleteId } = await ensurePerson(c, row, out);
  const exerciseId = await ensureExercise(c, String(n.exercise), n.unit as string, out);
  const [m] = await c.tx
    .insert(maxes)
    .values({
      orgId: c.orgId,
      athleteId: athleteId!,
      exerciseId,
      value: String(n.rawValue).replace(/,/g, ""),
      unit: n.unit as "lb",
      kind: n.kind as "imported",
      method: String(n.method),
      recordedOn: String(n.date),
      source: "teambuildr",
      sourceRecordId: row.sourceRecordId,
      importBatchId: c.batchId,
      enteredBy: c.viewer.userId,
    })
    .returning({ id: maxes.id });
  out.created.push({ type: "max", id: m.id });
  await linkExternal(c, c.schema.recordEntityType, row.sourceRecordId!, "max", m.id);
  out.action = "create";
};

const commitSet: Committer = async (c, row, out) => {
  const n = row.normalized as Record<string, unknown>;
  const { athleteId } = await ensurePerson(c, row, out);
  const date = String(n.date);
  const title = String(n.workout);
  const wKey = syntheticId(c.orgId, "tb-workout", athleteId, date, title.toLowerCase());
  const workoutId = await cached(c, `workout:${wKey}`, async () => {
    const existing = await findExternal(c.tx, c.orgId, c.schema.idSource, "workout", wKey);
    if (existing) return existing;
    const [w] = await c.tx
      .insert(workouts)
      .values({ orgId: c.orgId, athleteId: athleteId!, scheduledDate: date, title, status: "completed", source: "teambuildr", sourceRecordId: wKey })
      .returning({ id: workouts.id });
    out.created.push({ type: "workout", id: w.id });
    await linkExternal(c, "workout", wKey, "workout", w.id);
    return w.id;
  });
  const exerciseId = await ensureExercise(c, String(n.exercise), (n.loadUnit as string) ?? null, out);
  const iKey = `${wKey}|${String(n.exercise).toLowerCase()}`;
  const itemId = await cached(c, `item:${iKey}`, async () => {
    const existing = await findExternal(c.tx, c.orgId, c.schema.idSource, "workout_item", iKey);
    if (existing) return existing;
    const [{ count }] = await c.tx.select({ count: sql<number>`count(*)::int` }).from(workoutItems).where(eq(workoutItems.workoutId, workoutId));
    const [it] = await c.tx
      .insert(workoutItems)
      .values({ workoutId, sortOrder: count + 1, exerciseId, blockLabel: String.fromCharCode(65 + Math.min(count, 25)), prescription: [], notes: "Imported from TeamBuildr (performed sets only)." })
      .returning({ id: workoutItems.id });
    out.created.push({ type: "workout_item", id: it.id });
    await linkExternal(c, "workout_item", iKey, "workout_item", it.id);
    return it.id;
  });
  const [s] = await c.tx
    .insert(setLogs)
    .values({
      orgId: c.orgId,
      workoutItemId: itemId,
      athleteId: athleteId!,
      setIndex: Number(n.setIndex),
      reps: (n.reps as number | null) ?? null,
      load: (n.load as string | null) ?? null,
      loadUnit: (n.loadUnit as "lb" | null) ?? null,
      rpe: (n.rpe as string | null) ?? null,
      note: (n.note as string | null) ?? null,
      clientMutationId: row.sourceRecordId!,
      loggedVia: "import",
      loggedBy: c.viewer.userId,
      loggedAt: localToUtc(date, "12:00", c.tz),
    })
    .onConflictDoNothing()
    .returning({ id: setLogs.id });
  if (!s) {
    out.action = "skip";
    out.warnings.push("A set with this number already exists for this exercise and workout; not duplicated.");
    return;
  }
  out.created.push({ type: "set_log", id: s.id });
  await linkExternal(c, c.schema.recordEntityType, row.sourceRecordId!, "set_log", s.id);
  out.action = "create";
};

const commitQuestionnaireAnswer: Committer = async (c, row, out) => {
  const n = row.normalized as Record<string, unknown>;
  const { athleteId } = await ensurePerson(c, row, out);
  const qName = String(n.questionnaire);
  const allQuestions = (c.extra.questions as Record<string, QuestionDef[]>)[qName.toLowerCase()] ?? [];
  const versionId = await cached(c, `qversion:${qName.toLowerCase()}`, async () => {
    let qid = await findExternal(c.tx, c.orgId, c.schema.idSource, "questionnaire", qName.toLowerCase());
    if (!qid) {
      const [q] = await c.tx.insert(questionnaires).values({ orgId: c.orgId, name: `${qName} (TeamBuildr import)`, active: false, schedule: {} }).returning({ id: questionnaires.id });
      qid = q.id;
      out.created.push({ type: "questionnaire", id: qid });
      await linkExternal(c, "questionnaire", qName.toLowerCase(), "questionnaire", qid);
    }
    const [cur] = await c.tx.select().from(questionnaireVersions).where(eq(questionnaireVersions.questionnaireId, qid)).orderBy(sql`${questionnaireVersions.version} desc`).limit(1);
    const missing = allQuestions.filter((q) => !cur?.questions.some((x) => x.key === q.key));
    if (cur && !missing.length) return cur.id;
    const [v] = await c.tx
      .insert(questionnaireVersions)
      .values({ questionnaireId: qid, version: (cur?.version ?? 0) + 1, questions: [...(cur?.questions ?? []), ...missing] })
      .returning({ id: questionnaireVersions.id });
    out.created.push({ type: "questionnaire_version", id: v.id });
    await c.tx.update(questionnaires).set({ currentVersionId: v.id }).where(eq(questionnaires.id, qid));
    return v.id;
  });
  const rKey = syntheticId(c.orgId, "tb-response", athleteId, n.date, qName.toLowerCase());
  const key = String(n.questionKey);
  const answer = (n.answer as number | string | null) ?? null;
  let responseId = c.cache.get(`response:${rKey}`) ?? (await findExternal(c.tx, c.orgId, c.schema.idSource, "questionnaire_response", rKey));
  if (!responseId) {
    const answers: Record<string, number | string | boolean | null> = Object.fromEntries(allQuestions.map((q) => [q.key, null]));
    answers[key] = answer;
    const [r] = await c.tx
      .insert(questionnaireResponses)
      .values({
        orgId: c.orgId,
        athleteId: athleteId!,
        versionId,
        forDate: String(n.date),
        answers,
        submittedAt: n.submittedAt ? new Date(String(n.submittedAt)) : localToUtc(String(n.date), "12:00", c.tz),
        source: "teambuildr",
        sourceRecordId: rKey,
      })
      .returning({ id: questionnaireResponses.id });
    responseId = r.id;
    c.cache.set(`respcreated:${rKey}`, "1");
    out.created.push({ type: "questionnaire_response", id: r.id });
    await linkExternal(c, "questionnaire_response", rKey, "questionnaire_response", r.id);
    out.action = "create";
  } else {
    const [r] = await c.tx.select({ answers: questionnaireResponses.answers }).from(questionnaireResponses).where(eq(questionnaireResponses.id, responseId));
    const createdHere = c.cache.has(`respcreated:${rKey}`);
    const firstTouch = !c.cache.has(`response:${rKey}`);
    if (!createdHere && firstTouch) out.updates.push({ type: "questionnaire_response", id: responseId, before: { answers: r.answers } });
    await c.tx.update(questionnaireResponses).set({ answers: { ...r.answers, [key]: answer } }).where(eq(questionnaireResponses.id, responseId));
    out.action = createdHere ? "create" : "update";
  }
  c.cache.set(`response:${rKey}`, responseId);
  await linkExternal(c, c.schema.recordEntityType, row.sourceRecordId!, "questionnaire_response", responseId);
};

async function ensureMetricDef(c: CommitCtx, definedBy: "hawkin" | "other_vendor", m: { key: string; label: string; unit: string; header?: string; decimals?: number | null }, out: RowOutcome) {
  return cached(c, `metric:${definedBy}:${m.key}`, async () => {
    const [d] = await c.tx
      .select({ id: metricDefinitions.id })
      .from(metricDefinitions)
      .where(and(eq(metricDefinitions.orgId, c.orgId), eq(metricDefinitions.definedBy, definedBy), eq(metricDefinitions.key, m.key)));
    if (d) return d.id;
    const [nd] = await c.tx
      .insert(metricDefinitions)
      .values({
        orgId: c.orgId,
        key: m.key,
        name: m.label,
        unit: m.unit,
        category: definedBy === "hawkin" ? "force_plate" : "other",
        definedBy,
        vendorMetricId: m.header ?? m.label,
        precision: m.decimals ?? 2,
        description: definedBy === "hawkin" ? "Vendor-defined Hawkin Dynamics metric (imported as exported)." : "Imported vendor metric.",
      })
      .returning({ id: metricDefinitions.id });
    out.created.push({ type: "metric_definition", id: nd.id });
    return nd.id;
  });
}

const commitHawkin: Committer = async (c, row, out) => {
  const n = row.normalized as Record<string, unknown>;
  const { athleteId } = await ensurePerson(c, row, out, { athleteActive: n.athleteActive as boolean | null });
  const typeName = String(n.testType);
  const typeKey = (n.testTypeId as string) ?? typeName.toLowerCase();
  const testTypeId = await cached(c, `testtype:${typeKey}`, async () => {
    const ext = await findExternal(c.tx, c.orgId, "hawkin", "test_type", typeKey);
    if (ext) return ext;
    const [t] = await c.tx.select({ id: testTypes.id }).from(testTypes).where(and(eq(testTypes.orgId, c.orgId), eq(testTypes.vendor, "hawkin"), eq(testTypes.key, slug(typeName))));
    let id = t?.id;
    if (!id) {
      const [nt] = await c.tx
        .insert(testTypes)
        .values({ orgId: c.orgId, key: slug(typeName), name: typeName, vendor: "hawkin", vendorTestTypeId: (n.testTypeId as string) ?? null, protocol: "Vendor-defined (Hawkin Dynamics)" })
        .returning({ id: testTypes.id });
      id = nt.id;
      out.created.push({ type: "test_type", id });
    }
    await linkExternal(c, "test_type", typeKey, "test_type", id, "hawkin");
    return id;
  });
  const metrics = (n.metrics as MetricCell[]) ?? [];
  const sessionKey = row.sourceRecordId!;
  const testedAt = new Date(String(n.testedAt));
  const isAggregate = Boolean(n.isAggregate);
  const sourceActive = n.active !== false && n.athleteActive !== false;
  const existingSession = await findExternal(c.tx, c.orgId, "hawkin", "test", sessionKey);

  if (existingSession) {
    const [trial] = await c.tx.select({ id: trials.id }).from(trials).where(eq(trials.testSessionId, existingSession)).limit(1);
    let changed = false;
    for (const m of metrics) {
      const defId = await ensureMetricDef(c, "hawkin", m, out);
      const [mv] = await c.tx
        .select({ id: metricValues.id, rawValue: metricValues.rawValue, value: metricValues.value })
        .from(metricValues)
        .where(and(eq(metricValues.source, "hawkin"), eq(metricValues.sourceRecordId, sessionKey), eq(metricValues.metricDefinitionId, defId)));
      if (mv && mv.rawValue === m.raw) continue;
      changed = true;
      if (mv) {
        out.updates.push({ type: "metric_value", id: mv.id, before: { value: mv.value, rawValue: mv.rawValue } });
        await c.tx.update(metricValues).set({ value: m.value, rawValue: m.raw }).where(eq(metricValues.id, mv.id));
      } else {
        const [nv] = await c.tx
          .insert(metricValues)
          .values({
            orgId: c.orgId, athleteId: athleteId!, metricDefinitionId: defId, testSessionId: existingSession, trialId: trial?.id ?? null,
            value: m.value, rawValue: m.raw, unit: m.unit, recordedAt: testedAt, source: "hawkin",
            aggregation: isAggregate ? "vendor_mean" : "trial", importBatchId: c.batchId, sourceRecordId: sessionKey,
          })
          .returning({ id: metricValues.id });
        out.created.push({ type: "metric_value", id: nv.id });
      }
    }
    if (trial) {
      const [t] = await c.tx.select({ sourceActive: trials.sourceActive }).from(trials).where(eq(trials.id, trial.id));
      if (t.sourceActive !== sourceActive) {
        out.updates.push({ type: "trial", id: trial.id, before: { sourceActive: t.sourceActive } });
        await c.tx.update(trials).set({ sourceActive }).where(eq(trials.id, trial.id));
        changed = true;
      }
    }
    await linkExternal(c, "test", sessionKey, "test_session", existingSession, "hawkin");
    out.action = changed ? "update" : "skip";
    return;
  }

  const [s] = await c.tx
    .insert(testSessions)
    .values({
      orgId: c.orgId,
      athleteId: athleteId!,
      testTypeId,
      testedAt,
      sourceTimestamp: (n.sourceTimestamp as string) ?? null,
      source: "hawkin",
      sourceRecordId: sessionKey,
      importBatchId: c.batchId,
      device: "Hawkin Dynamics force plates",
      notes: isAggregate ? "Vendor average row (Hawkin export)" : null,
    })
    .returning({ id: testSessions.id });
  out.created.push({ type: "test_session", id: s.id });
  const [t] = await c.tx
    .insert(trials)
    .values({
      testSessionId: s.id,
      trialNumber: isAggregate ? null : ((n.trialNumber as number | null) ?? 1),
      performedAt: testedAt,
      isAggregate,
      aggregateKind: isAggregate ? "vendor_mean" : null,
      sourceTrialId: sessionKey,
      rawPayload: (n.payload as object) ?? row.raw,
      sourceActive,
    })
    .returning({ id: trials.id });
  out.created.push({ type: "trial", id: t.id });
  for (const m of metrics) {
    const defId = await ensureMetricDef(c, "hawkin", m, out);
    const [mv] = await c.tx
      .insert(metricValues)
      .values({
        orgId: c.orgId, athleteId: athleteId!, metricDefinitionId: defId, testSessionId: s.id, trialId: t.id,
        value: m.value, rawValue: m.raw, unit: m.unit, recordedAt: testedAt, source: "hawkin",
        aggregation: isAggregate ? "vendor_mean" : "trial", importBatchId: c.batchId, sourceRecordId: sessionKey,
      })
      .returning({ id: metricValues.id });
    out.created.push({ type: "metric_value", id: mv.id });
  }
  await linkExternal(c, "test", sessionKey, "test_session", s.id, "hawkin");
  out.action = "create";
};

const commitMetricValue: Committer = async (c, row, out) => {
  const n = row.normalized as Record<string, unknown>;
  const { athleteId } = await ensurePerson(c, row, out);
  const defId = await ensureMetricDef(c, "other_vendor", { key: String(n.metricKey), label: String(n.metricName), unit: String(n.unit), decimals: n.decimals as number | null }, out);
  const [mv] = await c.tx
    .insert(metricValues)
    .values({
      orgId: c.orgId, athleteId: athleteId!, metricDefinitionId: defId, value: (n.value as number | null) ?? null, rawValue: (n.rawValue as string | null) ?? null,
      unit: String(n.unit), recordedAt: new Date(String(n.recordedAt)), source: "other_vendor", aggregation: "single", importBatchId: c.batchId, sourceRecordId: row.sourceRecordId,
    })
    .returning({ id: metricValues.id });
  out.created.push({ type: "metric_value", id: mv.id });
  await linkExternal(c, c.schema.recordEntityType, row.sourceRecordId!, "metric_value", mv.id);
  out.action = "create";
};

const commitWearable: Committer = async (c, row, out) => {
  const n = row.normalized as Record<string, unknown>;
  const { athleteId } = await ensurePerson(c, row, out);
  const [w] = await c.tx
    .insert(wearableObservations)
    .values({
      orgId: c.orgId, athleteId: athleteId!, provider: String(n.provider), metricKey: String(n.metricKey), observedOn: String(n.date),
      value: (n.value as number | null) ?? null, unit: String(n.unit), quality: n.quality as "measured", sourceRecordId: row.sourceRecordId, importBatchId: c.batchId,
    })
    .onConflictDoNothing()
    .returning({ id: wearableObservations.id });
  if (!w) {
    out.action = "skip";
    return;
  }
  out.created.push({ type: "wearable_observation", id: w.id });
  await linkExternal(c, c.schema.recordEntityType, row.sourceRecordId!, "wearable_observation", w.id);
  out.action = "create";
};

export const COMMITTERS: Record<string, Committer> = {
  "zenplanner.members": commitPerson,
  "generic.people": commitPerson,
  "zenplanner.family_links": commitFamilyLink,
  "zenplanner.memberships": commitMembership,
  "zenplanner.attendance": commitAttendance,
  "zenplanner.documents_index": commitDocument,
  "teambuildr.maxes": commitMax,
  "teambuildr.workout_log": commitSet,
  "teambuildr.questionnaire": commitQuestionnaireAnswer,
  "hawkin.tests_csv": commitHawkin,
  "hawkin.api_tests": commitHawkin,
  "generic.metric_values": commitMetricValue,
  "wearable.daily_csv": commitWearable,
  "gohighlevel.contacts": commitGhlContact,
};

/** Pre-compute per-batch data a committer needs (e.g. all questions per questionnaire). */
export function prepareExtra(schemaId: string, rows: RowRecord[]): Record<string, unknown> {
  if (schemaId !== "teambuildr.questionnaire") return {};
  const byQ: Record<string, Map<string, { label: string; numeric: boolean }>> = {};
  for (const r of rows) {
    const n = r.normalized as Record<string, unknown> | null;
    if (!n || !n.questionKey) continue;
    const q = String(n.questionnaire).toLowerCase();
    byQ[q] ??= new Map();
    const cur = byQ[q].get(String(n.questionKey));
    const numeric = n.answer === null || typeof n.answer === "number";
    byQ[q].set(String(n.questionKey), { label: String(n.question), numeric: (cur?.numeric ?? true) && numeric });
  }
  const questions: Record<string, QuestionDef[]> = {};
  for (const [q, m] of Object.entries(byQ)) {
    questions[q] = [...m.entries()].map(([key, v]) => ({ key, label: v.label, kind: v.numeric ? "number" : "text", polarity: "neutral", required: false }));
  }
  return { questions };
}

export const FACILITY_TZ = DEFAULT_TZ;
