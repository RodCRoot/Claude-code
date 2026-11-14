/**
 * News watch: who is watched.
 *
 * Current athletes: off unless the family opts in. For a minor that is a guardian with the
 * "can sign forms" flag (the same flag as marketing consent in the Wins module); an adult athlete
 * decides alone. Any active guardian (or the athlete) can switch it off again, and so can staff
 * who manage people. Staff can ask the family in the app; no message is sent.
 *
 * Alumni: adults competing publicly in college. Staff add them with a recorded basis and can
 * take them off in one step. An alumnus linked to an athlete record that is under 18 on file (or
 * has no birthday on file) cannot be watched this way: that needs the guardian opt-in.
 *
 * Everything is derived from policy.ts through `winsAccess`; every change is audited and written
 * to the append-only `news_watch_events`.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { alumni, athletes, newsNegatives, newsWatchAthletes, newsWatchEvents, people, users, type NewsWatchAction } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { accessibleAthleteIds, assertCan, athleteScopeFilter, AuthzError, can, isStaff, requireOnAthlete, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { isMinor } from "@/lib/community/display-name";
import { winsAccess, type WinsAccess } from "@/lib/wins/access";
import { oneLine } from "@/lib/wins/shared";
import { closeClipsFor } from "./clips";
import { actorOf, newsOrg } from "./settings";
import { BASIS_MAX, fullNameForms, NEWS_WATCH_POLICY_TEXT, NEWS_WATCH_POLICY_VERSION, normText, type WatchedPerson } from "./shared";

export type Alumnus = typeof alumni.$inferSelect;
type WatchRow = typeof newsWatchAthletes.$inferSelect;

const uuid = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);

export type NewsWatchAccess = {
  athleteId: string;
  firstName: string;
  displayName: string | null;
  isMinor: boolean;
  relationship: WinsAccess["relationship"];
  optedIn: boolean;
  decidedAt: Date | null;
  decidedByName: string | null;
  /** Staff asked and the family has not answered. */
  requested: boolean;
  /** May switch it on (and answer a request). */
  canOptIn: boolean;
  /** May switch it off. */
  canOptOut: boolean;
  blockedReason: string | null;
};

async function watchRow(tx: Tx, orgId: string, athleteId: string, lock = false): Promise<WatchRow | null> {
  const q = tx.select().from(newsWatchAthletes).where(and(eq(newsWatchAthletes.orgId, orgId), eq(newsWatchAthletes.athleteId, athleteId)));
  const [row] = lock ? await q.for("update") : await q;
  return row ?? null;
}

/** What this viewer may do about news watch for one athlete. Null when they may not see the athlete. */
export async function newsWatchAccess(tx: Tx, v: Viewer, athleteId: string, opts: { today?: string } = {}): Promise<NewsWatchAccess | null> {
  const a = await winsAccess(tx, v, athleteId, opts);
  if (!a?.canSee) return null;
  const row = await watchRow(tx, v.orgId, athleteId);
  let decidedByName: string | null = null;
  if (row?.decidedBy) {
    const [u] = await tx.select({ name: users.displayName }).from(users).where(and(eq(users.id, row.decidedBy), eq(users.orgId, v.orgId)));
    decidedByName = u?.name ?? null;
  }
  const family = a.relationship === "guardian" || a.relationship === "self";
  const hidden = a.displayName === null;
  const canOptIn = family && a.canConsent && !hidden;
  return {
    athleteId,
    firstName: a.firstName,
    displayName: a.displayName,
    isMinor: a.isMinor,
    relationship: a.relationship,
    optedIn: row?.optedIn ?? false,
    decidedAt: row?.decidedAt ?? null,
    decidedByName,
    requested: !!row?.requestedAt && !row.optedIn,
    canOptIn,
    canOptOut: family ? a.canWithdraw : a.relationship === "staff" && can(v, "people.manage"),
    blockedReason: !family
      ? "Only the family can switch news watch on."
      : hidden
        ? "This athlete's name is hidden from other families, so a news clip could not be shown. Change how the name appears first."
        : a.consentBlockedReason?.replace("about public marketing", "about news watch") ?? null,
  };
}

