import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import Papa from "papaparse";
import { strToU8, zipSync } from "fflate";
import type { Tx } from "@/db";
import {
  archivedDocuments,
  athletes,
  auditEvents,
  bodyRegionReports,
  bookings,
  exercises,
  formRequests,
  guardianships,
  householdMembers,
  households,
  invoiceLines,
  invoices,
  maxes,
  memberships,
  metricDefinitions,
  metricValues,
  organizations,
  people,
  productVersions,
  products,
  questionnaireResponses,
  rawSignals,
  scheduleSessions,
  setLogs,
  storedObjects,
  testSessions,
  testTypes,
  transactions,
  trials,
  wearableObservations,
  workoutItems,
  workouts,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { athleteCapabilities, AuthzError, can, isStaff, type Viewer } from "@/lib/authz/policy";
import { CSV_FORMULA_ESCAPE } from "@/lib/csv";
import { objectAccess } from "@/lib/forms/access";
import { objectStore, saveObject, sha256Bytes } from "@/lib/storage";

export const EXPORT_SCHEMA_VERSION = "teamwork-export/1";

export type ExportScope = { kind: "org" } | { kind: "athlete"; athleteId: string };

export type ManifestFile = { path: string; sha256: string; bytes: number; dataset?: string; format?: "csv" | "json"; records?: number; kind: "data" | "file" };
export type Manifest = {
  schemaVersion: string;
  generatedAt: string;
  generatedBy: { userId: string; role: string };
  organization: { id: string; name: string; timezone: string };
  scope: ExportScope;
  includes: { health: boolean; billing: boolean };
  files: ManifestFile[];
  /** Record → file links (completed form PDFs, archived documents, raw signal files). */
  links: { entity: string; id: string; path: string; sha256: string }[];
  missingFiles: { entity: string; id: string; reason: string }[];
  notes: string[];
};

type Rights = { health: boolean; billing: boolean };

/** Who may export what. Org-wide: imports.manage. Per athlete: imports.manage, or staff with profile access. */
export async function exportRights(tx: Tx, v: Viewer, scope: ExportScope): Promise<Rights> {
  if (scope.kind === "org") {
    if (!can(v, "imports.manage")) throw new AuthzError("Only owners and admins can export organization-wide data.");
    return { health: true, billing: true };
  }
  if (can(v, "imports.manage")) {
    const caps = await athleteCapabilities(tx, v, scope.athleteId);
    if (!caps.size) throw new AuthzError();
    return { health: true, billing: true };
  }
  if (!isStaff(v)) throw new AuthzError();
  const caps = await athleteCapabilities(tx, v, scope.athleteId);
  if (!caps.has("profile.read")) throw new AuthzError();
  return { health: caps.has("health.read"), billing: caps.has("billing.read") };
}

function cell(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return v as string | number | boolean;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const fields = Object.keys(rows[0]);
  return Papa.unparse({ fields, data: rows.map((r) => fields.map((f) => cell(r[f]))) }, { escapeFormulae: CSV_FORMULA_ESCAPE });
}

const inIds = (col: Parameters<typeof inArray>[0], ids: string[]): SQL => (ids.length ? inArray(col, ids) : sql`false`);

/** Build the export zip in memory. Every file is listed in manifest.json with its sha256. */
export async function buildExport(tx: Tx, v: Viewer, scope: ExportScope): Promise<{ bytes: Uint8Array; manifest: Manifest; filename: string }> {
  const rights = await exportRights(tx, v, scope);
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, v.orgId));
  const orgId = v.orgId;

  // --- Scope: athletes and people ---------------------------------------------------
  const athleteRows =
    scope.kind === "org"
      ? await tx.select().from(athletes).where(eq(athletes.orgId, orgId))
      : await tx.select().from(athletes).where(and(eq(athletes.orgId, orgId), eq(athletes.id, scope.athleteId)));
  if (scope.kind === "athlete" && !athleteRows.length) throw new AuthzError();
  const athleteIds = athleteRows.map((a) => a.id);
  const aFilter = (col: Parameters<typeof inArray>[0]) => (scope.kind === "org" ? sql`true` : inIds(col, athleteIds));

  const guardianRows = await tx.select().from(guardianships).where(and(eq(guardianships.orgId, orgId), aFilter(guardianships.athleteId)));
  const personIds = scope.kind === "org" ? null : [...new Set([...athleteRows.map((a) => a.personId), ...guardianRows.map((g) => g.guardianPersonId)])];
  const peopleRows = await tx
    .select()
    .from(people)
    .where(and(eq(people.orgId, orgId), personIds ? inIds(people.id, personIds) : sql`true`));
  const hhMemberRows = await tx
    .select({ householdId: householdMembers.householdId, personId: householdMembers.personId, role: householdMembers.role, isPrimaryContact: householdMembers.isPrimaryContact })
    .from(householdMembers)
    .innerJoin(households, eq(households.id, householdMembers.householdId))
    .where(and(eq(households.orgId, orgId), personIds ? inIds(householdMembers.personId, athleteRows.map((a) => a.personId)) : sql`true`));
  const hhIds = [...new Set(hhMemberRows.map((h) => h.householdId))];
  const householdRows = await tx.select().from(households).where(and(eq(households.orgId, orgId), scope.kind === "org" ? sql`true` : inIds(households.id, hhIds)));

  const datasets: Record<string, Record<string, unknown>[]> = {
    people: peopleRows.map((p) => ({ ...p, customFields: p.customFields })),
    athletes: athleteRows,
    guardianships: guardianRows,
    households: householdRows,
    household_members: scope.kind === "org" ? hhMemberRows : await tx.select().from(householdMembers).where(inIds(householdMembers.householdId, hhIds)),
  };

  // --- Billing ------------------------------------------------------------------------
  if (rights.billing) {
    const ms = await tx
      .select({ m: memberships, productName: products.name, priceMinor: productVersions.priceMinor, currency: productVersions.currency })
      .from(memberships)
      .innerJoin(productVersions, eq(productVersions.id, memberships.productVersionId))
      .innerJoin(products, eq(products.id, productVersions.productId))
      .where(and(eq(memberships.orgId, orgId), aFilter(memberships.athleteId)));
    datasets.memberships = ms.map((r) => ({ ...r.m, productName: r.productName, priceMinor: r.priceMinor, currency: r.currency }));
    const lineRows = await tx
      .select({ l: invoiceLines })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(and(eq(invoices.orgId, orgId), scope.kind === "org" ? sql`true` : or(inIds(invoiceLines.athleteId, athleteIds), inIds(invoices.membershipId, ms.map((r) => r.m.id)))));
    const invoiceIds = scope.kind === "org" ? null : [...new Set([...lineRows.map((r) => r.l.invoiceId)])];
    const inv = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.orgId, orgId), invoiceIds ? or(inIds(invoices.id, invoiceIds), inIds(invoices.membershipId, ms.map((r) => r.m.id))) : sql`true`));
    datasets.invoices = inv;
    datasets.invoice_lines = scope.kind === "org" ? lineRows.map((r) => r.l) : lineRows.map((r) => r.l).filter((l) => inv.some((i) => i.id === l.invoiceId));
    datasets.transactions = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.orgId, orgId), scope.kind === "org" ? sql`true` : inIds(transactions.invoiceId, inv.map((i) => i.id))));
  }

  // --- Attendance -----------------------------------------------------------------------
  datasets.attendance = (
    await tx
      .select({ b: bookings, title: scheduleSessions.title, startsAt: scheduleSessions.startsAt, endsAt: scheduleSessions.endsAt, sessionStatus: scheduleSessions.status })
      .from(bookings)
      .innerJoin(scheduleSessions, eq(scheduleSessions.id, bookings.sessionId))
      .where(and(eq(bookings.orgId, orgId), aFilter(bookings.athleteId)))
  ).map((r) => ({ ...r.b, sessionTitle: r.title, sessionStartsAt: r.startsAt, sessionEndsAt: r.endsAt, sessionStatus: r.sessionStatus }));

  // --- Training -------------------------------------------------------------------------
  const wk = await tx.select().from(workouts).where(and(eq(workouts.orgId, orgId), aFilter(workouts.athleteId)));
  datasets.workouts = wk;
  datasets.workout_items = (
    await tx
      .select({ i: workoutItems, exercise: exercises.name })
      .from(workoutItems)
      .innerJoin(exercises, eq(exercises.id, workoutItems.exerciseId))
      .where(inIds(workoutItems.workoutId, wk.map((w) => w.id)))
  ).map((r) => ({ ...r.i, exerciseName: r.exercise }));
  datasets.set_logs = await tx.select().from(setLogs).where(and(eq(setLogs.orgId, orgId), aFilter(setLogs.athleteId)));
  datasets.maxes = (
    await tx
      .select({ m: maxes, exercise: exercises.name })
      .from(maxes)
      .innerJoin(exercises, eq(exercises.id, maxes.exerciseId))
      .where(and(eq(maxes.orgId, orgId), aFilter(maxes.athleteId)))
  ).map((r) => ({ ...r.m, exerciseName: r.exercise }));

  // --- Sports science (metrics are performance data; wellness/body reports are health data) --
  const sessions = await tx
    .select({ s: testSessions, testType: testTypes.name, vendor: testTypes.vendor })
    .from(testSessions)
    .innerJoin(testTypes, eq(testTypes.id, testSessions.testTypeId))
    .where(and(eq(testSessions.orgId, orgId), aFilter(testSessions.athleteId)));
  datasets.test_sessions = sessions.map((r) => ({ ...r.s, testTypeName: r.testType, testTypeVendor: r.vendor }));
  const trialRows = await tx.select().from(trials).where(inIds(trials.testSessionId, sessions.map((s) => s.s.id)));
  datasets.trials = trialRows;
  datasets.metric_values = (
    await tx
      .select({ m: metricValues, key: metricDefinitions.key, name: metricDefinitions.name, definedBy: metricDefinitions.definedBy, formulaKey: metricDefinitions.formulaKey, defUnit: metricDefinitions.unit })
      .from(metricValues)
      .innerJoin(metricDefinitions, eq(metricDefinitions.id, metricValues.metricDefinitionId))
      .where(and(eq(metricValues.orgId, orgId), aFilter(metricValues.athleteId)))
  ).map((r) => ({
    ...r.m,
    metricKey: r.key,
    metricName: r.name,
    metricDefinedBy: r.definedBy,
    formulaKey: r.formulaKey,
    definitionUnit: r.defUnit,
  }));
  if (rights.health) {
    datasets.questionnaire_responses = await tx.select().from(questionnaireResponses).where(and(eq(questionnaireResponses.orgId, orgId), aFilter(questionnaireResponses.athleteId)));
    datasets.body_reports = await tx.select().from(bodyRegionReports).where(and(eq(bodyRegionReports.orgId, orgId), aFilter(bodyRegionReports.athleteId)));
    datasets.wearable_observations = await tx.select().from(wearableObservations).where(and(eq(wearableObservations.orgId, orgId), aFilter(wearableObservations.athleteId)));
  }

  // --- Files ----------------------------------------------------------------------------
  const zipFiles: Record<string, Uint8Array> = {};
  const manifest: Manifest = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: { userId: v.userId, role: v.role },
    organization: { id: orgId, name: org?.name ?? "", timezone: org?.timezone ?? "" },
    scope,
    includes: rights,
    files: [],
    links: [],
    missingFiles: [],
    notes: [
      "Money values are integer minor units with an ISO currency column.",
      "Instants are ISO-8601 UTC; local calendar dates are YYYY-MM-DD in the organization timezone. source_timestamp columns keep the original text.",
      "Null means missing / not calculable — never zero. raw_value keeps vendor precision.",
      "metric_values.metricDefinedBy tells whether a value is vendor-defined (e.g. hawkin) or Teamwork-derived (formulaKey/formulaVersion).",
      ...(rights.health ? [] : ["Health data (questionnaires, body reports, wearables) excluded: the exporter lacks health access for this athlete."]),
      ...(rights.billing ? [] : ["Billing data excluded: the exporter lacks billing access for this athlete."]),
    ],
  };
  const addFile = (p: string, bytes: Uint8Array, meta: Omit<ManifestFile, "path" | "sha256" | "bytes">) => {
    zipFiles[p] = bytes;
    const entry: ManifestFile = { path: p, sha256: sha256Bytes(bytes), bytes: bytes.byteLength, ...meta };
    manifest.files.push(entry);
    return entry;
  };
  const addObject = async (entity: string, id: string, objectId: string, dir: string) => {
    const [o] = await tx.select().from(storedObjects).where(and(eq(storedObjects.id, objectId), eq(storedObjects.orgId, orgId)));
    if (!o) return manifest.missingFiles.push({ entity, id, reason: "stored object row missing" });
    let bytes: Uint8Array;
    try {
      bytes = await objectStore().get(o.storageKey);
    } catch {
      return manifest.missingFiles.push({ entity, id, reason: "file missing from storage" });
    }
    if (sha256Bytes(bytes) !== o.sha256) manifest.missingFiles.push({ entity, id, reason: "checksum mismatch vs stored_objects.sha256 (file included anyway)" });
    const p = `files/${dir}/${id}-${o.filename.replace(/[^\w.-]+/g, "_")}`;
    const f = addFile(p, bytes, { kind: "file" });
    manifest.links.push({ entity, id, path: p, sha256: f.sha256 });
  };

  const personIdList = peopleRows.map((p) => p.id);
  // Stored files (completed form PDFs, archived documents) follow the same per-file rules as
  // /api/files: an exporter without imports.manage (e.g. an assigned coach) only gets files they
  // could already open, so an export can't be used to reach intake/medical PDFs or staff archives.
  const fileFilter = async <T>(rows: T[], objectIdOf: (r: T) => string) => {
    if (can(v, "imports.manage")) return rows;
    const out: T[] = [];
    for (const r of rows) if ((await objectAccess(tx, v, objectIdOf(r))).allowed) out.push(r);
    if (out.length < rows.length) manifest.notes.push(`${rows.length - out.length} stored file(s) excluded: the exporter cannot open them.`);
    return out;
  };
  const forms = await fileFilter(
    await tx
      .select()
      .from(formRequests)
      .where(and(eq(formRequests.orgId, orgId), sql`${formRequests.completedPdfObjectId} is not null`, scope.kind === "org" ? sql`true` : inIds(formRequests.subjectPersonId, personIdList))),
    (f) => f.completedPdfObjectId!,
  );
  datasets.completed_forms = forms.map((f) => ({ id: f.id, subjectPersonId: f.subjectPersonId, athleteId: f.athleteId, templateVersionId: f.templateVersionId, status: f.status, completedAt: f.completedAt, integrityHash: f.integrityHash, source: f.source }));
  for (const f of forms) await addObject("form_request", f.id, f.completedPdfObjectId!, "forms");
  const arch = await fileFilter(
    await tx.select().from(archivedDocuments).where(and(eq(archivedDocuments.orgId, orgId), scope.kind === "org" ? sql`true` : inIds(archivedDocuments.personId, personIdList))),
    (d) => d.objectId,
  );
  datasets.archived_documents = arch;
  for (const d of arch) await addObject("archived_document", d.id, d.objectId, "archived_documents");
  const signals = await tx.select().from(rawSignals).where(and(eq(rawSignals.orgId, orgId), inIds(rawSignals.trialId, trialRows.map((t) => t.id))));
  datasets.raw_signals = signals;
  for (const s of signals) await addObject("raw_signal", s.id, s.objectId, "raw_signals");

  for (const [name, rows] of Object.entries(datasets)) {
    addFile(`data/${name}.csv`, strToU8(toCsv(rows)), { dataset: name, format: "csv", records: rows.length, kind: "data" });
    addFile(`data/${name}.json`, strToU8(JSON.stringify(rows, null, 1)), { dataset: name, format: "json", records: rows.length, kind: "data" });
  }
  zipFiles["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const label = scope.kind === "org" ? "org" : `athlete-${scope.athleteId.slice(0, 8)}`;
  return { bytes: zipSync(zipFiles, { level: 6 }), manifest, filename: `teamwork-export-${label}-${stamp}.zip` };
}

