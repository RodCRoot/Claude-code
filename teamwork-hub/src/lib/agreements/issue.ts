import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, formRequests, formTemplates, formTemplateVersions, membershipAgreements, membershipEvents, memberships, organizations, people, products, productVersions } from "@/db/schema";
import { audit, type AuditActor } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { UserError } from "@/lib/billing/errors";
import { actorOf } from "@/lib/billing/util";
import { contentHash } from "@/lib/forms/hash";
import { todayLocal } from "@/lib/time";
import { SAMPLE_AGREEMENT_BODY, SAMPLE_AGREEMENT_NAME, SAMPLE_AGREEMENT_SIGNERS } from "./sample-template";
import { buildAgreementTerms, DEFAULT_RESIGN_ON, mergeValues, renderAgreement, RESIGN_TRIGGERS, resignReasons, termsHash, unknownMergeFields, type AgreementTerms, type ResignTrigger } from "./terms";

export const AGREEMENT_KIND = "membership_agreement" as const;

export type AgreementSettings = {
  /** Reservations are refused while a membership's agreement is unsigned (default: yes, like required forms). */
  blockReservationsUntilSigned: boolean;
  /** Billing waits for the signature (default: no, billing starts as scheduled). */
  billingWaitsForSignature: boolean;
  /** Which changes require a new signature. */
  resignOn: ResignTrigger[];
  /** New memberships created by staff require an agreement by default. */
  requireForNewMemberships: boolean;
};

export const DEFAULT_AGREEMENT_SETTINGS: AgreementSettings = { blockReservationsUntilSigned: true, billingWaitsForSignature: false, resignOn: DEFAULT_RESIGN_ON, requireForNewMemberships: false };

const TRIGGER_KEYS = new Set<string>(RESIGN_TRIGGERS.map((t) => t.key));

export function agreementSettingsOf(settings: Record<string, unknown> | null | undefined): AgreementSettings {
  const raw = ((settings ?? {}) as Record<string, unknown>).agreements as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return DEFAULT_AGREEMENT_SETTINGS;
  return {
    blockReservationsUntilSigned: raw.blockReservationsUntilSigned !== false,
    billingWaitsForSignature: raw.billingWaitsForSignature === true,
    resignOn: Array.isArray(raw.resignOn) ? (raw.resignOn.filter((x) => typeof x === "string" && TRIGGER_KEYS.has(x)) as ResignTrigger[]) : DEFAULT_RESIGN_ON,
    requireForNewMemberships: raw.requireForNewMemberships === true,
  };
}

export async function agreementSettings(tx: Tx, orgId: string): Promise<AgreementSettings> {
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  return agreementSettingsOf(o?.settings);
}

export async function saveAgreementSettings(tx: Tx, v: Viewer, next: AgreementSettings) {
  assertCan(v, "settings.manage");
  const clean: AgreementSettings = { ...next, resignOn: [...new Set(next.resignOn.filter((k) => TRIGGER_KEYS.has(k)))] };
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, v.orgId)).for("update");
  await tx.update(organizations).set({ settings: { ...(o?.settings ?? {}), agreements: clean } }).where(eq(organizations.id, v.orgId));
  await audit(tx, actorOf(v), "agreements.settings", "org", v.orgId, { summary: "Membership agreement rules updated", before: agreementSettingsOf(o?.settings), after: clean });
  return clean;
}

/** The published membership agreement template version new agreements are issued on, or null. */
export async function agreementTemplateVersion(tx: Tx, orgId: string) {
  const [row] = await tx
    .select({ ver: formTemplateVersions, tpl: formTemplates })
    .from(formTemplateVersions)
    .innerJoin(formTemplates, eq(formTemplates.id, formTemplateVersions.templateId))
    .where(and(eq(formTemplates.orgId, orgId), eq(formTemplates.kind, AGREEMENT_KIND), eq(formTemplates.active, true), eq(formTemplateVersions.status, "published")))
    .orderBy(desc(formTemplates.createdAt), desc(formTemplateVersions.version))
    .limit(1);
  return row ?? null;
}