async function logEvent(tx: Tx, v: Viewer, e: { athleteId?: string; alumniId?: string; action: NewsWatchAction; relationship: "guardian" | "self" | "staff"; policy?: boolean; note?: string | null }) {
  await tx.insert(newsWatchEvents).values({
    orgId: v.orgId,
    athleteId: e.athleteId ?? null,
    alumniId: e.alumniId ?? null,
    action: e.action,
    actorUserId: v.userId,
    actorPersonId: v.personId,
    relationship: e.relationship,
    policyVersion: e.policy ? NEWS_WATCH_POLICY_VERSION : null,
    policyText: e.policy ? NEWS_WATCH_POLICY_TEXT : null,
    note: e.note ?? null,
  });
}

/**
 * Switch news watch on or off for one athlete. On: the family only (see the file comment). Off:
 * the family or staff who manage people; it stops matching at once, closes this athlete's
 * unapproved clips and takes down the approved ones.
 */
export async function setNewsOptIn(tx: Tx, v: Viewer, athleteId: string, on: boolean, opts: { today?: string; now?: Date } = {}): Promise<{ optedIn: boolean }> {
  if (!uuid(athleteId)) throw new AuthzError();
  const access = await newsWatchAccess(tx, v, athleteId, opts);
  if (!access) throw new AuthzError();
  if (on ? !access.canOptIn : !access.canOptOut) throw new AuthzError(access.blockedReason ?? undefined);
  const now = opts.now ?? new Date();
  const [a] = await tx.select({ isDemo: athletes.isDemo }).from(athletes).where(and(eq(athletes.id, athleteId), eq(athletes.orgId, v.orgId)));
  const before = await watchRow(tx, v.orgId, athleteId, true);
  const wasOn = before?.optedIn ?? false;
  if (on && wasOn) return { optedIn: true };
  // Already off and nothing to answer: nothing to record.
  if (!on && !wasOn && !before?.requestedAt) return { optedIn: false };
  const relationship = access.relationship === "staff" ? "staff" : access.relationship === "self" ? "self" : "guardian";
  const set = { optedIn: on, decidedAt: now, decidedBy: v.userId, decidedAs: relationship, requestedAt: null, requestedBy: null, updatedAt: now } as const;
  if (before) await tx.update(newsWatchAthletes).set(set).where(eq(newsWatchAthletes.id, before.id));
  else await tx.insert(newsWatchAthletes).values({ orgId: v.orgId, athleteId, isDemo: a?.isDemo ?? false, ...set });
  const action: NewsWatchAction = on ? "granted" : before?.optedIn ? "revoked" : "declined";
  await logEvent(tx, v, { athleteId, action, relationship, policy: relationship !== "staff" });
  let closed = { closed: 0, takenDown: 0 };
  if (!on) closed = await closeClipsFor(tx, v.orgId, { athleteId }, v, "News watch was switched off for this athlete");
  await audit(tx, actorOf(v), `newswatch.optin.${action}`, "athlete", athleteId, {
    summary: on ? `News watch switched on by ${relationship === "self" ? "the athlete" : "a guardian"}` : `News watch switched off by ${relationship === "staff" ? "staff" : relationship === "self" ? "the athlete" : "a guardian"}`,
    before: { optedIn: before?.optedIn ?? false },
    after: { optedIn: on, policyVersion: relationship !== "staff" ? NEWS_WATCH_POLICY_VERSION : null, ...closed },
  });
  return { optedIn: on };
}

/** Staff ask the family to consider news watch. Sets a request the family sees in the app. Sends no message. */
export async function requestNewsOptIn(tx: Tx, v: Viewer, athleteId: string, opts: { now?: Date } = {}): Promise<void> {
  assertCan(v, "wins.review");
  if (!uuid(athleteId)) throw new AuthzError();
  await requireOnAthlete(tx, v, athleteId, "profile.read");
  const [a] = await tx.select({ isDemo: athletes.isDemo }).from(athletes).where(and(eq(athletes.id, athleteId), eq(athletes.orgId, v.orgId)));
  if (!a) throw new AuthzError();
  const before = await watchRow(tx, v.orgId, athleteId, true);
  if (before?.optedIn) throw new UserError("News watch is already on for this athlete.");
  if (before?.requestedAt) return;
  if (before?.decidedAt && before.decidedAs !== "staff") throw new UserError("The family already said no or switched it off. They can change their answer themselves on the Wins page.");
  const now = opts.now ?? new Date();
  if (before) await tx.update(newsWatchAthletes).set({ requestedAt: now, requestedBy: v.userId, updatedAt: now }).where(eq(newsWatchAthletes.id, before.id));
  else await tx.insert(newsWatchAthletes).values({ orgId: v.orgId, athleteId, requestedAt: now, requestedBy: v.userId, isDemo: a.isDemo });
  await logEvent(tx, v, { athleteId, action: "requested", relationship: "staff", policy: true });
  await audit(tx, actorOf(v), "newswatch.optin.requested", "athlete", athleteId, { summary: "Staff asked the family about news watch (shown in the app, no message sent)" });
}

