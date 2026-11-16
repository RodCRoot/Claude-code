import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import {
  alerts,
  archivedDocuments,
  athletes,
  bookings,
  coachAssignments,
  creditBuckets,
  creditLedger,
  leads,
  membershipHolds,
  personTags,
  tags,
  zpBills,
  zpMembershipDetails,
  zpPersonDetails,
  zpPersonHealth,
  exercises,
  externalIds,
  guardianships,
  householdMembers,
  households,
  importBatches,
  importRows,
  maxes,
  memberships,
  metricDefinitions,
  metricValues,
  organizations,
  people,
  products,
  productVersions,
  questionnaireResponses,
  questionnaires,
  questionnaireVersions,
  rawSignals,
  scheduleSessions,
  serviceTypes,
  setLogs,
  storedObjects,
  testSessions,
  testTypes,
  trials,
  vbtReadings,
  wearableObservations,
  workoutItems,
  workouts,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { UserError } from "@/lib/actions";
import { objectStore, saveObject, sha256Bytes } from "@/lib/storage";
import { DEFAULT_TZ } from "@/lib/time";
import { advanceHawkinCheckpoint } from "@/lib/integrations/hawkin/checkpoint";
import { COMMITTERS, findExternal, prepareExtra, type Created, type RowOutcome, type UpdateRecord } from "./commit";
import { billRefreshPatch, parentKey, prepareGridExtra, ZP_GRID_COMMITTERS } from "./commit-zenplanner";
import { vocabOverrides } from "@/lib/zenplanner/vocab";
import { todayLocal } from "@/lib/time";
import { identityKey, matchPerson } from "./identity";
import { peopleByAddress } from "@/lib/messaging/inbound";
import { autoMap, fieldMapping, mappingOptions, metricHeaders, missingRequired, normalizeRow, OPTION_PREFIX } from "./mapping";
import { cleanCell, parseDate } from "./normalize";
import { ParseError, parseUpload, type ParsedFile } from "./parse";
import { RowCache, rowRejectionReason } from "./row-errors";
import { getSchema } from "./schemas";
import type { IdentityInput, MetricCell, RowAction } from "./types";

export type Batch = typeof importBatches.$inferSelect;
export type ImportRow = typeof importRows.$inferSelect;

const actor = (v: Viewer) => ({ orgId: v.orgId, actorUserId: v.userId, actorRole: v.role });

export async function orgTimezone(tx: Tx, orgId: string): Promise<string> {
  const [o] = await tx.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId));
  return o?.tz ?? DEFAULT_TZ;
}

export async function getBatch(tx: Tx, v: Viewer, id: string, lock = false): Promise<Batch> {
  assertCan(v, "imports.manage");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new UserError("Import not found.");
  const q = tx.select().from(importBatches).where(and(eq(importBatches.id, id), eq(importBatches.orgId, v.orgId)));
  const [b] = lock ? await q.for("update") : await q;
  if (!b) throw new UserError("Import not found.");
  return b;
}

// ---------------------------------------------------------------------------
// 1. Upload
// ---------------------------------------------------------------------------

export async function createBatch(
  tx: Tx,
  v: Viewer,
  input: { filename: string; bytes: Uint8Array; schemaId: string; source?: Batch["source"]; extraMapping?: Record<string, string> },
): Promise<{ batch: Batch; duplicates: Batch[] }> {
  assertCan(v, "imports.manage");
  const schema = getSchema(input.schemaId);
  if (schema.internal && !input.source) throw new UserError("That schema is filled by an integration, not by upload.");
  if (input.bytes.byteLength === 0) throw new UserError("The file is empty.");
  if (input.bytes.byteLength > 25 * 1024 * 1024) throw new UserError("Files over 25 MB are not accepted; split the export by date range.");
  let parsed: ParsedFile;
  try {
    parsed = parseUpload(input.filename, input.bytes);
  } catch (e) {
    if (e instanceof ParseError) throw new UserError(e.message);
    throw e;
  }
  const checksum = sha256Bytes(input.bytes);
  const duplicates = await tx
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.orgId, v.orgId), eq(importBatches.checksum, checksum)))
    .orderBy(desc(importBatches.createdAt));
  const obj = await saveObject(tx, {
    orgId: v.orgId,
    bytes: input.bytes,
    filename: input.filename,
    mimeType: input.filename.toLowerCase().endsWith(".json") ? "application/json" : input.filename.toLowerCase().endsWith(".zip") ? "application/zip" : "text/csv",
    kind: "import_source",
    accessLevel: "owner_only",
    uploadedBy: v.userId,
  });
  const mapping = { ...autoMap(schema, parsed.headers), ...(input.extraMapping ?? {}) };
  const [batch] = await tx
    .insert(importBatches)
    .values({
      orgId: v.orgId,
      source: input.source ?? schema.source,
      entityType: schema.id,
      status: "uploaded",
      objectId: obj.id,
      originalFilename: input.filename,
      checksum,
      mapping,
      stats: { fileRows: parsed.rows.length, columns: parsed.headers.length, attachments: new Set(parsed.attachments.values()).size, duplicateUploads: duplicates.length },
      limitations: schema.limitations,
      createdBy: v.userId,
    })
    .returning();
  await audit(tx, actor(v), "import.upload", "import_batch", batch.id, {
    summary: `Uploaded ${input.filename} (${parsed.rows.length} rows) as ${schema.label}`,
    after: { checksum, schema: schema.id, duplicates: duplicates.map((d) => d.id) },
  });
  return { batch, duplicates };
}

export async function loadBatchFile(tx: Tx, batch: Batch): Promise<ParsedFile> {
  if (!batch.objectId) throw new UserError("The source file for this import is missing.");
  const [o] = await tx.select().from(storedObjects).where(and(eq(storedObjects.id, batch.objectId), eq(storedObjects.orgId, batch.orgId)));
  if (!o) throw new UserError("The source file for this import is missing.");
  const bytes = await objectStore().get(o.storageKey);
  if (sha256Bytes(bytes) !== o.sha256) throw new UserError("The stored source file failed its checksum; re-upload it.");
  return parseUpload(o.filename, bytes);
}

// ---------------------------------------------------------------------------
// 2–3. Schema + mapping
// ---------------------------------------------------------------------------

function assertEditable(b: Batch) {
  if (b.status === "committed") throw new UserError("This import is committed. Revert it before changing it.");
  if (b.status === "reverted") throw new UserError("This import was reverted. Upload the file again to start over.");
}