/**
 * Create (once) and publish the SAMPLE membership agreement template. The text is labelled sample
 * until an owner or admin marks approved language on the template page.
 */
export async function ensureSampleAgreementTemplate(tx: Tx, actor: AuditActor & { orgId: string }, opts: { isDemo?: boolean } = {}) {
  const existing = await agreementTemplateVersion(tx, actor.orgId);
  if (existing) return { templateId: existing.tpl.id, versionId: existing.ver.id, created: false };
  const [t] = await tx.insert(formTemplates).values({ orgId: actor.orgId, name: SAMPLE_AGREEMENT_NAME, kind: AGREEMENT_KIND, renewalMonths: null, requiredForBooking: false }).returning();
  const content = { title: "Membership Agreement", bodyMarkdown: SAMPLE_AGREEMENT_BODY, fields: [], signers: SAMPLE_AGREEMENT_SIGNERS };
  const [ver] = await tx
    .insert(formTemplateVersions)
    .values({ templateId: t.id, version: 1, ...content, contentHash: contentHash(content), isSampleText: true, status: "published", publishedAt: new Date(), publishedBy: actor.actorUserId })
    .returning();
  await audit(tx, actor, "agreements.sample_template", "form_template", t.id, { summary: `Created the SAMPLE membership agreement template${opts.isDemo ? " (demo)" : ""}; replace its text with approved language` });
  return { templateId: t.id, versionId: ver.id, created: true };
}

/** Publishing check for membership agreement drafts: every {{field}} must be a known merge field. */
export function assertAgreementBody(body: string) {
  const unknown = unknownMergeFields(body);
  if (unknown.length) throw new UserError(`Unknown merge fields: ${unknown.map((u) => `{{${u}}}`).join(", ")}. Use only the fields listed for membership agreements.`);
}

type Agreement = typeof membershipAgreements.$inferSelect;

/** The agreement that currently applies to a membership (latest not superseded), with its request status. */
export async function currentAgreement(tx: Tx, membershipId: string): Promise<(Agreement & { requestStatus: string }) | null> {
  const [row] = await tx
    .select({ a: membershipAgreements, status: formRequests.status })
    .from(membershipAgreements)
    .innerJoin(formRequests, eq(formRequests.id, membershipAgreements.formRequestId))
    .where(and(eq(membershipAgreements.membershipId, membershipId), isNull(membershipAgreements.supersededAt)))
    .orderBy(desc(membershipAgreements.createdAt))
    .limit(1);
  return row ? { ...row.a, requestStatus: row.status } : null;
}

/** Last agreement that was actually signed for the membership (may since be superseded). */
export async function lastSignedAgreement(tx: Tx, membershipId: string): Promise<Agreement | null> {
  const [a] = await tx
    .select()
    .from(membershipAgreements)
    .where(and(eq(membershipAgreements.membershipId, membershipId), sql`${membershipAgreements.signedAt} is not null`))
    .orderBy(desc(membershipAgreements.signedAt))
    .limit(1);
  return a ?? null;
}

/**
 * Issue a membership agreement for signature: the template body is rendered with the membership's actual
 * terms and frozen on the form request. An earlier unsigned agreement for the membership is superseded
 * (its request can no longer be signed); an earlier signed one stays on file as the record of what was signed.
 */
