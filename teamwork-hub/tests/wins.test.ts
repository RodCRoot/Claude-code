import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditEvents, communityDisplayPrefs, guardianships, organizations, people, winConsentEvents, winMarketingPosts, wins, xpEvents } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { addEvent, createSeason } from "@/lib/anywhere/season";
import { AuthzError, type Viewer } from "@/lib/authz/policy";
import { boardPayload } from "@/lib/community/board";
import { setDisplayMode } from "@/lib/community/display-name";
import { communitySettingsOf, saveCommunitySettings } from "@/lib/community/settings";
import { DEFAULT_XP } from "@/lib/engagement/settings";
import { setObjectStoreForTests, type ObjectStore } from "@/lib/storage";
import { addDaysYmd, localToUtc } from "@/lib/time";
import { winsAccess } from "@/lib/wins/access";
import { addTeamEvents, competingThisWeekFamily, competingThisWeekStaff, createTeam, listTeams, setTeamAthletes, staffCalendar } from "@/lib/wins/calendar";
import { answerMarketingConsent, consentHistory, requestMarketingConsent, revokeMarketingConsent } from "@/lib/wins/consent";
import { addLead, convertLead, dismissLead, listLeads } from "@/lib/wins/leads";
import { markPosted, marketingQueue, markTakenDown } from "@/lib/wins/marketing";
import { preparePhoto } from "@/lib/wins/photo";
import { bannedTopic, captionDrafts, cleanSourceUrl, MARKETING_POLICY_VERSION, mentionsLastName, parseScheduleLines } from "@/lib/wins/shared";
import { answerDraft, approvedWinsBetween, approveWin, editWin, recentWinsForOutreach, removeWin, reviewQueue, setSharing, submitWin, winPhotoFor, winsFeed, winsForAthlete } from "@/lib/wins/wins";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

type Ctx = Awaited<ReturnType<typeof seedOrg>>;
/** A Monday. */
const TODAY = "2026-03-02";
const NOW = localToUtc(TODAY, "12:00");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const db = testDb();
let ctx: Ctx;
let other: Ctx;
const V: Record<string, Viewer> = {};
const ALL = ["rod", "erin", "marcus", "tess", "alex", "jordan", "chris", "sam", "casey", "dana", "maya", "kiosk"];

class MemoryStore implements ObjectStore {
  files = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.files.set(key, bytes);
  }
  async get(key: string) {
    const b = this.files.get(key);
    if (!b) throw new Error("missing");
    return b;
  }
  async delete(key: string) {
    this.files.delete(key);
  }
}

beforeAll(async () => {
  // Core identities only: every test builds the wins, teams and seasons it needs.
  ctx = await seedOrg(TODAY, { modules: [] });
  other = await seedOrg(TODAY, { modules: [] });
  for (const k of ALL) V[k] = await viewerFor(ctx, k);
  V.otherOwner = await viewerFor(other, "rod");
  // Names that cannot collide with anything else in a payload.
  await db.update(people).set({ firstName: "Zyxeli", lastName: "Qwvhidden" }).where(eq(people.id, ctx.people.eli_parker));
  await db.update(people).set({ lastName: "Parkerson" }).where(eq(people.id, ctx.people.maya_parker));
  // Eli is hidden by his guardian, through the real path.
  await db.transaction((tx) => setDisplayMode(tx, V.alex, { athleteId: ctx.athletes.eli, mode: "hidden" }, TODAY));
  setObjectStoreForTests(new MemoryStore());
});
afterAll(async () => {
  setObjectStoreForTests(null);
  await closeTestDb();
});

let n = 0;
const base = (key: string, extra: Record<string, unknown> = {}) => ({ athleteId: ctx.athletes[key], occurredOn: addDaysYmd(TODAY, -2), sport: "Volleyball", type: "placing", headline: `Won the sample invitational ${++n}`, ...extra });
const submit = (v: Viewer, key: string, extra: Record<string, unknown> = {}) => db.transaction((tx) => submitWin(tx, v, base(key, extra), { today: TODAY }));
const approve = (v: Viewer, winId: string, extra: Record<string, unknown> = {}) => db.transaction((tx) => approveWin(tx, v, { winId, ...extra }, { today: TODAY, now: NOW }));
/** Submitted by the family and approved by a coach in scope. */
async function approved(key: string, by: Viewer, coach: Viewer, extra: Record<string, unknown> = {}) {
  const w = await submit(by, key, extra);
  return approve(coach, w.id);
}
const grant = (v: Viewer, winId: string) => db.transaction((tx) => answerMarketingConsent(tx, v, winId, "grant", { today: TODAY }));
const audits = (action: string, entityId: string) => db.select().from(auditEvents).where(and(eq(auditEvents.orgId, ctx.orgId), eq(auditEvents.action, action), eq(auditEvents.entityId, entityId)));
const board = () => db.transaction((tx) => boardPayload(tx, ctx.orgId, { now: NOW }));
const feed = (v: Viewer) => db.transaction((tx) => winsFeed(tx, v, { today: TODAY }));
const queue = (v: Viewer = V.erin) => db.transaction((tx) => marketingQueue(tx, v, { today: TODAY }));
const denied = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(AuthzError);
const refused = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(UserError);