export async function saveMapping(tx: Tx, v: Viewer, batchId: string, input: { schemaId?: string; mapping: Record<string, string> }) {
  const b = await getBatch(tx, v, batchId, true);
  assertEditable(b);
  const schemaId = input.schemaId ?? b.entityType;
  const schema = getSchema(schemaId);
  if (schema.internal && b.source !== schema.source) throw new UserError("That schema is filled by an integration.");
  const parsed = await loadBatchFile(tx, b);
  const mapping: Record<string, string> = {};
  for (const [k, val] of Object.entries(input.mapping)) {
    if (k.startsWith(OPTION_PREFIX)) {
      const opt = schema.options?.find((o) => OPTION_PREFIX + o.key === k);
      if (opt && opt.choices.some((c) => c.value === val)) mapping[k] = val;
      continue;
    }
    if (!val) continue;
    if (!schema.fields.some((f) => f.key === k)) continue;
    if (!parsed.headers.includes(val)) throw new UserError(`Column "${val}" is not in the file.`);
    mapping[k] = val;
  }
  // Keep integration-provided options (e.g. Hawkin sync window).
  for (const [k, val] of Object.entries(b.mapping)) if (k.startsWith(OPTION_PREFIX + "sync")) mapping[k] = val;
  await tx.delete(importRows).where(eq(importRows.batchId, b.id));
  await tx
    .update(importBatches)
    .set({ entityType: schema.id, source: schema.internal ? b.source : schema.source, mapping, status: "mapped", limitations: schema.limitations, stats: { fileRows: b.stats.fileRows ?? 0, columns: b.stats.columns ?? 0 } })
    .where(eq(importBatches.id, b.id));
  await audit(tx, actor(v), "import.map", "import_batch", b.id, { summary: `Mapping saved (${schema.label})`, before: b.mapping, after: mapping });
  return { missing: missingRequired(schema, mapping) };
}

/** Mapping presets live in organization settings under importMappingPresets[schemaId][name]. */
export async function savePreset(tx: Tx, v: Viewer, batchId: string, name: string) {
  const b = await getBatch(tx, v, batchId);
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new UserError("Name the preset.");
  const m = fieldMapping(b.mapping);
  await tx.execute(sql`
    update organizations set settings = jsonb_set(
      jsonb_set(coalesce(settings, '{}'::jsonb), '{importMappingPresets}', coalesce(settings->'importMappingPresets', '{}'::jsonb), true),
      ${sql.raw(`'{importMappingPresets,${JSON.stringify(b.entityType)}}'`)},
      coalesce(settings->'importMappingPresets'->${b.entityType}, '{}'::jsonb) || ${JSON.stringify({ [clean]: m })}::jsonb, true)
    where id = ${v.orgId}`);
  await audit(tx, actor(v), "import.preset_save", "organization", v.orgId, { summary: `Saved mapping preset "${clean}" for ${b.entityType}`, after: m });
}

export async function listPresets(tx: Tx, orgId: string, schemaId: string): Promise<Record<string, Record<string, string>>> {
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  const all = (o?.settings?.importMappingPresets ?? {}) as Record<string, Record<string, Record<string, string>>>;
  return all[schemaId] ?? {};
}

export async function applyPreset(tx: Tx, v: Viewer, batchId: string, name: string) {
  const b = await getBatch(tx, v, batchId);
  const presets = await listPresets(tx, v.orgId, b.entityType);
  const p = presets[name];
  if (!p) throw new UserError("Preset not found.");
  const parsed = await loadBatchFile(tx, b);
  const usable = Object.fromEntries(Object.entries(p).filter(([, h]) => parsed.headers.includes(h)));
  const opts = Object.fromEntries(Object.entries(b.mapping).filter(([k]) => k.startsWith(OPTION_PREFIX)));
  return saveMapping(tx, v, batchId, { mapping: { ...usable, ...opts } });
}

// ---------------------------------------------------------------------------
// 4–5. Validate + identity matching
// ---------------------------------------------------------------------------

type Planned = {
  rowNumber: number;
  raw: Record<string, unknown>;
  normalized: Record<string, unknown> | null;
  status: ImportRow["status"];
  errors: string[];
  warnings: string[];
  sourceRecordId: string | null;
  matchPersonId: string | null;
  matchConfidence: ImportRow["matchConfidence"];
  matchCandidates: ImportRow["matchCandidates"];
};

async function planExisting(
  tx: Tx,
  orgId: string,
  schemaId: string,
  localId: string,
  n: Record<string, unknown>,
  file: { mapped: string[]; blank: (field: string) => boolean },
): Promise<RowAction> {
  if (schemaId === "zenplanner.bill_grid") {
    // A bill already in the history: a later export refreshes its payment state (paid, unpaid, status, dates).
    const [bill] = await tx.select().from(zpBills).where(and(eq(zpBills.id, localId), eq(zpBills.orgId, orgId)));
    if (!bill) return "skip";
    const patch = billRefreshPatch(bill, n, file.mapped, file.blank);
    if (!Object.keys(patch).length) return "skip";
    n._billPatch = patch;
    return "update";
  }
  if (schemaId === "zenplanner.members" || schemaId === "generic.people" || schemaId === "zenplanner.person_grid") {
    const [p] = await tx.select().from(people).where(and(eq(people.id, localId), eq(people.orgId, orgId)));
    if (!p) return "skip";
    const fills = (p.dateOfBirth === null && n.dob) || (p.email === null && n.email) || (p.phone === null && n.phone);
    return fills ? "update" : "skip";
  }
  if (schemaId.startsWith("hawkin.")) {
    const existing = await tx
      .select({ key: metricDefinitions.key, raw: metricValues.rawValue })
      .from(metricValues)
      .innerJoin(metricDefinitions, eq(metricDefinitions.id, metricValues.metricDefinitionId))
      .where(and(eq(metricValues.orgId, orgId), eq(metricValues.testSessionId, localId)));
    const map = new Map(existing.map((e) => [e.key, e.raw]));
    const changed = ((n.metrics as MetricCell[]) ?? []).some((m) => !map.has(m.key) || map.get(m.key) !== m.raw);
    const [t] = await tx.select({ sourceActive: trials.sourceActive }).from(trials).where(eq(trials.testSessionId, localId)).limit(1);
    const activeChanged = t && t.sourceActive !== (n.active !== false && n.athleteActive !== false);
    return changed || activeChanged ? "update" : "skip";
  }
  return "skip";
}

