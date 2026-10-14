import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, gte, inArray } from "drizzle-orm";
import type { DB, Tx } from "@/db";
import { organizations, people, signerStepUpChallenges, users, type formTemplates } from "@/db/schema";
import { audit } from "@/lib/audit";
import { UserError } from "@/lib/actions";
import { AuthzError, assertCan, type Viewer } from "@/lib/authz/policy";
import { emailConfig, sendEmail } from "@/lib/messaging/channels/email";
import type { ChannelResult } from "@/lib/messaging/channels/types";
import { loadRequestContext, type RequestContext } from "./context";
import { formEvent } from "./requests";

/**
 * Signer identity step-up: before a signature is accepted on a form whose kind the org
 * requires it for, the signer proves control of the email address on file with a
 * one-time code (or an MFA-verified session, if the org allows it). When email cannot
 * be delivered, staff verify identity in person (`staff_witnessed_in_person`). The
 * requirement is never skipped silently: signRequest refuses until one is satisfied.
 *
 * Codes: 6 digits, HMAC-SHA256(SESSION_SECRET, challengeId:code) at rest, 10-minute
 * expiry, 5 attempts, resend cooldown + hourly cap. Delivery goes through the messaging
 * module's email adapter, which honors DELIVERY_ENABLED / DELIVERY_TEST_RECIPIENTS and
 * reports `not_configured` honestly. (The outbox/thread path is not used: it would store
 * the code in a message body and may defer delivery past quiet hours.)
 */

export type TemplateKind = (typeof formTemplates.$inferSelect)["kind"];

export const STEP_UP_CODE_TTL_MS = 10 * 60_000;
export const STEP_UP_MAX_ATTEMPTS = 5;
export const STEP_UP_RESEND_COOLDOWN_MS = 60_000;
export const STEP_UP_MAX_CODES_PER_HOUR = 5;

export type StepUpSettings = {
  /** Template kinds whose signatures require identity step-up. */
  requireForKinds: TemplateKind[];
  /** A session that completed MFA (for a user with MFA enabled) satisfies step-up. */
  allowSessionMfa: boolean;
};

export const DEFAULT_STEP_UP: StepUpSettings = { requireForKinds: ["waiver", "agreement"], allowSessionMfa: true };

const KINDS: TemplateKind[] = ["waiver", "agreement", "intake", "medical", "media_release", "policy"];

/** Org settings live at `organizations.settings.formsStepUp`; absent = defaults (ON for waivers/agreements). */
export function stepUpSettingsOf(settings: Record<string, unknown> | null | undefined): StepUpSettings {
  const raw = (settings?.formsStepUp ?? {}) as Partial<StepUpSettings>;
  return {
    requireForKinds: Array.isArray(raw.requireForKinds) ? raw.requireForKinds.filter((k): k is TemplateKind => KINDS.includes(k)) : DEFAULT_STEP_UP.requireForKinds,
    allowSessionMfa: typeof raw.allowSessionMfa === "boolean" ? raw.allowSessionMfa : DEFAULT_STEP_UP.allowSessionMfa,
  };
}

export function stepUpRequiredFor(s: StepUpSettings, kind: string): boolean {
  return (s.requireForKinds as string[]).includes(kind);
}

export async function updateStepUpSettings(tx: Tx, v: Viewer, input: StepUpSettings) {
  assertCan(v, "settings.manage");
  const next: StepUpSettings = {
    requireForKinds: [...new Set(input.requireForKinds.filter((k) => KINDS.includes(k)))],
    allowSessionMfa: !!input.allowSessionMfa,
  };
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  const before = stepUpSettingsOf(org.settings);
  await tx.update(organizations).set({ settings: { ...org.settings, formsStepUp: next } }).where(eq(organizations.id, v.orgId));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "forms.step_up_settings", "organization", v.orgId, {
    summary: `Signer identity step-up: ${next.requireForKinds.length ? next.requireForKinds.join(", ") : "off"}; MFA ${next.allowSessionMfa ? "accepted" : "not accepted"}`,
    before,
    after: next,
  });
  return next;
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (≥32 chars) to issue signing codes.");
  return s;
}

