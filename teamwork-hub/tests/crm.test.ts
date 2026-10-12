import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  athletes,
  auditEvents,
  automationRules,
  bookings,
  commPreferences,
  guardianships,
  jobs,
  leads,
  messageDeliveries,
  messages,
  payerAuthorizations,
  payerBeneficiaries,
  people,
  scheduleSessions,
  serviceTypes,
  tasks,
} from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { dispatch, evaluate, notifySession, previewRule } from "@/lib/automation/engine";
import { convertLead, conversionPreview } from "@/lib/crm/convert";
import { createLeadFromInquiry, RATE_LIMIT, type InquiryInput } from "@/lib/crm/intake";
import { changeStage, getLead, listLeads, scheduleAssessment, upcomingAssessmentSessions } from "@/lib/crm/leads";
import { createStage, deleteStage, listStages } from "@/lib/crm/stages";
import { DomainError } from "@/lib/messaging/errors";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
const db = () => testDb();

beforeAll(async () => {
  ctx = await seedOrg();
});
afterAll(closeTestDb);

const inquiry = (x: Partial<InquiryInput> = {}): InquiryInput => ({
  inquiringFor: "child",
  contactFirstName: "Robin",
  contactLastName: "Testerson",
  email: `robin.${Math.random().toString(36).slice(2)}@example.test`,
  athleteFirstName: "Sky",
  athleteLastName: "Testerson",
  athleteAge: 12,
  sport: "Soccer",
  consentEmail: true,
  consentSms: false,
  preferredTimes: [],
  ...x,
});

describe("lead intake", () => {
  it("creates people + lead (stage new) + follow-up task for the owner + consent with source and timestamp", async () => {
    const r = await db().transaction((tx) => createLeadFromInquiry(tx, ctx.orgId, inquiry({ phone: "+1 812 555 0300", consentSms: true }), { ip: "10.0.0.1" }));
    const [lead] = await db().select().from(leads).where(eq(leads.id, r.leadId));
    expect(lead.stage).toBe("new");
    expect(lead.ownerUserId).toBe(ctx.users.erin); // seeded default owner
    expect(lead.contactPersonId).not.toBe(lead.personId);
    const [athletePerson] = await db().select().from(people).where(eq(people.id, lead.personId));
    expect(athletePerson.status).toBe("lead");
    const [task] = await db().select().from(tasks).where(and(eq(tasks.relatedType, "lead"), eq(tasks.relatedId, lead.id)));
    expect(task.assigneeUserId).toBe(ctx.users.erin);
    const prefs = await db().select().from(commPreferences).where(eq(commPreferences.personId, lead.contactPersonId!));
    expect(prefs.find((p) => p.channel === "sms")!.consent).toBe("opted_in");
    expect(prefs.find((p) => p.channel === "sms")!.consentSource).toMatch(/form/);
    expect(prefs.every((p) => p.capturedAt instanceof Date)).toBe(true);
    const [job] = await db().select().from(jobs).where(eq(jobs.dedupeKey, `automation.evaluate:lead_created:${lead.id}`));
    expect(job).toBeDefined();
  });

  it("validates server-side", async () => {
    await expect(db().transaction((tx) => createLeadFromInquiry(tx, ctx.orgId, inquiry({ email: undefined, phone: undefined })))).rejects.toThrow();
    await expect(db().transaction((tx) => createLeadFromInquiry(tx, ctx.orgId, inquiry({ athleteFirstName: "" })))).rejects.toThrow();
    await expect(db().transaction((tx) => createLeadFromInquiry(tx, ctx.orgId, inquiry({ consentSms: true, phone: undefined })))).rejects.toThrow();
  });

  it("rate-limits per IP", async () => {
    for (let i = 0; i < RATE_LIMIT.max; i++) {
      await db().transaction((tx) => createLeadFromInquiry(tx, ctx.orgId, inquiry(), { ip: "10.9.9.9" }));
    }
    await expect(db().transaction((tx) => createLeadFromInquiry(tx, ctx.orgId, inquiry(), { ip: "10.9.9.9" }))).rejects.toBeInstanceOf(DomainError);
    await db().transaction((tx) => createLeadFromInquiry(tx, ctx.orgId, inquiry(), { ip: "10.9.9.10" }));
  });

  it("flags a matching email as a possible duplicate without merging", async () => {
    const r = await db().transaction((tx) =>
      createLeadFromInquiry(tx, ctx.orgId, inquiry({ contactFirstName: "Alex", contactLastName: "Parker", email: "ALEX.PARKER@example.test", athleteFirstName: "Pip", athleteLastName: "Parker" })),
    );
    expect(r.possibleDuplicates.map((d) => d.personId)).toContain(ctx.people.alex_parker);
    const [lead] = await db().select().from(leads).where(eq(leads.id, r.leadId));
    expect(lead.contactPersonId).not.toBe(ctx.people.alex_parker);
    const erin = await viewerFor(ctx, "erin");
    const row = (await listLeads(db(), erin)).find((l) => l.id === r.leadId)!;
    expect(row.possibleDuplicate).toBe(true);
  });
});