export async function validateBatch(tx: Tx, v: Viewer, batchId: string) {
  const b = await getBatch(tx, v, batchId, true);
  assertEditable(b);
  const schema = getSchema(b.entityType);
  const missing = missingRequired(schema, b.mapping);
  if (missing.length) throw new UserError(`Map the required fields first: ${missing.join(", ")}.`);
  const parsed = await loadBatchFile(tx, b);
  const tz = await orgTimezone(tx, v.orgId);
  const { metrics } = metricHeaders(schema, parsed.headers, b.mapping);
  const fieldMap = fieldMapping(b.mapping);
  const ctx = {
    orgId: v.orgId,
    tz,
    options: mappingOptions(b.mapping),
    vocab: schema.source === "zenplanner" ? await vocabOverrides(tx, v.orgId) : undefined,
    today: todayLocal(tz),
    mapped: Object.keys(fieldMap),
  };

  // Membership, Bill and Attendance grids follow a Person import from the same Zen Planner account and cannot
  // create people, so a name that exactly one person carries is offered as a suggestion (never linked silently).
  const nameOnlyTier = schema.id in ZP_GRID_COMMITTERS && !schema.allowCreatePerson;
  const planned: Planned[] = [];
  const seen = new Map<string, number>();
  const matches = new Map<string, Awaited<ReturnType<typeof matchPerson>>>();
  const allDates: string[] = [];

  for (let i = 0; i < parsed.rows.length; i++) {
    const raw = parsed.rows[i];
    const rowNumber = i + 2; // header is line 1
    const base = normalizeRow(schema, raw, b.mapping, ctx, metrics);
    // Some sources put several people on one line (a GHL contact naming siblings): one row each.
    for (const r of schema.split ? schema.split(base) : [base]) {
    const p: Planned = {
      rowNumber,
      raw,
      normalized: null,
      status: "ready",
      errors: r.errors,
      warnings: r.warnings,
      sourceRecordId: r.sourceRecordId,
      matchPersonId: null,
      matchConfidence: null,
      matchCandidates: null,
    };
    const n: Record<string, unknown> = { ...r.data, _dates: r.dates };
    p.normalized = n;
    planned.push(p);

    // Schema-specific pre-checks
    if (schema.id === "zenplanner.documents_index" && n.file) {
      const f = String(n.file).toLowerCase();
      if (!parsed.attachments.has(f) && !parsed.attachments.has(f.split("/").pop()!)) r.errors.push(`File "${n.file}" is not in the uploaded .zip.`);
    }
    if (schema.id.startsWith("hawkin.") && r.sourceRecordId && !/^(syn|avg):/.test(r.sourceRecordId)) {
      const [clash] = await tx
        .select({ orgId: testSessions.orgId })
        .from(testSessions)
        .where(and(eq(testSessions.source, "hawkin"), eq(testSessions.sourceRecordId, r.sourceRecordId), ne(testSessions.orgId, v.orgId)))
        .limit(1);
      if (clash) r.errors.push(`Hawkin test ${r.sourceRecordId} already belongs to another organization.`);
    }

    if (r.errors.length) {
      p.status = "invalid";
      n._action = "reject";
      continue;
    }
    if (r.sourceRecordId) {
      const first = seen.get(r.sourceRecordId);
      if (first !== undefined) {
        p.status = "duplicate";
        n._action = "skip";
        p.warnings.push(`Duplicate of row ${first} in this file (same source record).`);
        continue;
      }
      seen.set(r.sourceRecordId, rowNumber);
    }
    allDates.push(...r.dates);
    if (n.skipReason || n.status === "not_checkin") {
      n._action = "skip";
      n._skipReason = n.skipReason ?? "Not a check-in";
      continue;
    }

    // Identity
    const identity = r.identity as IdentityInput;
    n._identity = identity;
    const key = identityKey(identity);
    n._identityKey = key;

    // Already imported? (source record registry)
    const existingLocal = r.sourceRecordId ? await findExternal(tx, v.orgId, schema.idSource, schema.recordEntityType, r.sourceRecordId) : null;

    let m = matches.get(key);
    if (!m) {
      m = await matchPerson(tx, v.orgId, schema.idSource, identity, { nameOnlyTier });
      matches.set(key, m);
    }
    p.matchConfidence = m.confidence;
    p.matchCandidates = m.candidates;

    if (existingLocal) {
      const action = await planExisting(tx, v.orgId, schema.id, existingLocal, n, {
        mapped: ctx.mapped,
        blank: (field) => !fieldMap[field] || cleanCell(raw[fieldMap[field]]) === null,
      });
      n._action = action;
      n._existingLocalId = existingLocal;
      p.matchPersonId = m.personId;
      if (!m.personId && action === "update") {
        // Existing record whose person isn't resolvable by id: resolve via the record.
        if (schema.recordEntityType === "member" || schema.recordEntityType === "person") p.matchPersonId = existingLocal;
      }
      if (action === "update" && !p.matchPersonId && schema.id.startsWith("hawkin.")) {
        const [s] = await tx.select({ personId: athletes.personId }).from(testSessions).innerJoin(athletes, eq(athletes.id, testSessions.athleteId)).where(eq(testSessions.id, existingLocal));
        p.matchPersonId = s?.personId ?? null;
      }
      continue;
    }

    if (m.confidence === "exact_source_id") {
      p.matchPersonId = m.personId;
      n._action = "link";
    } else if (m.confidence === "strong") {
      p.status = "needs_review";
      p.matchPersonId = m.personId;
      n._action = "link";
    } else if (m.confidence === "name_only") {
      p.status = "needs_review";
      p.matchPersonId = m.personId;
      n._action = "link";
      p.warnings.push("Matched by name only: exactly one person in Teamwork has this name, with no birth date or email to confirm it.");
    } else if (m.confidence === "ambiguous") {
      p.status = "needs_review";
      n._action = null;
    } else if (schema.allowCreatePerson) {
      n._action = "create";
    } else {
      p.status = "needs_review";
      n._action = null;
      p.warnings.push("No matching person in Teamwork. Import them first (e.g. the member list), link manually, or skip.");
    }

    // Secondary identity (family links: the guardian).
    if (schema.id === "zenplanner.family_links") {
      const g = n.guardian as IdentityInput;
      const gm = await matchPerson(tx, v.orgId, schema.idSource, g);
      if (gm.confidence === "exact_source_id" || gm.confidence === "strong") {
        n._guardianPersonId = gm.personId;
        if (gm.confidence === "strong") p.warnings.push("Guardian matched by exact name + email (strong match).");
      } else {
        p.status = "invalid";
        n._action = "reject";
        p.errors.push(
          gm.confidence === "none"
            ? `Guardian "${g.firstName} ${g.lastName}" not found — import the member list first.`
            : `Guardian "${g.firstName} ${g.lastName}" is ambiguous (${gm.candidates.length} candidates) — add member IDs to the export.`,
        );
      }
    }

    // GoHighLevel: the contact's phone/email belong to the parent. Propose (never auto-link) a match.
    if (schema.id === "gohighlevel.contacts") {
      const gc = (n.guardianContact ?? {}) as { phone?: string | null; email?: string | null };
      const cands = new Map<string, string>();
      if (gc.email) for (const m of await peopleByAddress(tx, v.orgId, "email", gc.email)) cands.set(m.id, m.name);
      if (gc.phone) for (const m of await peopleByAddress(tx, v.orgId, "sms", gc.phone)) cands.set(m.id, m.name);
      if (p.matchPersonId) cands.delete(p.matchPersonId);
      if (cands.size === 1) {
        const [[gid, gname]] = [...cands.entries()];
        n._guardianPersonId = gid;
        p.warnings.push(`Parent phone/email matches ${gname}. Confirming this row links them as ${String(n.firstName)}'s guardian.`);
        if (p.status === "ready") p.status = "needs_review";
      } else if (cands.size > 1) {
        n._guardianPersonId = null;
        n._guardianSkip = true;
        p.warnings.push(`Parent phone/email matches ${cands.size} people (${[...cands.values()].join(", ")}). No guardian will be linked automatically; link the right one in People.`);
        if (p.status === "ready") p.status = "needs_review";
      } else if (gc.email || gc.phone) {
        p.warnings.push("No one in Teamwork has this phone/email yet: a placeholder parent/guardian record will be created with it.");
      }
    }
    }
  }

  // Zen Planner Person grid: the Parent First/Last/Email columns name a guardian. Never merged by
  // name: an existing person is only proposed (staff confirm the row), and several candidates link nobody.
  if (schema.id === "zenplanner.person_grid") {
    const live = planned.filter((p) => p.normalized && (p.status === "ready" || p.status === "needs_review") && p.normalized._identityKey);
    const byFamilyName = new Map<string, string>();
    for (const p of live) {
      const n = p.normalized!;
      if (n.familyId && n.firstName && n.lastName) byFamilyName.set(`${String(n.familyId)}|${String(n.firstName).toLowerCase()}|${String(n.lastName).toLowerCase()}`, String(n._identityKey));
    }
    for (const p of live) {
      const n = p.normalized!;
      const parent = n.parent as { firstName: string; lastName: string; email: string | null } | null;
      if (!parent || n._action === "skip") continue;
      const who = `${parent.firstName} ${parent.lastName}`;
      const inFile = n.familyId ? byFamilyName.get(`${String(n.familyId)}|${parent.firstName.toLowerCase()}|${parent.lastName.toLowerCase()}`) : undefined;
      if (inFile && inFile !== n._identityKey) {
        n._guardianBatchKey = inFile;
        n._isChildOfBatchRow = true;
        p.warnings.push(`Parent ${who} is also a row in this file with the same Family ID and will be linked as guardian (no health access).`);
        continue;
      }
      const known = await findExternal(tx, v.orgId, schema.idSource, "parent", parentKey((n.familyId as string | null) ?? null, parent));
      if (known) {
        n._guardianPersonId = known;
        continue;
      }
      const gm = await matchPerson(tx, v.orgId, schema.idSource, { sourceEntityType: "member", firstName: parent.firstName, lastName: parent.lastName, email: parent.email, adult: true, needsAthlete: false });
      const others = gm.candidates.filter((c) => c.personId !== p.matchPersonId);
      if ((gm.confidence === "strong" || gm.confidence === "exact_source_id") && gm.personId && gm.personId !== p.matchPersonId) {
        n._guardianPersonId = gm.personId;
        p.warnings.push(`Parent ${who} matches a person already in Teamwork (exact name and email). Confirming this row links them as guardian with no health access.`);
        if (p.status === "ready") p.status = "needs_review";
      } else if (others.length) {
        n._guardianSkip = true;
        p.warnings.push(`Parent ${who} could be ${others.length} existing ${others.length === 1 ? "person" : "people"} (name or email only). No guardian will be linked automatically; link the right one in People.`);
        if (p.status === "ready") p.status = "needs_review";
      } else {
        p.warnings.push(`A new parent/guardian record will be created for ${who} (no health access, not an emergency contact).`);
      }
    }
  }

  // Persist rows
  await tx.delete(importRows).where(eq(importRows.batchId, b.id));
  for (let i = 0; i < planned.length; i += 500) {
    const chunk = planned.slice(i, i + 500);
    await tx.insert(importRows).values(
      chunk.map((p) => ({
        batchId: b.id,
        rowNumber: p.rowNumber,
        raw: p.raw,
        normalized: p.normalized,
        status: p.status,
        errors: p.errors,
        warnings: p.warnings,
        sourceRecordId: p.sourceRecordId,
        matchPersonId: p.matchPersonId,
        matchConfidence: p.matchConfidence,
        matchCandidates: p.matchCandidates,
      })),
    );
  }
  const sorted = allDates.filter((d) => parseDate(d)).sort();
  const stats: Record<string, number> = { ...(await computeStats(tx, b.id)), fileRows: parsed.rows.length, metricColumns: metrics.length, coverageConfirmed: 0 };
  await tx
    .update(importBatches)
    .set({ status: "validated", stats, coverageStart: sorted[0] ?? null, coverageEnd: sorted[sorted.length - 1] ?? null })
    .where(eq(importBatches.id, b.id));
  await audit(tx, actor(v), "import.validate", "import_batch", b.id, { summary: `Validated ${parsed.rows.length} rows`, after: stats });
  return stats;
}

