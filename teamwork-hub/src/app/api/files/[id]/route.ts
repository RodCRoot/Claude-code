import type { NextRequest } from "next/server";
import { db } from "@/db";
import { getViewer } from "@/lib/auth/viewer";
import { audit } from "@/lib/audit";
import { objectAccess } from "@/lib/forms/access";
import { objectStore, sha256Bytes } from "@/lib/storage";

/**
 * GET /api/files/:id — the only way stored objects leave the server (all modules).
 * - 401 when signed out; 404 when the object doesn't exist, is in another org, or the
 *   viewer isn't allowed (no existence leak). Rules: see objectAccess() in
 *   src/lib/forms/access.ts.
 * - Bytes are re-hashed and must match stored_objects.sha256 (500 on mismatch).
 * - `?inline=1` displays in the browser (sandboxed CSP); default is a download.
 * - Every successful download is audited ("file.download").
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await getViewer();
  if (!viewer) return text(401, "Sign in to download this file.");
  const { allowed, object } = await objectAccess(db, viewer, id);
  if (!object || !allowed) return text(404, "File not found.");

  let bytes: Uint8Array;
  try {
    bytes = await objectStore().get(object.storageKey);
  } catch {
    console.error(JSON.stringify({ level: "error", msg: "stored_object_missing", objectId: object.id }));
    return text(410, "This file is no longer available. Ask Teamwork staff for help.");
  }
  if (sha256Bytes(bytes) !== object.sha256) {
    console.error(JSON.stringify({ level: "error", msg: "stored_object_checksum_mismatch", objectId: object.id }));
    return text(500, "This file failed its integrity check and was not served. Teamwork staff have been notified in the logs.");
  }
  await audit(db, { orgId: viewer.orgId, actorUserId: viewer.userId, actorRole: viewer.role }, "file.download", "stored_object", object.id, {
    summary: `Downloaded ${object.filename}`,
  });
  const inline = req.nextUrl.searchParams.get("inline") === "1";
  const ascii = object.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": object.mimeType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(object.filename)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Checksum-SHA256": object.sha256,
    },
  });
}

function text(status: number, body: string) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
