import { eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { formRequests, signatures, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { AuthzError, can, canOnAthlete, type Viewer } from "@/lib/authz/policy";
import { ESIGN_CONSENT_TEXT } from "./consent";
import { applicableRoles, requiredRoles, SIGNER_ROLE_LABEL, validateSubmission, type SignerRole } from "./fields";
import { dataHash } from "./hash";
import { isAdultAt, isOpen, loadRequestContext, signingGuardians, type RequestContext } from "./context";
import { completeRequest } from "./completion";
import { formEvent } from "./requests";

/** Roles that may submit the form's field values (the first data-bearing signature). */
const DATA_ROLES: SignerRole[] = ["guardian", "second_guardian", "adult_athlete"];

export type SignOption = {
  role: SignerRole;
  label: string;
  required: boolean;
  /** True when this signature must also submit the field values. */
  submitsData: boolean;
  signerPersonId: string;
  signerName: string;
  relationship: string | null;
};

export type SigningState = {
  open: boolean;
  subjectIsAdult: boolean;
  applicable: SignerRole[];
  required: SignerRole[];
  signed: SignerRole[];
  remainingRequired: SignerRole[];
  needsData: boolean;
  /** What the current viewer can sign right now, for themself. */
  mine: SignOption[];
  /** Explanation when the viewer cannot sign. */
  blockedReason: string | null;
  /** Staff (forms.manage) only: people who can sign in person on this device. */
  inPerson: SignOption[];
};

type Guardians = Awaited<ReturnType<typeof signingGuardians>>;

function rolesForPerson(
  personId: string,
  ctx: RequestContext,
  st: { adult: boolean; applicable: SignerRole[]; required: SignerRole[]; guardians: Guardians; needsData: boolean },
): SignOption[] {
  const signedRoles = new Set(ctx.signatures.map((s) => s.signerRole));
  if (ctx.signatures.some((s) => s.signerPersonId === personId)) return [];
  const out: SignOption[] = [];
  const mk = (role: SignerRole, name: string, relationship: string | null): SignOption => ({
    role,
    label: SIGNER_ROLE_LABEL[role],
    required: st.required.includes(role),
    submitsData: st.needsData && DATA_ROLES.includes(role),
    signerPersonId: personId,
    signerName: name,
    relationship,
  });
  const g = st.guardians.find((x) => x.personId === personId);
  if (g && !st.adult) {
    const name = `${g.firstName} ${g.lastName}`;
    if (st.applicable.includes("guardian") && !signedRoles.has("guardian")) out.push(mk("guardian", name, g.relationship));
    else if (st.applicable.includes("second_guardian") && !signedRoles.has("second_guardian")) out.push(mk("second_guardian", name, g.relationship));
  }
  if (personId === ctx.req.subjectPersonId) {
    const name = `${ctx.subject.firstName} ${ctx.subject.lastName}`;
    const role: SignerRole = st.adult ? "adult_athlete" : "athlete_assent";
    if (st.applicable.includes(role) && !signedRoles.has(role)) out.push(mk(role, name, "self"));
  }
  // Assent cannot be the data-bearing signature: a guardian completes the form first.
  return out.filter((o) => !(st.needsData && !DATA_ROLES.includes(o.role)));
}

export async function signingState(tx: Tx, v: Viewer, ctx: RequestContext, at = new Date()): Promise<SigningState> {
  const adult = isAdultAt(ctx.subject.dateOfBirth, at);
  const guardians = ctx.req.athleteId ? await signingGuardians(tx, ctx.req.orgId, ctx.req.athleteId) : [];
  const applicable = applicableRoles(ctx.version.signers, adult);
  const required = requiredRoles(ctx.version.signers, { subjectIsAdult: adult, signingGuardianCount: guardians.length });
  const signed = ctx.signatures.map((s) => s.signerRole as SignerRole);
  const remainingRequired = required.filter((r) => !signed.includes(r));
  const needsData = !ctx.req.submittedData && (ctx.version.fields?.length ?? 0) > 0;
  const open = isOpen(ctx.req.status);
  const st = { adult, applicable, required, guardians, needsData };

  let mine: SignOption[] = [];
  let blockedReason: string | null = null;
  if (!open) blockedReason = `This request is ${ctx.req.status.replaceAll("_", " ")}; it can no longer be signed.`;
  else if (v.personId && ctx.req.athleteId && (await canOnAthlete(tx, v, ctx.req.athleteId, "forms.sign"))) {
    mine = rolesForPerson(v.personId, ctx, st);
    if (!mine.length) {
      if (ctx.signatures.some((s) => s.signerPersonId === v.personId)) blockedReason = "You have already signed this form.";
      else if (v.personId === ctx.req.subjectPersonId && !adult && needsData)
        blockedReason = "A parent or guardian must complete and sign this form first; then you can add your assent.";
      else if (v.personId === ctx.req.subjectPersonId && !adult) blockedReason = "Athletes under 18 cannot sign for themselves. A parent or guardian must sign.";
      else blockedReason = "There is no remaining signature for you on this form.";
    }
  } else if (v.personId === ctx.req.subjectPersonId && !adult) {
    blockedReason = "Athletes under 18 cannot sign for themselves. A parent or guardian must sign.";
  } else if (!can(v, "forms.manage")) {
    blockedReason = "You do not have permission to sign forms for this athlete. Ask the primary guardian or Teamwork staff.";
  }
  if (open && can(v, "forms.manage") && v.personId && applicable.includes("staff_witness") && !signed.includes("staff_witness") && !needsData) {
    if (!ctx.signatures.some((s) => s.signerPersonId === v.personId)) {
      mine.push({
        role: "staff_witness",
        label: SIGNER_ROLE_LABEL.staff_witness,
        required: required.includes("staff_witness"),
        submitsData: false,
        signerPersonId: v.personId,
        signerName: v.displayName,
        relationship: `staff (${v.role})`,
      });
      blockedReason = null;
    }
  }

  let inPerson: SignOption[] = [];
  if (open && can(v, "forms.manage")) {
    const persons = new Set<string>(guardians.map((g) => g.personId));
    persons.add(ctx.req.subjectPersonId);
    for (const p of persons) inPerson.push(...rolesForPerson(p, ctx, st));
    inPerson = inPerson.filter((o, i, arr) => arr.findIndex((x) => x.role === o.role && x.signerPersonId === o.signerPersonId) === i);
  }
  return { open, subjectIsAdult: adult, applicable, required, signed, remainingRequired, needsData, mine, blockedReason, inPerson };
}

export type SignInput = {
  requestId: string;
  role: string;
  typedName: string;
  consent: boolean;
  /** Raw form values keyed `field_<key>` (only used for the first data-bearing signature). */
  values: Record<string, unknown>;
  /** Staff-assisted in-person signing: the person physically signing. */
  inPersonSignerPersonId?: string | null;
};

export type SignEvidence = { ip: string | null; userAgent: string | null; authMethod: string };

export function normalizeTypedName(s: string) {
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Record one signature. Signed data is never changed: the first data-bearing
 * signature freezes `submitted_data`; every later signer signs over that exact data
 * (same data hash). Completes the request when all required roles have signed.
 */
export async function signRequest(tx: Tx, v: Viewer, input: SignInput, evidence: SignEvidence, now = new Date()) {
  const ctx = await loadRequestContext(tx, v.orgId, input.requestId, { forUpdate: true });
  if (!ctx) throw new AuthzError("Form request not found.");
  const st = await signingState(tx, v, ctx, now);
  if (!st.open) throw new UserError(st.blockedReason ?? "This request can no longer be signed.");

  const inPerson = !!input.inPersonSignerPersonId;
  const pool = inPerson ? st.inPerson : st.mine;
  if (inPerson && !can(v, "forms.manage")) throw new AuthzError();
  const opt = pool.find((o) => o.role === input.role && (!inPerson || o.signerPersonId === input.inPersonSignerPersonId));
  if (!opt) {
    if (input.role === "athlete_assent" || (!inPerson && v.personId === ctx.req.subjectPersonId && !st.subjectIsAdult)) {
      throw new AuthzError(st.blockedReason ?? "Athletes under 18 cannot sign for themselves except to give assent.");
    }
    throw new AuthzError(st.blockedReason ?? "You cannot sign this form in that role.");
  }

  const typedName = normalizeTypedName(input.typedName ?? "");
  if (typedName.length < 3 || typedName.length > 120 || typedName.split(" ").length < 2) {
    throw new UserError("Type your full legal name (first and last).", { typedName: "Full legal name (first and last) is required." });
  }
  if (!input.consent) throw new UserError("You must agree to sign electronically.", { consent: "Check the box to agree to the statement above." });

  let data = ctx.req.submittedData;
  if (!data) {
    if (st.needsData) {
      if (!opt.submitsData) throw new UserError("A parent/guardian or adult athlete must complete the form first.");
      const res = validateSubmission(ctx.version.fields ?? [], input.values);
      if (!res.ok) throw new UserError("Please fix the highlighted fields.", res.errors);
      data = res.data;
    } else data = {};
    await tx.update(formRequests).set({ submittedData: data }).where(eq(formRequests.id, ctx.req.id));
    ctx.req.submittedData = data;
  }
  const dh = dataHash(data);

  let signerUserId: string | null = null;
  let authMethod = evidence.authMethod;
  if (inPerson) {
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.personId, opt.signerPersonId));
    signerUserId = u?.id ?? null;
    authMethod = `in_person_staff_witnessed; witness=${v.displayName} [${v.userId}]`;
  } else {
    signerUserId = v.userId;
  }

  // Millisecond precision so the stored instant round-trips exactly into the integrity hash.
  const signedAt = new Date(Math.floor(now.getTime()));
  const [sig] = await tx
    .insert(signatures)
    .values({
      formRequestId: ctx.req.id,
      signerRole: opt.role,
      signerPersonId: opt.signerPersonId,
      signerUserId,
      relationship: opt.relationship,
      typedName,
      consentText: ESIGN_CONSENT_TEXT,
      consentGiven: true,
      templateContentHash: ctx.version.contentHash,
      dataHash: dh,
      authMethod,
      ip: evidence.ip,
      userAgent: evidence.userAgent?.slice(0, 500) ?? null,
      signedAt,
    })
    .returning();
  await formEvent(tx, ctx.req.id, "signed", v.userId, {
    signatureId: sig.id,
    role: opt.role,
    signerPersonId: opt.signerPersonId,
    inPerson,
    dataHash: dh,
  });
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "forms.sign", "form_request", ctx.req.id, {
    summary: `${SIGNER_ROLE_LABEL[opt.role]} signature recorded${inPerson ? " in person (staff witnessed)" : ""}`,
    after: { signatureId: sig.id, role: opt.role },
  });

  const signedRoles = new Set([...ctx.signatures.map((s) => s.signerRole), opt.role]);
  const done = st.required.every((r) => signedRoles.has(r));
  const fresh = (await loadRequestContext(tx, v.orgId, ctx.req.id))!;
  if (done) {
    const c = await completeRequest(tx, fresh, v.userId, signedAt);
    await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "forms.complete", "form_request", ctx.req.id, {
      summary: `Form completed: ${ctx.version.title} v${ctx.version.version}`,
      after: { integrityHash: c.integrity, pdfObjectId: c.pdfObjectId },
    });
    return { status: "completed" as const, signatureId: sig.id, ...c };
  }
  if (ctx.req.status !== "partially_signed") {
    await tx.update(formRequests).set({ status: "partially_signed" }).where(eq(formRequests.id, ctx.req.id));
    await formEvent(tx, ctx.req.id, "status_changed", v.userId, { from: ctx.req.status, to: "partially_signed" });
  }
  return { status: "partially_signed" as const, signatureId: sig.id, remaining: st.required.filter((r) => !signedRoles.has(r)) };
}