export async function computeStats(tx: Tx, batchId: string): Promise<Record<string, number>> {
  const res = await tx.execute(sql`
    select status, coalesce(normalized->>'_action', 'undecided') as action, count(*)::int as n
    from import_rows where batch_id = ${batchId} group by 1, 2`);
  const stats: Record<string, number> = { rows: 0 };
  for (const r of res.rows as { status: string; action: string; n: number }[]) {
    stats.rows += r.n;
    stats[`status_${r.status}`] = (stats[`status_${r.status}`] ?? 0) + r.n;
    if (r.status === "needs_review") stats.needs_review = (stats.needs_review ?? 0) + r.n;
    else stats[`action_${r.action}`] = (stats[`action_${r.action}`] ?? 0) + r.n;
  }
  return stats;
}

async function refreshStats(tx: Tx, b: Batch) {
  const s = await computeStats(tx, b.id);
  const keep = Object.fromEntries(Object.entries(b.stats).filter(([k]) => ["fileRows", "metricColumns", "coverageConfirmed", "columns", "attachments", "duplicateUploads"].includes(k)));
  await tx.update(importBatches).set({ stats: { ...keep, ...s } }).where(eq(importBatches.id, b.id));
}

// ---------------------------------------------------------------------------
// Review decisions
// ---------------------------------------------------------------------------