export async function issueMembershipAgreement(tx: Tx, actor: AuditActor & { orgId: string }, input: { membershipId: string; reason: string; notify?: boolean }) {
  const [m] = await tx.select().from(memberships).where(and(eq(memberships.id, input.membershipId), eq(memberships.orgId, actor.orgId))).for("update");
  if (!m) throw new UserError("Membership not found.");
  const tplv = await agreementTemplateVersion(tx, actor.orgId);
  if (!tplv) throw new UserError("There is no published membership agreement template yet. Create one under Documents, Templates (a sample is available in Settings, Payments and agreements).");
  const { terms, policy, autopay } = await buildAgreementTerms(tx, actor.orgId, m.id);
  const values = mergeValues(terms, policy, autopay);
  const rendered = renderAgreement(tplv.ver.bodyMarkdown, values);
  const [ath] = await tx.select({ personId: athletes.personId }).from(athletes).where(eq(athletes.id, m.athleteId));
  const hash = termsHash(terms);

  const prior = await tx.select({ a: membershipAgreements, r: formRequests }).from(membershipAgreements).innerJoin(formRequests, eq(formRequests.id, membershipAgreements.formRequestId)).where(and(eq(membershipAgreements.membershipId, m.id), isNull(membershipAgreements.supersededAt))).for("update");
  // Same terms on the same template version and still open: nothing to do (idempotent).
  const same = prior.find((p) => p.a.termsHash === hash && p.r.templateVersionId === tplv.ver.id && (p.r.status === "pending" || p.r.status === "partially_signed" || p.r.status === "completed"));
  if (same) {
    if (m.agreementState === "not_required") await tx.update(memberships).set({ agreementState: same.r.status === "completed" ? "signed" : "awaiting", updatedAt: new Date() }).where(eq(memberships.id, m.id));
    return { agreement: same.a, requestId: same.r.id, created: false };
  }
  const { createRequest, formEvent } = await import("@/lib/forms/requests");
  const req = await createRequest(tx, { orgId: actor.orgId, versionId: tplv.ver.id, athleteId: m.athleteId, subjectPersonId: ath.personId, requestedBy: actor.actorUserId, isDemo: m.isDemo, reason: `membership_agreement:${input.reason}`, notify: input.notify ?? false });
  await tx.update(formRequests).set({ renderedBodyMarkdown: rendered, mergeValues: values }).where(eq(formRequests.id, req.id));
  const [agreement] = await tx
    .insert(membershipAgreements)
    .values({ orgId: actor.orgId, membershipId: m.id, productVersionId: m.productVersionId, formRequestId: req.id, reason: input.reason, terms: terms as unknown as Record<string, unknown>, termsHash: hash, createdBy: actor.actorUserId })
    .returning();
  for (const p of prior) {
    await tx.update(membershipAgreements).set({ supersededAt: new Date(), supersededById: agreement.id }).where(eq(membershipAgreements.id, p.a.id));
    if (p.r.status === "pending" || p.r.status === "partially_signed") {
      await tx.update(formRequests).set({ status: "superseded", supersededById: req.id }).where(eq(formRequests.id, p.r.id));
      await formEvent(tx, p.r.id, "superseded", actor.actorUserId, { from: p.r.status, newRequestId: req.id, reason: input.reason });
    }
  }
  await tx.update(memberships).set({ agreementState: "awaiting", updatedAt: new Date() }).where(eq(memberships.id, m.id));
  await tx.insert(membershipEvents).values({ membershipId: m.id, type: "agreement_issued", actorUserId: actor.actorUserId, effectiveOn: todayLocal(), details: { agreementId: agreement.id, formRequestId: req.id, reason: input.reason, productVersionId: m.productVersionId } });
  await audit(tx, actor, "agreements.issue", "membership", m.id, { summary: `Membership agreement issued for signature (${input.reason.replaceAll("_", " ")}): ${terms.planName}, ${terms.memberName}`, after: { agreementId: agreement.id, formRequestId: req.id, termsHash: hash } });
  return { agreement, requestId: req.id, created: true };
}

/** Staff action: require (and issue) an agreement for an existing membership. */
export async function requireAgreement(tx: Tx, v: Viewer, membershipId: string, reason = "staff") {
  assertCan(v, "billing.manage");
  return issueMembershipAgreement(tx, { ...actorOf(v), orgId: v.orgId }, { membershipId, reason, notify: true });
}