describe("pipeline", () => {
  it("only CRM staff can see leads", async () => {
    for (const k of ["alex", "marcus", "dana"]) {
      await expect(listLeads(db(), await viewerFor(ctx, k))).rejects.toBeInstanceOf(AuthzError);
    }
    expect((await listLeads(db(), await viewerFor(ctx, "erin"))).length).toBeGreaterThanOrEqual(8);
  });

  it("filters by stage, owner and age", async () => {
    const erin = await viewerFor(ctx, "erin");
    const lost = await listLeads(db(), erin, { stage: "lost" });
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.every((l) => l.stage === "lost")).toBe(true);
    expect((await listLeads(db(), erin, { owner: "me" })).every((l) => l.ownerUserId === erin.userId)).toBe(true);
    const adults = await listLeads(db(), erin, { minAge: 18 });
    expect(adults.every((l) => l.age! >= 18)).toBe(true);
    expect(adults.some((l) => l.id === ctx.extra.crm.lead_new_adult)).toBe(true);
  });

  it("stage changes are audited; lost requires a reason; won only through conversion", async () => {
    const erin = await viewerFor(ctx, "erin");
    const id = ctx.extra.crm.lead_new;
    await expect(changeStage(db(), erin, id, { stage: "lost" })).rejects.toBeInstanceOf(DomainError);
    await expect(changeStage(db(), erin, id, { stage: "won" })).rejects.toThrow(/Convert/);
    await changeStage(db(), erin, id, { stage: "contacted" });
    const hist = await db().select().from(auditEvents).where(and(eq(auditEvents.entityId, id), eq(auditEvents.action, "crm.lead_stage_changed")));
    expect(hist.at(-1)!.before).toMatchObject({ stage: "new" });
    expect(hist.at(-1)!.after).toMatchObject({ stage: "contacted" });
    const detail = await getLead(db(), erin, id);
    expect(detail.history.some((h) => h.action === "crm.lead_stage_changed")).toBe(true);
  });

  it("stages are configurable but a stage in use cannot be deleted", async () => {
    const erin = await viewerFor(ctx, "erin");
    const s = await createStage(db(), erin, { label: "Trial week", kind: "open" });
    const stages = await listStages(db(), ctx.orgId);
    const won = stages.find((x) => x.isWon)!;
    expect(s.sortOrder).toBeLessThan(won.sortOrder);
    await expect(deleteStage(db(), erin, stages.find((x) => x.key === "lost")!.id)).rejects.toThrow(/Move them/);
    await deleteStage(db(), erin, s.id);
  });

  it("schedule assessment lists only upcoming assessment sessions", async () => {
    const erin = await viewerFor(ctx, "erin");
    expect(await upcomingAssessmentSessions(db(), ctx.orgId)).toHaveLength(0);
    const [cls] = await db().insert(serviceTypes).values({ orgId: ctx.orgId, name: "Group class", kind: "class" }).returning();
    const [st] = await db().insert(serviceTypes).values({ orgId: ctx.orgId, name: "Athlete assessment", kind: "assessment" }).returning();
    const start = new Date(Date.now() + 3 * 86_400_000);
    const mk = (serviceTypeId: string, title: string) =>
      db().insert(scheduleSessions).values({ orgId: ctx.orgId, serviceTypeId, title, startsAt: start, endsAt: new Date(start.getTime() + 3_600_000), timezone: ctx.tz, capacity: 2 }).returning();
    await mk(cls.id, "Speed class");
    const [assess] = await mk(st.id, "Assessment block");
    const opts = await upcomingAssessmentSessions(db(), ctx.orgId);
    expect(opts.map((o) => o.id)).toEqual([assess.id]);
    const id = ctx.extra.crm.lead_contacted;
    await scheduleAssessment(db(), erin, id, assess.id);
    const [l] = await db().select().from(leads).where(eq(leads.id, id));
    expect(l.assessmentSessionId).toBe(assess.id);
    expect(l.stage).toBe("assessment_booked");
  });
});