export type Decision = { resolution: "link"; personId: string } | { resolution: "create_new" } | { resolution: "skip" };

export async function resolveIdentity(tx: Tx, v: Viewer, batchId: string, key: string, d: Decision) {
  const b = await getBatch(tx, v, batchId, true);
  if (b.status !== "validated") throw new UserError("Validate the import before resolving matches.");
  const schema = getSchema(b.entityType);
  const rows = await tx
    .select({ id: importRows.id, status: importRows.status })
    .from(importRows)
    .where(and(eq(importRows.batchId, b.id), sql`${importRows.normalized}->>'_identityKey' = ${key}`, inArray(importRows.status, ["needs_review", "ready"])));
  if (!rows.length) throw new UserError("Nothing to resolve for that person.");
  let personId: string | null = null;
  let action: RowAction;
  if (d.resolution === "link") {
    const [p] = await tx.select({ id: people.id }).from(people).where(and(eq(people.id, d.personId), eq(people.orgId, v.orgId)));
    if (!p) throw new UserError("Choose a person from this organization.");
    personId = p.id;
    action = "link";
  } else if (d.resolution === "create_new") {
    if (!schema.allowCreatePerson) throw new UserError("This import cannot create people. Import the member list first, link to an existing person, or skip.");
    action = "create";
  } else action = "skip";
  await tx
    .update(importRows)
    .set({
      status: "ready",
      resolution: d.resolution,
      resolvedBy: v.userId,
      matchPersonId: personId,
      normalized: sql`jsonb_set(${importRows.normalized}, '{_action}', ${JSON.stringify(action)}::jsonb)`,
    })
    .where(inArray(importRows.id, rows.map((r) => r.id)));
  await refreshStats(tx, b);
  await audit(tx, actor(v), "import.resolve", "import_batch", b.id, { summary: `${d.resolution} for ${rows.length} row(s)`, after: { key, ...d } });
  return rows.length;
}

/** Confirm every strong (name + DOB/email, single-candidate) suggestion at once. */
export async function confirmStrongMatches(tx: Tx, v: Viewer, batchId: string) {
  const b = await getBatch(tx, v, batchId, true);
  if (b.status !== "validated") throw new UserError("Validate the import first.");
  const res = await tx
    .update(importRows)
    .set({ status: "ready", resolution: "link", resolvedBy: v.userId })
    .where(and(eq(importRows.batchId, b.id), eq(importRows.status, "needs_review"), eq(importRows.matchConfidence, "strong"), sql`${importRows.matchPersonId} is not null`))
    .returning({ id: importRows.id });
  await refreshStats(tx, b);
  await audit(tx, actor(v), "import.confirm_strong", "import_batch", b.id, { summary: `Confirmed ${res.length} strong match row(s)` });
  return res.length;
}

/**
 * Confirm every name-only suggestion at once: rows whose exact first + last name belongs to exactly one person
 * in Teamwork, with nothing in the file to back it up or contradict it. A separate, deliberate step from the
 * strong matches because a name alone is weaker evidence.
 */
export async function confirmNameOnlyMatches(tx: Tx, v: Viewer, batchId: string) {
  const b = await getBatch(tx, v, batchId, true);
  if (b.status !== "validated") throw new UserError("Validate the import first.");
  const res = await tx
    .update(importRows)
    .set({ status: "ready", resolution: "link", resolvedBy: v.userId })
    .where(and(eq(importRows.batchId, b.id), eq(importRows.status, "needs_review"), eq(importRows.matchConfidence, "name_only"), sql`${importRows.matchPersonId} is not null`))
    .returning({ id: importRows.id, key: sql<string>`${importRows.normalized}->>'_identityKey'` });
  await refreshStats(tx, b);
  const peopleCount = new Set(res.map((r) => r.key)).size;
  await audit(tx, actor(v), "import.confirm_name_only", "import_batch", b.id, { summary: `Confirmed ${res.length} name-only match row(s) for ${peopleCount} ${peopleCount === 1 ? "person" : "people"}` });
  return peopleCount;
}

export async function skipUnresolved(tx: Tx, v: Viewer, batchId: string) {
  const b = await getBatch(tx, v, batchId, true);
  if (b.status !== "validated") throw new UserError("Validate the import first.");
  const res = await tx
    .update(importRows)
    .set({ status: "ready", resolution: "skip", resolvedBy: v.userId, normalized: sql`jsonb_set(${importRows.normalized}, '{_action}', '"skip"'::jsonb)` })
    .where(and(eq(importRows.batchId, b.id), eq(importRows.status, "needs_review")))
    .returning({ id: importRows.id });
  await refreshStats(tx, b);
  await audit(tx, actor(v), "import.skip_unresolved", "import_batch", b.id, { summary: `Skipped ${res.length} unresolved row(s)` });
  return res.length;
}

export async function confirmCoverage(tx: Tx, v: Viewer, batchId: string, start: string, end: string, note?: string) {
  const b = await getBatch(tx, v, batchId, true);
  if (b.status !== "validated") throw new UserError("Validate the import first.");
  const s = parseDate(start);
  const e = parseDate(end);
  if (!s || !e) throw new UserError("Enter both coverage dates.", { coverageStart: !s ? "Required" : "", coverageEnd: !e ? "Required" : "" });
  if (s > e) throw new UserError("Coverage start must be on or before the end.");
  const schema = getSchema(b.entityType);
  const limitations = note?.trim() ? `${schema.limitations}\n\nStaff note: ${note.trim()}` : schema.limitations;
  await tx
    .update(importBatches)
    .set({ coverageStart: s, coverageEnd: e, limitations, stats: { ...b.stats, coverageConfirmed: 1 } })
    .where(eq(importBatches.id, b.id));
  await audit(tx, actor(v), "import.coverage", "import_batch", b.id, { summary: `Coverage confirmed ${s} → ${e}`, before: { start: b.coverageStart, end: b.coverageEnd } });
}

// ---------------------------------------------------------------------------
// 7. Commit
// ---------------------------------------------------------------------------

