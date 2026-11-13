import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { alumni, athletes, auditEvents, guardianships, newsItems, newsNegatives, newsSources, newsWatchAthletes, newsWatchEvents, people, winLeads, wins, type NewsClipStatus } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { AuthzError, can, type Viewer } from "@/lib/authz/policy";
import { boardPayload } from "@/lib/community/board";
import { setDisplayMode } from "@/lib/community/display-name";
import { addManualClip, alumniNewsFeed, approveClip, approveClips, ingestItems, listClips, pendingClipCount, rejectClip, removeClip, triageClip } from "@/lib/newswatch/clips";
import { cleanDomain, FeedError, feedUrlProblem, linkKey, parseFeed, searchQuery, titleKey, type FeedFetcher, type ParsedItem } from "@/lib/newswatch/feed";
import { runNewsWatch } from "@/lib/newswatch/job";
import { addSource, canApproveNews, ensureDefaultSources, listSources, saveNewsSettings, setSourceEnabled } from "@/lib/newswatch/settings";
import { alumniDisplayName, DEFAULT_SOURCES, displayHeadline, NEWS_JOB_TYPE, NEWS_USER_AGENT, NEWS_WATCH_POLICY_VERSION, scoreMatch, sensitiveCheck, type WatchedPerson } from "@/lib/newswatch/shared";
import { athleteWatchList, createAlumnus, loadWatched, markAthleteAsAlumni, newsWatchAccess, requestNewsOptIn, setAlumniWatch, setNewsOptIn, setWatchTerms } from "@/lib/newswatch/watch";
import { runScheduledJobNow, SCHEDULED_JOBS, NIGHTLY_JOB_TYPES } from "@/lib/scheduled/jobs";
import { localToUtc } from "@/lib/time";
import { convertLead, dismissLead, listLeads } from "@/lib/wins/leads";
import { marketingQueue } from "@/lib/wins/marketing";
import { submitWin, winsFeed, winsForAthlete } from "@/lib/wins/wins";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

/**
 * No test here touches the network: every feed is a fixture file with invented papers, schools
 * and people, served by a fake fetcher.
 */
type Ctx = Awaited<ReturnType<typeof seedOrg>>;
const TODAY = "2026-03-02";
const NOW = localToUtc(TODAY, "12:00");
const fx = (name: string) => readFileSync(join(__dirname, "fixtures", "newswatch", name), "utf8");
const db = testDb();
let ctx: Ctx;
let other: Ctx;
const V: Record<string, Viewer> = {};
const ALL = ["rod", "erin", "marcus", "tess", "alex", "jordan", "chris", "sam", "casey", "dana", "maya", "kiosk"];
const FAMILY_AND_OUTSIDERS = ["alex", "jordan", "chris", "sam", "casey", "dana", "maya", "kiosk"];

const GAZETTE = "https://gazette.example.com/feed.rss";
const COLLEGE = "https://athletics.example.org/feed.atom";
const BROKEN = "https://broken.example.com/feed";
const PAYWALLED = "https://paywalled.example.com/feed";
const DOWN = "https://down.example.com/feed";
const SEARCH = "https://search.example.net/rss/search?q={query}";

/** A fake fetcher: fixture bodies by address, with a record of everything that was requested. */
function fakeFetcher(): { fetch: FeedFetcher; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      if (url === GAZETTE) return { status: 200, body: fx("gazette-rss.xml") };
      if (url === COLLEGE) return { status: 200, body: fx("college-atom.xml") };
      if (url === BROKEN) return { status: 200, body: fx("malformed.xml") };
      if (url === PAYWALLED) return { status: 402, body: "" };
      if (url === DOWN) throw new Error("connect ECONNREFUSED (simulated)");
      if (url.startsWith("https://search.example.net/")) return { status: 200, body: decodeURIComponent(url).includes('"Zyra Quillfeather"') ? fx("search-zyra.xml") : fx("empty-rss.xml") };
      return { status: 404, body: "" };
    },
  };
}

const tx = <T>(fn: (t: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) => db.transaction(fn);
const clips = (v: Viewer, statuses?: NewsClipStatus[]) => listClips(db, v, { statuses, today: TODAY });
const person = (over: Partial<WatchedPerson> = {}): WatchedPerson => ({ kind: "athlete", id: "a1", firstName: "Zyra", lastName: "Quillfeather", school: "Fictional Falls High School", sport: "Volleyball", town: "Sampleton", sameNameInOrg: false, ...over });
const item = (slug: string, headline: string, over: Partial<ParsedItem> = {}): ParsedItem => ({ headline, link: `https://gazette.example.com/x/${slug}`, publishedAt: new Date(NOW.getTime() - 86_400_000), sourceName: "Sampleton Gazette", sourceUrl: null, snippet: null, ...over });
const ingest = async (items: ParsedItem[]) => tx(async (t) => ingestItems(t, ctx.orgId, { id: null, name: "Sampleton Gazette" }, items, await loadWatched(t, ctx.orgId), { now: NOW }));

beforeAll(async () => {
  ctx = await seedOrg(TODAY, { modules: [] });
  other = await seedOrg(TODAY, { modules: [] });
  for (const k of ALL) V[k] = await viewerFor(ctx, k);
  V.otherOwner = await viewerFor(other, "rod");
  // Obviously invented names that cannot collide with anything else.
  await db.update(people).set({ firstName: "Zyra", lastName: "Quillfeather" }).where(eq(people.id, ctx.people.maya_parker));
  await db.update(athletes).set({ school: "Fictional Falls High School", sport: "Volleyball" }).where(eq(athletes.id, ctx.athletes.maya));
});
afterAll(closeTestDb);

describe("feed parsing (fixtures only)", () => {
  it("reads an RSS feed: title, link, date, a two-sentence plain summary, and nothing else", () => {
    const items = parseFeed(fx("gazette-rss.xml"));
    expect(items).toHaveLength(7); // the item without a link is skipped
    const first = items[0];
    expect(first.headline).toBe("Zyra Quillfeather scores 22 as Fictional Falls tops Makebelieve Central");
    expect(first.link).toContain("https://gazette.example.com/sports/article_1.html");
    expect(first.publishedAt?.toISOString()).toBe("2026-03-01T00:40:00.000Z");
    expect(first.snippet).toBe("The Fictional Falls volleyball team won in four sets on Tuesday. It was the first home win of the season.");
    expect(JSON.stringify(items)).not.toMatch(/third sentence|photo\.jpg|<img|<p>|enclosure/i);
  });

  it("reads an Atom feed, decoding entities and choosing the article link", () => {
    const items = parseFeed(fx("college-atom.xml"));
    expect(items).toHaveLength(2);
    expect(items[0].headline).toBe("Brennick Oddfellow's late goal lifts Imaginary College & clinches the title");
    expect(items[0].link).toBe("https://athletics.example.org/news/2026/3/1/soccer-title.aspx");
    expect(items[0].snippet).toBe("The Imaginary College soccer team won 2-1.");
    expect(items[1].publishedAt?.toISOString()).toBe("2026-02-27T15:00:00.000Z");
  });

  it("reads a search-style feed: publication from <source>, suffix removed, link-only description dropped", () => {
    const items = parseFeed(fx("search-zyra.xml"));
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ headline: "Zyra Quillfeather scores 22 as Fictional Falls tops Makebelieve Central | Sports", sourceName: "Sampleton Gazette", sourceUrl: "https://gazette.example.com/", snippet: null });
    expect(items[1].headline).toBe("Fictional Falls rolls into the sectional final");
  });

  it("an empty feed is an empty list; malformed XML and a web page are errors", () => {
    expect(parseFeed(fx("empty-rss.xml"))).toEqual([]);
    expect(() => parseFeed(fx("malformed.xml"))).toThrow(FeedError);
    expect(() => parseFeed("<!doctype html><html><body>Subscribe to continue reading</body></html>")).toThrow(FeedError);
  });

  it("the same article has the same key whichever way it arrived", () => {
    expect(linkKey("https://www.gazette.example.com/a/b.html?utm_source=rss#top")).toBe(linkKey("https://gazette.example.com/a/b.html"));
    expect(linkKey("https://gazette.example.com/a/b.html")).not.toBe(linkKey("https://gazette.example.com/a/c.html"));
    expect(titleKey("Zyra Quillfeather scores 22 | Sports", "Sampleton Gazette")).toBe(titleKey("zyra quillfeather scores 22", "sampleton gazette"));
    expect(titleKey("Sports roundup", "Sampleton Gazette")).not.toBe(titleKey("Sports roundup", "Elsewhere Times"));
  });

  it("only public https feed addresses are accepted, and a search asks for the exact full name on named sites", () => {
    for (const bad of ["http://gazette.example.com/feed", "https://localhost/feed", "https://10.0.0.5/feed", "https://user:pw@gazette.example.com/feed", "https://intranet/feed", "https://feeds.internal/x", "ftp://gazette.example.com", "not a url", "https://gazette.example.com:8443/feed"]) expect(feedUrlProblem(bad), bad).toBeTruthy();
    expect(feedUrlProblem(GAZETTE)).toBeNull();
    expect(searchQuery('Zyra "Q" Quillfeather', ["a.example.com", "b.example.com"])).toBe('"Zyra Q Quillfeather" (site:a.example.com OR site:b.example.com)');
    expect(cleanDomain("https://www.Example.com/sports")).toBe("example.com");
    expect(cleanDomain("not a domain")).toBeNull();
    expect(NEWS_USER_AGENT).toMatch(/feed reader/);
    expect(NEWS_USER_AGENT).not.toMatch(/mozilla|chrome|safari|googlebot/i);
  });
});

