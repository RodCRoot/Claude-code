/**
 * Level (c): the gym's public marketing. Off unless a parent or guardian (for a minor) or the
 * adult athlete records consent for that one win. Every step is written to the append-only
 * `win_consent_events` ledger with who, in what relationship, when, and the wording shown.
 * Staff can ask; staff can never answer. Nothing here sends a message.
 */
import { asc, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { users, winConsentEvents, wins, type WinConsentAction } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { assertCan, AuthzError, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { actorOf, type WinsAccess } from "./access";
import { MARKETING_POLICY_TEXT, MARKETING_POLICY_VERSION } from "./shared";
import { winForViewer, type Win } from "./wins";

async function record(tx: Tx, v: Viewer, win: Win, action: WinConsentAction, relationship: "guardian" | "self" | "staff") {
  await tx.insert(winConsentEvents).values({ orgId: v.orgId, winId: win.id, athleteId: win.athleteId, action, actorUserId: v.userId, actorPersonId: v.personId, relationship, policyVersion: MARKETING_POLICY_VERSION, policyText: MARKETING_POLICY_TEXT });
}

const familyRelationship = (a: WinsAccess): "guardian" | "self" => (a.relationship === "self" ? "self" : "guardian");

/**
 * Give or decline marketing consent for one win. A guardian with an active guardianship and the
 * "can sign forms" flag for a minor; the athlete for themselves when 18 or older. A hidden
 * athlete cannot be consented into marketing: the display name is what marketing uses.
 */
export async function answerMarketingConsent(tx: Tx, v: Viewer, winId: string, answer: "grant" | "decline", opts: { today?: string; now?: Date } = {}): Promise<Win> {
  const { win, access } = await winForViewer(tx, v, winId, opts.today);
  if (!access.canConsent) throw new AuthzError(access.consentBlockedReason ?? undefined);
  if (win.status === "removed" || win.status === "declined") throw new UserError("This win is no longer active.");
  if (answer === "grant" && !access.displayName) throw new UserError("This athlete's name is hidden from other families, so the win cannot be used publicly. Change how the name appears first (Leaderboards, How names appear).");
  if (answer === "grant" && win.marketingConsent === "granted") return win;
  const now = opts.now ?? new Date();
  const state = answer === "grant" ? "granted" : "declined";
  const [after] = await tx.update(wins).set({ marketingConsent: state, marketingConsentAt: now, marketingConsentBy: v.userId, updatedAt: now }).where(eq(wins.id, win.id)).returning();
  await record(tx, v, win, state, familyRelationship(access));
  await audit(tx, actorOf(v), answer === "grant" ? "wins.consent.grant" : "wins.consent.decline", "win", win.id, {
    summary: answer === "grant" ? `Marketing consent given by ${familyRelationship(access) === "self" ? "the athlete (adult)" : "a parent or guardian"}` : "Marketing consent declined by the family",
    before: { marketingConsent: win.marketingConsent },
    after: { marketingConsent: state, policyVersion: MARKETING_POLICY_VERSION },
  });
  return after;
}

/**
 * Withdraw marketing consent. Any active guardian of a minor, or the adult athlete: taking
 * something down never needs the same bar as putting it up. The win leaves the marketing queue
 * at once; if staff had marked it as posted it moves to their "take down" list.
 */
export async function revokeMarketingConsent(tx: Tx, v: Viewer, winId: string, opts: { today?: string; now?: Date } = {}): Promise<Win> {
  const { win, access } = await winForViewer(tx, v, winId, opts.today);
  if (!access.canWithdraw) throw new AuthzError(access.consentBlockedReason ?? undefined);
  if (win.marketingConsent !== "granted") throw new UserError("Marketing consent is not given for this win.");
  const now = opts.now ?? new Date();
  const [after] = await tx.update(wins).set({ marketingConsent: "revoked", marketingConsentAt: now, marketingConsentBy: v.userId, updatedAt: now }).where(eq(wins.id, win.id)).returning();
  await record(tx, v, win, "revoked", familyRelationship(access));
  await audit(tx, actorOf(v), "wins.consent.revoke", "win", win.id, { summary: "Marketing consent withdrawn by the family", before: { marketingConsent: "granted" }, after: { marketingConsent: "revoked" } });
  return after;
}

/**
 * "Ask the family": staff with the marketing queue flag a win so the guardian (or adult athlete)
 * sees a request in the app. It sends no message. A family that already said no, or withdrew,
 * is not asked again; they can change their answer themselves.
 */
export async function requestMarketingConsent(tx: Tx, v: Viewer, winId: string, opts: { today?: string; now?: Date } = {}): Promise<Win> {
  assertCan(v, "wins.marketing");
  const { win, access } = await winForViewer(tx, v, winId, opts.today);
  if (!access.canReview) throw new AuthzError();
  if (win.status !== "approved") throw new UserError("Approve the win before asking about marketing.");
  if (win.marketingConsent === "granted") throw new UserError("The family already gave marketing consent for this win.");
  if (win.marketingConsent !== "none") throw new UserError("The family already said no for this win. They can change their answer from the Wins page; please do not ask again here.");
  if (!access.displayName) throw new UserError("This athlete is hidden from other families, so their wins are not used for marketing.");
  if (win.consentRequestedAt) return win;
  const now = opts.now ?? new Date();
  const [after] = await tx.update(wins).set({ consentRequestedAt: now, consentRequestedBy: v.userId, updatedAt: now }).where(eq(wins.id, win.id)).returning();
  await record(tx, v, win, "requested", "staff");
  await audit(tx, actorOf(v), "wins.consent.request", "win", win.id, { summary: "Staff asked the family for marketing consent (shown in the app; no message sent)" });
  return after;
}

export type ConsentEvent = { action: WinConsentAction; relationship: "guardian" | "self" | "staff"; by: string; at: Date; policyVersion: string };

/** The consent history of one win, for the family and staff in scope. */
export async function consentHistory(tx: Tx, v: Viewer, winId: string): Promise<ConsentEvent[]> {
  await winForViewer(tx, v, winId);
  const rows = await tx
    .select({ e: winConsentEvents, by: users.displayName })
    .from(winConsentEvents)
    .innerJoin(users, eq(users.id, winConsentEvents.actorUserId))
    .where(eq(winConsentEvents.winId, winId))
    .orderBy(asc(winConsentEvents.createdAt));
  return rows.map((r) => ({ action: r.e.action, relationship: r.e.relationship, by: r.by, at: r.e.createdAt, policyVersion: r.e.policyVersion }));
}