export async function commitBatch(tx: Tx, v: Viewer, batchId: string) {
  const b = await getBatch(tx, v, batchId, true);
  if (b.status === "committed") throw new UserError("Already committed.");
  if (b.status !== "validated") throw new UserError("Validate the import before committing.");
  const schema = getSchema(b.entityType);
  const [{ pending }] = await tx
    .select({ pending: sql<number>`count(*)::int` })
    .from(importRows)
    .where(and(eq(importRows.batchId, b.id), eq(importRows.status, "needs_review")));
  if (pending) throw new UserError(`${pending} row(s) still need review. Link, create, or skip them first.`);
  if (!b.stats.coverageConfirmed) throw new UserError("Confirm the coverage date range on the preview before committing.");

  const rows = await tx.select().from(importRows).where(eq(importRows.batchId, b.id)).orderBy(asc(importRows.rowNumber));
  // Person grid: rows that name another row of the file as their parent go last, so the parent exists first.
  if (schema.id === "zenplanner.person_grid") {
    const late = (r: (typeof rows)[number]) => ((r.normalized as Record<string, unknown> | null)?._isChildOfBatchRow ? 1 : 0);
    rows.sort((a, z) => late(a) - late(z) || a.rowNumber - z.rowNumber);
  }
  const parsed = schema.id === "zenplanner.documents_index" ? await loadBatchFile(tx, b) : null;
  const cache = new RowCache();
  const c = {
    tx,
    viewer: v,
    orgId: v.orgId,
    batchId: b.id,
    schema,
    tz: await orgTimezone(tx, v.orgId),
    attachments: parsed?.attachments ?? new Map<string, Uint8Array>(),
    cache,
    extra: { ...prepareExtra(schema.id, rows), ...prepareGridExtra(schema.id, rows) },
  };
  const committer = COMMITTERS[schema.id] ?? ZP_GRID_COMMITTERS[schema.id];
  // Zen Planner grids: each row commits inside its own savepoint, so a row the database refuses (a check,
  // a missing value, an overlap) is rejected with its reason and the rest of the file still commits.
  const rowSavepoints = schema.id in ZP_GRID_COMMITTERS;
  const counts: Record<string, number> = { create: 0, link: 0, update: 0, skip: 0, reject: 0 };
  const skippedIds: string[] = [];
  for (const row of rows) {
    const n = (row.normalized ?? {}) as Record<string, unknown>;
    if (row.status === "invalid") {
      counts.reject++;
      continue;
    }
    if (row.status === "duplicate") {
      counts.skip++;
      continue;
    }
    if (n._action === "skip" || !n._action) {
      counts.skip++;
      skippedIds.push(row.id);
      continue;
    }
    const out: RowOutcome = { action: n._action as RowAction, created: [], updates: [], warnings: [] };
    if (rowSavepoints) {
      cache.beginRow();
      try {
        await tx.transaction(async () => {
          await committer(c, row, out);
        });
        cache.keepRow();
      } catch (e) {
        const reason = rowRejectionReason(e);
        if (reason === null) throw e;
        // Everything the row wrote is gone with its savepoint; forget the ids it cached and record why.
        cache.undoRow();
        counts.reject++;
        await tx
          .update(importRows)
          .set({ status: "invalid", errors: [...row.errors, `Rejected at commit: ${reason}`], normalized: { ...n, _result: "reject" } })
          .where(eq(importRows.id, row.id));
        continue;
      }
    } else {
      await committer(c, row, out);
    }
    counts[out.action]++;
    await tx
      .update(importRows)
      .set({
        status: out.action === "skip" ? "skipped" : "committed",
        createdEntities: out.created,
        warnings: [...row.warnings, ...out.warnings],
        normalized: { ...n, _result: out.action, _updates: out.updates },
      })
      .where(eq(importRows.id, row.id));
  }
  for (let i = 0; i < skippedIds.length; i += 2000) {
    await tx.update(importRows).set({ status: "skipped" }).where(inArray(importRows.id, skippedIds.slice(i, i + 2000)));
  }
  const stats = { ...b.stats, ...(await computeStats(tx, b.id)), committed_create: counts.create, committed_link: counts.link, committed_update: counts.update, committed_skip: counts.skip, committed_reject: counts.reject };
  await tx.update(importBatches).set({ status: "committed", committedAt: new Date(), committedBy: v.userId, stats }).where(eq(importBatches.id, b.id));
  if (b.source === "hawkin_api") await advanceHawkinCheckpoint(tx, v.orgId, b);
  await audit(tx, actor(v), "import.commit", "import_batch", b.id, { summary: `Committed ${schema.label}: ${JSON.stringify(counts)}`, after: counts });
  return counts;
}

// ---------------------------------------------------------------------------
// 9. Revert
// ---------------------------------------------------------------------------

type TableRef = { table: Parameters<Tx["delete"]>[0]; idCol: Parameters<typeof inArray>[0] };

/** Deletion order respects foreign keys (children first). */
const REVERT_ORDER: [string, TableRef | "household_member" | "person_tag"][] = [
  ["zp_bill", { table: zpBills, idCol: zpBills.id }],
  ["zp_membership_detail", { table: zpMembershipDetails, idCol: zpMembershipDetails.id }],
  ["membership_hold", { table: membershipHolds, idCol: membershipHolds.id }],
  ["credit_bucket", { table: creditBuckets, idCol: creditBuckets.id }],
  ["lead", { table: leads, idCol: leads.id }],
  ["alert", { table: alerts, idCol: alerts.id }],
  ["coach_assignment", { table: coachAssignments, idCol: coachAssignments.id }],
  ["zp_person_health", { table: zpPersonHealth, idCol: zpPersonHealth.id }],
  ["zp_person_detail", { table: zpPersonDetails, idCol: zpPersonDetails.id }],
  ["person_tag", "person_tag"],
  ["tag", { table: tags, idCol: tags.id }],
  ["metric_value", { table: metricValues, idCol: metricValues.id }],
  ["raw_signal", { table: rawSignals, idCol: rawSignals.id }],
  ["trial", { table: trials, idCol: trials.id }],
  ["test_session", { table: testSessions, idCol: testSessions.id }],
  ["vbt_reading", { table: vbtReadings, idCol: vbtReadings.id }],
  ["set_log", { table: setLogs, idCol: setLogs.id }],
  ["workout_item", { table: workoutItems, idCol: workoutItems.id }],
  ["workout", { table: workouts, idCol: workouts.id }],
  ["max", { table: maxes, idCol: maxes.id }],
  ["booking", { table: bookings, idCol: bookings.id }],
  ["schedule_session", { table: scheduleSessions, idCol: scheduleSessions.id }],
  ["service_type", { table: serviceTypes, idCol: serviceTypes.id }],
  ["membership", { table: memberships, idCol: memberships.id }],
  ["product_version", { table: productVersions, idCol: productVersions.id }],
  ["product", { table: products, idCol: products.id }],
  ["questionnaire_response", { table: questionnaireResponses, idCol: questionnaireResponses.id }],
  ["questionnaire_version", { table: questionnaireVersions, idCol: questionnaireVersions.id }],
  ["questionnaire", { table: questionnaires, idCol: questionnaires.id }],
  ["wearable_observation", { table: wearableObservations, idCol: wearableObservations.id }],
  ["archived_document", { table: archivedDocuments, idCol: archivedDocuments.id }],
  ["stored_object", { table: storedObjects, idCol: storedObjects.id }],
  ["guardianship", { table: guardianships, idCol: guardianships.id }],
  ["household_member", "household_member"],
  ["household", { table: households, idCol: households.id }],
  ["athlete", { table: athletes, idCol: athletes.id }],
  ["person", { table: people, idCol: people.id }],
  ["exercise", { table: exercises, idCol: exercises.id }],
  ["metric_definition", { table: metricDefinitions, idCol: metricDefinitions.id }],
  ["test_type", { table: testTypes, idCol: testTypes.id }],
];