describe("matching (pure)", () => {
  it("the exact full name in the headline is likely; in the summary only it is possible until the school agrees", () => {
    expect(scoreMatch(person({ school: null, sport: null, town: null }), { headline: "Zyra Quillfeather scores 22" })).toMatchObject({ level: "likely", score: 60 });
    expect(scoreMatch(person({ school: null, sport: null, town: null }), { headline: "Banquet honors athletes", snippet: "Senior Zyra Quillfeather was named MVP." })).toMatchObject({ level: "possible", score: 50 });
    const withSchool = scoreMatch(person(), { headline: "Fictional Falls honors its athletes", snippet: "Senior Zyra Quillfeather was named MVP in volleyball." });
    expect(withSchool).toMatchObject({ level: "likely", score: 80 });
    expect(withSchool.reasons.join(" ")).toMatch(/summary[\s\S]*school[\s\S]*sport/);
    // The preferred name with the last name also counts as the full name.
    expect(scoreMatch(person({ preferredName: "Zee" }), { headline: "Zee Quillfeather wins" }).level).toBe("likely");
  });

  it("never matches on a first name or a last name alone, whatever else agrees", () => {
    for (const headline of ["Zyra leads Fictional Falls volleyball in Sampleton", "Quillfeather leads Fictional Falls volleyball in Sampleton", "Quillfeather, Zyra's cousin, wins", "Zyraa Quillfeatherson scores"]) {
      expect(scoreMatch(person(), { headline }), headline).toMatchObject({ level: "unlikely", score: 0 });
    }
    expect(scoreMatch(person({ firstName: "Ann", lastName: "Lee" }), { headline: "Joann Leeds wins the title" }).level).toBe("unlikely");
  });

  it("a search for the exact name makes a headline without the name possible, never likely on its own", () => {
    expect(scoreMatch(person({ school: null, sport: null, town: null }), { headline: "Panthers roll into the final", searchedForThisPerson: true })).toMatchObject({ level: "possible", score: 30 });
    expect(scoreMatch(person({ school: null, sport: null, town: null }), { headline: "Panthers roll into the final", searchedForThisPerson: false }).level).toBe("unlikely");
  });

  it("same-name ambiguity and very common names lower the score", () => {
    const same = scoreMatch(person({ sameNameInOrg: true, school: null, sport: null, town: null }), { headline: "Zyra Quillfeather scores 22" });
    expect(same).toMatchObject({ level: "possible", score: 30 });
    expect(same.reasons.join(" ")).toMatch(/same name/);
    const common = person({ firstName: "John", lastName: "Smith", school: null, sport: null, town: null });
    expect(scoreMatch(common, { headline: "John Smith scores 22" })).toMatchObject({ level: "possible", score: 40 });
    expect(scoreMatch(common, { headline: "Panthers win", searchedForThisPerson: true }).level).toBe("unlikely");
    expect(scoreMatch(person({ firstName: "Zyra", lastName: "Smith", school: null, sport: null, town: null }), { headline: "Zyra Smith scores 22" }).score).toBe(50);
  });

  it("'not our athlete' history suppresses the article, the marked word, and lowers the publication", () => {
    const neg = { titleKeys: ["tk1"], publications: { "sampleton gazette": 2 }, terms: ["Otherville"] };
    const p = person({ negatives: neg, school: null, sport: null, town: null });
    expect(scoreMatch(p, { headline: "Zyra Quillfeather scores 22", titleKey: "tk1" }).level).toBe("unlikely");
    expect(scoreMatch(p, { headline: "Otherville's Zyra Quillfeather scores 22" }).level).toBe("unlikely");
    expect(scoreMatch(p, { headline: "Zyra Quillfeather scores 22", publication: "sampleton gazette" })).toMatchObject({ level: "possible", score: 30 });
    expect(scoreMatch(p, { headline: "Zyra Quillfeather scores 22", publication: "elsewhere times" }).level).toBe("likely");
  });

  it("the sensitive check blocks health topics and labels arrests, courts, deaths and discipline", () => {
    expect(sensitiveCheck("Zyra Quillfeather sidelined with a knee injury")).toMatchObject({ blocked: "health or injuries" });
    expect(sensitiveCheck("Teen arrested after crash, police say").warning).toMatch(/arrest.*crash/);
    expect(sensitiveCheck("Former star sentenced in court case").warning).toMatch(/court/);
    expect(sensitiveCheck("Community mourns coach who died Sunday").warning).toMatch(/death/);
    expect(sensitiveCheck("Two players suspended for a violation of team rules").warning).toMatch(/discipline/);
    expect(sensitiveCheck("Quillfeather owns the court with 22 points and a late shot")).toEqual({ blocked: null, warning: null });
  });

  it("display: the full name becomes the shown name, and long dashes become plain", () => {
    const p = { firstName: "Zyra", lastName: "Quillfeather" };
    expect(displayHeadline("Zyra Quillfeather scores 22 — Quillfeather's best night", p, "Zyra")).toBe("Zyra scores 22 - Zyra's best night");
    expect(displayHeadline("Zyra  Quillfeather wins", p, "Zyra Q.")).toBe("Zyra Q. wins");
    expect(displayHeadline("x".repeat(200), p, "Zyra").length).toBe(120);
    expect(alumniDisplayName({ firstName: "Brennick", lastName: "Oddfellow", fullNameOk: false })).toBe("Brennick O.");
    expect(alumniDisplayName({ firstName: "Brennick", lastName: "Oddfellow", fullNameOk: true })).toBe("Brennick Oddfellow");
  });
});

