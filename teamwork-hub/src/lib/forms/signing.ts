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
import { consumeChallenge, sessionMfaSatisfies, stepUpRequiredFor, stepUpSettingsOf, verifiedChallenge } from "./step-up";

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
  /** In-person only: the witnessing staff member attests they verified the signer's identity. */
  identityAttested?: boolean;
};

/** `authMethod` is the session's sign-in method (`session_password` / `session_password_mfa`). */
export type SignEvidence = { ip: string | null; userAgent: string | null; authMethod: string };

/** Signer identity step-up has not been satisfied (see step-up.ts). */
export class StepUpRequiredError extends UserError {
  constructor(message: string) {
    super(message, { stepUpCode: "Enter the 6-digit code we emailed you." });
    this.name = "StepUpRequiredError";
  }
}

type StepUpMethod = "email_otp" | "session_mfa" | "staff_witnessed_in_person";

/**
 * Decide how this signer's identity was established and build the `auth_method`
 * evidence string. Throws when step-up is required and not satisfied — never skips.
 *   in person:  staff_witnessed_in_person; witness=<name> [<user id>]; identity=staff_attested
 *   email OTP:  <session method>; step_up=email_otp; challenge=<id>
 *   MFA:        session_password_mfa; step_up=session_mfa
 */
async function resolveIdentity(
  tx: Tx,
  v: Viewer,
  ctx: RequestContext,
  opt: SignOption,
  inPerson: boolean,
  input: SignInput,
  evidence: SignEvidence,
  now: Date,
): Promise<{ authMethod: string; challengeId: string | null; stepUp: StepUpMethod | null }> {
  if (inPerson) {
    if (!input.identityAttested) {
      throw new UserError("Confirm that you verified the signer's identity in person before recording their signature.", {
        identityAttested: "Required: you are attesting to the signer's identity.",
      });
    }
    return { authMethod: `staff_witnessed_in_person; witness=${v.displayName} [${v.userId}]; identity=staff_attested`, challengeId: null, stepUp: "staff_witnessed_in_person" };
  }
  const settings = stepUpSettingsOf(ctx.org?.settings);
  if (!stepUpRequiredFor(settings, ctx.template.kind)) return { authMethod: evidence.authMethod, challengeId: null, stepUp: null };
  const ch = await verifiedChallenge(tx, ctx.req.id, opt.signerPersonId, v.userId, now);
  if (ch) return { authMethod: `${evidence.authMethod}; step_up=email_otp; challenge=${ch.id}`, challengeId: ch.id, stepUp: "email_otp" };
  if (await sessionMfaSatisfies(tx, v, settings)) return { authMethod: "session_password_mfa; step_up=session_mfa", challengeId: null, stepUp: "session_mfa" };
  throw new StepUpRequiredError(
    "Verify your identity before signing: enter the 6-digit code we email to the address on file. If email isn't available, Teamwork staff can verify you in person.",
  );
}

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
  const freezeData = !data;
  if (!data) {
    if (st.needsData) {
      if (!opt.submitsData) throw new UserError("A parent/guardian or adult athlete must complete the form first.");
      const res = validateSubmission(ctx.version.fields ?? [], input.values);
      if (!res.ok) throw new UserError("Please fix the highlighted fields.", res.errors);
      data = res.data;
    } else data = {};
  }

  // Identity step-up is resolved before anything is written.
  const identity = await resolveIdentity(tx, v, ctx, opt, inPerson, input, evidence, now);

  if (freezeData) {
    await tx.update(formRequests).set({ submittedData: data }).where(eq(formRequests.id, ctx.req.id));
    ctx.req.submittedData = data;
  }
  const dh = dataHash(data);

  let signerUserId: string | null = null;
  const authMethod = identity.authMethod;
  if (inPerson) {
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.personId, opt.signerPersonId));
    signerUserId = u?.id ?? null;
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
  if (identity.challengeId) await consumeChallenge(tx, identity.challengeId, sig.id, signedAt);
  await formEvent(tx, ctx.req.id, "signed", v.userId, {
    signatureId: sig.id,
    role: opt.role,
    signerPersonId: opt.signerPersonId,
    inPerson,
    stepUp: identity.stepUp,
    dataHash: dh,
  });
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "forms.sign", "form_request", ctx.req.id, {
    summary: `${SIGNER_ROLE_LABEL[opt.role]} signature recorded${inPerson ? " in person (staff witnessed, identity attested)" : identity.stepUp ? ` (identity: ${identity.stepUp.replaceAll("_", " ")})` : ""}`,
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