describe("pure rules", () => {
  it("blocks health, injury, body-weight and grades topics, and lets ordinary sports wording through", () => {
    for (const s of ["Back from ACL surgery and scored twice", "Returned after a concussion", "Made weight for the 132 lb class", "Lost 10 pounds and ran a PR", "Made the honor roll and the team", "3.9 GPA scholar athlete", "Academic all-state", "Cleared to play after rehab"]) expect(bannedTopic(s), s).not.toBeNull();
    for (const s of ["Won the 8th grade city title", "New squat PR of 225 lb in the weight room", "Named all-conference", "Committed to Fictional State", "Hit a walk-off double", "Voted captain"]) expect(bannedTopic(s), s).toBeNull();
  });
  it("finds a last name as a whole word only", () => {
    expect(mentionsLastName("Maya Parkerson made the team", "Parkerson")).toBe(true);
    expect(mentionsLastName("maya parkerson's big day", "Parkerson")).toBe(true);
    expect(mentionsLastName("Cole scored", "Co")).toBe(false);
    expect(mentionsLastName("Won at the Kimball Classic", "Kim")).toBe(false);
  });
  it("accepts https links only and never credentials", () => {
    expect(cleanSourceUrl("https://news.example.test/a").url).toBe("https://news.example.test/a");
    expect(cleanSourceUrl("").url).toBeNull();
    for (const bad of ["http://news.example.test/a", "javascript:alert(1)", "https://user:pw@example.test/", "not a link", "https://localhost"]) expect(cleanSourceUrl(bad).error, bad).toBeTruthy();
  });
  it("caption drafts use the display name only, with no em dashes", () => {
    const drafts = captionDrafts({ displayName: "Maya P.", headline: "Named all-conference.", type: "selection", sport: "Volleyball", orgName: "Teamwork Demo" });
    expect(drafts).toHaveLength(3);
    for (const d of drafts) {
      expect(d.text).toContain("Maya P.");
      expect(d.text).toContain("Named all-conference");
      expect(d.text).not.toMatch(/—|Parkerson/);
    }
  });
  it("parses pasted schedule lines and reports bad ones by line number", () => {
    const ok = parseScheduleLines("2026-03-03, 19:00, vs Makebelieve Central, Home\n2026-03-07\n2026-03-09, Pretend Prep");
    expect(ok.errors).toEqual([]);
    expect(ok.rows).toEqual([
      { eventDate: "2026-03-03", startTimeLocal: "19:00", opponent: "Makebelieve Central", location: "Home" },
      { eventDate: "2026-03-07", startTimeLocal: null, opponent: null, location: null },
      { eventDate: "2026-03-09", startTimeLocal: null, opponent: "Pretend Prep", location: null },
    ]);
    expect(parseScheduleLines("March 3\n2026-02-30\n2026-03-03, 25:00").errors).toHaveLength(3);
  });
  it("strips EXIF from a JPEG and text chunks from a PNG, and refuses other files", () => {
    const exif = [0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x47, 0x50];
    const app0 = [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46];
    const jpeg = new Uint8Array([0xff, 0xd8, ...app0, ...exif, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
    const out = preparePhoto(jpeg);
    expect(out.error).toBeNull();
    expect(Buffer.from(out.photo!.bytes).includes(Buffer.from("Exif"))).toBe(false);
    expect([...out.photo!.bytes]).toEqual([0xff, 0xd8, ...app0, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);
    const chunk = (type: string, data: number[]) => [0, 0, 0, data.length, ...Buffer.from(type), ...data, 0, 0, 0, 0];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [1, 2]), ...chunk("tEXt", [...Buffer.from("GPS 39.1")]), ...chunk("eXIf", [9, 9]), ...chunk("IDAT", [7]), ...chunk("IEND", [])]);
    const p = preparePhoto(png);
    expect(p.photo!.mimeType).toBe("image/png");
    expect(Buffer.from(p.photo!.bytes).includes(Buffer.from("GPS"))).toBe(false);
    expect(Buffer.from(p.photo!.bytes).includes(Buffer.from("eXIf"))).toBe(false);
    expect(Buffer.from(p.photo!.bytes).includes(Buffer.from("IDAT"))).toBe(true);
    expect(preparePhoto(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39])).error).toMatch(/JPEG or PNG/);
    expect(preparePhoto(new Uint8Array(6 * 1024 * 1024)).error).toMatch(/5 MB/);
  });
});

describe("who can submit a win (every demo role)", () => {
  it("staff in scope, the athlete, and guardians who can act for the athlete", async () => {
    const yes: [string, string][] = [["rod", "maya"], ["erin", "maya"], ["marcus", "maya"], ["marcus", "dana"], ["tess", "eli"], ["alex", "maya"], ["alex", "eli"], ["jordan", "maya"], ["chris", "ava"], ["sam", "leo"], ["dana", "dana"], ["maya", "maya"]];
    for (const [who, key] of yes) {
      const w = await submit(V[who], key);
      expect(w.status, `${who} -> ${key}`).toBe("pending");
      expect(w.submittedAs).toBe(["rod", "erin", "marcus", "tess"].includes(who) ? "staff" : who === "dana" || who === "maya" ? "athlete" : "guardian");
      expect(w.marketingConsent).toBe("none");
      expect((await audits("wins.submit", w.id)).length).toBe(1);
    }
  });
  it("nobody else: coaches outside their roster, unrelated families, a guardian who cannot book, the kiosk, another organization", async () => {
    const no: [string, string][] = [["marcus", "eli"], ["tess", "maya"], ["tess", "dana"], ["chris", "maya"], ["alex", "ava"], ["alex", "leo"], ["sam", "maya"], ["casey", "leo"], ["dana", "maya"], ["maya", "eli"], ["maya", "dana"], ["kiosk", "maya"], ["otherOwner", "maya"]];
    for (const [who, key] of no) await denied(submit(V[who], key));
  });
  it("Jordan (no health access) can submit: health access is irrelevant. Casey (cannot book) sees Leo's wins but cannot add one", async () => {
    const j = await db.transaction((tx) => winsAccess(tx, V.jordan, ctx.athletes.maya, { today: TODAY }));
    expect(j).toMatchObject({ canSee: true, canSubmit: true, canSetSharing: true, canConsent: true, canWithdraw: true });
    const c = await db.transaction((tx) => winsAccess(tx, V.casey, ctx.athletes.leo, { today: TODAY }));
    expect(c).toMatchObject({ canSee: true, canSubmit: false, canSetSharing: false, canConsent: true, canWithdraw: true });
    const stranger = await db.transaction((tx) => winsAccess(tx, V.chris, ctx.athletes.maya, { today: TODAY }));
    expect(stranger).toMatchObject({ canSee: false, canSubmit: false, canConsent: false, canWithdraw: false });
    await denied(db.transaction((tx) => winsForAthlete(tx, V.chris, ctx.athletes.maya)));
    await denied(db.transaction((tx) => winsForAthlete(tx, V.kiosk, ctx.athletes.maya)));
    expect(await db.transaction((tx) => winsAccess(tx, V.otherOwner, ctx.athletes.maya))).toBeNull();
  });
  it("refuses health, body weight, grades, a last name, an em dash, a future date and a non-https link", async () => {
    await refused(submit(V.alex, "maya", { headline: "Back from knee surgery and won" }));
    await refused(submit(V.alex, "maya", { headline: "Won the title", detail: "Made weight at the weigh-in" }));
    await refused(submit(V.alex, "maya", { headline: "Honor roll and all-conference" }));
    await refused(submit(V.alex, "maya", { headline: "Maya Parkerson named all-conference" }));
    await refused(submit(V.marcus, "maya", { headline: "Great week — two wins" }));
    await refused(submit(V.alex, "maya", { occurredOn: addDaysYmd(TODAY, 1) }));
    await refused(submit(V.alex, "maya", { sourceUrl: "http://news.example.test/a" }));
    await refused(submit(V.alex, "maya", { type: "grades" }).catch((e) => Promise.reject(e.name === "ZodError" ? new UserError("bad") : e)));
    const ok = await submit(V.alex, "maya", { sourceUrl: "https://news.example.test/a", detail: "A short detail." });
    expect(ok.sourceUrl).toBe("https://news.example.test/a");
  });
});