describe("who is watched", () => {
  it("is off by default and nobody is matched until a family opts in", async () => {
    expect(await loadWatched(db, ctx.orgId)).toEqual([]);
    const r = await ingest(parseFeed(fx("gazette-rss.xml")));
    expect(r.newClips).toBe(0);
    expect(await db.select().from(newsItems).where(eq(newsItems.orgId, ctx.orgId))).toHaveLength(0);
    expect((await newsWatchAccess(db, V.alex, ctx.athletes.maya, { today: TODAY }))?.optedIn).toBe(false);
  });

  it("staff can ask the family in the app, and can never switch it on", async () => {
    const jobCount = async () => ((await db.execute(sql`select count(*)::int as n from jobs where org_id = ${ctx.orgId}`)).rows[0] as { n: number }).n;
    const jobsBefore = await jobCount();
    for (const k of ["rod", "erin", "marcus"]) await expect(tx((t) => setNewsOptIn(t, V[k], ctx.athletes.maya, true, { today: TODAY })), k).rejects.toThrow(AuthzError);
    await expect(tx((t) => requestNewsOptIn(t, V.tess, ctx.athletes.maya))).rejects.toThrow(AuthzError); // not her athlete
    for (const k of FAMILY_AND_OUTSIDERS) await expect(tx((t) => requestNewsOptIn(t, V[k], ctx.athletes.maya)), k).rejects.toThrow(AuthzError);
    await tx((t) => requestNewsOptIn(t, V.marcus, ctx.athletes.maya));
    expect((await newsWatchAccess(db, V.alex, ctx.athletes.maya, { today: TODAY }))?.requested).toBe(true);
    expect(await loadWatched(db, ctx.orgId)).toEqual([]);
    // Asking sends nothing: no job was queued.
    expect(await jobCount()).toBe(jobsBefore);
  });

  it("for a minor only a guardian with the sign-forms flag opts in; every other demo role is refused", async () => {
    await db.update(guardianships).set({ canSignForms: false }).where(and(eq(guardianships.athleteId, ctx.athletes.maya), eq(guardianships.guardianPersonId, ctx.people.jordan_parker)));
    const on = (v: Viewer, athlete = ctx.athletes.maya) => tx((t) => setNewsOptIn(t, v, athlete, true, { today: TODAY, now: NOW }));
    for (const k of ["jordan", "chris", "sam", "casey", "dana", "maya", "kiosk", "otherOwner", "tess"]) await expect(on(V[k]), k).rejects.toThrow(AuthzError);
    const jordan = await newsWatchAccess(db, V.jordan, ctx.athletes.maya, { today: TODAY });
    expect(jordan).toMatchObject({ canOptIn: false, canOptOut: true });
    expect(jordan?.blockedReason).toMatch(/not set up to sign/);
    expect((await newsWatchAccess(db, V.maya, ctx.athletes.maya, { today: TODAY }))?.blockedReason).toMatch(/parent or guardian decides about news watch/);
    expect(await newsWatchAccess(db, V.chris, ctx.athletes.maya, { today: TODAY })).toBeNull();

    await on(V.alex);
    const [row] = await db.select().from(newsWatchAthletes).where(eq(newsWatchAthletes.athleteId, ctx.athletes.maya));
    expect(row).toMatchObject({ optedIn: true, decidedBy: V.alex.userId, decidedAs: "guardian", requestedAt: null });
    expect(row.decidedAt?.toISOString()).toBe(NOW.toISOString());
    const events = await db.select().from(newsWatchEvents).where(eq(newsWatchEvents.athleteId, ctx.athletes.maya)).orderBy(newsWatchEvents.createdAt);
    expect(events.map((e) => [e.action, e.relationship])).toEqual([["requested", "staff"], ["granted", "guardian"]]);
    expect(events[1]).toMatchObject({ actorUserId: V.alex.userId, policyVersion: NEWS_WATCH_POLICY_VERSION });
    expect(events[1].policyText).toMatch(/SAMPLE WORDING.*news search service/);
    // The ledger is append-only, and the database refuses a staff-granted opt-in.
    await expect(db.update(newsWatchEvents).set({ note: "x" }).where(eq(newsWatchEvents.id, events[1].id))).rejects.toThrow();
    await expect(db.update(newsWatchAthletes).set({ decidedAs: "staff" }).where(eq(newsWatchAthletes.id, row.id))).rejects.toThrow();
    const audit = await db.select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "newswatch.optin.granted")));
    expect(audit).toHaveLength(1);
  });

  it("an adult athlete decides alone, and a hidden athlete cannot be opted in", async () => {
    await expect(tx((t) => setNewsOptIn(t, V.marcus, ctx.athletes.dana, true, { today: TODAY }))).rejects.toThrow(AuthzError);
    await tx((t) => setNewsOptIn(t, V.dana, ctx.athletes.dana, true, { today: TODAY }));
    const [row] = await db.select().from(newsWatchAthletes).where(eq(newsWatchAthletes.athleteId, ctx.athletes.dana));
    expect(row).toMatchObject({ optedIn: true, decidedAs: "self" });
    await tx((t) => setNewsOptIn(t, V.dana, ctx.athletes.dana, false, { today: TODAY }));

    await tx((t) => setDisplayMode(t, V.alex, { athleteId: ctx.athletes.eli, mode: "hidden" }, TODAY));
    await expect(tx((t) => setNewsOptIn(t, V.alex, ctx.athletes.eli, true, { today: TODAY }))).rejects.toThrow(/hidden from other families/);
  });

  it("the watch list has the athlete with the school and sport as matching words; a coach sees only their athletes", async () => {
    await tx((t) => setWatchTerms(t, V.marcus, ctx.athletes.maya, { school: "", sport: "", town: "Sampleton" }));
    await expect(tx((t) => setWatchTerms(t, V.tess, ctx.athletes.maya, { town: "x" }))).rejects.toThrow(AuthzError);
    const watched = await loadWatched(db, ctx.orgId);
    expect(watched).toHaveLength(1);
    expect(watched[0]).toMatchObject({ kind: "athlete", id: ctx.athletes.maya, firstName: "Zyra", lastName: "Quillfeather", school: "Fictional Falls High School", sport: "Volleyball", town: "Sampleton", sameNameInOrg: false });
    expect((await athleteWatchList(db, V.marcus, { today: TODAY })).find((a) => a.athleteId === ctx.athletes.maya)).toMatchObject({ optedIn: true, isMinor: true });
    expect((await athleteWatchList(db, V.tess, { today: TODAY })).some((a) => a.athleteId === ctx.athletes.maya)).toBe(false);
    for (const k of FAMILY_AND_OUTSIDERS) await expect(athleteWatchList(db, V[k]), k).rejects.toThrow(AuthzError);
  });
});