describe("conversion", () => {
  it("never merges silently: a duplicate email requires an explicit link-or-create choice", async () => {
    const erin = await viewerFor(ctx, "erin");
    const leadId = ctx.extra.crm.lead_duplicate; // Alex Parker's email, child Nora
    const pv = await conversionPreview(db(), erin, leadId);
    expect(pv.guardianCandidates.map((c) => c.personId)).toContain(ctx.people.alex_parker);

    await expect(db().transaction((tx) => convertLead(tx, erin, { leadId }))).rejects.toThrow(/link existing.*create new/);
    // Cannot link to someone who is not a listed candidate.
    await expect(db().transaction((tx) => convertLead(tx, erin, { leadId, guardianChoice: `link:${ctx.people.chris_parker}` }))).rejects.toThrow(/listed possible matches/);
    // Nothing was written by the failed attempts.
    const [still] = await db().select().from(leads).where(eq(leads.id, leadId));
    expect(still.convertedAt).toBeNull();

    // Explicit choice: link the existing Alex; reuse Alex's existing payer account.
    const res = await db().transaction((tx) =>
      convertLead(tx, erin, { leadId, guardianChoice: `link:${ctx.people.alex_parker}`, household: ctx.households.parker, payer: ctx.payers.parker }),
    );
    const [lead] = await db().select().from(leads).where(eq(leads.id, leadId));
    expect(lead.convertedAt).not.toBeNull();
    expect(lead.convertedAthleteId).toBe(res.athleteId);
    expect(lead.stage).toBe("won");
    const [g] = await db().select().from(guardianships).where(eq(guardianships.athleteId, res.athleteId));
    expect(g.guardianPersonId).toBe(ctx.people.alex_parker);
    const [ben] = await db().select().from(payerBeneficiaries).where(eq(payerBeneficiaries.athleteId, res.athleteId));
    expect(ben.payerAccountId).toBe(ctx.payers.parker);
    // The intake-created contact record still exists (archived, pointing at Alex) — not deleted, not merged.
    const [orig] = await db().select().from(people).where(eq(people.id, lead.contactPersonId!));
    expect(orig.status).toBe("archived");
    expect(orig.customFields).toMatchObject({ linkedToPersonId: ctx.people.alex_parker });
    // Alex's own record is untouched.
    const [alex] = await db().select().from(people).where(eq(people.id, ctx.people.alex_parker));
    expect(alex.status).toBe("active");
    expect(await db().select().from(jobs).where(eq(jobs.dedupeKey, `crm.lead_converted:${leadId}`))).toHaveLength(1);
    await expect(db().transaction((tx) => convertLead(tx, erin, { leadId, guardianChoice: "new" }))).rejects.toThrow(/already been converted/);
  });

  it("create-new on a duplicate creates separate people with their own payer", async () => {
    const erin = await viewerFor(ctx, "erin");
    const r = await db().transaction((tx) =>
      createLeadFromInquiry(tx, ctx.orgId, inquiry({ contactFirstName: "Sam", contactLastName: "Rivera", email: "sam.rivera@example.test", athleteFirstName: "Mia", athleteLastName: "Rivera" })),
    );
    const res = await db().transaction((tx) => convertLead(tx, erin, { leadId: r.leadId, guardianChoice: "new" }));
    const [g] = await db().select().from(guardianships).where(eq(guardianships.athleteId, res.athleteId));
    expect(g.guardianPersonId).not.toBe(ctx.people.sam_rivera);
    const auths = await db().select().from(payerAuthorizations).where(eq(payerAuthorizations.payerAccountId, res.payerAccountId));
    expect(auths.map((a) => a.personId)).toEqual([g.guardianPersonId]);
    expect(auths[0].canPay).toBe(true);
    const [a] = await db().select().from(athletes).where(eq(athletes.id, res.athleteId));
    expect(a.active).toBe(true);
  });

  it("guardians and coaches cannot convert", async () => {
    for (const k of ["alex", "marcus"]) {
      await expect(convertLead(db(), await viewerFor(ctx, k), { leadId: ctx.extra.crm.lead_done })).rejects.toBeInstanceOf(AuthzError);
    }
  });
});

