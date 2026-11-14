import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { archivedDocuments, people, storedObjects } from "@/db/schema";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { assertCan, type Viewer } from "@/lib/authz/policy";

export const ARCHIVE_LABEL = "Imported archive — original evidence only";
export const MAX_ARCHIVE_BYTES = 15 * 1024 * 1024;

export const archiveInputSchema = z.object({
  personId: z.string().uuid("Choose a person."),
  title: z.string().trim().min(2, "Title is required.").max(200),
  originalSystem: z.string().trim().min(2, "Original system is required.").max(120),
  originalSignedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
    .nullable(),
  evidenceNotes: z.string().trim().max(4000),
  visibility: z.enum(["staff", "subject_and_guardians"]),
});

export function isPdf(bytes: Uint8Array) {
  return bytes.length > 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
}

/**
 * Store a historical signed document exactly as received. The original file is
 * the evidence: no signature rows are created and nothing is re-signed.
 */
export async function importArchive(
  tx: Tx,
  v: Viewer,
  input: z.infer<typeof archiveInputSchema> & { bytes: Uint8Array; filename: string },
) {
  assertCan(v, "forms.manage");
  const data = archiveInputSchema.parse(input);
  if (!input.bytes.length) throw new UserError("Choose a PDF file to upload.", { file: "A PDF file is required." });
  if (input.bytes.length > MAX_ARCHIVE_BYTES) throw new UserError("File is larger than 15 MB.", { file: "Max 15 MB." });
  if (!isPdf(input.bytes)) throw new UserError("Only PDF files can be archived.", { file: "File is not a PDF." });
  const [person] = await tx.select().from(people).where(and(eq(people.id, data.personId), eq(people.orgId, v.orgId)));
  if (!person) throw new UserError("Person not found.");
  const { saveObject } = await import("@/lib/storage");
  const obj = await saveObject(tx, {
    orgId: v.orgId,
    bytes: input.bytes,
    filename: input.filename.toLowerCase().endsWith(".pdf") ? input.filename : `${input.filename}.pdf`,
    mimeType: "application/pdf",
    kind: "imported_archive",
    ownerPersonId: person.id,
    accessLevel: data.visibility,
    uploadedBy: v.userId,
  });
  const originalSignedAt = data.originalSignedDate ? new Date(`${data.originalSignedDate}T12:00:00Z`) : null;
  const [doc] = await tx
    .insert(archivedDocuments)
    .values({
      orgId: v.orgId,
      personId: person.id,
      objectId: obj.id,
      title: data.title,
      originalSystem: data.originalSystem,
      originalSignedAt,
      originalEvidence: {
        label: ARCHIVE_LABEL,
        notes: data.evidenceNotes || null,
        originalSignedDate: data.originalSignedDate,
        originalFilename: input.filename,
        sha256: obj.sha256,
        importedBy: v.userId,
        importedAt: new Date().toISOString(),
      },
    })
    .returning();
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "forms.archive_import", "archived_document", doc.id, {
    summary: `Imported archive "${data.title}" for ${person.firstName} ${person.lastName} from ${data.originalSystem}`,
    after: { objectId: obj.id, sha256: obj.sha256, visibility: data.visibility },
  });
  return { doc, object: obj };
}

export async function listArchive(tx: Tx, orgId: string, opts: { personIds?: string[] } = {}) {
  const rows = await tx
    .select({ doc: archivedDocuments, obj: storedObjects, first: people.firstName, last: people.lastName })
    .from(archivedDocuments)
    .innerJoin(storedObjects, eq(storedObjects.id, archivedDocuments.objectId))
    .innerJoin(people, eq(people.id, archivedDocuments.personId))
    .where(eq(archivedDocuments.orgId, orgId))
    .orderBy(desc(archivedDocuments.createdAt));
  return opts.personIds ? rows.filter((r) => opts.personIds!.includes(r.doc.personId)) : rows;
}