describe("approval flow", () => {
  it("a win is shown nowhere until a staff member in scope approves it; approval is audited and awards XP once", async () => {
    const w = await submit(V.alex, "maya", { headline: "Unapproved marker Quokka" });
    expect(JSON.stringify(await board())).not.toContain("Quokka");
    expect(JSON.stringify(await feed(V.chris))).not.toContain("Quokka");
    expect(JSON.stringify(await queue())).not.toContain("Quokka");
    // The family and staff in scope do see it, as pending.
    expect((await db.transaction((tx) => winsForAthlete(tx, V.alex, ctx.athletes.maya))).wins.find((x) => x.id === w.id)?.status).toBe("pending");
    expect((await db.transaction((tx) => reviewQueue(tx, V.marcus))).some((x) => x.id === w.id)).toBe(true);
    expect((await db.transaction((tx) => reviewQueue(tx, V.tess))).some((x) => x.id === w.id)).toBe(false);

    for (const who of ["tess", "alex", "maya", "chris", "kiosk", "otherOwner"]) await denied(approve(V[who], w.id));
    const a = await approve(V.marcus, w.id, { headline: "Approved marker Quokka, edited by staff" });
    expect(a).toMatchObject({ status: "approved", approvedBy: V.marcus.userId, headline: "Approved marker Quokka, edited by staff" });
    const [log] = await audits("wins.approve", w.id);
    expect(log.actorUserId).toBe(V.marcus.userId);
    expect(log.before).toMatchObject({ status: "pending", headline: "Unapproved marker Quokka" });
    expect(log.after).toMatchObject({ status: "approved", headline: "Approved marker Quokka, edited by staff" });
    const xp = await db.select().from(xpEvents).where(and(eq(xpEvents.orgId, ctx.orgId), eq(xpEvents.idempotencyKey, `win:${w.id}`)));
    expect(xp).toHaveLength(1);
    expect(xp[0]).toMatchObject({ kind: "win_approved", points: DEFAULT_XP.win_approved, athleteId: ctx.athletes.maya });
    await refused(approve(V.marcus, w.id));
    expect(JSON.stringify(await feed(V.chris))).toContain("Quokka");
    expect(JSON.stringify(await board())).toContain("Quokka");
  });
  it("staff cannot approve wording that breaks the rules, and edits after approval are audited", async () => {
    const w = await submit(V.sam, "leo");
    await refused(approve(V.marcus, w.id, { headline: "Leo Rivera committed" }));
    await refused(approve(V.marcus, w.id, { headline: "Back from injury" }));
    await approve(V.marcus, w.id);
    await denied(db.transaction((tx) => editWin(tx, V.sam, { winId: w.id, headline: "Family rewrite" })));
    await denied(db.transaction((tx) => editWin(tx, V.tess, { winId: w.id, headline: "Other coach rewrite" })));
    const e = await db.transaction((tx) => editWin(tx, V.erin, { winId: w.id, headline: "Committed to Fictional State (sample)" }));
    expect(e.headline).toBe("Committed to Fictional State (sample)");
    expect((await audits("wins.edit", w.id))[0].before).toMatchObject({ headline: w.headline });
    // Once the family consents to public use of that wording, staff cannot change it.
    await grant(V.sam, w.id);
    await refused(db.transaction((tx) => editWin(tx, V.erin, { winId: w.id, headline: "Different wording" })));
  });
  it("staff remove with a reason; the family can withdraw; both are audited and the win disappears everywhere", async () => {
    const a = await approved("maya", V.alex, V.marcus, { headline: "Removable marker Wombat" });
    expect(JSON.stringify(await feed(V.chris))).toContain("Wombat");
    await refused(db.transaction((tx) => removeWin(tx, V.marcus, a.id, { today: TODAY })));
    await denied(db.transaction((tx) => removeWin(tx, V.tess, a.id, { reason: "x", today: TODAY })));
    await denied(db.transaction((tx) => removeWin(tx, V.chris, a.id, { today: TODAY })));
    const r = await db.transaction((tx) => removeWin(tx, V.marcus, a.id, { reason: "Family asked at the desk", today: TODAY }));
    expect(r).toMatchObject({ status: "removed", removedBy: V.marcus.userId, removedReason: "Family asked at the desk" });
    expect((await audits("wins.remove", a.id)).length).toBe(1);
    expect(JSON.stringify(await feed(V.chris))).not.toContain("Wombat");
    expect(JSON.stringify(await board())).not.toContain("Wombat");
    expect((await db.transaction((tx) => winsForAthlete(tx, V.alex, ctx.athletes.maya))).wins.some((x) => x.id === a.id)).toBe(false);

    const b = await approved("maya", V.alex, V.marcus, { headline: "Withdrawn marker Numbat" });
    await db.transaction((tx) => removeWin(tx, V.jordan, b.id, { today: TODAY }));
    expect((await audits("wins.withdraw", b.id)).length).toBe(1);
    expect(JSON.stringify(await board())).not.toContain("Numbat");
    // XP stays: the ledger is append-only.
    expect(await db.select().from(xpEvents).where(eq(xpEvents.idempotencyKey, `win:${b.id}`))).toHaveLength(1);
  });
});

describe("sharing levels (a) in the app and (b) on the TV", () => {
  it("each level is separate, and only a guardian (minor) or the adult athlete can change it", async () => {
    const w = await approved("maya", V.alex, V.marcus, { headline: "Level marker Bilby" });
    expect(w).toMatchObject({ showInApp: true, showOnTv: true });
    for (const who of ["maya", "marcus", "rod", "chris", "casey", "kiosk"]) await denied(db.transaction((tx) => setSharing(tx, V[who], { winId: w.id, showInApp: false, showOnTv: false }, { today: TODAY })));
    await db.transaction((tx) => setSharing(tx, V.jordan, { winId: w.id, showInApp: true, showOnTv: false }, { today: TODAY }));
    expect(JSON.stringify(await board())).not.toContain("Bilby");
    expect(JSON.stringify(await feed(V.chris))).toContain("Bilby");
    await db.transaction((tx) => setSharing(tx, V.alex, { winId: w.id, showInApp: false, showOnTv: true }, { today: TODAY }));
    expect(JSON.stringify(await board())).toContain("Bilby");
    expect(JSON.stringify(await feed(V.chris))).not.toContain("Bilby");
    expect((await audits("wins.sharing.set", w.id)).length).toBe(2);
    // The submitter can switch levels off at submission; marketing is never on at submission.
    const off = await submit(V.maya, "maya", { showInApp: false, showOnTv: "false" });
    expect(off).toMatchObject({ showInApp: false, showOnTv: false, marketingConsent: "none" });
    // An adult athlete decides for herself.
    const d = await approved("dana", V.dana, V.marcus);
    await db.transaction((tx) => setSharing(tx, V.dana, { winId: d.id, showInApp: false, showOnTv: false }, { today: TODAY }));
  });
});

