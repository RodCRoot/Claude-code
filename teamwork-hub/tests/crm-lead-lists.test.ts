import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { athletes, auditEvents, leads } from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { convertLead, conversionPreview } from "@/lib/crm/convert";
import { createLeadFromInquiry, RATE_LIMIT, type InquiryInput } from "@/lib/crm/intake";
import { KEEP, NO_SOURCE, interestDisplay, leadLists, leadSport, listChoice, normalizeLeadInterest, normalizeLeadSource, sourceDisplay, utmFrom } from "@/lib/crm/lead-vocab";
import { getLead, leadSources, listLeads, updateLeadMarketing } from "@/lib/crm/leads";
import { DomainError } from "@/lib/messaging/errors";
import { REPORTS } from "@/lib/reports";
import { scoreboardContext } from "@/lib/scoreboard/core";
import { marketingEconomics, saveSpend } from "@/lib/scoreboard/marketing";
import { saveVocabExtras } from "@/lib/zenplanner/vocab";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

const db = testDb();
let ctx: Awaited<ReturnType<typeof seedOrg>>;
type V = Awaited<ReturnType<typeof viewerFor>>;
let rod: V;
let erin: V;
let marcus: V;
let n = 0;

const inquiry = (x: Partial<InquiryInput> = {}): InquiryInput => {
  n += 1;
  return {
    inquiringFor: "child",
    contactFirstName: "Pat",
    contactLastName: `Listtest${n}`,
    email: `pat.listtest${n}@example.test`,
    athleteFirstName: "Kit",
    athleteLastName: `Listtest${n}`,
    athleteAge: 14,
    sport: "Volleyball",
    preferredTimes: [],
    consentEmail: false,
    consentSms: false,
    ...x,
  };
};
const make = async (x: Partial<InquiryInput> = {}, channel = "web_inquiry") => {
  const r = await db.transaction((tx) => createLeadFromInquiry(tx, ctx.orgId, inquiry(x), { source: channel }));
  const [lead] = await db.select().from(leads).where(eq(leads.id, r.leadId));
  return lead;
};

beforeAll(async () => {
  ctx = await seedOrg("2026-03-02", { modules: ["scheduling", "billing"] });
  rod = await viewerFor(ctx, "rod");
  erin = await viewerFor(ctx, "erin");
  marcus = await viewerFor(ctx, "marcus");
});
afterAll(closeTestDb);

describe("normalising stored values", () => {
  it("maps list values, older spellings and unknown text, and never invents a source", () => {
    expect(normalizeLeadSource("facebook")).toEqual({ label: "Facebook", onList: true });
    expect(normalizeLeadSource("web_inquiry")).toEqual({ label: "Website", onList: true });
    expect(normalizeLeadSource("walk_in")).toEqual({ label: "Walk-in", onList: true });
    expect(normalizeLeadSource("Walk-In")).toEqual({ label: "Walk-in", onList: true });
    expect(normalizeLeadSource("referral")).toEqual({ label: "Referral", onList: true });
    expect(normalizeLeadSource("instagram")).toEqual({ label: "Instagram", onList: false });
    for (const none of [null, "", "  ", "staff", "zenplanner"]) expect(normalizeLeadSource(none).label).toBe(NO_SOURCE);
    expect(normalizeLeadSource("Radio", { source: ["Radio"] })).toEqual({ label: "Radio", onList: true });
    expect(normalizeLeadInterest("weight loss")).toEqual({ label: "Weight Loss", onList: true });
    expect(normalizeLeadInterest("Volleyball")).toEqual({ label: "Volleyball", onList: false });
    expect(sourceDisplay("Other", "Radio ad")).toBe("Other: Radio ad");
    expect(sourceDisplay("staff", null)).toBeNull();
    expect(interestDisplay("Other", null)).toBe("Other");
  });

  it("a form choice must be on the list; free text is only kept beside Other", () => {
    expect(listChoice("source", "FLYER", "ignored")).toEqual({ value: "Flyer", other: null });
    expect(listChoice("source", "Other", "  Radio ad ")).toEqual({ value: "Other", other: "Radio ad" });
    expect(listChoice("source", "<script>", "x")).toEqual({ value: null, other: null });
    expect(listChoice("priority", "high", null).value).toBe("High");
    expect(leadLists().priorities).toEqual(["Low", "Medium", "High"]);
    expect(leadLists({ interest: ["Speed Camp"] }).interests).toContain("Speed Camp");
  });

  it("reads tracking values from a query string or a stored lead", () => {
    expect(utmFrom({ utm_source: "google", utm_campaign: " spring ", utm_medium: "cpc", utm_term: "speed training", other: "x" })).toEqual({ source: "google", campaign: "spring", medium: "cpc", term: "speed training" });
    expect(utmFrom({ source: "fb", campaign: null, medium: null, term: null })).toEqual({ source: "fb", campaign: null, medium: null, term: null });
    expect(utmFrom({ org: "x" })).toBeNull();
    expect(utmFrom({ utm_source: "a".repeat(500) })!.source).toHaveLength(200);
  });
});

