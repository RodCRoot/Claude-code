import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq, sql } from "drizzle-orm";
import { ShowcaseSheet } from "@/components/showcase/sheet";
import { athletes, auditEvents, bodyRegionReports, guardianships, invoices, metricDefinitions, metricValues, notes, organizations, payerAuthorizations, people, questionnaireResponses, showcaseConsents, showcaseViewDays, showcases, testSessions, users } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { AuthzError, type Viewer } from "@/lib/authz/policy";
import { showcaseAccess } from "@/lib/showcase/access";
import { DEFAULT_SHOWCASE_CONFIG, FORBIDDEN_KEYS, SHOWCASE_CONFIG_KEYS, SHOWCASE_POLICY_VERSION, SHOWCASE_SHOW_KEYS, ShowcaseInputError, cleanHttpsUrl, configFromForm, sanitizeConfig } from "@/lib/showcase/allowlist";
import { ageBandOf, buildCatalog } from "@/lib/showcase/catalog";
import { SHOWCASE_DATA_KEYS, composeShowcase, displayName, sparklinePoints, type ShowcaseData } from "@/lib/showcase/compose";
import { renderShowcasePdf, showcaseContentHash } from "@/lib/showcase/pdf";
import { createRateLimiter } from "@/lib/showcase/rate-limit";
import { saveShowcaseSettings } from "@/lib/showcase/settings";
import { getShowcaseBuilder, linkStateOf, listPublishedShowcases, privateShowcaseData, publicShowcase, publishShowcase, revokeShowcase, rotateShowcaseLink, saveShowcaseDraft, staffRevokeShowcase } from "@/lib/showcase/showcase";
import { TOKEN_PATTERN, hashShareToken, newShareToken } from "@/lib/showcase/token";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { extractPdfText } from "./helpers/pdf-text";

type Ctx = Awaited<ReturnType<typeof seedOrg>>;
const db = testDb();
let ctx: Ctx;
let other: Ctx;
const V: Record<string, Viewer> = {};
let maya: string;
let token: string;

const denied = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(AuthzError);
const refused = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(UserError);
const rowOf = async (athleteId: string) => (await db.select().from(showcases).where(eq(showcases.athleteId, athleteId)))[0];
const cfgOf = async (athleteId: string) => sanitizeConfig((await rowOf(athleteId)).config);
const live = (t: string, now?: Date) => db.transaction((tx) => publicShowcase(tx, t, { now, countView: false }));
/** Every key at every depth of a value. */
function deepKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      out.add(k);
      deepKeys(x, out);
    }
  return out;
}

beforeAll(async () => {
  ctx = await seedOrg("2026-03-02");
  other = await seedOrg("2026-03-02", { modules: [] });
  for (const k of ["rod", "erin", "marcus", "tess", "alex", "jordan", "chris", "sam", "casey", "maya", "dana", "kiosk"]) V[k] = await viewerFor(ctx, k);
  V.otherOwner = await viewerFor(other, "rod");
  maya = ctx.athletes.maya;
  token = ctx.extra.showcase.token;
});
afterAll(closeTestDb);