describe("hidden athletes, last names and ids never reach the TV, the feed or the family card", () => {
  it("an approved win of the hidden athlete is on no community surface, yet his own family sees it", async () => {
    const w = await approved("eli", V.alex, V.tess, { headline: "Hidden marker Dunnart", sport: "Soccer" });
    const tv = JSON.stringify(await board());
    expect(tv).not.toMatch(/Dunnart|Zyxeli|Qwvhidden/);
    for (const who of ["chris", "sam", "dana", "maya", "marcus", "rod", "erin"]) expect(JSON.stringify(await feed(V[who])), who).not.toMatch(/Dunnart|Zyxeli|Qwvhidden/);
    expect(JSON.stringify(await feed(V.alex))).not.toContain("Dunnart");
    expect((await db.transaction((tx) => winsForAthlete(tx, V.alex, ctx.athletes.eli))).wins.some((x) => x.id === w.id)).toBe(true);
    // Not in the marketing queue either, and nobody can consent him into it or be asked.
    expect(JSON.stringify(await queue())).not.toMatch(/Dunnart|Zyxeli/);
    await refused(grant(V.alex, w.id));
    await refused(db.transaction((tx) => requestMarketingConsent(tx, V.erin, w.id, { today: TODAY })));
  });
  it("the TV payload carries display names only: no ids, no last names, no source links", async () => {
    await approved("maya", V.alex, V.marcus, { headline: "Payload marker Potoroo", sourceUrl: "https://news.example.test/potoroo" });
    const payload = await board();
    const panel = payload.panels.find((p) => p.key === "wins");
    expect(panel && panel.key === "wins" && panel.items.some((i) => i.name === "Maya P." && /Potoroo/.test(i.headline))).toBe(true);
    const text = JSON.stringify(payload);
    expect(text).not.toMatch(UUID);
    expect(text).not.toMatch(/Parkerson|Rivera|Brooks|news\.example/);
    const f = await feed(V.chris);
    const ftext = JSON.stringify(f);
    expect(ftext).not.toMatch(/Parkerson|Rivera|Brooks|news\.example/);
    expect(ftext).not.toContain(ctx.athletes.maya);
    expect(f.every((i) => i.mine === false)).toBe(true);
    expect((await feed(V.alex)).some((i) => i.mine)).toBe(true);
  });
  it("defence in depth: wording that gains a last name after approval (a rename, a direct edit) is dropped, not shown", async () => {
    const w = await approved("maya", V.alex, V.marcus, { headline: "Rename marker Quoll" });
    await db.update(wins).set({ headline: "Rename marker Quoll for Maya Parkerson" }).where(eq(wins.id, w.id));
    expect(JSON.stringify(await board())).not.toContain("Quoll");
    expect(JSON.stringify(await feed(V.chris))).not.toContain("Quoll");
    await grant(V.alex, w.id);
    expect(JSON.stringify(await queue())).not.toContain("Quoll");
    await db.update(wins).set({ status: "removed" }).where(eq(wins.id, w.id));
  });
  it("the wins panel can be switched off, and the community master switch empties the feed", async () => {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, ctx.orgId));
    const s = communitySettingsOf(org.settings);
    const save = (patch: Record<string, unknown>) => db.transaction((tx) => saveCommunitySettings(tx, V.rod, { ...s, panels: Object.entries(s.panels).filter(([, on]) => on).map(([k]) => k), ...patch }));
    await save({ panels: Object.keys(s.panels).filter((k) => k !== "wins") });
    expect((await board()).panels.some((p) => p.key === "wins")).toBe(false);
    await save({ enabled: false });
    expect(await feed(V.chris)).toEqual([]);
    expect((await db.transaction((tx) => competingThisWeekFamily(tx, V.chris, { now: NOW }))).items).toEqual([]);
    await save({});
    expect((await board()).panels.some((p) => p.key === "wins")).toBe(true);
  });
});