describe("lead forms store list values", () => {
  it("public form: a chosen source and interest are stored in the list's spelling, with the sport kept separately", async () => {
    const lead = await make({ leadSource: "facebook", leadInterest: "performance training" });
    expect(lead.source).toBe("Facebook");
    expect(lead.interest).toBe("Performance Training");
    const inq = lead.inquiry as Record<string, unknown>;
    expect(inq.channel).toBe("web_inquiry");
    expect(inq.sport).toBe("Volleyball");
    expect(leadSport(lead)).toBe("Volleyball");
  });

  it("Other keeps its free text; a value that is not on the list is not stored as typed", async () => {
    const other = await make({ leadSource: "Other", heardFrom: "Radio ad", leadInterest: "Other", interestOther: "Rehab after surgery" });
    expect(other.source).toBe("Other");
    expect((other.inquiry as Record<string, unknown>).sourceOther).toBe("Radio ad");
    expect((other.inquiry as Record<string, unknown>).interestOther).toBe("Rehab after surgery");
    const forged = await make({ leadSource: "Totally made up", leadInterest: "Nope", priority: "Urgent" });
    expect(forged.source).toBe("web_inquiry"); // falls back to the channel, exactly as before this change
    expect(forged.interest).toBe("Volleyball");
    expect((forged.inquiry as Record<string, unknown>).priority).toBeNull();
  });

  it("without a choice nothing changes for existing callers, and the row still reads as Website", async () => {
    const lead = await make();
    expect(lead.source).toBe("web_inquiry");
    expect(lead.interest).toBe("Volleyball");
    const d = await getLead(db, erin, lead.id);
    expect(normalizeLeadSource(d.lead.source).label).toBe("Website");
    const row = (await listLeads(db, erin, { q: (await getLead(db, erin, lead.id)).person.lastName })).find((r) => r.id === lead.id)!;
    expect(row).toMatchObject({ sourceLabel: "Website", sport: "Volleyball", interestLabel: null });
  });

  it("UTM values from the link are stored on the lead and survive absent ones", async () => {
    const lead = await make({ utm: { source: "google", campaign: "spring-speed", medium: "cpc", term: "speed training bloomington" } });
    expect((lead.inquiry as Record<string, unknown>).utm).toEqual({ source: "google", campaign: "spring-speed", medium: "cpc", term: "speed training bloomington" });
    const none = await make({ utm: { source: "", campaign: "", medium: "", term: "" } });
    expect("utm" in (none.inquiry as Record<string, unknown>)).toBe(false);
  });

  it("staff form: source, interest and priority from the lists", async () => {
    const lead = await make({ leadSource: "Walk-in", leadInterest: "General Fitness", priority: "High" }, "staff");
    expect(lead).toMatchObject({ source: "Walk-in", interest: "General Fitness" });
    expect((lead.inquiry as Record<string, unknown>).priority).toBe("High");
    const none = await make({}, "staff");
    expect(none.source).toBe("staff");
    expect(normalizeLeadSource(none.source).label).toBe(NO_SOURCE);
  });

  it("the public rate limit still counts web inquiries that chose a list source", async () => {
    const fresh = await seedOrg("2026-03-02", { modules: [] });
    const web = (i: number) => db.transaction((tx) => createLeadFromInquiry(tx, fresh.orgId, inquiry({ leadSource: i % 2 ? "Facebook" : undefined }), { source: "web_inquiry" }));
    for (let i = 0; i < RATE_LIMIT.orgWebMax; i++) await web(i);
    await expect(web(1)).rejects.toBeInstanceOf(DomainError);
    await expect(web(2)).rejects.toBeInstanceOf(DomainError);
    // Staff-entered leads are never limited.
    await db.transaction((tx) => createLeadFromInquiry(tx, fresh.orgId, inquiry({ leadSource: "Facebook" }), { source: "staff" }));
  });
});