const RESTORABLE: Record<string, { table: Parameters<Tx["update"]>[0]; idCol: Parameters<typeof eq>[0] }> = {
  person: { table: people, idCol: people.id },
  athlete: { table: athletes, idCol: athletes.id },
  metric_value: { table: metricValues, idCol: metricValues.id },
  trial: { table: trials, idCol: trials.id },
  questionnaire_response: { table: questionnaireResponses, idCol: questionnaireResponses.id },
  zp_bill: { table: zpBills, idCol: zpBills.id },
};

async function tryDelete(tx: Tx, type: string, ref: TableRef | "household_member" | "person_tag", ids: string[]): Promise<{ deleted: number; kept: string[] }> {
  const run = async (subset: string[]) => {
    if (ref === "person_tag") {
      for (const composite of subset) {
        const [pid, tid] = composite.split(":");
        await tx.delete(personTags).where(and(eq(personTags.personId, pid), eq(personTags.tagId, tid)));
      }
      return;
    }
    if (type === "credit_bucket") {
      // An imported punch card that was never used has only its grant entry. One that a booking
      // already drew on still has booking-linked entries, so the delete fails and the bucket is kept.
      await tx.delete(creditLedger).where(and(inArray(creditLedger.bucketId, subset), eq(creditLedger.kind, "grant")));
    }
    if (type === "tag") {
      // Keep a tag someone else has started using since the import.
      const used = await tx.select({ id: personTags.tagId }).from(personTags).where(inArray(personTags.tagId, subset));
      if (used.length) throw new Error("tag in use");
    }
    if (ref === "household_member") {
      for (const composite of subset) {
        const [hh, pid] = composite.split(":");
        await tx.delete(householdMembers).where(and(eq(householdMembers.householdId, hh), eq(householdMembers.personId, pid)));
      }
      return;
    }
    if (type === "person") {
      // Import rows of reverted / uncommitted batches may still point at a person we created;
      // unhook them (rows of in-progress batches go back to review). Committed batches keep theirs,
      // which correctly blocks deleting a person later data depends on.
      await tx.execute(sql`
        update import_rows r set match_person_id = null,
          status = case when b.status = 'validated' and r.status in ('ready','needs_review') then 'needs_review' else r.status end,
          resolution = case when b.status = 'validated' then null else r.resolution end
        from import_batches b
        where b.id = r.batch_id and b.status <> 'committed' and r.match_person_id in (${sql.join(subset.map((id) => sql`${id}::uuid`), sql`, `)})`);
    }
    if (type === "questionnaire_version") {
      await tx.update(questionnaires).set({ currentVersionId: null }).where(inArray(questionnaires.currentVersionId, subset));
    }
    await tx.delete(ref.table).where(inArray(ref.idCol, subset));
  };
  // Try in one savepoint; if something still references a record, fall back to one-by-one.
  try {
    await tx.transaction(async () => {
      await run(ids);
    });
    return { deleted: ids.length, kept: [] };
  } catch {
    const kept: string[] = [];
    let deleted = 0;
    for (const id of ids) {
      try {
        await tx.transaction(async () => {
          await run([id]);
        });
        deleted++;
      } catch {
        kept.push(id);
      }
    }
    return { deleted, kept };
  }
}