describe("alumni", () => {
  it("owner, admin and operations manage alumni; coaches and families cannot", async () => {
    const raw = { firstName: "Brennick", lastName: "Oddfellow", sport: "Soccer", college: "Imaginary College", gradYear: "2024" };
    for (const k of ["marcus", "tess", ...FAMILY_AND_OUTSIDERS]) await expect(tx((t) => createAlumnus(t, V[k], raw)), k).rejects.toThrow(AuthzError);
    const a = await tx((t) => createAlumnus(t, V.erin, raw));
    expect(a).toMatchObject({ watch: false, fullNameOk: false, gradYear: 2024 });
    ctx.extra.nw = { brennick: a.id };
    // Watching needs a recorded basis.
    await expect(tx((t) => setAlumniWatch(t, V.erin, a.id, { watch: true, basis: "ok" }))).rejects.toThrow(UserError);
    await expect(tx((t) => setAlumniWatch(t, V.marcus, a.id, { watch: true, basis: "Public college roster" }))).rejects.toThrow(AuthzError);
    await expect(tx((t) => setAlumniWatch(t, V.otherOwner, a.id, { watch: true, basis: "Public college roster" }))).rejects.toThrow(AuthzError);
    const on = await tx((t) => setAlumniWatch(t, V.erin, a.id, { watch: true, basis: "Gave permission at alumni day" }, { today: TODAY, now: NOW }));
    expect(on).toMatchObject({ watch: true, watchBasis: "Gave permission at alumni day", watchSetBy: V.erin.userId });
    const [ev] = await db.select().from(newsWatchEvents).where(eq(newsWatchEvents.alumniId, a.id));
    expect(ev).toMatchObject({ action: "alumni_added", relationship: "staff", note: "Gave permission at alumni day" });
    // The database refuses a watched alumnus without a basis.
    await expect(db.update(alumni).set({ watchBasis: null }).where(eq(alumni.id, a.id))).rejects.toThrow();
    expect((await loadWatched(db, ctx.orgId)).map((p) => p.kind).sort()).toEqual(["alumni", "athlete"]);
  });

  it("a departing athlete is marked as alumni from the profile; a minor is never watched on staff's say-so", async () => {
    await expect(tx((t) => markAthleteAsAlumni(t, V.marcus, ctx.athletes.leo))).rejects.toThrow(AuthzError);
    const leo = await tx((t) => markAthleteAsAlumni(t, V.erin, ctx.athletes.leo, { college: "Fictional State University" }));
    expect(leo).toMatchObject({ athleteId: ctx.athletes.leo, college: "Fictional State University", watch: false, sport: "Football" });
    expect((await tx((t) => markAthleteAsAlumni(t, V.erin, ctx.athletes.leo))).id).toBe(leo.id); // once
    await expect(tx((t) => setAlumniWatch(t, V.erin, leo.id, { watch: true, basis: "Public college roster" }, { today: TODAY }))).rejects.toThrow(/under 18/);
    // Dana is an adult on file, so her alumni record can be watched with a basis.
    const dana = await tx((t) => markAthleteAsAlumni(t, V.rod, ctx.athletes.dana));
    await tx((t) => setAlumniWatch(t, V.rod, dana.id, { watch: true, basis: "Public college roster" }, { today: TODAY }));
    await tx((t) => setAlumniWatch(t, V.rod, dana.id, { watch: false }));
  });
});

