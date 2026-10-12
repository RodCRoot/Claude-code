import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tx } from "@/db";
import { storedObjects } from "@/db/schema";

/**
 * Object storage adapter. The default backend writes to STORAGE_DIR on local disk
 * (development / single-server). The interface is S3-shaped so a bucket backend can
 * replace it without touching callers. Files are only ever served through
 * authorization-checked route handlers, never from a public path.
 */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

class LocalDiskStore implements ObjectStore {
  constructor(private root: string) {}
  private resolve(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root))) throw new Error("invalid storage key");
    return p;
  }
  async put(key: string, bytes: Uint8Array) {
    const p = this.resolve(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }
  async get(key: string) {
    return new Uint8Array(await readFile(this.resolve(key)));
  }
}

let store: ObjectStore | null = null;
export function objectStore(): ObjectStore {
  if (!store) store = new LocalDiskStore(process.env.STORAGE_DIR ?? "./.storage");
  return store;
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
}
