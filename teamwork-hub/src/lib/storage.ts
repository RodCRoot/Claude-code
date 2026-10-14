import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tx } from "@/db";
import { storedObjects } from "@/db/schema";
import { log } from "@/lib/observability";
import { S3ObjectStore, type S3StoreConfig } from "@/lib/storage-s3";

/**
 * Object storage adapter, selected by STORAGE_BACKEND:
 * - `local` (default): files under STORAGE_DIR on local disk (development / single server
 *   with a persistent disk).
 * - `s3`: an S3-compatible bucket (src/lib/storage-s3.ts) — private objects, server-side
 *   encryption, credentials from the standard AWS chain.
 * Files are only ever served through authorization-checked route handlers, never from a
 * public path or bucket URL.
 */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  /** Remove an object. Idempotent: deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}

export class LocalDiskStore implements ObjectStore {
  private root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  resolve(key: string) {
    const p = path.resolve(this.root, key);
    if (!key || !p.startsWith(this.root + path.sep)) throw new Error("invalid storage key");
    return p;
  }
  async put(key: string, bytes: Uint8Array) {
    const p = this.resolve(key);
    await mkdir(path.dirname(p), { recursive: true });
    // Write-then-rename so a crash never leaves a half-written file under the final key.
    const tmp = `${p}.${randomUUID()}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, p);
  }
  async get(key: string) {
    return new Uint8Array(await readFile(this.resolve(key)));
  }
  async delete(key: string) {
    await rm(this.resolve(key), { force: true });
  }
}

export type StorageConfig = { backend: "local"; dir: string } | ({ backend: "s3" } & S3StoreConfig);

/** Parse storage settings from the environment (throws with variable names, never values). */
export function storageConfigFromEnv(e: Record<string, string | undefined> = process.env): StorageConfig {
  const backend = (e.STORAGE_BACKEND || "local").toLowerCase();
  if (backend === "local") return { backend: "local", dir: e.STORAGE_DIR || "./.storage" };
  if (backend !== "s3") throw new Error(`STORAGE_BACKEND must be "local" or "s3"`);
  const missing = ["S3_BUCKET", "S3_REGION"].filter((n) => !e[n]);
  if (missing.length) throw new Error(`STORAGE_BACKEND=s3 requires ${missing.join(", ")}`);
  const sse = (e.S3_SSE || "AES256") as S3StoreConfig["sse"];
  if (!["AES256", "aws:kms", "none"].includes(sse)) throw new Error(`S3_SSE must be AES256, aws:kms, or none`);
  return {
    backend: "s3",
    bucket: e.S3_BUCKET!,
    region: e.S3_REGION!,
    endpoint: e.S3_ENDPOINT || undefined,
    forcePathStyle: e.S3_FORCE_PATH_STYLE === "true",
    prefix: e.S3_PREFIX || undefined,
    sse,
    kmsKeyId: e.S3_KMS_KEY_ID || undefined,
  };
}

export function createObjectStore(cfg: StorageConfig = storageConfigFromEnv()): ObjectStore {
  if (cfg.backend === "s3") {
    const { backend: _b, ...s3 } = cfg;
    void _b;
    return new S3ObjectStore(s3);
  }
  return new LocalDiskStore(cfg.dir);
}

const g = globalThis as unknown as { __twObjectStore?: ObjectStore | null };
export function objectStore(): ObjectStore {
  if (!g.__twObjectStore) g.__twObjectStore = createObjectStore();
  return g.__twObjectStore;
}

/** Replace the process-wide store (tests only). Pass null to fall back to the env config. */
export function setObjectStoreForTests(s: ObjectStore | null) {
  g.__twObjectStore = s;
}

/**
 * Best-effort removal of object bytes whose stored_objects rows are already gone (call it
 * after the transaction that deleted the rows has committed). Failures are logged, never thrown:
 * a leftover file is harmless, a failed revert is not.
 */
export async function deleteStoredBytes(keys: string[]): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (const key of keys) {
    try {
      await objectStore().delete(key);
      deleted++;
    } catch (e) {
      failed++;
      log("warn", "stored_object_delete_failed", { storageKey: key, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { deleted, failed };
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Store bytes and register them with checksum + access level. */
export async function saveObject(
  tx: Tx,
  input: {
    orgId: string;
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
    kind: (typeof storedObjects.$inferInsert)["kind"];
    ownerPersonId?: string | null;
    accessLevel?: (typeof storedObjects.$inferInsert)["accessLevel"];
    uploadedBy?: string | null;
  },
) {
  const sha = sha256Bytes(input.bytes);
  const key = `${input.orgId}/${input.kind}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${input.filename.replace(/[^\w.-]+/g, "_")}`;
  await objectStore().put(key, input.bytes);
  try {
    const [row] = await tx
      .insert(storedObjects)
      .values({
        orgId: input.orgId,
        storageKey: key,
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.bytes.byteLength,
        sha256: sha,
        kind: input.kind,
        ownerPersonId: input.ownerPersonId ?? null,
        accessLevel: input.accessLevel ?? "staff",
        uploadedBy: input.uploadedBy ?? null,
      })
      .returning();
    return row;
  } catch (e) {
    // The row was never registered: don't leave unreferenced bytes behind.
    await deleteStoredBytes([key]);
    throw e;
  }
}