/** Generate and store an export (stored object kind "export"); audited with what it includes. */
export async function createExport(tx: Tx, v: Viewer, scope: ExportScope) {
  const { bytes, manifest, filename } = await buildExport(tx, v, scope);
  let ownerPersonId: string | null = null;
  if (scope.kind === "athlete") {
    const [a] = await tx.select({ personId: athletes.personId }).from(athletes).where(and(eq(athletes.id, scope.athleteId), eq(athletes.orgId, v.orgId)));
    ownerPersonId = a.personId;
  }
  const obj = await saveObject(tx, {
    orgId: v.orgId,
    bytes,
    filename,
    mimeType: "application/zip",
    kind: "export",
    ownerPersonId,
    accessLevel: "owner_only",
    uploadedBy: v.userId,
  });
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "export.create", "stored_object", obj.id, {
    summary: `Created ${scope.kind === "org" ? "organization-wide" : "per-athlete"} export (${manifest.files.length} files)`,
    after: { scope, includes: manifest.includes, files: manifest.files.length, sha256: obj.sha256 },
  });
  return { object: obj, manifest };
}

async function exportMeta(tx: Tx, orgId: string, objectId: string): Promise<{ scope: ExportScope; includes: Rights } | null> {
  const [e] = await tx
    .select({ after: auditEvents.after })
    .from(auditEvents)
    .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, "export.create"), eq(auditEvents.entityId, objectId)))
    .limit(1);
  return (e?.after as { scope: ExportScope; includes: Rights } | undefined) ?? null;
}