describe("editing a lead", () => {
  it("staff change source, interest and priority from the lists (audited); coaches cannot", async () => {
    const lead = await make();
    await expect(db.transaction((tx) => updateLeadMarketing(tx, marcus, lead.id, { source: "Flyer" }))).rejects.toBeInstanceOf(AuthzError);
    await expect(db.transaction((tx) => updateLeadMarketing(tx, erin, lead.id, { source: "Billboard", interest: KEEP, priority: KEEP }))).rejects.toBeInstanceOf(DomainError);
    await db.transaction((tx) => updateLeadMarketing(tx, erin, lead.id, { source: "Other", sourceOther: "County fair booth", interest: "Weight Loss", priority: "Medium" }));
    const [after] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(after).toMatchObject({ source: "Other", interest: "Weight Loss" });
    const inq = after.inquiry as Record<string, unknown>;
    expect(inq).toMatchObject({ sourceOther: "County fair booth", priority: "Medium", sport: "Volleyball" });
    const [a] = await db.select().from(auditEvents).where(and(eq(auditEvents.entityId, lead.id), eq(auditEvents.action, "crm.lead_marketing_update")));
    expect(a.actorUserId).toBe(erin.userId);
    expect(a.before).toMatchObject({ source: "web_inquiry" });
  });

  it("an older value that is not on the list stays valid: it is displayed, kept on save, and its sport is not lost", async () => {
    const lead = await make();
    // Rows written before the lists existed: the staff form's old "instagram" key, and the sport in `interest` with no inquiry.sport.
    await db.update(leads).set({ source: "instagram", interest: "Lacrosse", inquiry: { inquiringFor: "child", athleteAge: 14 } }).where(eq(leads.id, lead.id));
    let [cur] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(sourceDisplay(cur.source, null)).toBe("Instagram");
    expect(leadSport(cur)).toBe("Lacrosse");
    await db.transaction((tx) => updateLeadMarketing(tx, erin, lead.id, { source: KEEP, interest: KEEP, priority: "Low" }));
    [cur] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(cur).toMatchObject({ source: "instagram", interest: "Lacrosse" });
    // Choosing an Interest moves the old sport aside instead of overwriting it.
    await db.transaction((tx) => updateLeadMarketing(tx, erin, lead.id, { source: KEEP, interest: "Performance Training", priority: KEEP }));
    [cur] = await db.select().from(leads).where(eq(leads.id, lead.id));
    expect(cur.interest).toBe("Performance Training");
    expect(leadSport(cur)).toBe("Lacrosse");
    // Conversion offers the sport, not the interest, as the athlete's sport.
    const pv = await conversionPreview(db, rod, lead.id);
    expect(leadSport(pv.lead)).toBe("Lacrosse");
  });

  it("conversion uses the sport even when an Interest was chosen", async () => {
    const lead = await make({ leadInterest: "Endurance", sport: "Track" });
    const r = await db.transaction((tx) => convertLead(tx, rod, { leadId: lead.id, dateOfBirth: "2012-01-05" }));
    const [ath] = await db.select().from(athletes).where(eq(athletes.id, r.athleteId));
    expect(ath.sport).toBe("Track");
  });
});

describe("grouping by the normalised value", () => {
  it("the leads list filter and the source list use normalised labels", async () => {
    const fresh = await seedOrg("2026-03-02", { modules: [] });
    const v = await viewerFor(fresh, "erin");
    const add = (x: Partial<InquiryInput>, channel: string) => db.transaction((tx) => createLeadFromInquiry(tx, fresh.orgId, inquiry(x), { source: channel }));
    await add({}, "web_inquiry");
    await add({ leadSource: "Website" }, "web_inquiry");
    await add({ leadSource: "Facebook" }, "web_inquiry");
    await add({}, "staff");
    const legacy = await add({}, "staff");
    await db.update(leads).set({ source: "walk_in" }).where(eq(leads.id, legacy.leadId));
    expect(await leadSources(db, fresh.orgId)).toEqual(["Facebook", NO_SOURCE, "Walk-in", "Website"].sort());
    expect(await listLeads(db, v, { source: "Website" })).toHaveLength(2);
    expect(await listLeads(db, v, { source: "Walk-in" })).toHaveLength(1);
    expect(await listLeads(db, v, { source: NO_SOURCE })).toHaveLength(1);
    expect(await listLeads(db, v, { source: "Newspaper Advertisement" })).toHaveLength(0);

    // The report: one row per normalised source and per interest.
    const def = REPORTS.find((r) => r.key === "leads-by-source")!;
    expect(def.cap).toBe("crm.manage");
    const res = await def.run(db, fresh.orgId, { from: "2020-01-01", to: "2099-01-01", tz: "America/Indiana/Indianapolis" });
    const src = Object.fromEntries(res.rows.filter((r) => r.group === "Source").map((r) => [r.value, r.leads]));
    expect(src).toEqual({ Website: 2, Facebook: 1, "Walk-in": 1, [NO_SOURCE]: 1 });
    const int = res.rows.filter((r) => r.group === "Interest");
    expect(int).toHaveLength(1); // every lead here only recorded a sport
    expect(int[0]).toMatchObject({ value: "No interest recorded", leads: 5 });

    // The scoreboard marketing page groups the same way, and spend typed as "website" lines up with it.
    const owner = await viewerFor(fresh, "rod");
    const month = new Date().toISOString().slice(0, 7);
    await db.transaction((tx) => saveSpend(tx, owner, { month, channel: "website", amount: "100.00" }));
    const c = await scoreboardContext(db, owner, {});
    const mk = await marketingEconomics(db, owner, c, { months: 2 });
    const web = mk.channels.find((x) => x.channel === "Website")!;
    expect(web).toMatchObject({ leads: 2, spendMinor: 10000, costPerLeadMinor: 5000 });
    expect(mk.channels.map((x) => x.channel)).not.toContain("web_inquiry");
    expect(mk.channels.find((x) => x.channel === "Walk-in")!.leads).toBe(1);
  });

  it("an owner-added list value is a first-class source", async () => {
    await db.transaction((tx) => saveVocabExtras(tx, rod, "source", ["Yard Sign"]));
    const lead = await make({ leadSource: "yard sign" });
    expect(lead.source).toBe("Yard Sign");
    expect((await leadSources(db, ctx.orgId))).toContain("Yard Sign");
  });
});