const term = (max: number) => z.preprocess((x) => oneLine(x).slice(0, max) || null, z.string().nullable());
const termsInput = z.object({ school: term(80), sport: term(40), town: term(60) });

/** Words that tell this athlete apart: school, sport, town. Staff in scope. */
export async function setWatchTerms(tx: Tx, v: Viewer, athleteId: string, raw: unknown): Promise<void> {
  assertCan(v, "wins.review");
  if (!uuid(athleteId)) throw new AuthzError();
  await requireOnAthlete(tx, v, athleteId, "profile.read");
  const input = termsInput.parse(raw);
  const [a] = await tx.select({ isDemo: athletes.isDemo }).from(athletes).where(and(eq(athletes.id, athleteId), eq(athletes.orgId, v.orgId)));
  if (!a) throw new AuthzError();
  const before = await watchRow(tx, v.orgId, athleteId, true);
  if (before) await tx.update(newsWatchAthletes).set({ ...input, updatedAt: new Date() }).where(eq(newsWatchAthletes.id, before.id));
  else await tx.insert(newsWatchAthletes).values({ orgId: v.orgId, athleteId, isDemo: a.isDemo, ...input });
  await audit(tx, actorOf(v), "newswatch.terms.set", "athlete", athleteId, { summary: "News watch matching words changed", before: before ? { school: before.school, sport: before.sport, town: before.town } : null, after: input });
}

export type AthleteWatchLine = { athleteId: string; personId: string; name: string; isMinor: boolean; optedIn: boolean; requested: boolean; declined: boolean; decidedAt: Date | null; school: string | null; sport: string | null; town: string | null; hidden: boolean };

/** Staff list: every active athlete in scope with their news watch state. */
export async function athleteWatchList(tx: Tx, v: Viewer, opts: { today?: string } = {}): Promise<AthleteWatchLine[]> {
  assertCan(v, "wins.review");
  const scope = await accessibleAthleteIds(tx, v, "profile.read");
  const org = await newsOrg(tx, v.orgId);
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const rows = await tx
    .select({ id: athletes.id, personId: people.id, first: people.firstName, preferred: people.preferredName, last: people.lastName, dob: people.dateOfBirth, aSchool: athletes.school, aSport: athletes.sport, w: newsWatchAthletes, mode: sql<string | null>`(select mode from community_display_prefs dp where dp.athlete_id = ${athletes.id} and dp.org_id = ${v.orgId})` })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .leftJoin(newsWatchAthletes, eq(newsWatchAthletes.athleteId, athletes.id))
    .where(and(eq(athletes.orgId, v.orgId), eq(athletes.active, true), athleteScopeFilter(scope, athletes.id)))
    .orderBy(asc(people.firstName), asc(people.lastName));
  const defaultHidden = ((org?.orgSettings.community as { defaultDisplayMode?: string } | undefined)?.defaultDisplayMode ?? "") === "hidden";
  return rows.map((r) => ({
    athleteId: r.id,
    personId: r.personId,
    name: `${r.preferred ?? r.first} ${r.last}`,
    isMinor: isMinor(r.dob, today),
    optedIn: r.w?.optedIn ?? false,
    requested: !!r.w?.requestedAt && !r.w.optedIn,
    declined: !!r.w?.decidedAt && !r.w.optedIn && r.w.decidedAs !== "staff",
    decidedAt: r.w?.decidedAt ?? null,
    school: r.w?.school ?? r.aSchool ?? null,
    sport: r.w?.sport ?? r.aSport ?? null,
    town: r.w?.town ?? null,
    hidden: r.mode ? r.mode === "hidden" : defaultHidden,
  }));
}

// ---------------------------------------------------------------------------
// Alumni
// ---------------------------------------------------------------------------