describe("marketing consent (level c)", () => {
  it("default is no; only a guardian who can sign (minor) or the adult athlete can give it; who and when are stored", async () => {
    const w = await approved("maya", V.alex, V.marcus);
    expect(w.marketingConsent).toBe("none");
    for (const who of ["maya", "rod", "erin", "marcus", "tess", "chris", "sam", "dana", "kiosk", "otherOwner"]) await denied(grant(V[who], w.id));
    const g = await grant(V.jordan, w.id);
    expect(g).toMatchObject({ marketingConsent: "granted", marketingConsentBy: V.jordan.userId });
    expect(g.marketingConsentAt).toBeInstanceOf(Date);
    const events = await db.select().from(winConsentEvents).where(eq(winConsentEvents.winId, w.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "granted", relationship: "guardian", actorUserId: V.jordan.userId, actorPersonId: ctx.people.jordan_parker, policyVersion: MARKETING_POLICY_VERSION });
    expect(events[0].policyText).toMatch(/SAMPLE WORDING/);
    expect((await audits("wins.consent.grant", w.id)).length).toBe(1);
    expect((await db.transaction((tx) => consentHistory(tx, V.alex, w.id)))[0]).toMatchObject({ action: "granted", by: "Jordan Parker" });
    await denied(db.transaction((tx) => consentHistory(tx, V.chris, w.id)));
  });
  it("a guardian without the sign-forms flag cannot consent, but can still withdraw what the other parent gave", async () => {
    const link = and(eq(guardianships.guardianPersonId, ctx.people.jordan_parker), eq(guardianships.athleteId, ctx.athletes.maya));
    await db.update(guardianships).set({ canSignForms: false }).where(link);
    try {
      const w = await approved("maya", V.alex, V.marcus);
      const a = await db.transaction((tx) => winsAccess(tx, V.jordan, ctx.athletes.maya, { today: TODAY }));
      expect(a).toMatchObject({ canConsent: false, canWithdraw: true });
      expect(a!.consentBlockedReason).toMatch(/sign permissions/);
      await denied(grant(V.jordan, w.id));
      await denied(db.transaction((tx) => answerMarketingConsent(tx, V.jordan, w.id, "decline", { today: TODAY })));
      await grant(V.alex, w.id);
      const r = await db.transaction((tx) => revokeMarketingConsent(tx, V.jordan, w.id, { today: TODAY }));
      expect(r).toMatchObject({ marketingConsent: "revoked", marketingConsentBy: V.jordan.userId });
    } finally {
      await db.update(guardianships).set({ canSignForms: true }).where(link);
    }
  });
  it("an adult consents for herself; a guardian linked to an adult cannot; a minor athlete cannot", async () => {
    const d = await approved("dana", V.dana, V.marcus);
    await db.insert(guardianships).values({ orgId: ctx.orgId, guardianPersonId: ctx.people.alex_parker, athleteId: ctx.athletes.dana });
    try {
      const a = await db.transaction((tx) => winsAccess(tx, V.alex, ctx.athletes.dana, { today: TODAY }));
      expect(a).toMatchObject({ canSee: true, canConsent: false, canSetSharing: false, canWithdraw: false });
      await denied(grant(V.alex, d.id));
    } finally {
      await db.execute(sql`delete from guardianships where guardian_person_id = ${ctx.people.alex_parker} and athlete_id = ${ctx.athletes.dana}`);
    }
    const g = await grant(V.dana, d.id);
    expect(g.marketingConsent).toBe("granted");
    expect((await db.select().from(winConsentEvents).where(eq(winConsentEvents.winId, d.id)))[0].relationship).toBe("self");
    const m = await approved("maya", V.maya, V.marcus);
    await denied(grant(V.maya, m.id));
    await denied(db.transaction((tx) => revokeMarketingConsent(tx, V.chris, m.id, { today: TODAY })));
  });
  it("the consent ledger is append-only, and the database refuses consent without who and when", async () => {
    const [e] = await db.select().from(winConsentEvents).where(eq(winConsentEvents.orgId, ctx.orgId)).limit(1);
    await expect(db.update(winConsentEvents).set({ action: "revoked" }).where(eq(winConsentEvents.id, e.id))).rejects.toThrow();
    await expect(db.delete(winConsentEvents).where(eq(winConsentEvents.id, e.id))).rejects.toThrow();
    const w = await approved("maya", V.alex, V.marcus);
    await expect(db.update(wins).set({ marketingConsent: "granted" }).where(eq(wins.id, w.id))).rejects.toThrow();
    // Staff can only ever be recorded as having asked.
    await expect(db.insert(winConsentEvents).values({ orgId: ctx.orgId, winId: w.id, athleteId: w.athleteId, action: "granted", actorUserId: V.rod.userId, relationship: "staff", policyVersion: "x", policyText: "x" })).rejects.toThrow();
  });
});

describe("marketing queue", () => {
  it("lists only approved wins with consent; revoking removes the win at once", async () => {
    const yes = await approved("maya", V.alex, V.marcus, { headline: "Queue marker Bandicoot" });
    const no = await approved("leo", V.sam, V.marcus, { headline: "Queue marker Kowari" });
    const pendingWithConsent = await submit(V.alex, "maya", { headline: "Queue marker Mulgara" });
    await grant(V.alex, yes.id);
    await grant(V.alex, pendingWithConsent.id);
    let q = await queue();
    expect(q.ready.every((i) => i.consent === "granted")).toBe(true);
    const item = q.ready.find((i) => i.winId === yes.id)!;
    expect(item).toMatchObject({ displayName: "Maya P.", posts: [] });
    expect(item.captions).toHaveLength(3);
    for (const c of item.captions) {
      expect(c.text).toContain("Maya P.");
      expect(c.text).not.toMatch(/Parkerson|—/);
    }
    expect(q.ready.some((i) => i.winId === no.id)).toBe(false);
    expect(q.ready.some((i) => i.winId === pendingWithConsent.id)).toBe(false);
    expect(q.needConsent.some((i) => i.winId === no.id)).toBe(true);
    for (const i of q.needConsent) expect(i.captions).toEqual([]);

    await db.transaction((tx) => revokeMarketingConsent(tx, V.alex, yes.id, { today: TODAY }));
    q = await queue();
    expect(q.ready.some((i) => i.winId === yes.id)).toBe(false);
    expect(q.takeDown.some((i) => i.winId === yes.id)).toBe(false);
    expect((await audits("wins.consent.revoke", yes.id)).length).toBe(1);
    const ev = await db.select().from(winConsentEvents).where(eq(winConsentEvents.winId, yes.id));
    expect(ev.map((e) => e.action).sort()).toEqual(["granted", "revoked"]);
    // Nothing can be marked as posted without consent.
    await refused(db.transaction((tx) => markPosted(tx, V.erin, { winId: yes.id, channel: "instagram", postedOn: TODAY }, { today: TODAY })));
    await refused(db.transaction((tx) => markPosted(tx, V.erin, { winId: no.id, channel: "instagram", postedOn: TODAY }, { today: TODAY })));
  });
  it("owner, admin and operations only; coaches and families cannot open it or mark anything", async () => {
    for (const who of ["marcus", "tess", "alex", "maya", "dana", "kiosk"]) {
      await denied(queue(V[who]));
      await denied(db.transaction((tx) => markPosted(tx, V[who], { winId: ctx.athletes.maya, channel: "instagram", postedOn: TODAY })));
      await denied(db.transaction((tx) => requestMarketingConsent(tx, V[who], ctx.athletes.maya)));
    }
    expect((await queue(V.rod)).ready).toBeDefined();
    expect((await queue(V.otherOwner)).ready).toEqual([]);
  });
  it("mark as posted stores date and channel; a later revoke moves it to the take-down list", async () => {
    const w = await approved("dana", V.dana, V.marcus, { headline: "Posted marker Antechinus", sport: "Track" });
    await grant(V.dana, w.id);
    await refused(db.transaction((tx) => markPosted(tx, V.erin, { winId: w.id, channel: "billboard", postedOn: TODAY }, { today: TODAY })));
    await refused(db.transaction((tx) => markPosted(tx, V.erin, { winId: w.id, channel: "instagram", postedOn: addDaysYmd(TODAY, 1) }, { today: TODAY })));
    await db.transaction((tx) => markPosted(tx, V.erin, { winId: w.id, channel: "instagram", postedOn: TODAY }, { today: TODAY }));
    await db.transaction((tx) => markPosted(tx, V.erin, { winId: w.id, channel: "instagram", postedOn: TODAY }, { today: TODAY }));
    expect(await db.select().from(winMarketingPosts).where(eq(winMarketingPosts.winId, w.id))).toHaveLength(1);
    expect((await audits("wins.marketing.posted", w.id)).length).toBe(1);
    expect((await queue()).ready.find((i) => i.winId === w.id)!.posts).toEqual([{ channel: "instagram", postedOn: TODAY }]);
    await db.transaction((tx) => revokeMarketingConsent(tx, V.dana, w.id, { today: TODAY }));
    let q = await queue();
    expect(q.ready.some((i) => i.winId === w.id)).toBe(false);
    expect(q.takeDown.find((i) => i.winId === w.id)).toMatchObject({ reason: "The family withdrew marketing consent", posts: [{ channel: "instagram", postedOn: TODAY }] });
    await db.transaction((tx) => markTakenDown(tx, V.erin, w.id));
    q = await queue();
    expect(q.takeDown.some((i) => i.winId === w.id)).toBe(false);
  });
  it("'Ask the family' records a request the guardian sees in the app, sends nothing, and is not repeated after a no", async () => {
    const w = await approved("leo", V.sam, V.marcus);
    const jobs = async () => Number((await db.execute(sql`select count(*) as n from jobs where org_id = ${ctx.orgId}`)).rows[0].n);
    const before = await jobs();
    const r = await db.transaction((tx) => requestMarketingConsent(tx, V.erin, w.id, { today: TODAY }));
    expect(r.consentRequestedBy).toBe(V.erin.userId);
    expect(r.marketingConsent).toBe("none");
    expect(await jobs()).toBe(before);
    expect((await db.select().from(winConsentEvents).where(eq(winConsentEvents.winId, w.id)))[0]).toMatchObject({ action: "requested", relationship: "staff" });
    expect((await db.transaction((tx) => winsForAthlete(tx, V.sam, ctx.athletes.leo))).wins.find((x) => x.id === w.id)?.consentRequested).toBe(true);
    expect((await queue()).needConsent.find((i) => i.winId === w.id)?.asked).toBe(true);
    await db.transaction((tx) => answerMarketingConsent(tx, V.sam, w.id, "decline", { today: TODAY }));
    await refused(db.transaction((tx) => requestMarketingConsent(tx, V.erin, w.id, { today: TODAY })));
    expect((await queue()).ready.some((i) => i.winId === w.id)).toBe(false);
    // The family can still change their mind on their own.
    expect((await grant(V.casey, w.id)).marketingConsent).toBe("granted");
    const pending = await submit(V.sam, "leo");
    await refused(db.transaction((tx) => requestMarketingConsent(tx, V.erin, pending.id, { today: TODAY })));
  });
  it("an athlete hidden after consenting drops out of the queue", async () => {
    const w = await approved("ava", V.chris, V.tess, { headline: "Later hidden marker Ningaui", sport: "Basketball" });
    await grant(V.chris, w.id);
    expect((await queue()).ready.some((i) => i.winId === w.id)).toBe(true);
    await db.transaction((tx) => setDisplayMode(tx, V.chris, { athleteId: ctx.athletes.ava, mode: "hidden" }, TODAY));
    expect(JSON.stringify(await queue())).not.toContain("Ningaui");
    expect(JSON.stringify(await feed(V.alex))).not.toContain("Ningaui");
    await db.delete(communityDisplayPrefs).where(eq(communityDisplayPrefs.athleteId, ctx.athletes.ava));
  });
});