/** Authorize a download: the viewer needs at least the rights the export was generated with. */
export async function authorizeExportDownload(tx: Tx, v: Viewer, objectId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(objectId)) throw new AuthzError();
  const [o] = await tx.select().from(storedObjects).where(and(eq(storedObjects.id, objectId), eq(storedObjects.orgId, v.orgId), eq(storedObjects.kind, "export")));
  if (!o) throw new AuthzError();
  const meta = await exportMeta(tx, v.orgId, o.id);
  if (!meta) throw new AuthzError();
  const rights = await exportRights(tx, v, meta.scope);
  if ((meta.includes.health && !rights.health) || (meta.includes.billing && !rights.billing)) throw new AuthzError("This export contains data you do not have access to.");
  const bytes = await objectStore().get(o.storageKey);
  if (sha256Bytes(bytes) !== o.sha256) throw new Error("Export file failed its checksum.");
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "export.download", "stored_object", o.id, { summary: `Downloaded ${o.filename}` });
  return { object: o, bytes };
}

/** Exports visible to the viewer: all for imports.manage; otherwise per-athlete exports they created. */
export async function listExports(tx: Tx, v: Viewer) {
  if (!isStaff(v)) throw new AuthzError();
  const rows = await tx
    .select({ o: storedObjects, after: auditEvents.after, personFirst: people.firstName, personLast: people.lastName })
    .from(storedObjects)
    .leftJoin(auditEvents, and(eq(auditEvents.entityId, sql`${storedObjects.id}::text`), eq(auditEvents.action, "export.create")))
    .leftJoin(people, eq(people.id, storedObjects.ownerPersonId))
    .where(and(eq(storedObjects.orgId, v.orgId), eq(storedObjects.kind, "export"), can(v, "imports.manage") ? sql`true` : eq(storedObjects.uploadedBy, v.userId)))
    .orderBy(desc(storedObjects.createdAt))
    .limit(50);
  return rows.map((r) => ({
    ...r.o,
    scope: (r.after as { scope?: ExportScope } | null)?.scope ?? null,
    includes: (r.after as { includes?: Rights } | null)?.includes ?? null,
    athleteName: r.personFirst ? `${r.personFirst} ${r.personLast}` : null,
  }));
}

/** Job handler for large organizations (register under "exports.build" in the worker). */
export const EXPORT_JOB_TYPE = "exports.build";