describe("the nightly job", () => {
  const sourcesBy = async () => new Map((await db.select().from(newsSources).where(eq(newsSources.orgId, ctx.orgId))).map((s) => [s.name, s]));

  it("sources are owner and admin only, validated, and the sample defaults are created once", async () => {
    for (const k of ["erin", "marcus", ...FAMILY_AND_OUTSIDERS]) {
      await expect(tx((t) => addSource(t, V[k], { name: "X feed", kind: "rss", url: GAZETTE, minIntervalMinutes: 60 })), k).rejects.toThrow(AuthzError);
      await expect(listSources(db, V[k]), k).rejects.toThrow(AuthzError);
      await expect(tx((t) => saveNewsSettings(t, V[k], { enabled: "on", dailyRequestCap: 50, maxAgeDays: 30 })), k).rejects.toThrow(AuthzError);
    }
    const add = (raw: Record<string, unknown>) => tx((t) => addSource(t, V.rod, { minIntervalMinutes: 60, audience: "all", ...raw }));
    await expect(add({ name: "Plain http", kind: "rss", url: "http://gazette.example.com/feed" })).rejects.toThrow(/https/);
    await expect(add({ name: "Internal", kind: "rss", url: "https://localhost/feed" })).rejects.toThrow(/public web address/);
    await expect(add({ name: "No query", kind: "search", url: "https://search.example.net/rss", sites: "gazette.example.com" })).rejects.toThrow(/\{query\}/);
    await expect(add({ name: "No sites", kind: "search", url: SEARCH, sites: "" })).rejects.toThrow(/plain domains/);
    await expect(add({ name: "Too often", kind: "rss", url: GAZETTE, minIntervalMinutes: 5 })).rejects.toThrow();

    expect(await tx((t) => ensureDefaultSources(t, other.orgId))).toBe(DEFAULT_SOURCES.length);
    expect(await tx((t) => ensureDefaultSources(t, other.orgId))).toBe(0);
    const defaults = await listSources(db, V.otherOwner);
    expect(defaults.map((s) => s.kind).sort()).toEqual(["rss", "search", "search", "search"]);
    expect(defaults.flatMap((s) => s.sites).sort()).toEqual(["heraldtimesonline.com", "suncommercial.com", "tmnews.com"]);
    expect(defaults.every((s) => s.enabled && s.isDefault && s.url.startsWith("https://"))).toBe(true);

    await add({ name: "Sampleton Gazette (publisher feed)", kind: "rss", url: GAZETTE });
    await add({ name: "Imaginary College Athletics", kind: "rss", url: COLLEGE, audience: "alumni" });
    await add({ name: "Broken feed", kind: "rss", url: BROKEN });
    await add({ name: "Paywalled paper", kind: "rss", url: PAYWALLED });
    await add({ name: "Site that is down", kind: "rss", url: DOWN });
    await add({ name: "Sampleton Gazette (news search)", kind: "search", url: SEARCH, sites: "www.gazette.example.com" });
    await add({ name: "Switched off", kind: "rss", url: "https://off.example.com/feed", enabled: "on" });
    const off = (await sourcesBy()).get("Switched off")!;
    await tx((t) => setSourceEnabled(t, V.rod, off.id, false));
  });

  it("does nothing while News watch is off, and is registered as a nightly job with Run now", async () => {
    const f = fakeFetcher();
    expect(await runNewsWatch(db, ctx.orgId, { now: NOW, fetcher: f.fetch })).toEqual({ skipped: "News watch is switched off in Settings" });
    expect(f.calls).toEqual([]);
    expect(NIGHTLY_JOB_TYPES).toContain(NEWS_JOB_TYPE);
    expect(SCHEDULED_JOBS.find((j) => j.type === NEWS_JOB_TYPE)).toMatchObject({ label: "News watch", manual: true });
    // Run now goes through the real handler; switched off, it requests nothing.
    const res = await runScheduledJobNow(db, V.rod, NEWS_JOB_TYPE, NOW);
    expect(res).toHaveLength(1);
    expect(res[0].status).toBe("done");
    await expect(runScheduledJobNow(db, V.erin, NEWS_JOB_TYPE, NOW)).rejects.toThrow(AuthzError);
  });

  it("reads every enabled source, isolates the failing ones, and turns matches into suggested clips", async () => {
    await tx((t) => saveNewsSettings(t, V.rod, { enabled: "on", dailyRequestCap: 50, maxAgeDays: 30 }));
    const f = fakeFetcher();
    const r = await runNewsWatch(db, ctx.orgId, { now: NOW, fetcher: f.fetch });
    if ("skipped" in r) throw new Error(r.skipped);
    // Five feeds once each, then one search per watched person. The switched-off source is never requested.
    expect(f.calls.slice(0, 5).sort()).toEqual([BROKEN, COLLEGE, DOWN, GAZETTE, PAYWALLED].sort());
    expect(f.calls).toHaveLength(7);
    const searches = f.calls.slice(5).map((u) => decodeURIComponent(u));
    expect(searches.some((u) => u.includes('"Zyra Quillfeather" site:gazette.example.com'))).toBe(true);
    expect(searches.some((u) => u.includes('"Brennick Oddfellow" site:gazette.example.com'))).toBe(true);
    // Only feed addresses were requested: never an article page.
    expect(f.calls.some((u) => /article_|soccer-title|off\.example/.test(u))).toBe(false);

    expect(r).toMatchObject({ watched: 2, requests: 7, failed: 3, capReached: false, sourcesFetched: 3 });
    expect(r.errors.map((e) => e.id).sort()).toEqual(["Broken feed", "Paywalled paper", "Site that is down"]);
    const s = await sourcesBy();
    expect(s.get("Paywalled paper")).toMatchObject({ lastStatus: "error", consecutiveFailures: 1 });
    expect(s.get("Paywalled paper")!.lastResult).toMatch(/HTTP 402.*does not work around/);
    expect(s.get("Paywalled paper")!.backoffUntil!.getTime()).toBe(NOW.getTime() + 30 * 60_000);
    expect(s.get("Broken feed")!.lastResult).toMatch(/cut off or not valid XML/);
    expect(s.get("Site that is down")!.lastResult).toMatch(/Could not read the feed/);
    expect(s.get("Sampleton Gazette (publisher feed)")).toMatchObject({ lastStatus: "ok", consecutiveFailures: 0 });
    expect(s.get("Sampleton Gazette (publisher feed)")!.lastResult).toMatch(/7 headlines read, 4 new clips to review/);
    expect(s.get("Sampleton Gazette (news search)")!.lastResult).toMatch(/2 of 2 names searched, 1 new clip to review/);
    expect(s.get("Switched off")!.lastFetchedAt).toBeNull();

    const all = await clips(V.rod);
    const zyra = all.filter((c) => c.person === "athlete");
    // Not the hardware-store story (last name alone), not the 2012 story, not the road closure.
    expect(zyra.map((c) => c.headline).sort()).toEqual([
      "Fictional Falls honors its fall athletes",
      "Fictional Falls rolls into the sectional final",
      "Otherville teen Zyra Quillfeather arrested after crash, police say",
      "Zyra Quillfeather scores 22 as Fictional Falls tops Makebelieve Central",
      "Zyra Quillfeather sidelined with a knee injury",
    ]);
    expect(zyra.every((c) => c.status === "suggested" && c.athleteId === ctx.athletes.maya && c.watched)).toBe(true);
    const by = (part: string) => all.find((c) => c.headline.includes(part))!;
    expect(by("scores 22")).toMatchObject({ matchLevel: "likely", sourceName: "Sampleton Gazette", sensitiveNote: null, blockedTopic: null, shownAs: "Zyra Q." });
    expect(by("honors its fall")).toMatchObject({ matchLevel: "likely" });
    expect(by("sectional final")).toMatchObject({ matchLevel: "possible" });
    expect(by("sectional final").reasons.join(" ")).toMatch(/news search for this exact full name/);
    expect(by("knee injury")).toMatchObject({ blockedTopic: "health or injuries", sensitiveNote: "Mentions health or injuries" });
    expect(by("arrested").sensitiveNote).toMatch(/arrest/);
    expect(by("late goal")).toMatchObject({ person: "alumni", personName: "Brennick Oddfellow", shownAs: "Brennick O.", sourceName: "Imaginary College Athletics" });
    // The search copy of the first article did not make a second clip, and nothing unmatched was stored.
    const stored = await db.select().from(newsItems).where(eq(newsItems.orgId, ctx.orgId));
    expect(stored).toHaveLength(6);
    expect(stored.every((i) => (i.snippet ?? "").length <= 280 && !/third sentence|<|photo\.jpg/.test(`${i.headline}${i.snippet ?? ""}`))).toBe(true);
  });

  it("is idempotent: a second run the same night requests nothing, and the next day adds no clip twice", async () => {
    const before = (await clips(V.rod)).length;
    const f1 = fakeFetcher();
    const again = await runNewsWatch(db, ctx.orgId, { now: new Date(NOW.getTime() + 60_000), fetcher: f1.fetch });
    expect(f1.calls).toEqual([]);
    expect(again).toMatchObject({ requests: 0, newClips: 0, sourcesSkipped: 6 });
    const f2 = fakeFetcher();
    const tomorrow = await runNewsWatch(db, ctx.orgId, { now: new Date(NOW.getTime() + 86_400_000), fetcher: f2.fetch });
    expect(f2.calls.length).toBe(7);
    expect(tomorrow).toMatchObject({ newClips: 0, failed: 3 });
    expect((await clips(V.rod)).length).toBe(before);
    // A source that keeps failing waits longer each time.
    const paywalled = (await sourcesBy()).get("Paywalled paper")!;
    expect(paywalled.consecutiveFailures).toBe(2);
    expect(paywalled.backoffUntil!.getTime()).toBe(NOW.getTime() + 86_400_000 + 60 * 60_000);
  });

  it("respects the daily request cap across all sources", async () => {
    await tx((t) => saveNewsSettings(t, V.rod, { enabled: "on", dailyRequestCap: 2, maxAgeDays: 30 }));
    const f = fakeFetcher();
    const r = await runNewsWatch(db, ctx.orgId, { now: new Date(NOW.getTime() + 3 * 86_400_000), fetcher: f.fetch });
    expect(f.calls).toHaveLength(2);
    expect(r).toMatchObject({ requests: 2, capReached: true });
    await tx((t) => saveNewsSettings(t, V.rod, { enabled: "on", dailyRequestCap: 100, maxAgeDays: 30 }));
  });
});

