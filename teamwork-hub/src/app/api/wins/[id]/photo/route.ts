import { db } from "@/db";
import { UserError } from "@/lib/actions";
import { objectStore, sha256Bytes } from "@/lib/storage";
import { json, withViewer } from "@/lib/training/http";
import { preparePhoto } from "@/lib/wins/photo";
import { PHOTO_MAX_BYTES } from "@/lib/wins/shared";
import { attachPhoto, winPhotoFor } from "@/lib/wins/wins";

const notFound = () => new Response("Not found.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/**
 * GET /api/wins/:id/photo: the only way a win photo is served. The athlete's family and staff in
 * scope always; anyone else in the organization only when the win is approved, the photo is
 * approved, the in-app level is on and the athlete is not hidden (`winPhotoFor`). Everything else
 * answers 404 so a win id cannot be probed.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withViewer(req, async (v) => {
    const file = await winPhotoFor(db, v, id);
    if (!file) return notFound();
    let bytes: Uint8Array;
    try {
      bytes = await objectStore().get(file.storageKey);
    } catch {
      return notFound();
    }
    if (sha256Bytes(bytes) !== file.sha256) return notFound();
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: { "Content-Type": file.mimeType, "Content-Length": String(bytes.byteLength), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" },
    });
  });
}

/**
 * POST /api/wins/:id/photo (multipart, field `photo`): add or replace the photo. JPEG or PNG up
 * to 5 MB; EXIF and other metadata are stripped before the bytes are stored. Scope is re-checked
 * in `attachPhoto`. A route handler is used because server actions cap the request body at 1 MB.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withViewer(req, async (v) => {
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > PHOTO_MAX_BYTES + 64 * 1024) return json({ error: "Photos can be up to 5 MB." }, 413);
    const form = await req.formData().catch(() => null);
    const file = form?.get("photo");
    if (!(file instanceof File) || file.size === 0) return json({ error: "Choose a photo first." }, 400);
    if (file.size > PHOTO_MAX_BYTES) return json({ error: "Photos can be up to 5 MB." }, 413);
    const { photo, error } = preparePhoto(new Uint8Array(await file.arrayBuffer()));
    if (!photo) return json({ error: error ?? "That photo could not be used." }, 400);
    try {
      await db.transaction((tx) => attachPhoto(tx, v, id, photo));
    } catch (e) {
      if (e instanceof UserError) return json({ error: e.message }, 422);
      throw e;
    }
    return json({ ok: true });
  });
}
