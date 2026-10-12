import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { getViewer } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/policy";
import { UserError } from "@/lib/actions";
import { createBatch } from "@/lib/imports/batches";
import { sameOrigin } from "@/lib/training/http";

/**
 * Multipart upload for the import wizard. A route handler (not a server action) so large
 * exports are not capped by the 1 MB server-action body limit. The original file is stored
 * with its checksum before anything else happens.
 */
export async function POST(req: NextRequest) {
  // Route handlers don't get Server Actions' built-in origin check.
  if (!sameOrigin(req)) return new NextResponse("Cross-origin upload refused.", { status: 403 });
  const v = await getViewer();
  if (!v) return NextResponse.redirect(new URL("/login", req.url), 303);
  if (!can(v, "imports.manage")) return NextResponse.redirect(new URL("/denied", req.url), 303);
  const back = (msg: string) => NextResponse.redirect(new URL(`/imports?error=${encodeURIComponent(msg)}`, req.url), 303);
  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return back("The upload could not be read.");
  }
  const file = fd.get("file");
  const schemaId = String(fd.get("schemaId") ?? "");
  if (!(file instanceof File) || file.size === 0) return back("Choose a file to upload.");
  if (!schemaId) return back("Choose what the file contains.");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { batch, duplicates } = await db.transaction((tx) => createBatch(tx, v, { filename: file.name || "upload.csv", bytes, schemaId }));
    const q = duplicates.length ? `?duplicate=${duplicates.length}` : "";
    return NextResponse.redirect(new URL(`/imports/${batch.id}${q}`, req.url), 303);
  } catch (e) {
    if (e instanceof UserError) return back(e.message);
    console.error(JSON.stringify({ level: "error", msg: "import_upload_failed", name: (e as Error)?.name, message: (e as Error)?.message }));
    return back("The upload failed. Nothing was saved.");
  }
}