/** HMAC of a code bound to its challenge id (a leaked table cannot be brute-forced offline without the secret). */
export function hashStepUpCode(challengeId: string, code: string): string {
  return createHmac("sha256", secret()).update(`teamwork.signer-step-up.v1:${challengeId}:${code}`).digest("hex");
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}${"*".repeat(Math.max(1, Math.min(local.length - 1, 6)))}@${domain}`;
}

/** The signer's email on file: their person record, else their login. */
export async function signerEmailOnFile(tx: Tx, orgId: string, personId: string): Promise<string | null> {
  const [p] = await tx.select({ email: people.email }).from(people).where(and(eq(people.id, personId), eq(people.orgId, orgId)));
  if (p?.email?.includes("@")) return p.email.trim();
  const [u] = await tx.select({ email: users.email }).from(users).where(and(eq(users.personId, personId), eq(users.orgId, orgId)));
  return u?.email?.includes("@") ? u.email.trim() : null;
}

/** True when this session's MFA satisfies step-up (user has MFA enabled AND verified it this session). */
export async function sessionMfaSatisfies(tx: Tx, v: Viewer, s: StepUpSettings): Promise<boolean> {
  if (!s.allowSessionMfa || !v.mfaVerified) return false;
  const [u] = await tx.select({ mfaEnabled: users.mfaEnabled }).from(users).where(eq(users.id, v.userId));
  return !!u?.mfaEnabled;
}

const challengeFor = (requestId: string, personId: string, userId: string) =>
  and(eq(signerStepUpChallenges.formRequestId, requestId), eq(signerStepUpChallenges.signerPersonId, personId), eq(signerStepUpChallenges.userId, userId));

/** The viewer's own remaining signature on this request (step-up is for self-signing). */
async function selfSignOption(tx: Tx, v: Viewer, ctx: RequestContext, now: Date) {
  const { signingState } = await import("./signing");
  const st = await signingState(tx, v, ctx, now);
  const opt = st.mine.find((o) => o.signerPersonId === v.personId);
  if (!opt) throw new AuthzError(st.blockedReason ?? "There is no remaining signature for you on this form.");
  return opt;
}

export type StepUpStatus = {
  required: boolean;
  allowSessionMfa: boolean;
  satisfiedByMfa: boolean;
  emailOnFile: string | null;
  emailConfigured: boolean;
  emailMissing: string[];
  verified: boolean;
  latest: {
    status: string;
    deliveryStatus: string | null;
    deliveryReason: string | null;
    expiresAt: Date;
    createdAt: Date;
    attemptsLeft: number;
  } | null;
  resendAvailableAt: Date | null;
};

/** What the signing page needs to show the viewer about step-up (self-signing). */
export async function stepUpStatus(tx: Tx, v: Viewer, ctx: RequestContext, now = new Date()): Promise<StepUpStatus> {
  const s = stepUpSettingsOf(ctx.org?.settings);
  const cfg = emailConfig();
  const required = stepUpRequiredFor(s, ctx.template.kind);
  const email = v.personId ? await signerEmailOnFile(tx, ctx.req.orgId, v.personId) : null;
  const [latest] = v.personId
    ? await tx.select().from(signerStepUpChallenges).where(challengeFor(ctx.req.id, v.personId, v.userId)).orderBy(desc(signerStepUpChallenges.createdAt)).limit(1)
    : [];
  return {
    required,
    allowSessionMfa: s.allowSessionMfa,
    satisfiedByMfa: required && (await sessionMfaSatisfies(tx, v, s)),
    emailOnFile: email ? maskEmail(email) : null,
    emailConfigured: cfg.configured,
    emailMissing: cfg.missing,
    verified: !!latest && latest.status === "verified" && latest.expiresAt > now,
    latest: latest
      ? {
          status: latest.expiresAt <= now && (latest.status === "pending" || latest.status === "verified") ? "expired" : latest.status,
          deliveryStatus: latest.deliveryStatus,
          deliveryReason: latest.deliveryReason,
          expiresAt: latest.expiresAt,
          createdAt: latest.createdAt,
          attemptsLeft: Math.max(0, latest.maxAttempts - latest.attempts),
        }
      : null,
    resendAvailableAt: latest ? new Date(latest.createdAt.getTime() + STEP_UP_RESEND_COOLDOWN_MS) : null,
  };
}

/**
 * Create a new code for the viewer's own signature on a request (rate limited; older
 * open codes are superseded). Returns the plaintext code ONLY so the caller can deliver it.
 */
export async function issueStepUpCode(tx: Tx, v: Viewer, requestId: string, now = new Date()) {
  const ctx = await loadRequestContext(tx, v.orgId, requestId, { forUpdate: true });
  if (!ctx) throw new AuthzError("Form request not found.");
  const opt = await selfSignOption(tx, v, ctx, now);
  const s = stepUpSettingsOf(ctx.org?.settings);
  if (!stepUpRequiredFor(s, ctx.template.kind)) throw new UserError("This form does not require identity verification.");
  const address = await signerEmailOnFile(tx, v.orgId, opt.signerPersonId);
  if (!address) {
    throw new UserError("There is no email address on file for you, so a code cannot be sent. Ask Teamwork staff to verify your identity in person and record your signature.");
  }
  const recent = await tx
    .select({ createdAt: signerStepUpChallenges.createdAt })
    .from(signerStepUpChallenges)
    .where(and(challengeFor(ctx.req.id, opt.signerPersonId, v.userId), gte(signerStepUpChallenges.createdAt, new Date(now.getTime() - 3600_000))))
    .orderBy(desc(signerStepUpChallenges.createdAt));
  if (recent.length >= STEP_UP_MAX_CODES_PER_HOUR) {
    throw new UserError("Too many codes were requested for this form in the last hour. Try again later, or ask Teamwork staff to verify you in person.");
  }
  const wait = recent[0] ? recent[0].createdAt.getTime() + STEP_UP_RESEND_COOLDOWN_MS - now.getTime() : 0;
  if (wait > 0) throw new UserError(`Please wait ${Math.ceil(wait / 1000)} seconds before requesting another code.`);

  await tx
    .update(signerStepUpChallenges)
    .set({ status: "superseded" })
    .where(and(challengeFor(ctx.req.id, opt.signerPersonId, v.userId), inArray(signerStepUpChallenges.status, ["pending", "verified"])));
  const id = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(now.getTime() + STEP_UP_CODE_TTL_MS);
  await tx.insert(signerStepUpChallenges).values({
    id,
    orgId: v.orgId,
    formRequestId: ctx.req.id,
    signerPersonId: opt.signerPersonId,
    userId: v.userId,
    signerRole: opt.role,
    channel: "email",
    address,
    codeHash: hashStepUpCode(id, code),
    expiresAt,
    maxAttempts: STEP_UP_MAX_ATTEMPTS,
    createdAt: now,
  });
  await formEvent(tx, ctx.req.id, "step_up_code_issued", v.userId, { challengeId: id, channel: "email", to: maskEmail(address), role: opt.role });
  return {
    challengeId: id,
    code,
    address,
    expiresAt,
    orgName: ctx.org?.branding?.displayName ?? ctx.org?.name ?? "Teamwork",
    title: ctx.version.title,
  };
}

/** Store the adapter's result. Anything other than sent / test_redirected makes the code unusable. */
export async function recordStepUpDelivery(tx: Tx, challengeId: string, res: ChannelResult) {
  const delivered = res.status === "sent" || res.status === "test_redirected";
  const reason = res.status === "test_redirected" ? `Redirected to test recipient ${res.address}` : (res.reason ?? null);
  const [row] = await tx
    .update(signerStepUpChallenges)
    .set({ deliveryStatus: res.status, deliveryReason: reason, providerMessageId: res.providerMessageId ?? null, ...(delivered ? {} : { status: "undeliverable" as const }) })
    .where(eq(signerStepUpChallenges.id, challengeId))
    .returning();
  if (row) await formEvent(tx, row.formRequestId, "step_up_code_delivery", row.userId, { challengeId, status: res.status, reason });
}

export function stepUpEmail(i: { code: string; orgName: string; title: string }) {
  return {
    subject: `${i.orgName}: your signing verification code`,
    body:
      `Your verification code for signing "${i.title}" is ${i.code}.\n\n` +
      `It expires in ${STEP_UP_CODE_TTL_MS / 60_000} minutes and works once. Enter it on the signing page.\n` +
      `If you did not try to sign this document, ignore this email and tell ${i.orgName} staff.`,
  };
}

export type SendStepUpResult = { status: ChannelResult["status"]; to: string; reason: string | null; expiresAt: Date };

/**
 * Issue a code (committed), send it via the messaging email adapter outside the DB
 * transaction, then record the delivery result (committed).
 */
export async function sendStepUpCode(db: DB, v: Viewer, requestId: string, now = new Date()): Promise<SendStepUpResult> {
  const issued = await db.transaction((tx) => issueStepUpCode(tx, v, requestId, now));
  const mail = stepUpEmail(issued);
  let res: ChannelResult;
  try {
    res = await sendEmail({ to: issued.address, subject: mail.subject, body: mail.body });
  } catch (e) {
    res = { status: "failed", address: issued.address, reason: e instanceof Error ? e.message : String(e) };
  }
  await db.transaction((tx) => recordStepUpDelivery(tx, issued.challengeId, res));
  return { status: res.status, to: maskEmail(issued.address), reason: res.reason ?? null, expiresAt: issued.expiresAt };
}

export type VerifyStepUpResult = { ok: true; challengeId: string } | { ok: false; error: string; attemptsLeft?: number };

/**
 * Check a code against the viewer's latest challenge for this request. Never throws for a
 * wrong code (so the attempt counter commits); callers turn `ok:false` into a UserError.
 */
export async function verifyStepUpCode(tx: Tx, v: Viewer, requestId: string, rawCode: string, now = new Date()): Promise<VerifyStepUpResult> {
  if (!v.personId) return { ok: false, error: "Request a verification code first." };
  const [ch] = await tx
    .select()
    .from(signerStepUpChallenges)
    .where(and(challengeFor(requestId, v.personId, v.userId), eq(signerStepUpChallenges.orgId, v.orgId)))
    .orderBy(desc(signerStepUpChallenges.createdAt))
    .limit(1)
    .for("update");
  if (!ch || ch.status === "superseded" || ch.status === "consumed") return { ok: false, error: "Request a verification code first." };
  if (ch.status === "undeliverable") {
    return { ok: false, error: "The last code could not be delivered by email, so it cannot be used. Request a new code, or ask Teamwork staff to verify you in person." };
  }
  if (ch.status === "locked") return { ok: false, error: "Too many incorrect codes. Request a new code.", attemptsLeft: 0 };
  if (ch.expiresAt <= now) return { ok: false, error: "This code has expired. Request a new code." };
  if (ch.status === "verified") return { ok: true, challengeId: ch.id };
  const code = rawCode.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) return { ok: false, error: "Enter the 6-digit code from the email.", attemptsLeft: ch.maxAttempts - ch.attempts };

  const expected = Buffer.from(ch.codeHash, "hex");
  const actual = Buffer.from(hashStepUpCode(ch.id, code), "hex");
  if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
    await tx.update(signerStepUpChallenges).set({ status: "verified", verifiedAt: now }).where(eq(signerStepUpChallenges.id, ch.id));
    await formEvent(tx, requestId, "step_up_verified", v.userId, { challengeId: ch.id, channel: ch.channel });
    return { ok: true, challengeId: ch.id };
  }
  const attempts = ch.attempts + 1;
  const locked = attempts >= ch.maxAttempts;
  await tx
    .update(signerStepUpChallenges)
    .set({ attempts, ...(locked ? { status: "locked" as const } : {}) })
    .where(eq(signerStepUpChallenges.id, ch.id));
  await formEvent(tx, requestId, "step_up_failed", v.userId, { challengeId: ch.id, attempts, locked });
  const left = ch.maxAttempts - attempts;
  return {
    ok: false,
    error: locked ? "Too many incorrect codes. Request a new code." : `That code is not correct. ${left} attempt${left === 1 ? "" : "s"} left.`,
    attemptsLeft: left,
  };
}

/** A verified, unexpired, unconsumed code for exactly this signer (locked for consumption). */
export async function verifiedChallenge(tx: Tx, requestId: string, personId: string, userId: string, now: Date) {
  const [ch] = await tx
    .select()
    .from(signerStepUpChallenges)
    .where(and(challengeFor(requestId, personId, userId), eq(signerStepUpChallenges.status, "verified"), gt(signerStepUpChallenges.expiresAt, now)))
    .orderBy(desc(signerStepUpChallenges.verifiedAt))
    .limit(1)
    .for("update");
  return ch ?? null;
}

export async function consumeChallenge(tx: Tx, challengeId: string, signatureId: string, now: Date) {
  await tx.update(signerStepUpChallenges).set({ status: "consumed", consumedAt: now, signatureId }).where(eq(signerStepUpChallenges.id, challengeId));
}