const name = (label: string) => z.preprocess(oneLine, z.string().min(1, `Add the ${label}`).max(60));
const alumniInput = z.object({
  firstName: name("first name"),
  lastName: name("last name"),
  sport: term(40),
  college: term(100),
  gradYear: z.preprocess((x) => (x === "" || x == null ? null : Number(x)), z.number().int().min(1990, "Use a four-digit year").max(2100).nullable()),
  notes: term(500),
  fullNameOk: z.preprocess((x) => x === true || x === "on" || x === "true", z.boolean()),
});

function manage(v: Viewer) {
  assertCan(v, "people.manage");
}

async function alumnusForUpdate(tx: Tx, v: Viewer, id: string): Promise<Alumnus> {
  manage(v);
  if (!uuid(id)) throw new AuthzError("Alumni record not found.");
  const [row] = await tx.select().from(alumni).where(and(eq(alumni.id, id), eq(alumni.orgId, v.orgId))).for("update");
  if (!row) throw new AuthzError("Alumni record not found.");
  return row;
}

/** Add an alumni record (owner, admin, operations). Not on the watch list until a basis is recorded. */
export async function createAlumnus(tx: Tx, v: Viewer, raw: unknown, opts: { isDemo?: boolean } = {}): Promise<Alumnus> {
  manage(v);
  const input = alumniInput.parse(raw);
  const [row] = await tx.insert(alumni).values({ orgId: v.orgId, ...input, createdBy: v.userId, isDemo: opts.isDemo ?? false }).returning();
  await audit(tx, actorOf(v), "newswatch.alumni.create", "alumni", row.id, { summary: "Alumni record added", after: { sport: row.sport, college: row.college, gradYear: row.gradYear, fullNameOk: row.fullNameOk } });
  return row;
}

export async function updateAlumnus(tx: Tx, v: Viewer, id: string, raw: unknown): Promise<Alumnus> {
  const before = await alumnusForUpdate(tx, v, id);
  const input = alumniInput.parse(raw);
  const [row] = await tx.update(alumni).set({ ...input, updatedAt: new Date() }).where(eq(alumni.id, before.id)).returning();
  await audit(tx, actorOf(v), "newswatch.alumni.update", "alumni", row.id, { summary: "Alumni record changed", before: { sport: before.sport, college: before.college, gradYear: before.gradYear, fullNameOk: before.fullNameOk }, after: { sport: row.sport, college: row.college, gradYear: row.gradYear, fullNameOk: row.fullNameOk } });
  return row;
}

/**
 * Put an alumnus on the watch list (a basis is required and recorded) or take them off. Taking
 * them off closes their unapproved clips and takes down the approved ones.
 */
export async function setAlumniWatch(tx: Tx, v: Viewer, id: string, input: { watch: boolean; basis?: unknown }, opts: { today?: string; now?: Date } = {}): Promise<Alumnus> {
  const before = await alumnusForUpdate(tx, v, id);
  const now = opts.now ?? new Date();
  if (input.watch) {
    const basis = oneLine(input.basis).slice(0, BASIS_MAX);
    if (basis.length < 5) throw new UserError('Say on what basis this person is watched, for example "gave permission at alumni day" or "public college roster".', { basis: "Required" });
    if (!before.active) throw new UserError("This alumni record is inactive. Make it active first.");
    if (before.athleteId) {
      const [p] = await tx.select({ dob: people.dateOfBirth }).from(athletes).innerJoin(people, eq(people.id, athletes.personId)).where(and(eq(athletes.id, before.athleteId), eq(athletes.orgId, v.orgId)));
      const org = await newsOrg(tx, v.orgId);
      const today = opts.today ?? new Intl.DateTimeFormat("en-CA", { timeZone: org?.tz }).format(now);
      if (isMinor(p?.dob ?? null, today)) throw new UserError("The linked athlete record is under 18 or has no birthday on file. A minor is watched only when a parent or guardian opts in on the Wins page.");
    }
    const [row] = await tx.update(alumni).set({ watch: true, watchBasis: basis, watchSetBy: v.userId, watchSetAt: now, updatedAt: now }).where(eq(alumni.id, before.id)).returning();
    await logEvent(tx, v, { alumniId: row.id, action: "alumni_added", relationship: "staff", note: basis });
    await audit(tx, actorOf(v), "newswatch.alumni.watch_on", "alumni", row.id, { summary: "Alumnus added to the news watch list", after: { basis } });
    return row;
  }
  if (!before.watch) return before;
  const [row] = await tx.update(alumni).set({ watch: false, watchSetBy: v.userId, watchSetAt: now, updatedAt: now }).where(eq(alumni.id, before.id)).returning();
  await logEvent(tx, v, { alumniId: row.id, action: "alumni_removed", relationship: "staff", note: before.watchBasis });
  const closed = await closeClipsFor(tx, v.orgId, { alumniId: row.id }, v, "Taken off the news watch list");
  await audit(tx, actorOf(v), "newswatch.alumni.watch_off", "alumni", row.id, { summary: "Alumnus taken off the news watch list", after: closed });
  return row;
}

