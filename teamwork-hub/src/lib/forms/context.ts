import { and, asc, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import {
  athletes,
  formRequests,
  formTemplates,
  formTemplateVersions,
  guardianships,
  organizations,
  people,
  signatures,
  users,
} from "@/db/schema";
import { ADULT_AGE, ageOn } from "./fields";

export type RequestContext = NonNullable<Awaited<ReturnType<typeof loadRequestContext>>>;

/** Everything needed to show, sign, complete, or verify one request (org-scoped). */
export async function loadRequestContext(tx: Tx, orgId: string, requestId: string, opts: { forUpdate?: boolean } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return null;
  const q = tx.select().from(formRequests).where(and(eq(formRequests.id, requestId), eq(formRequests.orgId, orgId)));
  const [req] = opts.forUpdate ? await q.for("update") : await q;
  if (!req) return null;
  const [version] = await tx.select().from(formTemplateVersions).where(eq(formTemplateVersions.id, req.templateVersionId));
  const [template] = await tx.select().from(formTemplates).where(eq(formTemplates.id, version.templateId));
  const [subject] = await tx.select().from(people).where(eq(people.id, req.subjectPersonId));
  const athlete = req.athleteId ? (await tx.select().from(athletes).where(eq(athletes.id, req.athleteId)))[0] ?? null : null;
  const sigs = await tx
    .select({ sig: signatures, firstName: people.firstName, lastName: people.lastName })
    .from(signatures)
    .innerJoin(people, eq(people.id, signatures.signerPersonId))
    .where(eq(signatures.formRequestId, req.id))
    .orderBy(asc(signatures.signedAt));
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
  return {
    req,
    version,
    template,
    subject,
    athlete,
    org,
    signatures: sigs.map((s) => ({ ...s.sig, signerName: `${s.firstName} ${s.lastName}` })),
  };
}

export function isAdultAt(dob: string | null, at: Date): boolean {
  const age = ageOn(dob, at);
  return age !== null && age >= ADULT_AGE;
}

/** Active guardians of an athlete who hold signing permission (forms.sign). */
export async function signingGuardians(tx: Tx, orgId: string, athleteId: string) {
  return tx
    .select({
      personId: guardianships.guardianPersonId,
      relationship: guardianships.relationship,
      firstName: people.firstName,
      lastName: people.lastName,
      userId: users.id,
    })
    .from(guardianships)
    .innerJoin(people, eq(people.id, guardianships.guardianPersonId))
    .leftJoin(users, eq(users.personId, guardianships.guardianPersonId))
    .where(
      and(
        eq(guardianships.orgId, orgId),
        eq(guardianships.athleteId, athleteId),
        eq(guardianships.status, "active"),
        eq(guardianships.canSignForms, true),
      ),
    );
}

export const OPEN_STATUSES = ["pending", "partially_signed"] as const;
export const isOpen = (s: string) => (OPEN_STATUSES as readonly string[]).includes(s);
