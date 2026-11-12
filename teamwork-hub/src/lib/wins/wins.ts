/**
 * Wins: achievements outside the gym. A win is shown nowhere until a staff member approves it,
 * and then only at the levels the family left on and under the athlete's display name
 * (`publicName` through `communityRoster`; hidden athletes are dropped). See docs/modules/wins.md.
 */
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { athletes, people, storedObjects, users, WIN_TYPES, wins, xpEvents, type MarketingConsentState, type WinStatus, type WinSubmitter, type WinType } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { accessibleAthleteIds, assertCan, athleteScopeFilter, AuthzError, can, isStaff, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { communityRoster, type RosterEntry } from "@/lib/community/display-name";
import { communityOrg } from "@/lib/community/settings";
import { engagementSettingsOf } from "@/lib/engagement/settings";
import { lintBlockMessage, lintFamilyMessage } from "@/lib/messaging/family-style";
import { saveObject } from "@/lib/storage";
import { addDaysYmd, fmt, localToUtc, todayLocal } from "@/lib/time";
import { actorOf, winsAccess, type WinsAccess } from "./access";
import type { PreparedPhoto } from "./photo";
import { bannedTopic, cleanSourceUrl, DETAIL_MAX, HEADLINE_MAX, HEADLINE_MIN, mentionsLastName, oneLine, WIN_TYPE_LABEL } from "./shared";

export type Win = typeof wins.$inferSelect;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date");
const bool = z.preprocess((x) => (x === undefined || x === null ? true : x === true || x === "on" || x === "true" || x === "1"), z.boolean());

export const winInput = z.object({
  athleteId: z.string().uuid("Choose an athlete"),
  occurredOn: ymd,
  sport: z.preprocess(oneLine, z.string().min(1, "Add the sport").max(40)),
  type: z.enum(WIN_TYPES, { message: "Choose what kind of win it is" }),
  headline: z.preprocess(oneLine, z.string()),
  detail: z.preprocess(oneLine, z.string()).optional(),
  sourceUrl: z.unknown().optional(),
  showInApp: bool.optional(),
  showOnTv: bool.optional(),
});

/**
 * The text rules for anything another family could read: one plain line each, length limits,
 * family style rules (no em dashes, no card or ID numbers), no health, body-weight or grades
 * topics, and no last name (the display name is what is shown).
 */
export function checkWinText(input: { headline: string; detail?: string | null }, who: { lastName: string; displayName: string | null; firstName: string }): { headline: string; detail: string | null } {
  const headline = oneLine(input.headline);
  const detail = oneLine(input.detail ?? "") || null;
  if (headline.length < HEADLINE_MIN) throw new UserError("Add a short headline.", { headline: "Required" });
  if (headline.length > HEADLINE_MAX) throw new UserError(`Keep the headline to ${HEADLINE_MAX} characters or fewer.`, { headline: `Up to ${HEADLINE_MAX} characters` });
  if (detail && detail.length > DETAIL_MAX) throw new UserError(`Keep the detail to ${DETAIL_MAX} characters or fewer.`, { detail: `Up to ${DETAIL_MAX} characters` });
  for (const [field, text] of [["headline", headline], ["detail", detail]] as const) {
    if (!text) continue;
    const lint = lintFamilyMessage(text, { requireSignOff: false });
    if (lint.blocks.length) throw new UserError(lintBlockMessage(lint, "This win").replace("can't be sent to families yet", "can't be saved yet"), { [field]: lint.blocks[0].message });
    const topic = bannedTopic(text);
    if (topic) throw new UserError(`Wins cannot mention ${topic}. Health, injuries, body weight and school grades stay private. Reword it around the achievement itself.`, { [field]: `Remove the mention of ${topic}` });
    if (mentionsLastName(text, who.lastName)) throw new UserError(`Leave the last name out. Others see ${who.displayName ?? who.firstName}, never a full name.`, { [field]: "Remove the last name" });
  }
  return { headline, detail };
}

/** A family consents to public use of the exact wording they saw, so staff cannot change it afterwards. */
const CONSENTED_WORDING = "The family gave marketing consent for this exact wording, so it cannot be changed. Approve it as written, or ask the family to withdraw consent first.";

const submitterOf = (a: WinsAccess): WinSubmitter => (a.relationship === "staff" ? "staff" : a.relationship === "self" ? "athlete" : "guardian");

async function accessOrThrow(tx: Tx, v: Viewer, athleteId: string, today?: string): Promise<WinsAccess> {
  const a = await winsAccess(tx, v, athleteId, { today });
  if (!a || !a.canSee) throw new AuthzError();
  return a;
}

async function loadWin(tx: Tx, v: Viewer, winId: string): Promise<Win> {
  if (!z.string().uuid().safeParse(winId).success) throw new AuthzError("Win not found.");
  const [w] = await tx.select().from(wins).where(and(eq(wins.id, winId), eq(wins.orgId, v.orgId))).for("update");
  if (!w) throw new AuthzError("Win not found.");
  return w;
}

/** Load a win for update together with the viewer's access to its athlete. */
export async function winForViewer(tx: Tx, v: Viewer, winId: string, today?: string): Promise<{ win: Win; access: WinsAccess }> {
  const win = await loadWin(tx, v, winId);
  return { win, access: await accessOrThrow(tx, v, win.athleteId, today) };
}

/**
 * Submit a win: the athlete, a guardian who may act for the athlete, or staff in scope. It starts
 * as "pending" (or "awaiting_family" for a staff draft made from a lead) and is shown nowhere
 * until staff approve it. The submitter may switch the in-app and TV levels off; marketing is
 * never on at submission.
 */
export async function submitWin(tx: Tx, v: Viewer, raw: unknown, opts: { today?: string; photo?: PreparedPhoto | null; draftFromLead?: boolean } = {}): Promise<Win> {
  const input = winInput.parse(raw);
  const access = await winsAccess(tx, v, input.athleteId, { today: opts.today });
  if (!access?.canSubmit) throw new AuthzError("You cannot add a win for this athlete.");
  if (opts.draftFromLead && !access.canReview) throw new AuthzError();
  if (input.occurredOn > access.today) throw new UserError("Add it once it has happened.", { occurredOn: "In the future" });
  if (input.occurredOn < addDaysYmd(access.today, -730)) throw new UserError("Wins can be added for the last two years.", { occurredOn: "Too long ago" });
  const text = checkWinText(input, access);
  const src = cleanSourceUrl(input.sourceUrl);
  if (src.error) throw new UserError(src.error, { sourceUrl: src.error });
  let photoObjectId: string | null = null;
  if (opts.photo) {
    const obj = await saveObject(tx, { orgId: v.orgId, bytes: opts.photo.bytes, filename: `win-photo.${opts.photo.ext}`, mimeType: opts.photo.mimeType, kind: "upload", ownerPersonId: access.personId, accessLevel: "subject_and_guardians", uploadedBy: v.userId });
    photoObjectId = obj.id;
  }
  const [row] = await tx
    .insert(wins)
    .values({
      orgId: v.orgId,
      athleteId: input.athleteId,
      occurredOn: input.occurredOn,
      sport: input.sport,
      type: input.type,
      headline: text.headline,
      detail: text.detail,
      sourceUrl: src.url,
      photoObjectId,
      status: opts.draftFromLead ? "awaiting_family" : "pending",
      showInApp: input.showInApp ?? true,
      showOnTv: input.showOnTv ?? true,
      submittedBy: v.userId,
      submittedAs: submitterOf(access),
      isDemo: access.isDemo,
    })
    .returning();
  await audit(tx, actorOf(v), "wins.submit", "win", row.id, {
    summary: `Win ${opts.draftFromLead ? "drafted from a lead" : "submitted"} by ${row.submittedAs}: ${WIN_TYPE_LABEL[row.type]}`,
    after: { athleteId: row.athleteId, type: row.type, headline: row.headline, occurredOn: row.occurredOn, showInApp: row.showInApp, showOnTv: row.showOnTv, hasPhoto: !!photoObjectId, status: row.status },
  });
  return row;
}

/** Family answer to a staff draft: yes moves it to staff review, no closes it. Same right as submitting. */
export async function answerDraft(tx: Tx, v: Viewer, winId: string, answer: "confirm" | "decline", opts: { today?: string } = {}): Promise<Win> {
  const { win, access } = await winForViewer(tx, v, winId, opts.today);
  if (access.relationship === "staff" || !access.canSubmit) throw new AuthzError("Only the athlete or a parent or guardian who can act for them can answer this.");
  if (win.status !== "awaiting_family") throw new UserError("This one has already been answered.");
  const now = new Date();
  const [after] = await tx
    .update(wins)
    .set(answer === "confirm" ? { status: "pending", familyConfirmedAt: now, familyConfirmedBy: v.userId, updatedAt: now } : { status: "declined", updatedAt: now })
    .where(eq(wins.id, win.id))
    .returning();
  await audit(tx, actorOf(v), answer === "confirm" ? "wins.draft.confirm" : "wins.draft.decline", "win", win.id, { summary: answer === "confirm" ? "Family confirmed a staff draft win" : "Family declined a staff draft win", before: { status: win.status }, after: { status: after.status } });
  return after;
}

/** Staff edit of the wording (pending or approved). Audited with the text before and after. */
export async function editWin(tx: Tx, v: Viewer, input: { winId: string; headline: string; detail?: string | null }, opts: { today?: string } = {}): Promise<Win> {
  const { win, access } = await winForViewer(tx, v, input.winId, opts.today);
  if (!access.canReview) throw new AuthzError();
  if (win.status !== "pending" && win.status !== "approved") throw new UserError("Only wins waiting for review or already approved can be edited.");
  const text = checkWinText(input, access);
  if (text.headline === win.headline && text.detail === win.detail) return win;
  if (win.marketingConsent === "granted") throw new UserError(CONSENTED_WORDING);
  const [after] = await tx.update(wins).set({ headline: text.headline, detail: text.detail, updatedAt: new Date() }).where(eq(wins.id, win.id)).returning();
  await audit(tx, actorOf(v), "wins.edit", "win", win.id, { summary: "Win wording edited by staff", before: { headline: win.headline, detail: win.detail }, after: text });
  return after;
}

/**
 * Approve a pending win (staff in scope). The headline may be edited in the same step; the photo
 * is approved only when `approvePhoto` is ticked. Audited. Awards XP once through the engagement
 * ledger (`win:<id>`) when levels are on.
 */
export async function approveWin(tx: Tx, v: Viewer, input: { winId: string; headline?: string | null; detail?: string | null; approvePhoto?: boolean }, opts: { today?: string; now?: Date } = {}): Promise<Win> {
  const { win, access } = await winForViewer(tx, v, input.winId, opts.today);
  if (!access.canReview) throw new AuthzError();
  if (win.status === "awaiting_family") throw new UserError("The family has not confirmed this yet. It can be approved once they do.");
  if (win.status !== "pending") throw new UserError("This win is not waiting for review.");
  // Re-check the wording even when nothing was edited: the athlete's name may have changed since.
  const text = checkWinText({ headline: input.headline?.trim() ? input.headline : win.headline, detail: input.detail === undefined || input.detail === null ? win.detail : input.detail }, access);
  if (win.marketingConsent === "granted" && (text.headline !== win.headline || text.detail !== win.detail)) throw new UserError(CONSENTED_WORDING);
  const now = opts.now ?? new Date();
  const photoOk = !!win.photoObjectId && input.approvePhoto === true;
  const [after] = await tx
    .update(wins)
    .set({ status: "approved", headline: text.headline, detail: text.detail, approvedAt: now, approvedBy: v.userId, photoApprovedAt: photoOk ? now : null, photoApprovedBy: photoOk ? v.userId : null, updatedAt: now })
    .where(eq(wins.id, win.id))
    .returning();
  const eng = engagementSettingsOf(access.org.orgSettings);
  if (eng.levelsEnabled && eng.xp.win_approved > 0) {
    await tx
      .insert(xpEvents)
      .values({ orgId: v.orgId, athleteId: win.athleteId, kind: "win_approved", points: eng.xp.win_approved, sourceType: "win", sourceId: win.id, idempotencyKey: `win:${win.id}`, occurredAt: now, isDemo: win.isDemo })
      .onConflictDoNothing({ target: [xpEvents.orgId, xpEvents.idempotencyKey] });
  }
  await audit(tx, actorOf(v), "wins.approve", "win", win.id, {
    summary: `Win approved${text.headline !== win.headline ? " with an edited headline" : ""}${photoOk ? ", photo approved" : win.photoObjectId ? ", photo not approved" : ""}`,
    before: { status: win.status, headline: win.headline, detail: win.detail },
    after: { status: "approved", headline: text.headline, detail: text.detail, photoApproved: photoOk },
  });
  return after;
}

/** Approve or un-approve the photo on its own (staff in scope). */
export async function setPhotoApproval(tx: Tx, v: Viewer, winId: string, approved: boolean, opts: { today?: string } = {}): Promise<Win> {
  const { win, access } = await winForViewer(tx, v, winId, opts.today);
  if (!access.canReview) throw new AuthzError();
  if (!win.photoObjectId) throw new UserError("This win has no photo.");
  if (win.status !== "approved") throw new UserError("Approve the win first.");
  const now = new Date();
  const [after] = await tx.update(wins).set({ photoApprovedAt: approved ? now : null, photoApprovedBy: approved ? v.userId : null, updatedAt: now }).where(eq(wins.id, win.id)).returning();
  await audit(tx, actorOf(v), approved ? "wins.photo.approve" : "wins.photo.unapprove", "win", win.id, { summary: approved ? "Win photo approved for display" : "Win photo taken off display" });
  return after;
}

/**
 * Take a win down (soft delete, audited). Staff in scope may remove any win with a reason. The
 * family may withdraw their athlete's win at any time. XP already awarded stays: the ledger is
 * append-only.
 */
export async function removeWin(tx: Tx, v: Viewer, winId: string, opts: { reason?: string | null; today?: string } = {}): Promise<Win> {
  const { win, access } = await winForViewer(tx, v, winId, opts.today);
  const family = access.relationship !== "staff";
  if (family ? !access.canWithdraw : !access.canReview) throw new AuthzError();
  if (win.status === "removed") return win;
  const reason = oneLine(opts.reason ?? "").slice(0, 200) || (family ? "Withdrawn by the family" : null);
  if (!family && !reason) throw new UserError("Add a short reason. It is kept in the audit log.", { reason: "Required" });
  const now = new Date();
  const [after] = await tx.update(wins).set({ status: "removed", removedAt: now, removedBy: v.userId, removedReason: reason, updatedAt: now }).where(eq(wins.id, win.id)).returning();
  await audit(tx, actorOf(v), family ? "wins.withdraw" : "wins.remove", "win", win.id, { summary: family ? "Win withdrawn by the family" : `Win removed by staff: ${reason}`, before: { status: win.status, headline: win.headline, marketingConsent: win.marketingConsent }, after: { status: "removed", reason } });
  return after;
}

/** Levels (a) in-app feed and (b) gym TV. A guardian decides for a minor, an adult for themselves. */
export async function setSharing(tx: Tx, v: Viewer, input: { winId: string; showInApp: boolean; showOnTv: boolean }, opts: { today?: string } = {}): Promise<Win> {
  const { win, access } = await winForViewer(tx, v, input.winId, opts.today);
  if (!access.canSetSharing) throw new AuthzError(access.relationship === "self" ? "A parent or guardian chooses where wins are shown for athletes under 18." : undefined);
  if (win.status === "removed" || win.status === "declined") throw new UserError("This win is no longer active.");
  const [after] = await tx.update(wins).set({ showInApp: input.showInApp, showOnTv: input.showOnTv, updatedAt: new Date() }).where(eq(wins.id, win.id)).returning();
  await audit(tx, actorOf(v), "wins.sharing.set", "win", win.id, { summary: `Win sharing set: in the app ${input.showInApp ? "on" : "off"}, gym TV ${input.showOnTv ? "on" : "off"}`, before: { showInApp: win.showInApp, showOnTv: win.showOnTv }, after: { showInApp: input.showInApp, showOnTv: input.showOnTv } });
  return after;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type WinView = {
  id: string;
  athleteId: string;
  occurredOn: string;
  sport: string;
  type: WinType;
  typeLabel: string;
  headline: string;
  detail: string | null;
  sourceUrl: string | null;
  status: WinStatus;
  showInApp: boolean;
  showOnTv: boolean;
  marketingConsent: MarketingConsentState;
  marketingConsentAt: Date | null;
  marketingConsentByName: string | null;
  consentRequested: boolean;
  hasPhoto: boolean;
  photoApproved: boolean;
  submittedAs: WinSubmitter;
  submittedByName: string | null;
  createdAt: Date;
  approvedAt: Date | null;
};

const toView = (w: Win, names: Map<string, string>): WinView => ({
  id: w.id,
  athleteId: w.athleteId,
  occurredOn: w.occurredOn,
  sport: w.sport,
  type: w.type,
  typeLabel: WIN_TYPE_LABEL[w.type],
  headline: w.headline,
  detail: w.detail,
  sourceUrl: w.sourceUrl,
  status: w.status,
  showInApp: w.showInApp,
  showOnTv: w.showOnTv,
  marketingConsent: w.marketingConsent,
  marketingConsentAt: w.marketingConsentAt,
  marketingConsentByName: w.marketingConsentBy ? names.get(w.marketingConsentBy) ?? null : null,
  consentRequested: !!w.consentRequestedAt && w.marketingConsent === "none",
  hasPhoto: !!w.photoObjectId,
  photoApproved: !!w.photoApprovedAt,
  submittedAs: w.submittedAs,
  submittedByName: w.submittedBy ? names.get(w.submittedBy) ?? null : null,
  createdAt: w.createdAt,
  approvedAt: w.approvedAt,
});

async function userNames(tx: Tx, orgId: string, ids: (string | null)[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map();
  const rows = await tx.select({ id: users.id, name: users.displayName }).from(users).where(and(eq(users.orgId, orgId), inArray(users.id, uniq)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** One athlete's wins for the athlete, their guardians and staff in scope (removed ones left out). */
export async function winsForAthlete(tx: Tx, v: Viewer, athleteId: string, opts: { limit?: number; today?: string } = {}): Promise<{ access: WinsAccess; wins: WinView[] }> {
  const access = await accessOrThrow(tx, v, athleteId, opts.today);
  const rows = await tx
    .select()
    .from(wins)
    .where(and(eq(wins.orgId, v.orgId), eq(wins.athleteId, athleteId), sql`${wins.status} <> 'removed'`))
    .orderBy(desc(wins.occurredOn), desc(wins.createdAt))
    .limit(opts.limit ?? 50);
  const names = await userNames(tx, v.orgId, rows.flatMap((r) => [r.submittedBy, r.marketingConsentBy]));
  return { access, wins: rows.map((r) => toView(r, names)) };
}

export type ReviewItem = WinView & { athleteName: string; personId: string; displayName: string | null };

/** Staff review queue: wins waiting for approval, and drafts waiting for a family, in scope. */
export async function reviewQueue(tx: Tx, v: Viewer, opts: { statuses?: WinStatus[]; limit?: number } = {}): Promise<ReviewItem[]> {
  assertCan(v, "wins.review");
  const scope = await accessibleAthleteIds(tx, v, "profile.read");
  const rows = await tx
    .select({ w: wins, personId: people.id, first: people.firstName, preferred: people.preferredName, last: people.lastName })
    .from(wins)
    .innerJoin(athletes, eq(athletes.id, wins.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(wins.orgId, v.orgId), inArray(wins.status, opts.statuses ?? ["pending", "awaiting_family"]), athleteScopeFilter(scope, wins.athleteId)))
    .orderBy(desc(wins.createdAt))
    .limit(opts.limit ?? 100);
  const names = await userNames(tx, v.orgId, rows.flatMap((r) => [r.w.submittedBy, r.w.marketingConsentBy]));
  const roster = await communityRoster(tx, v.orgId);
  return rows.map((r) => ({ ...toView(r.w, names), athleteName: `${r.preferred ?? r.first} ${r.last}`, personId: r.personId, displayName: roster.get(r.w.athleteId)?.displayName ?? null }));
}

/** One public feed line. No athlete id and no last name; `id` is the win's own id (for its photo). */
export type FeedItem = { id: string; name: string; typeLabel: string; sport: string; headline: string; detail: string | null; when: string; occurredOn: string; photo: boolean; mine: boolean };

type ShownRow = { w: Win; last: string };

/** Approved wins of active athletes, newest first, with the last name for the defensive check. */
async function approvedRows(tx: Tx, orgId: string, where: ReturnType<typeof sql>, limit: number): Promise<ShownRow[]> {
  return tx
    .select({ w: wins, last: people.lastName })
    .from(wins)
    .innerJoin(athletes, eq(athletes.id, wins.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(wins.orgId, orgId), eq(wins.status, "approved"), eq(athletes.active, true), where))
    .orderBy(desc(wins.occurredOn), desc(wins.approvedAt))
    .limit(limit);
}

/**
 * The single filter every community surface goes through: approved, the level switched on, a
 * visible display name, and (defence in depth) wording that does not contain the last name.
 */
function shown(rows: ShownRow[], roster: Map<string, RosterEntry>, level: "showInApp" | "showOnTv"): { w: Win; name: string }[] {
  const out: { w: Win; name: string }[] = [];
  for (const r of rows) {
    const name = roster.get(r.w.athleteId)?.displayName ?? null;
    if (!name || r.w.status !== "approved" || !r.w[level]) continue;
    if (mentionsLastName(`${r.w.headline} ${r.w.detail ?? ""}`, r.last)) continue;
    out.push({ w: r.w, name });
  }
  return out;
}

/**
 * The Wins feed every signed-in family and staff member sees: approved wins with level (a) on,
 * under display names. Hidden athletes never appear, not even to staff here. Empty when community
 * features are off.
 */
export async function winsFeed(tx: Tx, v: Viewer, opts: { limit?: number; today?: string } = {}): Promise<FeedItem[]> {
  if (v.role === "kiosk") throw new AuthzError();
  const org = await communityOrg(tx, v.orgId);
  if (!org.settings.enabled) return [];
  const today = opts.today ?? todayLocal(org.tz);
  const roster = await communityRoster(tx, v.orgId, { today, defaultMode: org.settings.defaultDisplayMode });
  const own = isStaff(v) ? [] : await accessibleAthleteIds(tx, v, "profile.read");
  const ownIds = new Set(own === "all" ? [] : own);
  const rows = await approvedRows(tx, v.orgId, sql`${wins.showInApp} and ${wins.occurredOn} >= ${addDaysYmd(today, -365)}`, 200);
  return shown(rows, roster, "showInApp")
    .slice(0, opts.limit ?? 30)
    .map(({ w, name }) => ({ id: w.id, name, typeLabel: WIN_TYPE_LABEL[w.type], sport: w.sport, headline: w.headline, detail: w.detail, when: fmt(localToUtc(w.occurredOn, "12:00", org.tz), "MMM d", org.tz), occurredOn: w.occurredOn, photo: !!w.photoObjectId && !!w.photoApprovedAt, mine: ownIds.has(w.athleteId) }));
}

/** TV board items: approved in the last 30 days with level (b) on. Display names only, no ids, no photos. */
export async function tvWinItems(tx: Tx, orgId: string, roster: Map<string, RosterEntry>, opts: { today: string; tz: string; limit?: number }): Promise<{ name: string; headline: string; label: string; sport: string; when: string }[]> {
  const rows = await approvedRows(tx, orgId, sql`${wins.showOnTv} and ${wins.occurredOn} >= ${addDaysYmd(opts.today, -30)}`, 60);
  return shown(rows, roster, "showOnTv")
    .slice(0, opts.limit ?? 5)
    .map(({ w, name }) => ({ name, headline: w.headline, label: WIN_TYPE_LABEL[w.type], sport: w.sport, when: fmt(localToUtc(w.occurredOn, "12:00", opts.tz), "MMM d", opts.tz) }));
}

/** May this viewer load this win's photo? The family and staff in scope always; others only what the feed shows. */
export async function winPhotoFor(tx: Tx, v: Viewer, winId: string): Promise<{ storageKey: string; mimeType: string; sha256: string } | null> {
  if (v.role === "kiosk" || !z.string().uuid().safeParse(winId).success) return null;
  const [row] = await tx
    .select({ w: wins, last: people.lastName, key: storedObjects.storageKey, mime: storedObjects.mimeType, sha: storedObjects.sha256 })
    .from(wins)
    .innerJoin(athletes, eq(athletes.id, wins.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .innerJoin(storedObjects, eq(storedObjects.id, wins.photoObjectId))
    .where(and(eq(wins.id, winId), eq(wins.orgId, v.orgId), eq(storedObjects.orgId, v.orgId)));
  if (!row || row.w.status === "removed") return null;
  const file = { storageKey: row.key, mimeType: row.mime, sha256: row.sha };
  const access = await winsAccess(tx, v, row.w.athleteId);
  if (access?.canSee) return file;
  if (!row.w.photoApprovedAt || !access?.org.settings.enabled) return null;
  const roster = await communityRoster(tx, v.orgId);
  return shown([{ w: row.w, last: row.last }], roster, "showInApp").length ? file : null;
}

export type OutreachWin = { winId: string; athleteId: string; personId: string; athleteName: string; headline: string; typeLabel: string; occurredOn: string; approvedAt: Date };

/**
 * Staff retention view: athletes in scope with a win approved in the last `days` days. A reason
 * to reach out with congratulations; it is not a risk signal and never feeds the risk level.
 */
export async function recentWinsForOutreach(tx: Tx, v: Viewer, opts: { days?: number; now?: Date; limit?: number } = {}): Promise<OutreachWin[]> {
  assertCan(v, "retention.view");
  const scope = await accessibleAthleteIds(tx, v, "profile.read");
  const since = new Date((opts.now ?? new Date()).getTime() - (opts.days ?? 14) * 86_400_000);
  const rows = await tx
    .select({ w: wins, personId: people.id, first: people.firstName, preferred: people.preferredName, last: people.lastName })
    .from(wins)
    .innerJoin(athletes, eq(athletes.id, wins.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(wins.orgId, v.orgId), eq(wins.status, "approved"), eq(athletes.active, true), gte(wins.approvedAt, since), athleteScopeFilter(scope, wins.athleteId)))
    .orderBy(desc(wins.approvedAt))
    .limit(opts.limit ?? 20);
  return rows.map((r) => ({ winId: r.w.id, athleteId: r.w.athleteId, personId: r.personId, athleteName: `${r.preferred ?? r.first} ${r.last}`, headline: r.w.headline, typeLabel: WIN_TYPE_LABEL[r.w.type], occurredOn: r.w.occurredOn, approvedAt: r.w.approvedAt! }));
}

/** Monthly recap: the athlete's approved wins that happened in the month. Plain facts, no ids. */
export async function approvedWinsBetween(tx: Tx, orgId: string, athleteId: string, fromYmd: string, toYmd: string): Promise<{ headline: string; typeLabel: string; occurredOn: string }[]> {
  const rows = await tx
    .select({ headline: wins.headline, type: wins.type, occurredOn: wins.occurredOn })
    .from(wins)
    .where(and(eq(wins.orgId, orgId), eq(wins.athleteId, athleteId), eq(wins.status, "approved"), gte(wins.occurredOn, fromYmd), lte(wins.occurredOn, toYmd)))
    .orderBy(wins.occurredOn);
  return rows.map((r) => ({ headline: r.headline, typeLabel: WIN_TYPE_LABEL[r.type], occurredOn: r.occurredOn }));
}

/** Counts for the staff tabs. */
export async function winCounts(tx: Tx, v: Viewer): Promise<{ pending: number; awaitingFamily: number }> {
  if (!can(v, "wins.review")) return { pending: 0, awaitingFamily: 0 };
  const scope = await accessibleAthleteIds(tx, v, "profile.read");
  const rows = await tx
    .select({ status: wins.status, n: sql<number>`count(*)::int` })
    .from(wins)
    .where(and(eq(wins.orgId, v.orgId), inArray(wins.status, ["pending", "awaiting_family"]), athleteScopeFilter(scope, wins.athleteId)))
    .groupBy(wins.status);
  return { pending: rows.find((r) => r.status === "pending")?.n ?? 0, awaitingFamily: rows.find((r) => r.status === "awaiting_family")?.n ?? 0 };
}