describe("leads to check", () => {
  it("a lead becomes a draft that only the family sees, then needs their yes and a staff approval", async () => {
    await denied(db.transaction((tx) => addLead(tx, V.alex, { note: "I heard something" })));
    await denied(db.transaction((tx) => addLead(tx, V.kiosk, { note: "I heard something" })));
    await denied(db.transaction((tx) => addLead(tx, V.tess, { note: "Heard Maya made a team", athleteId: ctx.athletes.maya })));
    await refused(db.transaction((tx) => addLead(tx, V.marcus, { note: "Heard Maya is back from surgery" })));
    await refused(db.transaction((tx) => addLead(tx, V.marcus, { note: "Saw an article", sourceUrl: "ftp://x.test/a" })));
    const lead = await db.transaction((tx) => addLead(tx, V.marcus, { note: "Heard Maya made all-conference", sourceUrl: "https://news.example.test/lead", athleteId: ctx.athletes.maya }));
    expect(lead.status).toBe("open");
    expect((await db.transaction((tx) => listLeads(tx, V.erin))).some((l) => l.id === lead.id)).toBe(true);
    expect((await db.transaction((tx) => listLeads(tx, V.tess))).some((l) => l.id === lead.id)).toBe(false);
    await denied(db.transaction((tx) => convertLead(tx, V.tess, lead.id, { occurredOn: TODAY, sport: "Volleyball", type: "selection", headline: "Named all-conference" }, { today: TODAY })));

    const draft = await db.transaction((tx) => convertLead(tx, V.marcus, lead.id, { occurredOn: addDaysYmd(TODAY, -1), sport: "Volleyball", type: "selection", headline: "Lead marker Kultarr all-conference" }, { today: TODAY }));
    expect(draft).toMatchObject({ status: "awaiting_family", submittedAs: "staff", sourceUrl: "https://news.example.test/lead", athleteId: ctx.athletes.maya });
    await refused(db.transaction((tx) => convertLead(tx, V.marcus, lead.id, { occurredOn: TODAY, sport: "Volleyball", type: "selection", headline: "Again" }, { today: TODAY })));
    expect(JSON.stringify(await board())).not.toContain("Kultarr");
    expect(JSON.stringify(await feed(V.chris))).not.toContain("Kultarr");
    await refused(approve(V.marcus, draft.id));
    for (const who of ["chris", "marcus", "rod", "kiosk"]) await denied(db.transaction((tx) => answerDraft(tx, V[who], draft.id, "confirm", { today: TODAY })));
    const confirmed = await db.transaction((tx) => answerDraft(tx, V.jordan, draft.id, "confirm", { today: TODAY }));
    expect(confirmed).toMatchObject({ status: "pending", familyConfirmedBy: V.jordan.userId });
    expect(JSON.stringify(await board())).not.toContain("Kultarr");
    await approve(V.marcus, draft.id);
    expect(JSON.stringify(await board())).toContain("Kultarr");
  });
  it("the family can decline a draft; a lead can be dismissed; a guardian who cannot act cannot answer", async () => {
    const lead = await db.transaction((tx) => addLead(tx, V.erin, { note: "Heard Leo committed somewhere" }));
    const draft = await db.transaction((tx) => convertLead(tx, V.erin, lead.id, { athleteId: ctx.athletes.leo, occurredOn: TODAY, sport: "Football", type: "commitment", headline: "Lead marker Dibbler commitment" }, { today: TODAY }));
    await denied(db.transaction((tx) => answerDraft(tx, V.casey, draft.id, "confirm", { today: TODAY })));
    const d = await db.transaction((tx) => answerDraft(tx, V.sam, draft.id, "decline", { today: TODAY }));
    expect(d.status).toBe("declined");
    await refused(approve(V.marcus, draft.id));
    expect((await audits("wins.draft.decline", draft.id)).length).toBe(1);
    const l2 = await db.transaction((tx) => addLead(tx, V.marcus, { note: "Something about a tournament" }));
    await denied(db.transaction((tx) => dismissLead(tx, V.tess, l2.id)));
    await db.transaction((tx) => dismissLead(tx, V.marcus, l2.id));
    expect((await db.transaction((tx) => listLeads(tx, V.rod, { status: "open" }))).some((l) => l.id === l2.id)).toBe(false);
  });
});

