import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, formRequests, formTemplates, formTemplateVersions, storedObjects } from "@/db/schema";
import { athleteCapabilities, can, coachAthleteIds, type Viewer } from "@/lib/authz/policy";

/**
 * Forms access policy (built on policy.ts):
 * - forms.manage staff (owner/admin/operations): everything in their org.
 * - Coaches: STATUS ONLY for assigned athletes (missing/pending/completed). They
 *   never see submitted field values or completed PDFs — forms can hold health and
 *   emergency data that coaches don't need to run a session.
 * - The subject (athlete themself, minor or adult): view their own forms + PDFs.
 * - Guardians: need `forms.sign` (may see anything they could be asked to sign) or
 *   `profile.read`; for health-bearing templates (kind intake/medical) a guardian
 *   without forms.sign also needs `health.read` to see values/PDF.
 * - Payer status alone grants nothing here.
 */
export type RequestAccess = { view: boolean; viewData: boolean; manage: boolean };

const NONE: RequestAccess = { view: false, viewData: false, manage: false };
export const HEALTH_BEARING_KINDS = ["intake", "medical"];

export async function requestAccess(
  tx: Tx,
  v: Viewer,
  r: { orgId: string; athleteId: string | null; subjectPersonId: string; templateKind: string },
): Promise<RequestAccess> {
  if (r.orgId !== v.orgId) return NONE;
  if (can(v, "forms.manage")) return { view: true, viewData: true, manage: true };
  if (v.personId && v.personId === r.subjectPersonId) return { view: true, viewData: true, manage: false };
  if (!r.athleteId) return NONE;
  if (v.role === "coach") {
    const ids = await coachAthleteIds(tx, v);
    return ids.includes(r.athleteId) ? { view: true, viewData: false, manage: false } : NONE;
  }
  if (v.role === "guardian") {
    const caps = await athleteCapabilities(tx, v, r.athleteId);
    if (caps.has("forms.sign")) return { view: true, viewData: true, manage: false };
    if (caps.has("profile.read")) {
      const health = HEALTH_BEARING_KINDS.includes(r.templateKind);
      return { view: true, viewData: !health || caps.has("health.read"), manage: false };
    }
  }
  return NONE;
}

/** Staff roles that may open any staff-level stored object. */
export function hasStaffFileAccess(v: Viewer) {
  return can(v, "forms.manage") || can(v, "people.manage");
}

export type StoredObject = typeof storedObjects.$inferSelect;

/**
 * Contract for /api/files/[id] (used by every module):
 * - access_level "staff": roles with forms.manage or people.manage.
 * - "owner_only": the owning person (owner_person_id) or the uploader only.
 * - kind "export": never served here (use /api/exports).
 * - "subject_and_guardians": the owning person (the subject), guardians of that
 *   person's athlete record with forms.sign or profile.read, and staff with
 *   forms.manage/people.manage. Completed form PDFs additionally follow
 *   requestAccess().viewData (so coaches and payers are denied).
 * Always org-scoped.
 */
export async function objectAccess(tx: Tx, v: Viewer, objectId: string): Promise<{ allowed: boolean; object: StoredObject | null }> {
  if (!/^[0-9a-f-]{36}$/i.test(objectId)) return { allowed: false, object: null };
  const [obj] = await tx.select().from(storedObjects).where(eq(storedObjects.id, objectId));
  if (!obj || obj.orgId !== v.orgId) return { allowed: false, object: null };
  // Export bundles carry billing/health/guardian data and are only served by /api/exports, which
  // re-checks the rights the export was generated with. Their owner_person_id (the athlete) must not
  // let the athlete or anyone else fetch the zip through the generic file route.
  if (obj.kind === "export") return { allowed: false, object: obj };

  if (obj.accessLevel === "owner_only") {
    const allowed = (!!v.personId && v.personId === obj.ownerPersonId) || (!!obj.uploadedBy && obj.uploadedBy === v.userId);
    return { allowed, object: obj };
  }
  if (obj.accessLevel === "staff") return { allowed: hasStaffFileAccess(v), object: obj };

  // subject_and_guardians
  if (obj.kind === "completed_form_pdf") {
    const [r] = await tx
      .select({ orgId: formRequests.orgId, athleteId: formRequests.athleteId, subjectPersonId: formRequests.subjectPersonId, kind: formTemplates.kind })
      .from(formRequests)
      .innerJoin(formTemplateVersions, eq(formTemplateVersions.id, formRequests.templateVersionId))
      .innerJoin(formTemplates, eq(formTemplates.id, formTemplateVersions.templateId))
      .where(and(eq(formRequests.completedPdfObjectId, obj.id), eq(formRequests.orgId, v.orgId)));
    if (r) {
      const a = await requestAccess(tx, v, { orgId: r.orgId, athleteId: r.athleteId, subjectPersonId: r.subjectPersonId, templateKind: r.kind });
      return { allowed: a.viewData, object: obj };
    }
  }
  if (hasStaffFileAccess(v)) return { allowed: true, object: obj };
  if (!obj.ownerPersonId) return { allowed: false, object: obj };
  if (v.personId && v.personId === obj.ownerPersonId) return { allowed: true, object: obj };
  if (v.role !== "guardian") return { allowed: false, object: obj };
  const [ath] = await tx
    .select({ id: athletes.id })
    .from(athletes)
    .where(and(eq(athletes.personId, obj.ownerPersonId), eq(athletes.orgId, v.orgId)));
  if (!ath) return { allowed: false, object: obj };
  const caps = await athleteCapabilities(tx, v, ath.id);
  return { allowed: caps.has("forms.sign") || caps.has("profile.read"), object: obj };
}
