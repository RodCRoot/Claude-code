import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import type { Viewer } from "@/lib/authz/policy";
import { testDb } from "./helpers/db";
import type { DB, Tx } from "@/db";
import { commitBatch, confirmCoverage, createBatch, getBatch, validateBatch } from "@/lib/imports/batches";

// Object storage goes to a throwaway directory during tests.
process.env.STORAGE_DIR = mkdtempSync(path.join(tmpdir(), "tw-imports-"));

export const FIXTURES = path.resolve(__dirname, "../fixtures");

export function fixture(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURES, rel)));
}

/** Zip a fixture folder in memory (e.g. the signed-documents archive). */
export function zipFolder(rel: string): Uint8Array {
  const dir = path.join(FIXTURES, rel);
  const files: Record<string, Uint8Array> = {};
  for (const f of readdirSync(dir)) files[f] = new Uint8Array(readFileSync(path.join(dir, f)));
  return zipSync(files);
}

export const tx = <T>(fn: (t: Tx) => Promise<T>): Promise<T> => testDb().transaction(fn);
export const db = (): DB => testDb();

export async function uploadAndValidate(v: Viewer, schemaId: string, filename: string, bytes: Uint8Array, options: Record<string, string> = {}) {
  const { batch, duplicates } = await tx((t) => createBatch(t, v, { filename, bytes, schemaId }));
  if (Object.keys(options).length) {
    const { saveMapping } = await import("@/lib/imports/batches");
    await tx((t) => saveMapping(t, v, batch.id, { mapping: { ...batch.mapping, ...Object.fromEntries(Object.entries(options).map(([k, val]) => [`$option.${k}`, val])) } }));
  }
  const stats = await tx((t) => validateBatch(t, v, batch.id));
  return { batchId: batch.id, duplicates, stats };
}

export async function confirmAndCommit(v: Viewer, batchId: string) {
  await tx(async (t) => {
    const b = await getBatch(t, v, batchId);
    await confirmCoverage(t, v, batchId, b.coverageStart ?? "2026-01-01", b.coverageEnd ?? "2026-12-31");
  });
  return tx((t) => commitBatch(t, v, batchId));
}