describe("clips: triage, approval and display", () => {
  const find = async (part: string, v: Viewer = V.rod, statuses?: NewsClipStatus[]) => (await clips(v, statuses)).find((c) => c.headline.includes(part));
  const feed = (v: Viewer = V.chris, onlyNews = false) => winsFeed(db, v, { today: TODAY, onlyNews });
  const board = () => tx((t) => boardPayload(t, ctx.orgId, { now: NOW }));

  it("clips are staff only; a coach sees clips about their own athletes and alumni clips", async () => {
    for (const k of [...FAMILY_AND_OUTSIDERS]) await expect(clips(V[k]), k).rejects.toThrow(AuthzError);
    expect(await clips(V.otherOwner)).toEqual([]);
    expect((await clips(V.marcus)).filter((c) => c.person === "athlete")).toHaveLength(5);
    const tess = await clips(V.tess);
    expect(tess.map((c) => c.person)).toEqual(["alumni"]);
    const c = (await find("scores 22"))!;
    await expect(tx((t) => triageClip(t, V.tess, c.id, "ours"))).rejects.toThrow(AuthzError);
    await expect(tx((t) => triageClip(t, V.otherOwner, c.id, "ours"))).rejects.toThrow(AuthzError);
    for (const k of FAMILY_AND_OUTSIDERS) await expect(tx((t) => triageClip(t, V[k], c.id, "ours")), k).rejects.toThrow(AuthzError);
    // The old lead actions cannot touch a news clip, and the staff lead list does not contain them.
    await expect(tx((t) => convertLead(t, V.rod, c.id, { athleteId: ctx.athletes.maya, occurredOn: TODAY, sport: "Volleyball", type: "placing", headline: "Sneaks past approval" }, { today: TODAY }))).rejects.toThrow(AuthzError);
    await expect(tx((t) => dismissLead(t, V.rod, c.id))).rejects.toThrow(AuthzError);
    expect(await listLeads(db, V.rod)).toEqual([]);
    await expect(tx((t) => submitWin(t, V.rod, { athleteId: ctx.athletes.maya, occurredOn: TODAY, sport: "Volleyball", type: "in_the_news", headline: "Typed in by hand" }, { today: TODAY }))).rejects.toThrow(UserError);
  });

  it("'our athlete' is triage only: it publishes nothing, and by default only owner and admin can approve", async () => {
    const c = (await find("scores 22"))!;
    expect(await tx((t) => triageClip(t, V.marcus, c.id, "ours", { now: NOW }))).toBe("confirmed");
    expect((await find("scores 22"))!.status).toBe("confirmed");
    expect(await feed()).toEqual([]);
    expect(await feed(V.alex)).toEqual([]);
    expect((await board()).panels.some((p) => p.key === "wins")).toBe(false);
    expect(await db.select().from(wins).where(eq(wins.orgId, ctx.orgId))).toHaveLength(0);

    expect(can(V.rod, "news.approve")).toBe(true);
    for (const k of ["erin", "marcus", "tess", ...FAMILY_AND_OUTSIDERS]) {
      expect(await canApproveNews(db, V[k]), k).toBe(false);
      await expect(tx((t) => approveClip(t, V[k], c.id, { today: TODAY })), k).rejects.toThrow(AuthzError);
      await expect(tx((t) => approveClips(t, V[k], [c.id], { today: TODAY })), k).rejects.toThrow(AuthzError);
      await expect(tx((t) => rejectClip(t, V[k], c.id)), k).rejects.toThrow(AuthzError);
    }
    await expect(tx((t) => approveClip(t, V.otherOwner, c.id, { today: TODAY }))).rejects.toThrow(AuthzError);
    expect(await pendingClipCount(db, V.rod)).toEqual({ canApprove: true, pending: 6 });
    for (const k of ["erin", "marcus", "tess", "alex", "kiosk"]) expect(await pendingClipCount(db, V[k]), k).toEqual({ canApprove: false, pending: 0 });
    // The database itself refuses an approved clip with nobody recorded as approving it.
    await expect(db.update(winLeads).set({ newsStatus: "approved" }).where(eq(winLeads.id, c.id))).rejects.toThrow();
  });

  it("the owner approves: it becomes an 'In the news' win shown with headline, publication, date and link, under the display name", async () => {
    const c = (await find("scores 22"))!;
    const { winId } = await tx((t) => approveClip(t, V.rod, c.id, { today: TODAY, now: NOW }));
    const [win] = await db.select().from(wins).where(eq(wins.id, winId!));
    expect(win).toMatchObject({ type: "in_the_news", status: "approved", approvedBy: V.rod.userId, headline: "Zyra scores 22 as Fictional Falls tops Makebelieve Central", newsSource: "Sampleton Gazette", occurredOn: "2026-02-28", showInApp: true, showOnTv: true, marketingConsent: "none", athleteId: ctx.athletes.maya });
    const items = await feed();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "Zyra Q.", typeLabel: "In the news", headline: "Zyra scores 22 as Fictional Falls tops Makebelieve Central", when: "Feb 28", mine: false, photo: false });
    expect(items[0].news).toEqual({ source: "Sampleton Gazette", url: expect.stringContaining("https://gazette.example.com/sports/article_1.html") });
    // Never the article's text or image, never the last name, never an athlete id.
    const out = JSON.stringify(items);
    expect(out).not.toMatch(/Quillfeather|four sets|first home win|photo\.jpg/);
    expect(out).not.toContain(ctx.athletes.maya);
    expect(await feed(V.chris, true)).toHaveLength(1);
    // The family sees it under their own wins, and can still switch levels off or withdraw it.
    expect((await winsForAthlete(db, V.alex, ctx.athletes.maya, { today: TODAY })).wins.map((w) => w.typeLabel)).toEqual(["In the news"]);
    // TV: headline, publication and display name only. No link.
    const panel = (await board()).panels.find((p) => p.key === "wins");
    expect(panel && "items" in panel ? panel.items : []).toEqual([{ name: "Zyra Q.", headline: "Zyra scores 22 as Fictional Falls tops Makebelieve Central", label: "In the news", sport: "Sampleton Gazette", when: "Feb 28" }]);
    expect(JSON.stringify(panel)).not.toMatch(/https?:|Quillfeather/);
    // Audited, with who approved.
    const audit = await db.select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, "newswatch.clip.approve")));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: V.rod.userId, entityId: c.id });
    await expect(tx((t) => approveClip(t, V.rod, c.id, { today: TODAY }))).rejects.toThrow(/already handled/);
  });

  it("approval never reaches public marketing: that still needs the family's own consent", async () => {
    const q = await tx((t) => marketingQueue(t, V.erin, { today: TODAY }));
    expect(q.ready).toEqual([]);
    const [win] = await db.select().from(wins).where(and(eq(wins.orgId, ctx.orgId), eq(wins.type, "in_the_news")));
    expect(win.marketingConsent).toBe("none");
    expect(win.marketingConsentAt).toBeNull();
    // Nothing was queued to be sent or posted anywhere.
    const jobs = await db.execute(sql`select type from jobs where org_id = ${ctx.orgId} and (type like 'messaging%' or type like 'notify%' or type like 'campaign%')`);
    expect(jobs.rows).toEqual([]);
  });

  it("a health headline can never be approved; a warning-label headline needs the approver's own judgment", async () => {
    const injury = (await find("knee injury"))!;
    await expect(tx((t) => approveClip(t, V.rod, injury.id, { today: TODAY }))).rejects.toThrow(/health or injuries[\s\S]*cannot be approved/);
    const arrest = (await find("arrested"))!;
    expect(arrest.sensitiveNote).toBeTruthy();
    expect(arrest.blockedTopic).toBeNull();
    // Bulk approve: the blocked one is reported and skipped, the other goes through.
    const honors = (await find("honors its fall"))!;
    const res = await tx((t) => approveClips(t, V.rod, [injury.id, honors.id, "not-an-id"], { today: TODAY, now: NOW }));
    expect(res.approved).toBe(1);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toMatchObject({ id: injury.id });
    expect((await find("knee injury"))!.status).toBe("suggested");
    expect(await feed()).toHaveLength(2);
    await tx((t) => rejectClip(t, V.rod, injury.id));
    expect(await find("knee injury")).toBeUndefined();
    await expect(tx((t) => approveClips(t, V.rod, [], { today: TODAY }))).rejects.toThrow(UserError);
  });

  it("'not our athlete' teaches the matcher: the article and its pattern are not suggested again", async () => {
    const arrest = (await find("arrested"))!;
    expect(await tx((t) => triageClip(t, V.marcus, arrest.id, "not_ours", { term: "Otherville" }))).toBe("not_ours");
    const [neg] = await db.select().from(newsNegatives).where(eq(newsNegatives.orgId, ctx.orgId));
    expect(neg).toMatchObject({ athleteId: ctx.athletes.maya, publication: "sampleton gazette", term: "Otherville", createdBy: V.marcus.userId });
    const again = await ingest([
      item("article_6b", "Otherville teen Zyra Quillfeather arrested after crash, police say"), // same article, new link
      item("otherville-2", "Zyra Quillfeather of Otherville wins the spelling bee"), // the marked word
      item("new-one", "Zyra Quillfeather signs with Imaginary College"), // a real new story still comes through
    ]);
    expect(again.newClips).toBe(1);
    const fresh = (await find("signs with"))!;
    // One earlier "not ours" from this publication: 60 + 0 context - 15.
    expect(fresh.matchLevel).toBe("possible");
    expect(fresh.reasons.join(" ")).toMatch(/not our athlete.*1 time/);
    await tx((t) => triageClip(t, V.erin, fresh.id, "ignore"));
  });

  it("the owner can let operations and coaches approve; a coach still only for their own athletes", async () => {
    await tx((t) => saveNewsSettings(t, V.rod, { enabled: "on", dailyRequestCap: 100, maxAgeDays: 30, operationsMayApprove: "on", coachesMayApprove: "on" }));
    for (const k of ["erin", "marcus", "tess"]) expect(await canApproveNews(db, V[k]), k).toBe(true);
    for (const k of FAMILY_AND_OUTSIDERS) expect(await canApproveNews(db, V[k]), k).toBe(false);
    const sectional = (await find("sectional final"))!;
    await expect(tx((t) => approveClip(t, V.tess, sectional.id, { today: TODAY }))).rejects.toThrow(AuthzError); // not her athlete
    expect(await pendingClipCount(db, V.tess)).toEqual({ canApprove: true, pending: 1 }); // the alumni clip only
    await tx((t) => approveClip(t, V.marcus, sectional.id, { today: TODAY, now: NOW }));
    expect(await feed()).toHaveLength(3);
    await tx((t) => saveNewsSettings(t, V.rod, { enabled: "on", dailyRequestCap: 100, maxAgeDays: 30 }));
    expect(await canApproveNews(db, V.marcus)).toBe(false);
    // One-step take down, approvers only.
    await expect(tx((t) => removeClip(t, V.marcus, sectional.id))).rejects.toThrow(AuthzError);
    await tx((t) => removeClip(t, V.rod, sectional.id));
    expect(await feed()).toHaveLength(2);
  });

  it("alumni clips: nothing shows before approval; then first name and last initial unless the full name was agreed", async () => {
    const alumniId = ctx.extra.nw.brennick;
    expect(await alumniNewsFeed(db, V.chris, { now: NOW })).toEqual([]);
    const c = (await find("late goal"))!;
    await tx((t) => triageClip(t, V.tess, c.id, "ours"));
    expect(await alumniNewsFeed(db, V.chris, { now: NOW })).toEqual([]);
    await expect(tx((t) => approveClip(t, V.tess, c.id, { today: TODAY }))).rejects.toThrow(AuthzError);
    expect((await tx((t) => approveClip(t, V.rod, c.id, { today: TODAY, now: NOW }))).winId).toBeNull();
    const shown = await alumniNewsFeed(db, V.chris, { now: NOW });
    expect(shown).toEqual([{ id: c.id, name: "Brennick O.", detail: "Soccer · Imaginary College", headline: "Brennick O.'s late goal lifts Imaginary College & clinches the title", source: "Imaginary College Athletics", when: "Feb 28", url: "https://athletics.example.org/news/2026/3/1/soccer-title.aspx" }]);
    expect(JSON.stringify(shown)).not.toMatch(/Oddfellow|won 2-1/);
    await expect(alumniNewsFeed(db, V.kiosk)).rejects.toThrow(AuthzError);
    expect(await alumniNewsFeed(db, V.otherOwner, { now: NOW })).toEqual([]);
    const tv = (await board()).panels.find((p) => p.key === "wins");
    expect(JSON.stringify(tv)).toContain("Alumni in the news");
    expect(JSON.stringify(tv)).not.toMatch(/https?:|Oddfellow/);
    await db.update(alumni).set({ fullNameOk: true }).where(eq(alumni.id, alumniId));
    expect((await alumniNewsFeed(db, V.alex, { now: NOW }))[0]).toMatchObject({ name: "Brennick Oddfellow", headline: "Brennick Oddfellow's late goal lifts Imaginary College & clinches the title" });
    // One step removes them from the watch list: the clip disappears and matching stops.
    await tx((t) => setAlumniWatch(t, V.erin, alumniId, { watch: false }));
    expect(await alumniNewsFeed(db, V.alex, { now: NOW })).toEqual([]);
    expect((await loadWatched(db, ctx.orgId)).map((p) => p.kind)).toEqual(["athlete"]);
    expect((await find("late goal", V.rod, ["removed"]))?.status).toBe("removed");
  });

  it("revoking the opt-in stops matching, hides pending clips and takes approved ones down", async () => {
    await ingest([item("pending-1", "Zyra Quillfeather named player of the week")]);
    expect(await find("player of the week")).toBeTruthy();
    expect(await feed()).toHaveLength(2);
    // Any active guardian may switch it off, also one who could not switch it on.
    await tx((t) => setNewsOptIn(t, V.jordan, ctx.athletes.maya, false, { today: TODAY, now: NOW }));
    expect((await clips(V.rod)).filter((c) => c.person === "athlete")).toEqual([]);
    expect((await find("player of the week", V.rod, ["withdrawn"]))?.status).toBe("withdrawn");
    expect(await feed()).toEqual([]);
    expect((await board()).panels.some((p) => p.key === "wins")).toBe(false);
    expect(await loadWatched(db, ctx.orgId)).toEqual([]);
    expect((await ingest([item("after-revoke", "Zyra Quillfeather wins again")])).newClips).toBe(0);
    const f = fakeFetcher();
    expect(await runNewsWatch(db, ctx.orgId, { now: new Date(NOW.getTime() + 9 * 86_400_000), fetcher: f.fetch })).toEqual({ skipped: "nobody is on the watch list yet" });
    expect(f.calls).toEqual([]);
    const events = await db.select().from(newsWatchEvents).where(eq(newsWatchEvents.athleteId, ctx.athletes.maya)).orderBy(newsWatchEvents.createdAt);
    expect(events.at(-1)).toMatchObject({ action: "revoked", relationship: "guardian", actorUserId: V.jordan.userId });
    // Staff asking again is refused: the family said no.
    await expect(tx((t) => requestNewsOptIn(t, V.marcus, ctx.athletes.maya))).rejects.toThrow(/already said no/);
  });

  it("two people with the same name at the gym: flagged, and never better than possible on the name alone", async () => {
    await tx((t) => setNewsOptIn(t, V.alex, ctx.athletes.maya, true, { today: TODAY }));
    await tx((t) => createAlumnus(t, V.erin, { firstName: "Zyra", lastName: "Quillfeather", college: "Elsewhere University" }));
    const watched = await loadWatched(db, ctx.orgId);
    expect(watched.find((p) => p.id === ctx.athletes.maya)?.sameNameInOrg).toBe(true);
    await db.update(athletes).set({ school: null, sport: null }).where(eq(athletes.id, ctx.athletes.maya));
    await tx((t) => setWatchTerms(t, V.marcus, ctx.athletes.maya, { school: "", sport: "", town: "" }));
    await db.delete(newsNegatives).where(eq(newsNegatives.orgId, ctx.orgId));
    expect((await ingest([item("same-name", "Zyra Quillfeather breaks the school record")])).newClips).toBe(1);
    const c = (await find("school record"))!;
    expect(c.matchLevel).toBe("possible");
    expect(c.reasons.join(" ")).toMatch(/same name/);
  });
  it("a clip added by hand follows the same rules: watched people only, staff in scope, shown to nobody until approved", async () => {
    const raw = { person: `athlete:${ctx.athletes.maya}`, headline: "Zyra Quillfeather leads the comeback", sourceName: "Sampleton Gazette", link: "https://gazette.example.com/x/by-hand", publishedOn: "2026-03-01" };
    for (const k of FAMILY_AND_OUTSIDERS) await expect(tx((t) => addManualClip(t, V[k], raw, { now: NOW })), k).rejects.toThrow(AuthzError);
    await expect(tx((t) => addManualClip(t, V.tess, raw, { now: NOW }))).rejects.toThrow(AuthzError);
    await expect(tx((t) => addManualClip(t, V.otherOwner, raw, { now: NOW }))).rejects.toThrow(AuthzError);
    await expect(tx((t) => addManualClip(t, V.marcus, { ...raw, person: `athlete:${ctx.athletes.leo}` }, { now: NOW }))).rejects.toThrow(/not on for this athlete/);
    await expect(tx((t) => addManualClip(t, V.marcus, { ...raw, link: "http://gazette.example.com/x" }, { now: NOW }))).rejects.toThrow(/https/);
    const before = (await feed()).length;
    const { clipId } = await tx((t) => addManualClip(t, V.marcus, raw, { now: NOW }));
    await expect(tx((t) => addManualClip(t, V.marcus, raw, { now: NOW }))).rejects.toThrow(/already in the list/);
    const c = (await clips(V.rod)).find((x) => x.id === clipId)!;
    expect(c).toMatchObject({ status: "suggested", person: "athlete", sourceName: "Sampleton Gazette" });
    expect(c.reasons[0]).toMatch(/Added by hand by/);
    expect((await feed()).length).toBe(before);
    await expect(tx((t) => approveClip(t, V.marcus, clipId, { today: TODAY }))).rejects.toThrow(AuthzError);
    await tx((t) => approveClip(t, V.rod, clipId, { today: TODAY, now: NOW }));
    expect((await feed()).map((i) => i.headline)).toContain("Zyra leads the comeback");
  });
});
