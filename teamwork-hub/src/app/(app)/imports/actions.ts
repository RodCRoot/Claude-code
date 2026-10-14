"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { requireViewer } from "@/lib/auth/viewer";
import { assertCan } from "@/lib/authz/policy";
import { formToObject, safeAction, UserError, type ActionState } from "@/lib/actions";
import {
  applyPreset,
  commitBatch,
  confirmCoverage,
  confirmStrongMatches,
  getBatch,
  loadBatchFile,
  resolveIdentity,
  revertBatch,
  saveMapping,
  savePreset,
  skipUnresolved,
  validateBatch,
} from "@/lib/imports/batches";
import { autoMap, OPTION_PREFIX } from "@/lib/imports/mapping";
import { getSchema } from "@/lib/imports/schemas";
import { runHawkinSync, setHawkinOptions } from "@/lib/integrations/hawkin/sync";
import { createExport } from "@/lib/exports/bundle";
import { deleteStoredBytes } from "@/lib/storage";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};

async function importer() {
  const v = await requireViewer();
  assertCan(v, "imports.manage");
  return v;
}

const done = (batchId: string, message: string): ActionState => {
  revalidatePath(`/imports/${batchId}`);
  revalidatePath("/imports");
  return { ok: true, message };
};

/** For actions whose form disappears afterwards: show the result as a page-level message. */
function flash(batchId: string, message: string): never {
  revalidatePath(`/imports/${batchId}`);
  revalidatePath("/imports");
  redirect(`/imports/${batchId}?flash=${encodeURIComponent(message)}`);
}

export const saveMappingAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await importer();
  const batchId = str(fd, "batchId");
  const schemaId = str(fd, "schemaId");
  const raw = formToObject(fd);
  const result = await db.transaction(async (tx) => {
    const b = await getBatch(tx, v, batchId);
    if (schemaId && schemaId !== b.entityType) {
      // Different schema: start from its auto-suggested mapping.
      const parsed = await loadBatchFile(tx, b);
      return saveMapping(tx, v, batchId, { schemaId, mapping: autoMap(getSchema(schemaId), parsed.headers) });
    }
    const mapping: Record<string, string> = {};
    for (const [k, val] of Object.entries(raw)) {
      if (k.startsWith("map.")) mapping[k.slice(4)] = String(val);
      if (k.startsWith("opt.")) mapping[OPTION_PREFIX + k.slice(4)] = String(val);
    }
    return saveMapping(tx, v, batchId, { mapping });
  });
  return done(batchId, result.missing.length ? `Saved. Still missing: ${result.missing.join(", ")}.` : "Mapping saved. Next: validate the rows.");
});

export const presetAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await importer();
  const batchId = str(fd, "batchId");
  const intent = str(fd, "intent");
  if (intent === "save") {
    await db.transaction((tx) => savePreset(tx, v, batchId, str(fd, "presetName")));
    return done(batchId, "Preset saved for this source.");
  }
  const name = str(fd, "preset");
  if (!name) throw new UserError("Choose a preset.");
  await db.transaction((tx) => applyPreset(tx, v, batchId, name));
  return done(batchId, `Applied preset "${name}".`);
});

export const validateAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await importer();
  const batchId = str(fd, "batchId");
  const stats = await db.transaction((tx) => validateBatch(tx, v, batchId));
  return done(batchId, `Validated ${stats.rows ?? 0} rows: ${stats.needs_review ?? 0} need review, ${stats.status_invalid ?? 0} rejected.`);
});

export const resolveAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await importer();
  const batchId = str(fd, "batchId");
  const key = str(fd, "key");
  // An explicit pick from the "someone else" list wins over the pre-selected suggestion.
  const choice = str(fd, "manualPersonId") || str(fd, "choice");
  if (!choice) throw new UserError("Choose a candidate, create new, or skip.");
  const decision =
    choice === "__create" ? ({ resolution: "create_new" } as const) : choice === "__skip" ? ({ resolution: "skip" } as const) : ({ resolution: "link", personId: choice } as const);
  const n = await db.transaction((tx) => resolveIdentity(tx, v, batchId, key, decision));
  return flash(batchId, `Resolved ${n} row(s).`);
});

