import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { integrations } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { objectStore, type ObjectStore } from "@/lib/storage";

export type StorageProbe = { ok: boolean; at: string; backend: string; error?: string };

/**
 * Write a small file to the configured object store, read it back and remove it, then record the
 * outcome on the File storage integration row. This is a real round trip: a failure is recorded as
 * a failure. The error text kept is the error's name only (no bucket names, keys or credentials).
 */
export async function checkStorage(tx: Tx, v: Viewer, opts: { store?: ObjectStore; backend?: string; now?: Date } = {}): Promise<StorageProbe> {
  assertCan(v, "integrations.manage");
  const store = opts.store ?? objectStore();
  const backend = opts.backend ?? (process.env.STORAGE_BACKEND || "local").toLowerCase();
  const key = `health/golive-check-${randomUUID()}.txt`;
  const body = new TextEncoder().encode(`teamwork hub storage check ${randomUUID()}`);
  const probe: StorageProbe = { ok: false, at: (opts.now ?? new Date()).toISOString(), backend };
  try {
    await store.put(key, body);
    const back = await store.get(key);
    probe.ok = back.length === body.length && back.every((b, i) => b === body[i]);
    if (!probe.ok) probe.error = "The file read back did not match what was written.";
  } catch (e) {
    probe.error = (e as Error).name || "Error";
  } finally {
    await store.delete(key).catch(() => undefined);
  }
  const [row] = await tx
    .select()
    .from(integrations)
    .where(and(eq(integrations.orgId, v.orgId), eq(integrations.provider, "object_storage")));
  const patch = {
    status: probe.ok ? ("connected" as const) : ("error" as const),
    lastCheckedAt: new Date(probe.at),
    lastError: probe.ok ? null : `Storage check failed (${probe.error})`,
    config: { ...(row?.config ?? {}), backend: backend === "s3" ? "s3" : "local_disk" },
    checkpoint: { ...(row?.checkpoint ?? {}), probe },
  };
  if (row) await tx.update(integrations).set(patch).where(eq(integrations.id, row.id));
  else await tx.insert(integrations).values({ orgId: v.orgId, provider: "object_storage", mode: "none", ...patch });
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "golive.storage_check", "organization", v.orgId, {
    summary: probe.ok ? `Storage check passed (${backend})` : `Storage check failed (${backend})`,
    after: probe,
  });
  return probe;
}