/**
 * Re-check a membership after something changed (plan, price, commitment, autopay method…).
 * - No agreement required: nothing happens.
 * - Unsigned agreement whose terms no longer match: re-issued so the text to sign is current.
 * - Signed agreement and a configured re-sign trigger fired: a new agreement is issued.
 */
export async function syncMembershipAgreement(tx: Tx, actor: AuditActor & { orgId: string }, membershipId: string): Promise<{ action: "none" | "reissued" | "resign_required"; reasons: ResignTrigger[] }> {
  const [m] = await tx.select().from(memberships).where(and(eq(memberships.id, membershipId), eq(memberships.orgId, actor.orgId)));
  if (!m || m.agreementState === "not_required") return { action: "none", reasons: [] };
  if (!["pending", "trialing", "active", "on_hold", "past_due"].includes(m.status)) return { action: "none", reasons: [] };
  const cur = await currentAgreement(tx, m.id);
  const { terms } = await buildAgreementTerms(tx, actor.orgId, m.id);
  if (!cur) {
    await issueMembershipAgreement(tx, actor, { membershipId: m.id, reason: "new" });
    return { action: "reissued", reasons: [] };
  }
  if (cur.requestStatus !== "completed") {
    if (cur.termsHash === termsHash(terms)) return { action: "none", reasons: [] };
    await issueMembershipAgreement(tx, actor, { membershipId: m.id, reason: cur.reason });
    return { action: "reissued", reasons: [] };
  }
  const settings = await agreementSettings(tx, actor.orgId);
  const reasons = resignReasons(cur.terms as unknown as AgreementTerms, terms, settings.resignOn);
  if (!reasons.length) return { action: "none", reasons: [] };
  await issueMembershipAgreement(tx, actor, { membershipId: m.id, reason: REASON_OF[reasons[0]], notify: true });
  return { action: "resign_required", reasons };
}

const REASON_OF: Record<ResignTrigger, string> = {
  plan: "plan_change",
  price: "price_change",
  sessions: "plan_change",
  commitment: "commitment_change",
  billing_day: "billing_day_change",
  discount: "discount_change",
  bank_debit: "payment_method_type",
};

export const AGREEMENT_REASON_LABEL: Record<string, string> = {
  new: "New membership",
  plan_change: "Plan change",
  price_change: "Price change",
  commitment_change: "Commitment change",
  billing_day_change: "Billing day change",
  discount_change: "Discount change",
  payment_method_type: "Paying by bank account",
  cutover: "Moving from Zen Planner",
  staff: "Requested by staff",
};

/** Hook: autopay was switched or its method changed. */
export async function onAutopayChanged(tx: Tx, v: Viewer | null, membershipId: string) {
  const [m] = await tx.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.id, membershipId));
  if (!m) return;
  await syncMembershipAgreement(tx, { ...actorOf(v, m.orgId), orgId: m.orgId }, membershipId);
}

/** Hook from forms: a request was completed. Marks the agreement signed and the membership no longer awaiting. */
export async function onFormRequestCompleted(tx: Tx, formRequestId: string, completedAt: Date) {
  const [a] = await tx.select().from(membershipAgreements).where(eq(membershipAgreements.formRequestId, formRequestId)).for("update");
  if (!a) return;
  await tx.update(membershipAgreements).set({ signedAt: completedAt }).where(eq(membershipAgreements.id, a.id));
  if (a.supersededAt) return;
  const [m] = await tx.select().from(memberships).where(eq(memberships.id, a.membershipId)).for("update");
  if (!m) return;
  await tx.update(memberships).set({ agreementState: "signed", updatedAt: new Date() }).where(eq(memberships.id, m.id));
  await tx.insert(membershipEvents).values({ membershipId: m.id, type: "agreement_signed", effectiveOn: todayLocal(), details: { agreementId: a.id, formRequestId, productVersionId: a.productVersionId } });
  await audit(tx, { orgId: a.orgId, actorUserId: null, actorRole: "system" }, "agreements.signed", "membership", m.id, { summary: "Membership agreement signed; the signed text is frozen on the document", after: { agreementId: a.id, formRequestId } });
}