/** Make an alumni record inactive (or active again). Inactive also means not watched and not shown. */
export async function setAlumniActive(tx: Tx, v: Viewer, id: string, active: boolean): Promise<Alumnus> {
  const before = await alumnusForUpdate(tx, v, id);
  if (before.active === active) return before;
  if (!active && before.watch) await setAlumniWatch(tx, v, id, { watch: false });
  const [row] = await tx.update(alumni).set({ active, updatedAt: new Date() }).where(eq(alumni.id, before.id)).returning();
  await audit(tx, actorOf(v), active ? "newswatch.alumni.reactivate" : "newswatch.alumni.deactivate", "alumni", row.id, { summary: active ? "Alumni record made active" : "Alumni record made inactive" });
  return row;
}

/**
 * From a profile: start an alumni record for a departing athlete (name, sport and graduation year
 * copied, linked to the athlete record). It does not change the athlete record, and it does not
 * put the person on the watch list: that needs a recorded basis, and an adult.
 */
export async function markAthleteAsAlumni(tx: Tx, v: Viewer, athleteId: string, raw: { college?: unknown } = {}): Promise<Alumnus> {
  manage(v);
  if (!uuid(athleteId)) throw new AuthzError();
  await requireOnAthlete(tx, v, athleteId, "profile.read");
  const [a] = await tx
    .select({ first: people.firstName, preferred: people.preferredName, last: people.lastName, sport: athletes.sport, gradYear: athletes.gradYear, isDemo: athletes.isDemo })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.id, athleteId), eq(athletes.orgId, v.orgId)));
  if (!a) throw new AuthzError();
  const [existing] = await tx.select().from(alumni).where(and(eq(alumni.orgId, v.orgId), eq(alumni.athleteId, athleteId)));
  if (existing) return existing;
  const college = oneLine(raw.college).slice(0, 100) || null;
  const [row] = await tx
    .insert(alumni)
    .values({ orgId: v.orgId, firstName: a.preferred?.trim() || a.first, lastName: a.last, sport: a.sport, college, gradYear: a.gradYear, athleteId, createdBy: v.userId, isDemo: a.isDemo })
    .returning();
  await audit(tx, actorOf(v), "newswatch.alumni.from_athlete", "alumni", row.id, { summary: "Athlete marked as alumni", after: { athleteId, college } });
  return row;
}

export async function alumnusForAthlete(tx: Tx, v: Viewer, athleteId: string): Promise<Alumnus | null> {
  if (!isStaff(v)) return null;
  const [row] = await tx.select().from(alumni).where(and(eq(alumni.orgId, v.orgId), eq(alumni.athleteId, athleteId)));
  return row ?? null;
}

/** Staff list of alumni (any staff member with wins.review may read; changes need people.manage). */
export async function listAlumni(tx: Tx, v: Viewer): Promise<Alumnus[]> {
  assertCan(v, "wins.review");
  return tx.select().from(alumni).where(eq(alumni.orgId, v.orgId)).orderBy(desc(alumni.active), asc(alumni.lastName), asc(alumni.firstName));
}

// ---------------------------------------------------------------------------
// The watch list the matcher uses
// ---------------------------------------------------------------------------

export const personKey = (p: Pick<WatchedPerson, "kind" | "id">) => `${p.kind}:${p.id}`;

/**
 * Everyone being watched right now: active athletes whose opt-in is on, and active alumni on the
 * watch list. An alumnus whose linked athlete record is itself being watched is left out so one
 * person is not searched twice. Also works out who shares a full name with someone else at the gym.
 */