export async function revertBatch(tx: Tx, v: Viewer, batchId: string) {
  const b = await getBatch(tx, v, batchId, true);
  if (b.status === "reverted") return { alreadyReverted: true, deleted: 0, kept: [] as Created[], deletedStorageKeys: [] as string[] };
  if (b.status !== "committed") throw new UserError("Only committed imports can be reverted.");
  const rows = await tx.select().from(importRows).where(eq(importRows.batchId, b.id));
  const byType = new Map<string, Set<string>>();
  const updates: UpdateRecord[] = [];
  for (const r of rows) {
    for (const ce of r.createdEntities) {
      if (!byType.has(ce.type)) byType.set(ce.type, new Set());
      byType.get(ce.type)!.add(ce.id);
    }
    const n = (r.normalized ?? {}) as Record<string, unknown>;
    updates.push(...(((n._updates as UpdateRecord[]) ?? []) as UpdateRecord[]));
  }
  // Restore pre-existing records we changed (newest-first so the original "before" wins).
  for (const u of updates.reverse()) {
    if (byType.get(u.type)?.has(u.id)) continue;
    const t = RESTORABLE[u.type];
    if (!t) continue;
    let before = u.before;
    if (u.after) {
      // Put back only the fields that still hold what this batch wrote: a later import (or anything else) that
      // changed a field since then keeps its value.
      const [cur] = (await tx.select().from(t.table as never).where(eq(t.idCol, u.id))) as Record<string, unknown>[];
      if (!cur) continue;
      before = Object.fromEntries(Object.entries(u.before).filter(([k]) => (cur[k] ?? null) === (u.after![k] ?? null)));
      if (!Object.keys(before).length) continue;
    }
    await tx.update(t.table).set(before as never).where(eq(t.idCol, u.id));
  }
  let deleted = 0;
  const kept: Created[] = [];
  // Bytes of stored objects whose rows this revert deletes; the caller removes them from the
  // object store after the transaction commits (deleteStoredBytes), never before.
  const deletedStorageKeys: string[] = [];
  for (const [type, ref] of REVERT_ORDER) {
    const ids = [...(byType.get(type) ?? [])];
    if (!ids.length) continue;
    const keys =
      type === "stored_object"
        ? await tx.select({ id: storedObjects.id, key: storedObjects.storageKey }).from(storedObjects).where(and(eq(storedObjects.orgId, v.orgId), inArray(storedObjects.id, ids)))
        : [];
    const res = await tryDelete(tx, type, ref, ids);
    deleted += res.deleted;
    kept.push(...res.kept.map((id) => ({ type, id })));
    deletedStorageKeys.push(...keys.filter((k) => !res.kept.includes(k.id)).map((k) => k.key));
  }
  // External ids this batch introduced are removed — except those for records that had to be kept
  // (still referenced by later data), so a re-import links to them instead of duplicating.
  const keptIds = kept.map((k) => k.id).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  await tx
    .delete(externalIds)
    .where(
      and(
        eq(externalIds.orgId, v.orgId),
        eq(externalIds.firstImportBatchId, b.id),
        keptIds.length ? sql`${externalIds.localId} not in (${sql.join(keptIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`true`,
      ),
    );
  await tx.update(importRows).set({ status: "reverted" }).where(and(eq(importRows.batchId, b.id), inArray(importRows.status, ["committed", "skipped"])));
  await tx
    .update(importBatches)
    .set({ status: "reverted", revertedAt: new Date(), revertedBy: v.userId, stats: { ...b.stats, reverted_deleted: deleted, reverted_kept: kept.length, reverted_restored: updates.length } })
    .where(eq(importBatches.id, b.id));
  await audit(tx, actor(v), "import.revert", "import_batch", b.id, {
    summary: `Reverted: deleted ${deleted} created record(s), restored ${updates.length} update(s), kept ${kept.length} still referenced elsewhere`,
    after: { kept },
  });
  return { alreadyReverted: false, deleted, kept, deletedStorageKeys };
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export async function listBatches(tx: Tx, v: Viewer, limit = 100) {
  assertCan(v, "imports.manage");
  return tx.select().from(importBatches).where(eq(importBatches.orgId, v.orgId)).orderBy(desc(importBatches.createdAt)).limit(limit);
}

export async function batchRows(tx: Tx, v: Viewer, batchId: string, filter?: ImportRow["status"][], limit = 200) {
  const b = await getBatch(tx, v, batchId);
  const conds = [eq(importRows.batchId, b.id)];
  if (filter?.length) conds.push(inArray(importRows.status, filter));
  return tx.select().from(importRows).where(and(...conds)).orderBy(asc(importRows.rowNumber)).limit(limit);
}

/** Identity groups awaiting review, one entry per source person. */
export async function reviewGroups(tx: Tx, v: Viewer, batchId: string) {
  const rows = await batchRows(tx, v, batchId, ["needs_review"], 5000);
  const groups = new Map<string, { key: string; rows: ImportRow[]; identity: IdentityInput; confidence: ImportRow["matchConfidence"]; suggested: string | null; candidates: { personId: string; reason: string }[] }>();
  for (const r of rows) {
    const n = r.normalized as Record<string, unknown>;
    const key = String(n._identityKey);
    const g = groups.get(key);
    if (g) g.rows.push(r);
    else groups.set(key, { key, rows: [r], identity: n._identity as IdentityInput, confidence: r.matchConfidence, suggested: r.matchPersonId, candidates: r.matchCandidates ?? [] });
  }
  return [...groups.values()];
}

export type ReviewConfidence = "strong" | "name_only" | "ambiguous" | "none";
export type ReviewGroup = {
  key: string;
  rowCount: number;
  firstRow: number;
  identity: IdentityInput;
  confidence: ImportRow["matchConfidence"];
  suggested: string | null;
  candidates: { personId: string; reason: string }[];
};

/**
 * One page of the identity review: one entry per source person (however many rows they have), counted and
 * filtered in SQL so a 20,000-row file with hundreds of people stays quick. `q` filters by name or email;
 * `confidence` by how the person matched. The totals by confidence ignore the filters (they label the tabs).
 */
export async function reviewGroupPage(
  tx: Tx,
  v: Viewer,
  batchId: string,
  opts: { page?: number; pageSize?: number; q?: string; confidence?: ReviewConfidence | "" } = {},
) {
  const b = await getBatch(tx, v, batchId);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(opts.pageSize ?? 25)));
  const q = (opts.q ?? "").trim().toLowerCase().slice(0, 80);
  const confidence = (["strong", "name_only", "ambiguous", "none"] as const).find((c) => c === opts.confidence) ?? null;
  const base = sql`
    select normalized->>'_identityKey' as key,
           count(*)::int as n,
           min(row_number)::int as first_row,
           coalesce(max(match_confidence), 'none') as confidence,
           lower(coalesce(max(normalized->'_identity'->>'lastName'), '')) as last,
           lower(coalesce(max(normalized->'_identity'->>'firstName'), '')) as first,
           lower(coalesce(max(normalized->'_identity'->>'email'), '')) as email
    from import_rows
    where batch_id = ${b.id} and status = 'needs_review'
    group by 1`;
  const totals = await tx.execute(sql`select confidence, count(*)::int as people, coalesce(sum(n), 0)::int as rows from (${base}) g group by 1`);
  const byConfidence: Record<ReviewConfidence, number> = { strong: 0, name_only: 0, ambiguous: 0, none: 0 };
  let total = 0;
  let totalRows = 0;
  for (const r of totals.rows as { confidence: ReviewConfidence; people: number; rows: number }[]) {
    if (r.confidence in byConfidence) byConfidence[r.confidence] += r.people;
    total += r.people;
    totalRows += r.rows;
  }
  const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const filter = sql`where true ${confidence ? sql`and confidence = ${confidence}` : sql``} ${q ? sql`and ((first || ' ' || last) like ${like} or (last || ', ' || first) like ${like} or email like ${like})` : sql``}`;
  const [{ matching }] = (await tx.execute(sql`select count(*)::int as matching from (${base}) g ${filter}`)).rows as { matching: number }[];
  const pages = Math.max(1, Math.ceil(matching / pageSize));
  const page = Math.min(pages, Math.max(1, Math.trunc(opts.page ?? 1)));
  const keys = (await tx.execute(sql`select key, n, first_row from (${base}) g ${filter} order by last, first, key limit ${pageSize} offset ${(page - 1) * pageSize}`)).rows as { key: string; n: number; first_row: number }[];
  const firstRows = keys.length
    ? await tx
        .select()
        .from(importRows)
        .where(and(eq(importRows.batchId, b.id), eq(importRows.status, "needs_review"), inArray(importRows.rowNumber, keys.map((k) => k.first_row))))
    : [];
  const groups: ReviewGroup[] = [];
  for (const k of keys) {
    const r = firstRows.find((x) => x.rowNumber === k.first_row && String((x.normalized as Record<string, unknown>)._identityKey) === k.key);
    if (!r) continue;
    const n = r.normalized as Record<string, unknown>;
    groups.push({ key: k.key, rowCount: k.n, firstRow: k.first_row, identity: n._identity as IdentityInput, confidence: r.matchConfidence, suggested: r.matchPersonId, candidates: r.matchCandidates ?? [] });
  }
  return { groups, total, totalRows, matching, byConfidence, page, pages, pageSize, q, confidence };
}

export { OPTION_PREFIX };
