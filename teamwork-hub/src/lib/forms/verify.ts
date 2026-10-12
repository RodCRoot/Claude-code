import { eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { storedObjects } from "@/db/schema";
import { contentHash, dataHash } from "./hash";
import type { RequestContext } from "./context";
import { computeIntegrity } from "./completion";

export type VerifyCheck = { label: string; ok: boolean; expected?: string | null; actual?: string | null; note?: string };
export type VerifyReport = { ok: boolean; checks: VerifyCheck[] };

/**
 * Recompute every hash from the stored records and compare:
 * version content hash, each signature's content/data hash, the integrity hash,
 * and (optionally) the PDF bytes against the stored object's SHA-256.
 */
export async function verifyRequest(tx: Tx, ctx: RequestContext, opts: { checkPdfBytes?: boolean } = {}): Promise<VerifyReport> {
  const checks: VerifyCheck[] = [];
  const vh = contentHash({
    title: ctx.version.title,
    bodyMarkdown: ctx.version.bodyMarkdown,
    fields: ctx.version.fields ?? [],
    signers: ctx.version.signers,
  });
  checks.push({ label: "Form version content matches its published hash", ok: vh === ctx.version.contentHash, expected: ctx.version.contentHash, actual: vh });

  const dh = dataHash(ctx.req.submittedData ?? {});
  for (const s of ctx.signatures) {
    checks.push({
      label: `${s.signerRole} signature was made over this exact form version`,
      ok: s.templateContentHash === ctx.version.contentHash,
      expected: ctx.version.contentHash,
      actual: s.templateContentHash,
    });
    checks.push({ label: `${s.signerRole} signature was made over the stored submitted data`, ok: s.dataHash === dh, expected: s.dataHash, actual: dh });
  }

  if (ctx.req.integrityHash) {
    const ih = computeIntegrity(ctx);
    checks.push({ label: "Integrity hash (version + data + signature evidence)", ok: ih === ctx.req.integrityHash, expected: ctx.req.integrityHash, actual: ih });
  } else {
    checks.push({ label: "Integrity hash", ok: true, note: "Not sealed yet — the request has not been completed." });
  }

  if (opts.checkPdfBytes && ctx.req.completedPdfObjectId) {
    const [obj] = await tx.select().from(storedObjects).where(eq(storedObjects.id, ctx.req.completedPdfObjectId));
    if (!obj) checks.push({ label: "Completed PDF on file", ok: false, note: "Stored object row missing." });
    else {
      try {
        const { objectStore, sha256Bytes } = await import("@/lib/storage");
        const bytes = await objectStore().get(obj.storageKey);
        const sha = sha256Bytes(bytes);
        checks.push({ label: "Completed PDF bytes match the stored SHA-256", ok: sha === obj.sha256, expected: obj.sha256, actual: sha });
      } catch {
        checks.push({ label: "Completed PDF bytes match the stored SHA-256", ok: false, note: "PDF file could not be read from storage." });
      }
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}
