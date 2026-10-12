import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { getViewer } from "@/lib/auth/viewer";
import { UserError } from "@/lib/actions";
import { AuthzError } from "@/lib/authz/policy";
import { importArchive, MAX_ARCHIVE_BYTES } from "@/lib/forms/archive";

/**
 * POST /api/files/archive (multipart) — import a historical signed PDF.
 * A route handler rather than a server action so files up to 15 MB are accepted
 * without raising the global server-action body limit. Same-origin only.
 */
export async function POST(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return Response.json({ ok: false, error: "Sign in first." }, { status: 401 });
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) return Response.json({ ok: false, error: "Cross-origin upload refused." }, { status: 403 });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_ARCHIVE_BYTES + 64 * 1024) return Response.json({ ok: false, error: "File is larger than 15 MB." }, { status: 413 });

  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return Response.json({ ok: false, error: "Could not read the upload." }, { status: 400 });
  }
  const file = fd.get("file");
  const str = (k: string) => (typeof fd.get(k) === "string" ? String(fd.get(k)) : "");
  try {
    if (!(file instanceof File) || file.size === 0) throw new UserError("Choose a PDF file to upload.", { file: "A PDF file is required." });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const res = await db.transaction((tx) =>
      importArchive(tx, viewer, {
        personId: str("personId"),
        title: str("title"),
        originalSystem: str("originalSystem"),
        originalSignedDate: str("originalSignedDate") || null,
        evidenceNotes: str("evidenceNotes"),
        visibility: str("visibility") === "subject_and_guardians" ? "subject_and_guardians" : "staff",
        bytes,
        filename: file.name || "archive.pdf",
      }),
    );
    return Response.json({ ok: true, message: `Archived "${res.doc.title}".`, id: res.doc.id });
  } catch (e) {
    if (e instanceof AuthzError) return Response.json({ ok: false, error: e.message }, { status: 403 });
    if (e instanceof UserError) return Response.json({ ok: false, error: e.message, fieldErrors: e.fieldErrors }, { status: 422 });
    if (e instanceof z.ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const i of e.issues) fieldErrors[i.path.join(".")] ??= i.message;
      return Response.json({ ok: false, error: "Please fix the highlighted fields.", fieldErrors }, { status: 422 });
    }
    console.error(JSON.stringify({ level: "error", msg: "archive_upload_failed", message: (e as Error)?.message }));
    return Response.json({ ok: false, error: "Upload failed. Nothing was saved." }, { status: 500 });
  }
}