describe("competition calendar", () => {
  const tomorrow = addDaysYmd(TODAY, 1);
  let teamId: string;
  beforeAll(async () => {
    // My Season: Maya's family entered a game tomorrow and one on Saturday.
    const season = await db.transaction((tx) => createSeason(tx, V.alex, { athleteId: ctx.athletes.maya, teamName: "Fictional Falls Volleyball", sport: "Volleyball", startsOn: addDaysYmd(TODAY, -30), endsOn: addDaysYmd(TODAY, 60) }));
    await db.transaction((tx) => addEvent(tx, V.alex, { seasonId: season.id, kind: "game", opponent: "Secretopponent Central", location: "Secretplace Gym", date: tomorrow, startTime: "18:30" }));
    await db.transaction((tx) => addEvent(tx, V.alex, { seasonId: season.id, kind: "practice", date: addDaysYmd(TODAY, 2), startTime: "16:00" }));
    // A staff team schedule attached to several athletes at once, the hidden one included.
    const t = await db.transaction((tx) => createTeam(tx, V.rod, { name: "Sampleton Storm (sample)", sport: "Soccer", kind: "club" }));
    teamId = t.id;
    const r = await db.transaction((tx) => addTeamEvents(tx, V.rod, { teamId, kind: "tournament", lines: `${tomorrow}, 09:00, Secretopponent Cup, Secretplace Fields\n${addDaysYmd(TODAY, 5)}\n${addDaysYmd(TODAY, 20)}, 10:00` }));
    expect(r).toEqual({ added: 3, skipped: 0 });
    expect(await db.transaction((tx) => addTeamEvents(tx, V.rod, { teamId, kind: "tournament", lines: `${tomorrow}, 09:00` }))).toEqual({ added: 0, skipped: 1 });
    await db.transaction((tx) => setTeamAthletes(tx, V.rod, teamId, [ctx.athletes.eli, ctx.athletes.ava, ctx.athletes.maya, ctx.athletes.leo]));
  });
  it("only staff manage team schedules, and a coach's save only touches their own athletes", async () => {
    for (const who of ["alex", "maya", "dana", "kiosk"]) {
      await denied(db.transaction((tx) => createTeam(tx, V[who], { name: "Family made team", sport: "Soccer", kind: "club" })));
      await denied(db.transaction((tx) => setTeamAthletes(tx, V[who], teamId, [])));
      await denied(db.transaction((tx) => listTeams(tx, V[who])));
    }
    await denied(db.transaction((tx) => setTeamAthletes(tx, V.otherOwner, teamId, [])));
    await denied(db.transaction((tx) => setTeamAthletes(tx, V.tess, teamId, [ctx.athletes.eli, ctx.athletes.maya])));
    // Tess (youth coach) drops Ava: Maya and Leo, whom she does not coach, stay on the schedule.
    expect(await db.transaction((tx) => setTeamAthletes(tx, V.tess, teamId, [ctx.athletes.eli]))).toEqual({ added: 0, removed: 1 });
    const seenByTess = (await db.transaction((tx) => listTeams(tx, V.tess))).find((t) => t.id === teamId)!;
    expect(seenByTess.athleteIds).toEqual([ctx.athletes.eli]);
    expect(seenByTess.otherAthletes).toBe(2);
    await db.transaction((tx) => setTeamAthletes(tx, V.rod, teamId, [ctx.athletes.eli, ctx.athletes.ava, ctx.athletes.maya, ctx.athletes.leo]));
    await refused(db.transaction((tx) => addTeamEvents(tx, V.rod, { teamId, kind: "game", lines: "next Friday" })));
  });
  it("the staff calendar merges both sources, one entry per athlete per day, scoped to the coach's roster", async () => {
    const all = await db.transaction((tx) => staffCalendar(tx, V.erin, { from: TODAY, to: addDaysYmd(TODAY, 27) }, {}, { today: TODAY }));
    const maya = all.entries.filter((e) => e.athleteId === ctx.athletes.maya);
    // Tomorrow is on both My Season and the team schedule: the family's entry wins. Practices are not competitions.
    expect(maya.filter((e) => e.date === tomorrow)).toHaveLength(1);
    expect(maya.find((e) => e.date === tomorrow)).toMatchObject({ source: "my_season", kind: "game", teamName: "Fictional Falls Volleyball", athleteName: "Maya Parkerson" });
    expect(maya.some((e) => e.date === addDaysYmd(TODAY, 2))).toBe(false);
    expect(maya.some((e) => e.date === addDaysYmd(TODAY, 5) && e.source === "team_schedule")).toBe(true);
    expect(all.sports.sort()).toEqual(["Soccer", "Volleyball"]);
    expect(all.teams).toContain("Sampleton Storm (sample)");

    const marcus = await db.transaction((tx) => staffCalendar(tx, V.marcus, { from: TODAY, to: addDaysYmd(TODAY, 27) }, {}, { today: TODAY }));
    expect(new Set(marcus.entries.map((e) => e.athleteId))).toEqual(new Set([ctx.athletes.maya, ctx.athletes.leo]));
    const tess = await db.transaction((tx) => staffCalendar(tx, V.tess, { from: TODAY, to: addDaysYmd(TODAY, 27) }, {}, { today: TODAY }));
    expect(new Set(tess.entries.map((e) => e.athleteId))).toEqual(new Set([ctx.athletes.eli, ctx.athletes.ava]));

    const soccer = await db.transaction((tx) => staffCalendar(tx, V.erin, { from: TODAY, to: addDaysYmd(TODAY, 27) }, { sport: "soccer" }, { today: TODAY }));
    expect(soccer.entries.every((e) => e.sport === "Soccer")).toBe(true);
    const hs = await db.transaction((tx) => staffCalendar(tx, V.erin, { from: TODAY, to: addDaysYmd(TODAY, 27) }, { groupId: ctx.groups.hs }, { today: TODAY }));
    expect(new Set(hs.entries.map((e) => e.athleteId))).toEqual(new Set([ctx.athletes.maya, ctx.athletes.leo]));
    const team = await db.transaction((tx) => staffCalendar(tx, V.erin, { from: TODAY, to: addDaysYmd(TODAY, 27) }, { team: "Fictional Falls Volleyball" }, { today: TODAY }));
    expect(team.entries.map((e) => e.athleteId)).toEqual([ctx.athletes.maya]);
    for (const who of ["alex", "maya", "kiosk"]) await denied(db.transaction((tx) => staffCalendar(tx, V[who], { from: TODAY, to: tomorrow })));
    await refused(db.transaction((tx) => staffCalendar(tx, V.erin, { from: TODAY, to: addDaysYmd(TODAY, 90) })));
  });
  it("the Today widget shows who competes tomorrow at a glance", async () => {
    const w = await db.transaction((tx) => competingThisWeekStaff(tx, V.marcus, { now: NOW }));
    expect(w.tomorrow).toBe(2);
    const day = w.days.find((d) => d.isTomorrow)!;
    expect(day.label).toBe("Tomorrow");
    expect(day.entries.map((e) => e.athleteName).sort()).toEqual(["Leo Rivera", "Maya Parkerson"]);
    expect(day.entries.every((e) => e.canSeeLoad)).toBe(true);
    await denied(db.transaction((tx) => competingThisWeekStaff(tx, V.alex, { now: NOW })));
  });
  it("the family card uses display names only: no hidden athlete, no ids, no last names, no team, opponent, place or time", async () => {
    for (const who of ["chris", "alex", "maya", "dana", "sam"]) {
      const card = await db.transaction((tx) => competingThisWeekFamily(tx, V[who], { now: NOW }));
      const text = JSON.stringify(card);
      expect(card.items.some((i) => i.name === "Maya P." && i.day === "Tomorrow" && i.kindLabel === "Game" && i.sport === "Volleyball"), who).toBe(true);
      expect(card.items.some((i) => i.name === "Leo R.")).toBe(true);
      expect(text).not.toMatch(/Zyxeli|Qwvhidden|Parkerson|Rivera/);
      expect(text).not.toMatch(/Secretopponent|Secretplace|Fictional Falls|Sampleton|18:30|6:30/);
      expect(text).not.toMatch(UUID);
      expect(Object.keys(card.items[0]).sort()).toEqual(["date", "day", "kindLabel", "name", "sport"]);
    }
    await denied(db.transaction((tx) => competingThisWeekFamily(tx, V.kiosk, { now: NOW })));
    expect((await db.transaction((tx) => competingThisWeekFamily(tx, V.otherOwner, { now: NOW }))).items).toEqual([]);
  });
});