describe("automations", () => {
  it("are disabled by default and dedupe per (rule, entity, recipient, period)", async () => {
    const rules = await db().select().from(automationRules).where(eq(automationRules.orgId, ctx.orgId));
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => !r.enabled)).toBe(true);

    const rule = rules.find((r) => r.trigger === "lead_created")!;
    await db().update(automationRules).set({ enabled: true, delayMinutes: 0 }).where(eq(automationRules.id, rule.id));
    const leadId = ctx.extra.crm.lead_booked;
    const e1 = await db().transaction((tx) => evaluate(tx, { orgId: ctx.orgId, trigger: "lead_created", leadId }));
    const e2 = await db().transaction((tx) => evaluate(tx, { orgId: ctx.orgId, trigger: "lead_created", leadId }));
    expect(e1.enqueued).toBe(1);
    expect(e2.enqueued).toBe(0);
    const js = await db().select().from(jobs).where(and(eq(jobs.orgId, ctx.orgId), eq(jobs.type, "automation.dispatch"), sql`${jobs.payload}->>'ruleId' = ${rule.id}`));
    expect(js).toHaveLength(1);
    // Running the dispatch twice (e.g. a retry) still yields one message.
    const p = js[0].payload as Parameters<typeof dispatch>[1];
    await db().transaction((tx) => dispatch(tx, p));
    const again = await db().transaction((tx) => dispatch(tx, p));
    expect(again.duplicate).toBe(true);
    const msgs = await db().select().from(messages).where(eq(messages.automationRuleId, rule.id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toContain("Tobi");
    expect(msgs[0].body).not.toContain("{{");
    // Lead contact has no SMS; rule channel is email; consent from the inquiry form is opted in.
    const ds = await db().select().from(messageDeliveries).where(eq(messageDeliveries.messageId, msgs[0].id));
    expect(ds.map((d) => d.channel).sort()).toEqual(["email", "in_app"]);
    await db().update(automationRules).set({ enabled: false }).where(eq(automationRules.id, rule.id));
  });

  it("preview lists recipients after routing/consent without sending", async () => {
    const erin = await viewerFor(ctx, "erin");
    const rule = (await db().select().from(automationRules).where(and(eq(automationRules.orgId, ctx.orgId), eq(automationRules.trigger, "session_cancelled"))))[0];
    const [st] = await db().insert(serviceTypes).values({ orgId: ctx.orgId, name: "Speed", kind: "class" }).returning();
    const start = new Date(Date.now() + 86_400_000);
    const [s] = await db()
      .insert(scheduleSessions)
      .values({ orgId: ctx.orgId, serviceTypeId: st.id, title: "Speed & Agility", startsAt: start, endsAt: new Date(start.getTime() + 3_600_000), timezone: ctx.tz, capacity: 10, status: "cancelled" })
      .returning();
    await db().insert(bookings).values({ orgId: ctx.orgId, sessionId: s.id, athleteId: ctx.athletes.maya, status: "booked" });
    const countBefore = (await db().select({ n: sql<number>`count(*)::int` }).from(messages))[0].n;
    const pv = await previewRule(db(), erin, rule.id, s.id);
    const countAfter = (await db().select({ n: sql<number>`count(*)::int` }).from(messages))[0].n;
    expect(countAfter).toBe(countBefore);
    expect(pv.items).toHaveLength(1);
    const item = pv.items[0];
    expect(item.subject).toBe("Cancelled: Speed & Agility");
    expect(item.body).toContain("Maya");
    const names = item.recipients.map((r) => r.personId).sort();
    expect(names).toEqual([ctx.people.alex_parker, ctx.people.jordan_parker].sort());
    const jordan = item.recipients.find((r) => r.personId === ctx.people.jordan_parker)!;
    expect(jordan.channels.find((c) => c.channel === "email")!.status).toBe("suppressed");
    expect(item.excludedNote).toMatch(/Minor/);
    expect(await db().select().from(jobs).where(sql`${jobs.payload}->>'ruleId' = ${rule.id}`)).toHaveLength(0);

    // With the rule disabled, notify.session_cancelled still sends a plain in-app notice (once).
    const n1 = await db().transaction((tx) => notifySession(tx, "session_cancelled", { sessionId: s.id }));
    const n2 = await db().transaction((tx) => notifySession(tx, "session_cancelled", { sessionId: s.id }));
    expect(n1).toMatchObject({ mode: "default_in_app", sent: 2 });
    expect(n2).toMatchObject({ sent: 0 });
  });

  it("attendance_lapsed fires once per lapse", async () => {
    const rule = (await db().select().from(automationRules).where(and(eq(automationRules.orgId, ctx.orgId), eq(automationRules.trigger, "attendance_lapsed"))))[0];
    await db().update(automationRules).set({ enabled: true }).where(eq(automationRules.id, rule.id));
    const [st] = await db().insert(serviceTypes).values({ orgId: ctx.orgId, name: "Lift", kind: "class" }).returning();
    const past = new Date(Date.now() - 30 * 86_400_000);
    const [s] = await db()
      .insert(scheduleSessions)
      .values({ orgId: ctx.orgId, serviceTypeId: st.id, title: "Lift", startsAt: past, endsAt: new Date(past.getTime() + 3_600_000), timezone: ctx.tz, capacity: 10, status: "completed" })
      .returning();
    await db().insert(bookings).values({ orgId: ctx.orgId, sessionId: s.id, athleteId: ctx.athletes.dana, status: "attended" });
    const a = await db().transaction((tx) => evaluate(tx, { orgId: ctx.orgId, trigger: "attendance_lapsed" }));
    const b = await db().transaction((tx) => evaluate(tx, { orgId: ctx.orgId, trigger: "attendance_lapsed" }));
    expect(a.enqueued).toBe(1); // Dana (adult) receives her own
    expect(a.tasksCreated).toBe(1);
    expect(b.enqueued).toBe(0);
    expect(b.tasksCreated).toBe(0);
    const js = await db().select().from(jobs).where(sql`${jobs.payload}->>'ruleId' = ${rule.id}`);
    expect(js.map((j) => (j.payload as { recipientPersonId: string }).recipientPersonId)).toEqual([ctx.people.dana_brooks]);
    await db().update(automationRules).set({ enabled: false }).where(eq(automationRules.id, rule.id));
    // Disabled before dispatch → the queued job is skipped, nothing sent.
    const res = await db().transaction((tx) => dispatch(tx, js[0].payload as Parameters<typeof dispatch>[1]));
    expect(res).toMatchObject({ skipped: "rule disabled" });
    expect(await db().select().from(messages).where(inArray(messages.automationRuleId, [rule.id]))).toHaveLength(0);
  });
});