/** Hook from forms: a request was voided (staff) — the membership keeps waiting for an agreement. */
export async function onFormRequestVoided(tx: Tx, formRequestId: string) {
  const [a] = await tx.select().from(membershipAgreements).where(eq(membershipAgreements.formRequestId, formRequestId));
  if (!a || a.supersededAt) return;
  await tx.update(membershipAgreements).set({ supersededAt: new Date() }).where(eq(membershipAgreements.id, a.id));
}

/** A new template version was published with "require re-signing": refresh every open agreement on older versions. */
export async function reissueOpenAgreements(tx: Tx, actor: AuditActor & { orgId: string }) {
  const open = await tx
    .select({ membershipId: membershipAgreements.membershipId, reason: membershipAgreements.reason })
    .from(membershipAgreements)
    .innerJoin(formRequests, eq(formRequests.id, membershipAgreements.formRequestId))
    .where(and(eq(membershipAgreements.orgId, actor.orgId), isNull(membershipAgreements.supersededAt), inArray(formRequests.status, ["pending", "partially_signed"])));
  let n = 0;
  for (const o of open) if ((await issueMembershipAgreement(tx, actor, { membershipId: o.membershipId, reason: o.reason })).created) n++;
  return n;
}

/**
 * Eligibility: is a reservation blocked because a membership agreement is unsigned?
 * Only when the organization keeps the default rule (blockReservationsUntilSigned).
 */
export async function agreementBlock(tx: Tx, orgId: string, athleteId: string): Promise<string | null> {
  const rows = await tx
    .select({ id: memberships.id, product: products.name })
    .from(memberships)
    .innerJoin(productVersions, eq(productVersions.id, memberships.productVersionId))
    .innerJoin(products, eq(products.id, productVersions.productId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.athleteId, athleteId), eq(memberships.agreementState, "awaiting"), inArray(memberships.status, ["pending", "trialing", "active", "on_hold", "past_due"])));
  if (!rows.length) return null;
  const s = await agreementSettings(tx, orgId);
  if (!s.blockReservationsUntilSigned) return null;
  return `The membership agreement for ${rows.map((r) => r.product).join(", ")} has not been signed yet. Sign it under Documents (or at the front desk) to reserve.`;
}

export type UnsignedAgreementRow = { membershipId: string; athleteId: string; athleteName: string; product: string; formRequestId: string; reason: string; issuedAt: Date; billingProvider: string };

/** Live memberships waiting for a signed agreement (staff lists, audit conflict, journey). */
export async function unsignedAgreements(tx: Tx, orgId: string, opts: { athleteIds?: string[] } = {}): Promise<UnsignedAgreementRow[]> {
  if (opts.athleteIds && !opts.athleteIds.length) return [];
  const conds = [eq(memberships.orgId, orgId), eq(memberships.agreementState, "awaiting"), inArray(memberships.status, ["pending", "trialing", "active", "on_hold", "past_due"]), isNull(membershipAgreements.supersededAt)];
  if (opts.athleteIds) conds.push(inArray(memberships.athleteId, opts.athleteIds));
  const rows = await tx
    .select({ m: memberships, a: membershipAgreements, first: people.firstName, last: people.lastName, product: products.name })
    .from(memberships)
    .innerJoin(membershipAgreements, eq(membershipAgreements.membershipId, memberships.id))
    .innerJoin(athletes, eq(athletes.id, memberships.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .innerJoin(productVersions, eq(productVersions.id, memberships.productVersionId))
    .innerJoin(products, eq(products.id, productVersions.productId))
    .where(and(...conds))
    .orderBy(membershipAgreements.createdAt);
  return rows.map((r) => ({ membershipId: r.m.id, athleteId: r.m.athleteId, athleteName: `${r.first} ${r.last}`, product: r.product, formRequestId: r.a.formRequestId, reason: r.a.reason, issuedAt: r.a.createdAt, billingProvider: r.m.billingProvider }));
}