describe("other surfaces", () => {
  it("retention: a recent approved win is a reason to congratulate, scoped like the radar", async () => {
    const w = await approved("maya", V.alex, V.marcus, { headline: "Outreach marker Phascogale" });
    const forMarcus = await db.transaction((tx) => recentWinsForOutreach(tx, V.marcus, { now: NOW }));
    expect(forMarcus.find((x) => x.winId === w.id)).toMatchObject({ athleteName: "Maya Parkerson", personId: ctx.people.maya_parker });
    expect((await db.transaction((tx) => recentWinsForOutreach(tx, V.tess, { now: NOW }))).some((x) => x.winId === w.id)).toBe(false);
    expect((await db.transaction((tx) => recentWinsForOutreach(tx, V.erin, { now: new Date(NOW.getTime() + 20 * 86_400_000) }))).some((x) => x.winId === w.id)).toBe(false);
    for (const who of ["alex", "maya", "kiosk"]) await denied(db.transaction((tx) => recentWinsForOutreach(tx, V[who])));
  });
  it("the monthly recap only gets approved wins that happened in the month", async () => {
    const inMonth = await approved("ethan", V.marcus, V.marcus, { headline: "Recap marker Planigale", occurredOn: "2026-02-20" });
    await submit(V.marcus, "ethan", { headline: "Recap pending marker", occurredOn: "2026-02-21" });
    await approved("ethan", V.marcus, V.marcus, { headline: "Recap other month", occurredOn: "2026-01-15" });
    const rows = await db.transaction((tx) => approvedWinsBetween(tx, ctx.orgId, ctx.athletes.ethan, "2026-02-01", "2026-02-28"));
    expect(rows).toEqual([{ headline: inMonth.headline, typeLabel: "Win or placing", occurredOn: "2026-02-20" }]);
    expect(Object.keys(rows[0]).sort()).toEqual(["headline", "occurredOn", "typeLabel"]);
  });
  it("photos: the family and staff in scope always; other families only once the win and the photo are approved and the app level is on", async () => {
    const jpeg = preparePhoto(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xda, 0x00, 0x02, 0x11, 0xff, 0xd9])).photo!;
    const w = await db.transaction((tx) => submitWin(tx, V.alex, base("maya"), { today: TODAY, photo: jpeg }));
    expect(w.photoObjectId).toBeTruthy();
    const can = async (who: string) => !!(await db.transaction((tx) => winPhotoFor(tx, V[who], w.id)));
    expect(await can("alex")).toBe(true);
    expect(await can("marcus")).toBe(true);
    for (const who of ["chris", "tess", "kiosk", "otherOwner"]) expect(await can(who), who).toBe(false);
    await approve(V.marcus, w.id);
    expect(await can("chris")).toBe(false);
    await approve(V.marcus, (await db.transaction((tx) => submitWin(tx, V.alex, base("maya"), { today: TODAY }))).id, { approvePhoto: true });
    const [again] = await db.select().from(wins).where(eq(wins.id, w.id));
    expect(again.photoApprovedAt).toBeNull();
    const w2 = await db.transaction((tx) => submitWin(tx, V.alex, base("maya"), { today: TODAY, photo: jpeg }));
    await approve(V.marcus, w2.id, { approvePhoto: true });
    const can2 = async (who: string) => !!(await db.transaction((tx) => winPhotoFor(tx, V[who], w2.id)));
    expect(await can2("chris")).toBe(true);
    expect(await can2("kiosk")).toBe(false);
    expect(await can2("otherOwner")).toBe(false);
    expect((await feed(V.chris)).find((i) => i.id === w2.id)?.photo).toBe(true);
    expect((await feed(V.chris)).find((i) => i.id === w.id)?.photo).toBe(false);
    await db.transaction((tx) => setSharing(tx, V.alex, { winId: w2.id, showInApp: false, showOnTv: true }, { today: TODAY }));
    expect(await can2("chris")).toBe(false);
    expect(await can2("alex")).toBe(true);
  });
});