export const bulkReviewAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await importer();
  const batchId = str(fd, "batchId");
  if (str(fd, "intent") === "confirm_strong") {
    const n = await db.transaction((tx) => confirmStrongMatches(tx, v, batchId));
    return flash(batchId, `Confirmed ${n} strong match row(s).`);
  }
  const n = await db.transaction((tx) => skipUnresolved(tx, v, batchId));
  return flash(batchId, `Skipped ${n} unresolved row(s).`);
});

export const coverageAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await importer();
  const batchId = str(fd, "batchId");
  await db.transaction((tx) => confirmCoverage(tx, v, batchId, str(fd, "coverageStart"), str(fd, "coverageEnd"), str(fd, "note")));
  return done(batchId, "Coverage confirmed.");
});

export const commitAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await importer();
  const batchId = str(fd, "batchId");
  const c = await db.transaction((tx) => commitBatch(tx, v, batchId));
  return flash(batchId, `Committed: ${c.create} created, ${c.link} linked, ${c.update} updated, ${c.skip} skipped, ${c.reject} rejected.`);
});

export const revertAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await importer();
  const batchId = str(fd, "batchId");
  const r = await db.transaction((tx) => revertBatch(tx, v, batchId));
  // Rows are gone (committed); now remove their bytes. Best-effort, failures are logged.
  await deleteStoredBytes(r.deletedStorageKeys);
  if (r.alreadyReverted) return flash(batchId, "Already reverted — nothing changed.");
  return flash(batchId, `Reverted: ${r.deleted} record(s) removed${r.kept.length ? `, ${r.kept.length} kept because later data uses them` : ""}.`);
});

export const hawkinSyncAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await importer();
  const mode = str(fd, "mode");
  let r;
  if (mode === "historical") {
    const from = str(fd, "from");
    const to = str(fd, "to");
    if (!from || !to) throw new UserError("Choose both dates.", { from: !from ? "Required" : "", to: !to ? "Required" : "" });
    const chunk = Number(str(fd, "chunkDays") || 30);
    r = await runHawkinSync(db, v, { mode: "historical", from: new Date(`${from}T00:00:00Z`), to: new Date(`${to}T23:59:59Z`), chunkDays: Math.min(90, Math.max(1, chunk)) });
  } else r = await runHawkinSync(db, v, { mode: "incremental" });
  revalidatePath("/imports/hawkin");
  revalidatePath("/imports");
  if (r.status === "not_configured") throw new UserError(`Hawkin is not configured. Set ${r.envVars.join(", ")} on the server.`);
  if (r.status === "failed") throw new UserError(`Sync failed: ${r.error}`);
  if (r.status === "no_changes") return { ok: true, message: `No new or changed tests (fetched ${r.fetched}).` };
  if (r.status === "awaiting_review" && r.batchId) redirect(`/imports/${r.batchId}`);
  return { ok: true, message: `Synced ${r.kept} test(s) of ${r.fetched} fetched${r.warnings.length ? ` — ${r.warnings.length} warning(s)` : ""}.` };
});

export const hawkinOptionsAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  await db.transaction((tx) => setHawkinOptions(tx, v, { autoCommit: fd.get("autoCommit") === "on", fetchForceTime: fd.get("fetchForceTime") === "on" }));
  revalidatePath("/imports/hawkin");
  return { ok: true, message: "Hawkin options saved." };
});

export const createExportAction = safeAction(async (_p: ActionState, fd: FormData) => {
  const v = await requireViewer();
  const kind = str(fd, "kind");
  const athleteId = str(fd, "athleteId");
  if (kind === "athlete" && !athleteId) throw new UserError("Choose an athlete.", { athleteId: "Required" });
  const { manifest } = await db.transaction((tx) => createExport(tx, v, kind === "org" ? { kind: "org" } : { kind: "athlete", athleteId }));
  revalidatePath("/imports/exports");
  return { ok: true, message: `Export ready: ${manifest.files.length} files${manifest.missingFiles.length ? `, ${manifest.missingFiles.length} file(s) missing (listed in manifest.json)` : ""}.` };
});