describe("allowlist (pure)", () => {
  it("keeps only allowlisted keys, whatever is posted", () => {
    const hostile = {
      ...DEFAULT_SHOWCASE_CONFIG,
      show: { ...DEFAULT_SHOWCASE_CONFIG.show, wellness: true, dateOfBirth: true, bodyMap: true, billing: true, address: true },
      wellness: true,
      dateOfBirth: "2011-01-01",
      notes: ["x"],
      invoices: true,
      accountEmail: "alex.parker@example.test",
      __proto__: { injury: true },
    };
    const c = sanitizeConfig(hostile, { strict: true });
    expect(Object.keys(c).sort()).toEqual([...SHOWCASE_CONFIG_KEYS].sort());
    expect(Object.keys(c.show).sort()).toEqual([...SHOWCASE_SHOW_KEYS].sort());
    for (const k of deepKeys(c)) expect(FORBIDDEN_KEYS as readonly string[]).not.toContain(k);
    // A form post with extra field names is read by name, so the extras never reach the config.
    const fromForm = sanitizeConfig(configFromForm({ nameDisplay: "full", "show.sport": "on", "show.wellness": "on", "show.dob": "on", wellness: "on", dateOfBirth: "2011-01-01", metricIds: "not-a-uuid" }), { strict: true });
    expect(Object.keys(fromForm.show).sort()).toEqual([...SHOWCASE_SHOW_KEYS].sort());
    expect(fromForm).toMatchObject({ nameDisplay: "full", metricIds: [] });
    expect(fromForm.show.sport).toBe(true);
  });

  it("video links are https only, bios are plain text and length limited, contact is a typed email", () => {
    expect(cleanHttpsUrl("https://example.com/v/1")).toBe("https://example.com/v/1");
    for (const bad of ["http://example.com/v", "javascript:alert(1)", "data:text/html,x", "//example.com", "https://user:pw@example.com/", "https://localhost/x", "ftp://example.com"]) expect(cleanHttpsUrl(bad), bad).toBeNull();
    expect(() => sanitizeConfig({ ...DEFAULT_SHOWCASE_CONFIG, videoUrl: "http://example.com/v" }, { strict: true })).toThrow(ShowcaseInputError);
    expect(() => sanitizeConfig({ ...DEFAULT_SHOWCASE_CONFIG, bio: "x".repeat(401) }, { strict: true })).toThrow(ShowcaseInputError);
    expect(() => sanitizeConfig({ ...DEFAULT_SHOWCASE_CONFIG, contactEmail: "not an email" }, { strict: true })).toThrow(ShowcaseInputError);
    expect(sanitizeConfig({ ...DEFAULT_SHOWCASE_CONFIG, bio: "Hi <script>alert(1)</script>\u0007 there" }).bio).toBe("Hi scriptalert(1)/script there");
  });

  it("names, age bands and sparklines", () => {
    const a = { firstName: "Maya", lastName: "Parker" };
    expect([displayName(a, "first"), displayName(a, "first_initial"), displayName(a, "full")]).toEqual(["Maya", "Maya P.", "Maya Parker"]);
    expect([ageBandOf(null), ageBandOf(10), ageBandOf(13), ageBandOf(14), ageBandOf(15), ageBandOf(18), ageBandOf(22)]).toEqual([null, "Under 11", "13 to 14", "13 to 14", "15 to 16", "17 to 18", "19 or older"]);
    const pts = sparklinePoints([1, 2, 3], 100, 40, 4);
    expect(pts[0]).toEqual({ x: 4, y: 36 });
    expect(pts[2]).toEqual({ x: 96, y: 4 });
  });

  it("the rate limiter allows the limit per window, then refuses, and never grows without bound", () => {
    const rl = createRateLimiter({ limit: 3, windowMs: 1000, maxKeys: 2 });
    expect([rl.check("a", 0), rl.check("a", 1), rl.check("a", 2), rl.check("a", 3)]).toEqual([true, true, true, false]);
    expect(rl.check("b", 4)).toBe(true);
    rl.check("c", 5);
    rl.check("d", 6);
    expect(rl.size()).toBeLessThanOrEqual(3);
    expect(rl.check("a", 1001)).toBe(true);
  });
});

describe("tokens", () => {
  it("are 256-bit random, stored only as a hash, and not enumerable", async () => {
    const a = newShareToken();
    const b = newShareToken();
    expect(a).toMatch(TOKEN_PATTERN);
    expect(Buffer.from(a, "base64url").length).toBe(32);
    expect(a).not.toBe(b);
    const row = await rowOf(maya);
    expect(row.tokenHash).toBe(hashShareToken(token));
    expect(row.tokenHash).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token);
    // Ids, hashes, near misses and junk all get the same answer as a link that never existed.
    for (const guess of [row.id, row.athleteId, row.tokenHash!, token.slice(0, -1), token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), token.toLowerCase(), `${token}0`, "", "x".repeat(43), "../../etc/passwd", newShareToken()]) {
      expect(await live(guess), guess).toBeNull();
    }
    expect(await live(undefined as unknown as string)).toBeNull();
    expect(await live(token)).not.toBeNull();
  });
});