export async function loadWatched(tx: Tx, orgId: string): Promise<WatchedPerson[]> {
  const ath = await tx
    .select({ id: athletes.id, personId: people.id, first: people.firstName, preferred: people.preferredName, last: people.lastName, aSchool: athletes.school, aSport: athletes.sport, school: newsWatchAthletes.school, sport: newsWatchAthletes.sport, town: newsWatchAthletes.town })
    .from(newsWatchAthletes)
    .innerJoin(athletes, eq(athletes.id, newsWatchAthletes.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(newsWatchAthletes.orgId, orgId), eq(newsWatchAthletes.optedIn, true), eq(athletes.orgId, orgId), eq(athletes.active, true), sql`${people.status} = 'active' and ${people.archivedAt} is null`))
    .orderBy(asc(athletes.id));
  const watchedAthletes = new Set(ath.map((a) => a.id));
  const alu = (await tx.select().from(alumni).where(and(eq(alumni.orgId, orgId), eq(alumni.active, true), eq(alumni.watch, true))).orderBy(asc(alumni.id))).filter((a) => !a.athleteId || !watchedAthletes.has(a.athleteId));

  // Same-name check across every person on file and every alumni record.
  const everyone = await tx.select({ id: people.id, first: people.firstName, preferred: people.preferredName, last: people.lastName }).from(people).where(eq(people.orgId, orgId));
  const allAlumni = await tx.select({ id: alumni.id, first: alumni.firstName, last: alumni.lastName, athleteId: alumni.athleteId }).from(alumni).where(eq(alumni.orgId, orgId));
  const athletePerson = new Map((await tx.select({ id: athletes.id, personId: athletes.personId }).from(athletes).where(eq(athletes.orgId, orgId))).map((a) => [a.id, a.personId]));
  // identity = the person record when there is one, so an alumnus and their own athlete record count once.
  const holders = new Map<string, Set<string>>();
  const note = (identity: string, forms: string[]) => {
    for (const f of forms) holders.set(f, (holders.get(f) ?? new Set()).add(identity));
  };
  for (const p of everyone) note(`p:${p.id}`, fullNameForms({ firstName: p.first, preferredName: p.preferred, lastName: p.last }));
  for (const a of allAlumni) note(a.athleteId && athletePerson.has(a.athleteId) ? `p:${athletePerson.get(a.athleteId)}` : `a:${a.id}`, fullNameForms({ firstName: a.first, lastName: a.last }));
  const shared = (identity: string, forms: string[]) => forms.some((f) => [...(holders.get(f) ?? [])].some((h) => h !== identity));

  const out: WatchedPerson[] = [
    ...ath.map((a) => ({ kind: "athlete" as const, id: a.id, firstName: a.first, preferredName: a.preferred, lastName: a.last, school: a.school ?? a.aSchool, sport: a.sport ?? a.aSport, town: a.town, sameNameInOrg: shared(`p:${a.personId}`, fullNameForms({ firstName: a.first, preferredName: a.preferred, lastName: a.last })) })),
    ...alu.map((a) => ({ kind: "alumni" as const, id: a.id, firstName: a.firstName, preferredName: null, lastName: a.lastName, school: a.college, sport: a.sport, town: null, sameNameInOrg: shared(a.athleteId && athletePerson.has(a.athleteId) ? `p:${athletePerson.get(a.athleteId)}` : `a:${a.id}`, fullNameForms({ firstName: a.firstName, lastName: a.lastName })) })),
  ];
  if (!out.length) return out;
  const athleteIds = out.filter((p) => p.kind === "athlete").map((p) => p.id);
  const alumniIds = out.filter((p) => p.kind === "alumni").map((p) => p.id);
  const negs = await tx
    .select()
    .from(newsNegatives)
    .where(and(eq(newsNegatives.orgId, orgId), sql`(${athleteIds.length ? inArray(newsNegatives.athleteId, athleteIds) : sql`false`} or ${alumniIds.length ? inArray(newsNegatives.alumniId, alumniIds) : sql`false`})`));
  for (const p of out) {
    const mine = negs.filter((n) => (p.kind === "athlete" ? n.athleteId === p.id : n.alumniId === p.id));
    const publications: Record<string, number> = {};
    for (const n of mine) if (n.publication) publications[n.publication] = (publications[n.publication] ?? 0) + 1;
    p.negatives = { titleKeys: mine.map((n) => n.titleKey).filter((k): k is string => !!k), publications, terms: mine.map((n) => n.term).filter((t): t is string => !!t && normText(t).length >= 3) };
  }
  return out;
}