describe("the public page", () => {
  it("shows only allowlisted data for an athlete who has wellness, body map, notes and billing on file", async () => {
    const data = (await live(token))!;
    expect(Object.keys(data).sort()).toEqual([...SHOWCASE_DATA_KEYS].sort());
    for (const k of deepKeys(data)) expect(FORBIDDEN_KEYS as readonly string[], `key ${k}`).not.toContain(k);
    expect(data.displayName).toBe("Maya P.");
    expect(data.tiles.length).toBeGreaterThan(0);
    expect(data.lifts.length).toBeGreaterThan(0);
    expect(data.inquireHref).toBe("/inquire?ref=showcase");

    // The athlete really does have the forbidden data on file.
    const [person] = await db.select().from(people).where(eq(people.id, ctx.people.maya_parker));
    const wellness = await db.select().from(questionnaireResponses).where(eq(questionnaireResponses.athleteId, maya));
    const body = await db.select().from(bodyRegionReports).where(eq(bodyRegionReports.athleteId, maya));
    const inv = await db.select().from(invoices).where(eq(invoices.payerAccountId, ctx.payers.parker));
    const noteRows = await db.select().from(notes).where(eq(notes.subjectPersonId, ctx.people.maya_parker));
    const [mayaUser] = await db.select().from(users).where(eq(users.id, ctx.users.maya));
    expect(wellness.length).toBeGreaterThan(0);
    expect(body.length).toBeGreaterThan(0);
    expect(inv.length).toBeGreaterThan(0);
    expect(noteRows.length).toBeGreaterThan(0);
    expect(person.dateOfBirth).toBeTruthy();

    const html = renderToStaticMarkup(createElement(ShowcaseSheet, { data }));
    const json = JSON.stringify(data);
    const forbidden = [
      person.lastName, // consent was for first name and last initial
      person.dateOfBirth!,
      person.dateOfBirth!.slice(0, 4) + "-",
      mayaUser.email,
      "alex.parker@example.test",
      "jordan.parker@example.test",
      "812 555",
      ...inv.map((i) => i.number),
      ...noteRows.map((n) => n.body),
      ...body.flatMap((b) => [b.note, b.reviewNote]).filter((x): x is string => !!x),
      ...body.map((b) => b.region),
      "Great intent on approach jumps",
      "wellness",
      "readiness",
      "soreness",
      "invoice",
      "Membership",
      ctx.athletes.maya,
      ctx.people.maya_parker,
    ];
    for (const f of forbidden) {
      expect(json.toLowerCase(), `json leaks ${f}`).not.toContain(f.toLowerCase());
      expect(html.toLowerCase(), `html leaks ${f}`).not.toContain(f.toLowerCase());
    }
    // What is there: the consented name, the verified marks, the methods footnote, the revenue link.
    expect(html).toContain("Maya P.");
    expect(html).toContain("Verified by Teamwork on");
    expect(html).toContain("How these numbers were recorded");
    expect(html).toContain('href="/inquire?ref=showcase"');
    // The video is a link, never an embed, and nothing loads from another origin.
    expect(html).not.toMatch(/<(iframe|video|embed|object|script)\b/i);
    expect(html).not.toMatch(/<(img|link|source)\b[^>]*(src|href)="https?:/i);
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it("marks a result verified only when staff or a device recorded it, never a self-entered value", async () => {
    const before = (await buildCatalog(db, ctx.orgId, maya, { includeTraining: true }))!;
    const sprint = before.metrics!.find((m) => m.name === "10 yd sprint")!;
    const jump = before.metrics!.find((m) => m.name.startsWith("Jump Height"))!;
    expect(sprint.latest.verified).toBe(true); // entered by the coach
    expect(jump.latest.verified).toBe(true); // imported from the force plate
    expect(jump.recordedBy).toMatch(/Hawkin/);
    // The same values attributed to the athlete's own login, or to nobody, are not verified.
    const cond = and(eq(metricValues.athleteId, maya), eq(metricValues.metricDefinitionId, sprint.id));
    for (const author of [ctx.users.maya, ctx.users.alex, null]) {
      await db.update(metricValues).set({ enteredBy: author }).where(cond);
      const c = (await buildCatalog(db, ctx.orgId, maya, { includeTraining: true }))!;
      const m = c.metrics!.find((x) => x.id === sprint.id)!;
      expect(m.latest.verified, String(author)).toBe(false);
      expect(m.best?.verified).toBe(false);
      const html = renderToStaticMarkup(createElement(ShowcaseSheet, { data: composeShowcase(c, { ...DEFAULT_SHOWCASE_CONFIG, metricIds: [sprint.id] }, { name: "Teamwork", primaryColor: "#1d4ed8", logoPath: null }, "2026-03-02") }));
      expect(html).not.toContain("Verified by Teamwork on");
      expect(html).toContain("(not verified)");
    }
    await db.update(metricValues).set({ enteredBy: ctx.users.marcus }).where(cond);
  });

  it("trend lines need three comparable points and never mix protocols", async () => {
    const c = (await buildCatalog(db, ctx.orgId, maya, { includeTraining: true }))!;
    const data = composeShowcase(c, { ...DEFAULT_SHOWCASE_CONFIG, metricIds: c.metrics!.map((m) => m.id).slice(0, 8) }, { name: "Teamwork", primaryColor: "#1d4ed8", logoPath: null }, "2026-03-02");
    for (const m of c.metrics!) {
      const tile = data.tiles.find((t) => t.id === m.id);
      if (!tile) continue;
      expect(!!tile.trend).toBe(m.trend.length >= 3);
    }
    // A result measured with a different protocol is left out of the trend, and the page says how many.
    const jump = c.metrics!.find((m) => m.name === "Broad Jump")!;
    const [tt] = (await db.execute(sql`insert into test_types (org_id, key, name, vendor, protocol) values (${ctx.orgId}, 'broad_jump_running', 'Running Broad Jump', 'teamwork', 'Two-step run-up.') returning id`)).rows as { id: string }[];
    const [s] = await db.insert(testSessions).values({ orgId: ctx.orgId, athleteId: maya, testTypeId: tt.id, testedAt: new Date("2025-06-01T16:00:00Z"), source: "teamwork_manual" }).returning();
    await db.insert(metricValues).values({ orgId: ctx.orgId, athleteId: maya, metricDefinitionId: jump.id, testSessionId: s.id, value: 999, unit: "cm", recordedAt: new Date("2025-06-01T16:00:00Z"), source: "teamwork_manual", aggregation: "single", enteredBy: ctx.users.marcus });
    const after = (await buildCatalog(db, ctx.orgId, maya, { includeTraining: true }))!.metrics!.find((m) => m.id === jump.id)!;
    expect(after.trend.map((p) => p.value)).not.toContain(999);
    expect(after.best!.value).not.toBe(999);
    expect(after.notCompared).toBe(jump.notCompared + 1);
    expect(after.trend.length).toBe(jump.trend.length);
  });

  it("counts opens per day and stores nothing about the visitor", async () => {
    const id = (await rowOf(maya)).id;
    const total = async () => Number(((await db.execute(sql`select coalesce(sum(views), 0)::int as n from showcase_view_days where showcase_id = ${id}`)).rows[0] as { n: number }).n);
    const n0 = await total();
    const days0 = (await db.select().from(showcaseViewDays).where(eq(showcaseViewDays.showcaseId, id))).length;
    await db.transaction((tx) => publicShowcase(tx, token));
    await db.transaction((tx) => publicShowcase(tx, token));
    expect(await total()).toBe(n0 + 2);
    expect((await db.select().from(showcaseViewDays).where(eq(showcaseViewDays.showcaseId, id))).length).toBeLessThanOrEqual(days0 + 1);
    await db.transaction((tx) => publicShowcase(tx, "x".repeat(43)));
    expect(await total()).toBe(n0 + 2);
    const cols = ((await db.execute(sql`select column_name from information_schema.columns where table_name = 'showcase_view_days' order by 1`)).rows as { column_name: string }[]).map((r) => r.column_name);
    expect(cols).toEqual(["day", "org_id", "showcase_id", "views"]);
    const all = ((await db.execute(sql`select column_name from information_schema.columns where table_name in ('showcases','showcase_consents','showcase_view_days')`)).rows as { column_name: string }[]).map((r) => r.column_name);
    for (const c of all) expect(c).not.toMatch(/(^|_)ip($|_)|user_agent|referr|visitor|token$/);
  });
});

describe("consent and control", () => {
  it("a minor athlete can draft but cannot publish; her change pauses the link until a guardian republishes", async () => {
    const access = await showcaseAccess(db, V.maya, maya);
    expect(access).toMatchObject({ relationship: "self", isMinor: true, canDraft: true, canPublish: false, canRevoke: true });
    const before = await cfgOf(maya);
    await denied(db.transaction((tx) => publishShowcase(tx, V.maya, maya, { config: before, consent: true })));
    await denied(db.transaction((tx) => rotateShowcaseLink(tx, V.maya, maya)));
    expect(await live(token)).not.toBeNull();

    // Saving the same thing changes nothing.
    expect((await db.transaction((tx) => saveShowcaseDraft(tx, V.maya, maya, before))).unpublished).toBe(false);
    expect(await live(token)).not.toBeNull();

    // A real change by the athlete: back to draft, link closed at once.
    const changed = { ...before, bio: "New bio written by the athlete." };
    const res = await db.transaction((tx) => saveShowcaseDraft(tx, V.maya, maya, changed));
    expect(res.unpublished).toBe(true);
    expect(res.row.status).toBe("draft");
    expect(await live(token)).toBeNull();
    const [a] = await db.select().from(auditEvents).where(and(eq(auditEvents.entityId, res.row.id), eq(auditEvents.action, "showcase.draft.unpublish")));
    expect(a.actorUserId).toBe(V.maya.userId);

    // The guardian republishes: consent is recorded again and the SAME link works again.
    await refused(db.transaction((tx) => publishShowcase(tx, V.alex, maya, { config: changed, consent: false })));
    const pub = await db.transaction((tx) => publishShowcase(tx, V.alex, maya, { config: changed, consent: true, expiryDays: 30 }));
    expect(pub.token).toBeNull();
    expect((await live(token))!.bio).toBe("New bio written by the athlete.");
    const consents = await db.select().from(showcaseConsents).where(eq(showcaseConsents.showcaseId, pub.row.id)).orderBy(showcaseConsents.createdAt);
    const last = consents.at(-1)!;
    expect(last).toMatchObject({ kind: "granted", actorRelationship: "guardian", actorUserId: V.alex.userId, actorPersonId: V.alex.personId, policyVersion: SHOWCASE_POLICY_VERSION });
    expect(sanitizeConfig(last.fields).bio).toBe("New bio written by the athlete.");
    expect(last.policyText).toContain("parent or legal guardian");
    expect(last.expiresAt!.getTime() - last.createdAt.getTime()).toBeGreaterThan(29 * 86_400_000);
  });

  it("the consent trail is append-only", async () => {
    const id = (await rowOf(maya)).id;
    await expect(db.update(showcaseConsents).set({ policyVersion: "edited" }).where(eq(showcaseConsents.showcaseId, id))).rejects.toThrow();
    await expect(db.delete(showcaseConsents).where(eq(showcaseConsents.showcaseId, id))).rejects.toThrow();
  });

  it("an unrelated guardian, a payer-only adult, the kiosk and another organization can neither see nor publish", async () => {
    const cfg = await cfgOf(maya);
    const all = async (v: Viewer) => {
      expect(await showcaseAccess(db, v, maya)).toMatchObject({ canView: false, canDraft: false, canPublish: false, canRevoke: false });
      await denied(getShowcaseBuilder(db, v, maya));
      await denied(db.transaction((tx) => saveShowcaseDraft(tx, v, maya, cfg)));
      await denied(db.transaction((tx) => publishShowcase(tx, v, maya, { config: cfg, consent: true })));
      await denied(db.transaction((tx) => revokeShowcase(tx, v, maya)));
      await denied(db.transaction((tx) => rotateShowcaseLink(tx, v, maya)));
      await denied(db.transaction((tx) => privateShowcaseData(tx, v, maya, { forPdf: true })));
    };
    for (const k of ["chris", "sam", "kiosk", "otherOwner"]) await all(V[k]);
    // Chris becomes a payer on the Parker account. Paying is not profile access.
    await db.insert(payerAuthorizations).values({ payerAccountId: ctx.payers.parker, personId: ctx.people.chris_parker, canViewInvoices: true, canPay: true });
    try {
      await all(V.chris);
    } finally {
      await db.delete(payerAuthorizations).where(and(eq(payerAuthorizations.payerAccountId, ctx.payers.parker), eq(payerAuthorizations.personId, ctx.people.chris_parker)));
    }
    expect(await live(token)).not.toBeNull();
  });

  it("staff never draft or publish; coaches cannot revoke; the list follows coach scope", async () => {
    const cfg = await cfgOf(maya);
    for (const k of ["marcus", "tess", "erin", "rod"]) {
      await denied(db.transaction((tx) => saveShowcaseDraft(tx, V[k], maya, cfg)));
      await denied(db.transaction((tx) => publishShowcase(tx, V[k], maya, { config: cfg, consent: true })));
      await denied(db.transaction((tx) => rotateShowcaseLink(tx, V[k], maya)));
      await denied(getShowcaseBuilder(db, V[k], maya));
    }
    const id = (await rowOf(maya)).id;
    for (const k of ["marcus", "tess", "erin"]) {
      await denied(db.transaction((tx) => revokeShowcase(tx, V[k], maya)));
      await denied(db.transaction((tx) => staffRevokeShowcase(tx, V[k], id)));
    }
    await denied(db.transaction((tx) => staffRevokeShowcase(tx, V.otherOwner, id)));
    expect((await listPublishedShowcases(db, V.rod)).map((r) => r.athleteId)).toContain(maya);
    expect((await listPublishedShowcases(db, V.erin)).map((r) => r.athleteId)).toContain(maya);
    expect((await listPublishedShowcases(db, V.marcus)).map((r) => r.athleteId)).toContain(maya); // assigned
    expect((await listPublishedShowcases(db, V.tess)).map((r) => r.athleteId)).not.toContain(maya); // not assigned
    expect(await listPublishedShowcases(db, V.otherOwner)).toEqual([]);
    await denied(listPublishedShowcases(db, V.alex));
    // The staff list never carries the token, its hash, or the contact email.
    const listed = JSON.stringify(await listPublishedShowcases(db, V.rod));
    expect(listed).not.toContain(token);
    expect(listed).not.toContain(hashShareToken(token));
    expect(listed).not.toContain("family.demo@example.test");
    expect(await live(token)).not.toBeNull();
  });

  it("posting extra keys, another athlete's metric, or a non-allowlisted metric cannot widen what is shown", async () => {
    const before = await cfgOf(maya);
    // A wearable metric (sleep) recorded for Maya: on file, but never offered and never accepted.
    const [sleep] = await db.insert(metricDefinitions).values({ orgId: ctx.orgId, key: "sleep_hours_t", name: "Sleep hours", unit: "h", category: "wearable", definedBy: "wearable", higherIsBetter: true }).returning();
    const [anyType] = (await db.execute(sql`select id from test_types where org_id = ${ctx.orgId} limit 1`)).rows as { id: string }[];
    const [s] = await db.insert(testSessions).values({ orgId: ctx.orgId, athleteId: maya, testTypeId: anyType.id, testedAt: new Date("2026-02-01T12:00:00Z"), source: "wearable" }).returning();
    await db.insert(metricValues).values({ orgId: ctx.orgId, athleteId: maya, metricDefinitionId: sleep.id, testSessionId: s.id, value: 7.5, unit: "h", recordedAt: new Date("2026-02-01T12:00:00Z"), source: "wearable", aggregation: "single" });
    const catalog = (await buildCatalog(db, ctx.orgId, maya, { includeTraining: true }))!;
    expect(catalog.metrics!.map((m) => m.id)).not.toContain(sleep.id);
    // Left/right asymmetry is read as an injury screen, so it is held back too, although Maya has results for it.
    const [asym] = await db.select().from(metricDefinitions).where(and(eq(metricDefinitions.orgId, ctx.orgId), eq(metricDefinitions.key, "braking_asymmetry")));
    expect((await db.select().from(metricValues).where(and(eq(metricValues.athleteId, maya), eq(metricValues.metricDefinitionId, asym.id)))).length).toBeGreaterThan(0);
    expect(catalog.metrics!.map((m) => m.name).join()).not.toMatch(/asymmetr/i);
    await refused(db.transaction((tx) => saveShowcaseDraft(tx, V.alex, maya, { ...before, metricIds: [asym.id] })));
    expect(Object.keys(catalog.athlete).sort()).toEqual(["ageBand", "firstName", "gradYear", "lastName", "position", "school", "sport", "weightLb"]);

    await refused(db.transaction((tx) => saveShowcaseDraft(tx, V.alex, maya, { ...before, metricIds: [...before.metricIds, sleep.id] })));
    await refused(db.transaction((tx) => publishShowcase(tx, V.alex, maya, { config: { ...before, metricIds: [sleep.id] }, consent: true })));
    await refused(db.transaction((tx) => saveShowcaseDraft(tx, V.alex, maya, { ...before, exerciseIds: ["00000000-0000-4000-8000-000000000001"] })));
    await refused(db.transaction((tx) => saveShowcaseDraft(tx, V.alex, maya, { ...before, videoUrl: "http://example.com/x" })));

    const hostile = { ...before, show: { ...before.show, wellness: true, dob: true, billing: true }, wellness: true, dateOfBirth: true, notes: "x", bodyMap: true, address: "1 Main St" };
    const { row } = await db.transaction((tx) => publishShowcase(tx, V.alex, maya, { config: hostile, consent: true }));
    expect(Object.keys(row.config).sort()).toEqual([...SHOWCASE_CONFIG_KEYS].sort());
    expect(Object.keys(row.config.show).sort()).toEqual([...SHOWCASE_SHOW_KEYS].sort());
    const [consent] = await db.select().from(showcaseConsents).where(eq(showcaseConsents.showcaseId, row.id)).orderBy(sql`created_at desc`).limit(1);
    expect(Object.keys(consent.fields).sort()).toEqual([...SHOWCASE_CONFIG_KEYS].sort());
    const data = (await live(token))!;
    expect(Object.keys(data).sort()).toEqual([...SHOWCASE_DATA_KEYS].sort());
    expect(JSON.stringify(data)).not.toMatch(/sleep|1 Main St/i);
    expect(await rowOf(maya)).toMatchObject({ status: "published" });
  });

  it("guardian flags: no health access is irrelevant; no training access cannot add, change or publish numbers", async () => {
    // Jordan has training but no health access: full builder, and nothing health-related exists to see.
    const j = await getShowcaseBuilder(db, V.jordan, maya);
    expect(j.access).toMatchObject({ canDraft: true, canPublish: true, canSeeTraining: true });
    expect(j.catalog.metrics!.length).toBeGreaterThan(0);

    const link = and(eq(guardianships.guardianPersonId, ctx.people.jordan_parker), eq(guardianships.athleteId, maya));
    await db.update(guardianships).set({ canViewTraining: false }).where(link);
    try {
      const b = await getShowcaseBuilder(db, V.jordan, maya);
      expect(b.access.canSeeTraining).toBe(false);
      expect(b.catalog).toMatchObject({ metrics: null, lifts: null, consistency: null });
      const { data } = await db.transaction((tx) => privateShowcaseData(tx, V.jordan, maya));
      expect(data).toMatchObject({ tiles: [], lifts: [], consistency: [] });
      const stored = await cfgOf(maya);
      expect(stored.metricIds.length).toBeGreaterThan(0);
      // Adding or removing numbers is refused...
      await refused(db.transaction((tx) => saveShowcaseDraft(tx, V.jordan, maya, { ...stored, metricIds: stored.metricIds.slice(0, 1) })));
      // ...publishing a page that carries numbers is refused...
      await refused(db.transaction((tx) => publishShowcase(tx, V.jordan, maya, { config: { ...stored, metricIds: [], exerciseIds: [] }, consent: true })));
      // ...and a profile-only edit keeps the other guardian's choices exactly as they were.
      const res = await db.transaction((tx) => saveShowcaseDraft(tx, V.jordan, maya, { ...stored, metricIds: [], exerciseIds: [], show: { ...stored.show, sessions: false, streak: false, relativeStrength: false, school: !stored.show.school } }));
      const after = sanitizeConfig(res.row.config);
      expect(after.metricIds).toEqual(stored.metricIds);
      expect(after.exerciseIds).toEqual(stored.exerciseIds);
      expect(after.show.sessions).toBe(stored.show.sessions);
      expect(after.show.school).toBe(!stored.show.school);
      expect(res.unpublished).toBe(true);
      expect(await live(token)).toBeNull();
    } finally {
      await db.update(guardianships).set({ canViewTraining: true }).where(link);
    }
    // Casey (cannot book or pay) is still a guardian with profile access to Leo: may publish. Sam's draft is there.
    expect(await showcaseAccess(db, V.casey, ctx.athletes.leo)).toMatchObject({ relationship: "guardian", canDraft: true, canPublish: true });
    expect((await rowOf(ctx.athletes.leo)).status).toBe("draft");
    const again = await cfgOf(maya);
    await db.transaction((tx) => publishShowcase(tx, V.alex, maya, { config: again, consent: true }));
    expect(await live(token)).not.toBeNull();
  });

  it("minimum age and the org switch are settings; adults publish for themselves", async () => {
    await denied(db.transaction((tx) => saveShowcaseSettings(tx, V.erin, { enabled: true, minAge: 13, defaultExpiryDays: 90, recapEnabled: true, recapGraceDays: 3 })));
    await db.transaction((tx) => saveShowcaseSettings(tx, V.rod, { enabled: true, minAge: 16, defaultExpiryDays: 90, recapEnabled: true, recapGraceDays: 3 }));
    const young = await showcaseAccess(db, V.maya, maya);
    expect(young).toMatchObject({ canDraft: false, canPublish: false });
    expect(young.draftBlockedReason).toMatch(/parent or guardian/);
    await denied(db.transaction(async (tx) => saveShowcaseDraft(tx, V.maya, maya, await cfgOf(maya))));
    expect((await showcaseAccess(db, V.alex, maya)).canDraft).toBe(true);

    await db.transaction((tx) => saveShowcaseSettings(tx, V.rod, { enabled: false, minAge: 13, defaultExpiryDays: 90, recapEnabled: true, recapGraceDays: 3 }));
    expect(await live(token)).toBeNull();
    await denied(db.transaction(async (tx) => publishShowcase(tx, V.alex, maya, { config: await cfgOf(maya), consent: true })));
    expect((await showcaseAccess(db, V.alex, maya)).draftBlockedReason).toMatch(/turned off/);
    await db.transaction((tx) => saveShowcaseSettings(tx, V.rod, { enabled: true, minAge: 13, defaultExpiryDays: 90, recapEnabled: true, recapGraceDays: 3 }));
    expect(await live(token)).not.toBeNull();
    const [org] = await db.select().from(organizations).where(eq(organizations.id, ctx.orgId));
    expect(org.settings.showcase).toMatchObject({ enabled: true, minAge: 13 });

    // Dana is an adult athlete: she drafts and publishes herself, consent says "self".
    const dana = ctx.athletes.dana;
    expect(await showcaseAccess(db, V.dana, dana)).toMatchObject({ relationship: "self", isMinor: false, canDraft: true, canPublish: true });
    const pub = await db.transaction((tx) => publishShowcase(tx, V.dana, dana, { config: { ...DEFAULT_SHOWCASE_CONFIG, nameDisplay: "full" }, consent: true, expiryDays: 0 }));
    expect(pub.token).toMatch(TOKEN_PATTERN);
    expect(pub.row.expiresAt).toBeNull();
    const [c] = await db.select().from(showcaseConsents).where(eq(showcaseConsents.showcaseId, pub.row.id));
    expect(c.actorRelationship).toBe("self");
    expect((await live(pub.token!))!.displayName).toBe("Dana Brooks");
    // An athlete with no birthday on file is treated as a minor.
    await db.update(people).set({ dateOfBirth: null }).where(eq(people.id, ctx.people.dana_brooks));
    expect(await showcaseAccess(db, V.dana, dana)).toMatchObject({ isMinor: true, canDraft: false, canPublish: false });
  });

  it("the PDF comes from the same payload, with a content hash, and only for the family", async () => {
    const { data } = await db.transaction((tx) => privateShowcaseData(tx, V.alex, maya, { forPdf: true }));
    const { bytes, contentHash } = await renderShowcasePdf(data, { generatedAt: new Date("2026-03-02T12:00:00Z") });
    expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash).toBe(showcaseContentHash(data));
    expect(showcaseContentHash({ ...data, bio: "different" } as ShowcaseData)).not.toBe(contentHash);
    const pdf = await extractPdfText(bytes);
    const text = pdf.text.replace(/\s+/g, " ");
    expect(text).toContain("Maya P.");
    expect(text).toContain("Verified by Teamwork on");
    expect(text).toContain(contentHash);
    expect(text).not.toContain("Parker");
    expect(text.toLowerCase()).not.toMatch(/wellness check|invoice|soreness/);
    // One page for a typical Showcase.
    expect((Buffer.from(bytes).toString("latin1").match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length).toBe(1);
    // A minor athlete may download it while a guardian's publication stands, and not otherwise.
    await db.transaction((tx) => privateShowcaseData(tx, V.maya, maya, { forPdf: true }));
    await db.transaction((tx) => revokeShowcase(tx, V.alex, maya));
    await denied(db.transaction((tx) => privateShowcaseData(tx, V.maya, maya, { forPdf: true })));
    await db.transaction((tx) => privateShowcaseData(tx, V.alex, maya, { forPdf: true }));
  });

  it("revoke kills the link immediately and for good; expiry and rotation do too", async () => {
    // (The previous test revoked the seeded link.)
    expect(await live(token)).toBeNull();
    expect(await rowOf(maya)).toMatchObject({ status: "draft", tokenHash: null });
    expect(linkStateOf(await rowOf(maya))).toBe("draft");
    const cfg = await cfgOf(maya);

    // Publishing after a revoke makes a NEW link; the old one never comes back.
    const p1 = await db.transaction((tx) => publishShowcase(tx, V.alex, maya, { config: cfg, consent: true, expiryDays: 30 }));
    expect(p1.token).toMatch(TOKEN_PATTERN);
    expect(p1.token).not.toBe(token);
    expect(await live(p1.token!)).not.toBeNull();
    expect(await live(token)).toBeNull();

    // Expiry.
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect(await live(p1.token!, new Date(Date.now() + 29 * 86_400_000))).not.toBeNull();
    expect(await live(p1.token!, later)).toBeNull();
    expect(linkStateOf(await rowOf(maya), later)).toBe("expired");

    // Rotation.
    const rot = await db.transaction((tx) => rotateShowcaseLink(tx, V.alex, maya));
    expect(await live(p1.token!)).toBeNull();
    expect(await live(rot.token)).not.toBeNull();

    // The athlete herself may take it down (never needs a guardian), and it is dead in the same breath.
    await db.transaction((tx) => revokeShowcase(tx, V.maya, maya));
    expect(await live(rot.token)).toBeNull();

    // Owner revoke from the staff list: audited, recorded as a withdrawal by staff.
    const p2 = await db.transaction((tx) => publishShowcase(tx, V.alex, maya, { config: cfg, consent: true }));
    expect(await live(p2.token!)).not.toBeNull();
    await db.transaction((tx) => staffRevokeShowcase(tx, V.rod, p2.row.id));
    expect(await live(p2.token!)).toBeNull();
    const [w] = await db.select().from(showcaseConsents).where(and(eq(showcaseConsents.showcaseId, p2.row.id), eq(showcaseConsents.kind, "withdrawn"))).orderBy(sql`created_at desc`).limit(1);
    expect(w).toMatchObject({ actorRelationship: "staff", actorUserId: V.rod.userId });
    const [a] = await db.select().from(auditEvents).where(and(eq(auditEvents.entityId, p2.row.id), eq(auditEvents.action, "showcase.revoke"))).orderBy(sql`created_at desc`).limit(1);
    expect(a).toMatchObject({ actorUserId: V.rod.userId, actorRole: "owner" });
    expect((await listPublishedShowcases(db, V.rod)).map((r) => r.athleteId)).not.toContain(maya);
    // No token was ever written to the audit log.
    const audits = JSON.stringify(await db.select().from(auditEvents).where(eq(auditEvents.entityId, p2.row.id)));
    for (const t of [token, p1.token!, rot.token, p2.token!]) expect(audits).not.toContain(t);
    // An archived athlete's page closes even if it was never revoked.
    const p3 = await db.transaction((tx) => publishShowcase(tx, V.alex, maya, { config: cfg, consent: true }));
    await db.update(people).set({ status: "archived" }).where(eq(people.id, ctx.people.maya_parker));
    expect(await live(p3.token!)).toBeNull();
    await db.update(people).set({ status: "active" }).where(eq(people.id, ctx.people.maya_parker));
    expect(await live(p3.token!)).not.toBeNull();
    expect((await db.select().from(athletes).where(eq(athletes.id, maya))).length).toBe(1);
  });
});
