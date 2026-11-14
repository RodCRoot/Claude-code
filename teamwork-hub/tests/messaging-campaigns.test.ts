import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  athletes,
  campaignRecipients,
  campaigns,
  formRequests,
  formTemplates,
  formTemplateVersions,
  jobs,
  messageDeliveries,
  messages,
  messageTemplates,
  segments,
} from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { jobHandlers } from "@/lib/jobs-registry";
import {
  approveCampaign,
  campaignReport,
  cancelCampaign,
  createCampaign,
  previewCampaign,
  rejectCampaign,
  sendCampaign,
  submitCampaign,
  updateCampaign,
} from "@/lib/messaging/campaigns";
import { deliverOne } from "@/lib/messaging/delivery";
import { DomainError } from "@/lib/messaging/errors";
import { createSegment, filterOptions, filtersFromFields, listSegments, parseFilters, previewSegment, resolveSegment, updateSegment } from "@/lib/messaging/segments";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
const tx = () => testDb();
/** Far-future instant (12:00 EST) so delivery/send jobs we create are never claimed by other test files' workers. */
const NOON = new Date("2031-03-04T17:00:00Z");
let templateId: string;
let medicalTemplateId: string;

const ENV_KEYS = ["EMAIL_PROVIDER", "EMAIL_API_KEY", "EMAIL_FROM", "SMS_PROVIDER", "SMS_ACCOUNT_SID", "SMS_AUTH_TOKEN", "SMS_FROM", "DELIVERY_ENABLED", "DELIVERY_TEST_RECIPIENTS"];

beforeAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  ctx = await seedOrg();
  const [t] = await tx()
    .insert(messageTemplates)
    .values({ orgId: ctx.orgId, key: "test_announce", name: "Gym closure", channel: "email", subject: "Closed Monday: {{org_name}}", body: "Hi {{recipient_first_name}}, the gym is closed Monday. See you Tuesday, {{athlete_first_name}}!", isSample: false })
    .returning();
  templateId = t.id;
  // A medical form (health data) pending for Maya.
  const [mt] = await tx().insert(formTemplates).values({ orgId: ctx.orgId, name: "Concussion clearance", kind: "medical" }).returning();
  medicalTemplateId = mt.id;
  const [mv] = await tx()
    .insert(formTemplateVersions)
    .values({ templateId: mt.id, version: 1, title: "Concussion clearance", bodyMarkdown: "Test", signers: [{ role: "guardian", required: true }], contentHash: createHash("sha256").update("x").digest("hex"), status: "published", isSampleText: true })
    .returning();
  await tx().insert(formRequests).values({ orgId: ctx.orgId, templateVersionId: mv.id, subjectPersonId: ctx.people.maya_parker, athleteId: ctx.athletes.maya, status: "pending" });
});
afterAll(async () => {
  await closeTestDb();
});

const names = (r: Awaited<ReturnType<typeof resolveSegment>>) => r.recipients.map((x) => x.recipient.personId);

describe("segments", () => {
  it("filters by sport, routes minors to guardians (not the minor), adults to themselves", async () => {
    const soccer = await resolveSegment(tx(), ctx.orgId, parseFilters({ audience: "athletes", sport: "volleyball" }));
    expect(soccer.matched).toBe(2); // Maya + Harper
    expect(names(soccer)).toEqual(expect.arrayContaining([ctx.people.alex_parker, ctx.people.jordan_parker]));
    expect(names(soccer)).not.toContain(ctx.people.maya_parker);
    expect(soccer.excluded.some((e) => e.reason.match(/Minor/))).toBe(true);

    const adults = await resolveSegment(tx(), ctx.orgId, parseFilters({ audience: "athletes", recipientRole: "athlete" }));
    expect(names(adults)).toContain(ctx.people.dana_brooks);
    expect(adults.recipients.every((r) => r.recipient.role === "athlete")).toBe(true);
  });

  it("a guardian of two matching athletes is one recipient", async () => {
    const r = await resolveSegment(tx(), ctx.orgId, parseFilters({ audience: "athletes", athleteActive: "active" }));
    const alex = r.recipients.filter((x) => x.recipient.personId === ctx.people.alex_parker);
    expect(alex).toHaveLength(1);
    expect(alex[0].athleteIds.sort()).toEqual([ctx.athletes.maya, ctx.athletes.eli].sort());
    expect(alex[0].athleteFirstNames.sort()).toEqual(["Eli", "Maya"]);
  });

  it("group, membership/product, active, attendance, missing form, tag and lead stage filters", async () => {
    const all = await resolveSegment(tx(), ctx.orgId, parseFilters({ audience: "athletes" }));
    const active = await resolveSegment(tx(), ctx.orgId, parseFilters({ audience: "athletes", athleteActive: "active" }));
    const inactive = await resolveSegment(tx(), ctx.orgId, parseFilters({ audience: "athletes", athleteActive: "inactive" }));
    expect(active.matched + inactive.matched).toBe(all.matched);
    expect(inactive.matched).toBeGreaterThanOrEqual(1); // Noah

    const attended = await resolveSegment(tx(), ctx.orgId, parseFilters({ audience: "athletes", attendance: { mode: "attended", days: 365 } }), new Date("2026-03-02T17:00:00Z"));
    const notAttended = await resolveSegment(tx(), ctx.orgId, parseFilters({ audience: "athletes", attendance: { mode: "not_attended", days: 365 } }), new Date("2026-03-02T17:00:00Z"));
    expect(attended.matched).toBeGreaterThan(0);
    expect(attended.matched + notAttended.matched).toBe(all.matched);

    const group = await resolveSegment(tx(), ctx.orgId, parseFilters({ audience: "athletes", groupId: ctx.groups.adult }));
    expect(group.matched).toBeGreaterThan(0);
    expect(group.matched).toBeLessThan(all.matched);

    const none = await resolveSegment(tx(), ctx.orgId, parseFilters({ audience: "athletes", membershipStatus: "none" }));
    const withActive = await resolveSegment(tx(), ctx.orgId, parseFilters({ audience: "athletes", membershipStatus: "active" }));
    expect(none.matched).toBeGreaterThan(0);
    const [mayaMembership] = (
      await tx().execute(sql`select pv.product_id from memberships m join product_versions pv on pv.id = m.product_version_id where m.athlete_id = ${ctx.athletes.maya} limit 1`)
    ).rows as { product_id: string }[];
    const byProduct = await resolveSegment(tx(), ctx.orgId, parseFilters({ audience: "athletes", productId: mayaMembership.product_id }));
    expect(byProduct.recipients.some((r) => r.athleteIds.includes(ctx.athletes.maya))).toBe(true);
    expect(byProduct.matched).toBeLessThanOrEqual(withActive.matched + none.matched);

    // "any" missing form never includes medical forms: Eli (pending intake) yes.
    const missing = await resolveSegment(tx(), ctx.orgId, parseFilters({ audience: "athletes", missingForm: "any" }));
    expect(missing.recipients.some((r) => r.athleteIds.includes(ctx.athletes.eli))).toBe(true);

    const leads = await resolveSegment(tx(), ctx.orgId, parseFilters({ audience: "leads", leadStage: "new" }));
    expect(leads.audience).toBe("leads");
    expect(leads.recipients.every((r) => r.recipient.role === "lead_contact")).toBe(true);
    expect(leads.recipients.map((r) => r.recipient.firstName)).toContain("Priya");
    const openLeads = await resolveSegment(tx(), ctx.orgId, parseFilters({ audience: "leads" }));
    expect(openLeads.recipients.map((r) => r.recipient.firstName)).not.toContain("Wes"); // lost lead

    const erin = await viewerFor(ctx, "erin");
    const opts = await filterOptions(tx(), erin);
    expect(opts.tags.length).toBeGreaterThan(0);
    const tagged = await resolveSegment(tx(), ctx.orgId, parseFilters({ audience: "athletes", tagId: opts.tags[0].id }));
    expect(tagged.matched).toBeLessThan(all.matched);
  });

  it("form fields parse into audience-specific filters", () => {
    const f = parseFilters(filtersFromFields((k) => ({ audience: "leads", leadStage: "new", groupId: "00000000-0000-0000-0000-000000000000", sport: "Soccer" })[k]));
    expect(f).toEqual({ audience: "leads", leadStage: "new", sport: "Soccer" });
    const g = parseFilters(filtersFromFields((k) => ({ audience: "athletes", attendanceMode: "attended", attendanceDays: "30", leadStage: "new" })[k]));
    expect(g).toEqual({ audience: "athletes", attendance: { mode: "attended", days: 30 } });
  });

  it("health-data filters (medical form) are blocked for staff without health access", async () => {
    const erin = await viewerFor(ctx, "erin");
    const rod = await viewerFor(ctx, "rod");
    const f = parseFilters({ audience: "athletes", missingForm: medicalTemplateId });
    await expect(previewSegment(tx(), erin, f)).rejects.toBeInstanceOf(AuthzError);
    await expect(createSegment(tx(), erin, { name: "Needs clearance", filters: f })).rejects.toBeInstanceOf(AuthzError);
    expect((await filterOptions(tx(), erin)).forms.some((x) => x.id === medicalTemplateId)).toBe(false);
    expect((await filterOptions(tx(), rod)).forms.some((x) => x.id === medicalTemplateId)).toBe(true);

    const res = await previewSegment(tx(), rod, f);
    expect(res.recipients.some((r) => r.athleteIds.includes(ctx.athletes.maya))).toBe(true);
    const seg = await createSegment(tx(), rod, { name: "Needs concussion clearance", filters: f });
    const listed = (await listSegments(tx(), erin)).find((s) => s.segment.id === seg.id)!;
    expect(listed.restricted).toBe(true);
    expect(listed.recipients).toBeNull();
    expect((await listSegments(tx(), rod)).find((s) => s.segment.id === seg.id)!.recipients).toBeGreaterThan(0);
    // Operations can't campaign on it, or edit it.
    await expect(createCampaign(tx(), erin, { name: "x", templateId, segmentId: seg.id })).rejects.toBeInstanceOf(AuthzError);
    await expect(updateSegment(tx(), erin, seg.id, { name: "renamed", filters: { audience: "athletes" } })).rejects.toBeInstanceOf(AuthzError);
    // Coaches don't manage segments at all.
    const marcus = await viewerFor(ctx, "marcus");
    await expect(listSegments(tx(), marcus)).rejects.toBeInstanceOf(AuthzError);
  });

  it("ids from another org are rejected", async () => {
    const erin = await viewerFor(ctx, "erin");
    const other = await seedOrg("2026-03-02", { modules: [] });
    await expect(createSegment(tx(), erin, { name: "x", filters: { audience: "athletes", groupId: other.groups.adult } })).rejects.toBeInstanceOf(DomainError);
  });
});

describe("campaigns", () => {
  let volleyball: string;
  let football: string;
  beforeAll(async () => {
    const erin = await viewerFor(ctx, "erin");
    volleyball = (await createSegment(tx(), erin, { name: "Volleyball families", filters: { audience: "athletes", sport: "Volleyball" } })).id;
    football = (await createSegment(tx(), erin, { name: "Football families", filters: { audience: "athletes", sport: "Football" } })).id;
  });

  it("draft → submit → owner/admin approval → send through the outbox, once per recipient", async () => {
    const erin = await viewerFor(ctx, "erin");
    const rod = await viewerFor(ctx, "rod");
    const c = await createCampaign(tx(), erin, { name: "Closure notice", templateId, segmentId: volleyball, channels: ["email", "sms"] });
    expect(c.status).toBe("draft");
    expect(c.channels).toEqual(["in_app", "email", "sms"]);

    // Approval requires owner/admin, and a submitted campaign.
    await expect(approveCampaign(tx(), erin, c.id, NOON)).rejects.toBeInstanceOf(AuthzError);
    await expect(approveCampaign(tx(), rod, c.id, NOON)).rejects.toBeInstanceOf(DomainError);
    await submitCampaign(tx(), erin, c.id, NOON);

    // Exact recipient list after routing + consent (campaign email needs opt-in).
    const pv = await previewCampaign(tx(), erin, c.id, NOON);
    const row = (pid: string) => pv.rows.find((r) => r.personId === pid)!;
    const plan = (pid: string, ch: string) => row(pid).channels.find((x) => x.channel === ch)!;
    expect(pv.rows.map((r) => r.personId).sort()).toEqual([ctx.people.alex_parker, ctx.people.jordan_parker, ctx.people.harper_guardian].sort());
    expect(pv.rows.map((r) => r.personId)).not.toContain(ctx.people.maya_parker);
    expect(plan(ctx.people.alex_parker, "email").status).toBe("queued");
    expect(plan(ctx.people.alex_parker, "sms").status).toBe("queued");
    expect(plan(ctx.people.jordan_parker, "email").status).toBe("suppressed");
    expect(plan(ctx.people.jordan_parker, "sms").reason).toMatch(/opt-in/);
    expect(pv.totals.email).toEqual({ queued: 1, deferred: 0, suppressed: 2 }); // Harper's guardian has no opt-in
    expect(pv.sample.body).toMatch(/^Hi \S+.*the gym is closed Monday\. See you Tuesday, (Maya|Harper)!$/);
    expect(pv.sample.missing).toEqual([]);

    await approveCampaign(tx(), rod, c.id, NOON);
    const [job] = await tx().select().from(jobs).where(eq(jobs.dedupeKey, `campaign.send:${c.id}`));
    expect(job.runAt.getTime()).toBe(NOON.getTime());
    expect((await tx().select().from(campaigns).where(eq(campaigns.id, c.id)))[0].status).toBe("approved");

    const r1 = await sendCampaign(tx(), { orgId: ctx.orgId, campaignId: c.id }, NOON);
    expect(r1).toEqual({ sent: 3, recipients: 3 });
    // Re-running (job retry) never sends twice.
    expect(await sendCampaign(tx(), { orgId: ctx.orgId, campaignId: c.id }, NOON)).toEqual({ skipped: "sent" });
    await tx().update(campaigns).set({ status: "sending" }).where(eq(campaigns.id, c.id));
    expect(await sendCampaign(tx(), { orgId: ctx.orgId, campaignId: c.id }, NOON)).toEqual({ sent: 0, recipients: 3 });

    const msgs = await tx().select().from(messages).where(eq(messages.campaignId, c.id));
    expect(msgs).toHaveLength(3);
    const alexMsg = msgs.find((m) => m.body.startsWith("Hi Alex"))!;
    expect(alexMsg.body).toBe("Hi Alex, the gym is closed Monday. See you Tuesday, Maya!");
    const recips = await tx().select().from(campaignRecipients).where(eq(campaignRecipients.campaignId, c.id));
    expect(recips.every((r) => r.messageId && r.threadId)).toBe(true);

    // Report: queued external copies; nothing claims "sent" without a provider.
    let rep = await campaignReport(tx(), erin, c.id);
    expect(rep.recipients).toBe(3);
    expect(rep.byChannel.in_app).toEqual({ delivered: 3 });
    expect(rep.byChannel.email).toEqual({ queued: 1, suppressed: 2 });
    expect(rep.byChannel.sms).toEqual({ queued: 1, suppressed: 2 });

    const queued = await tx()
      .select()
      .from(messageDeliveries)
      .where(and(inArray(messageDeliveries.messageId, msgs.map((m) => m.id)), eq(messageDeliveries.status, "queued")));
    for (const d of queued) await deliverOne(tx(), d.id, { attempts: 1, maxAttempts: 5 });
    rep = await campaignReport(tx(), erin, c.id);
    expect(rep.byChannel.email).toEqual({ not_configured: 1, suppressed: 2 });
    expect(rep.byChannel.sms).toEqual({ not_configured: 1, suppressed: 2 });
    expect(rep.reasons.some((x) => x.reason?.match(/not configured/))).toBe(true);
  });

  it("broadcast email needs explicit opt-in (re-checked at send time)", async () => {
    const erin = await viewerFor(ctx, "erin");
    const rod = await viewerFor(ctx, "rod");
    const c = await createCampaign(tx(), erin, { name: "Football update", templateId, segmentId: football, channels: ["email"] });
    await submitCampaign(tx(), erin, c.id, NOON);
    const pv = await previewCampaign(tx(), erin, c.id, NOON);
    const sam = pv.rows.find((r) => r.personId === ctx.people.sam_rivera)!.channels.find((x) => x.channel === "email")!;
    const casey = pv.rows.find((r) => r.personId === ctx.people.casey_nguyen)!.channels.find((x) => x.channel === "email")!;
    expect(sam.status).toBe("suppressed"); // consent unknown: fine for 1:1 mail, not for broadcasts
    expect(sam.reason).toMatch(/Broadcasts require email opt-in/);
    expect(casey.status).toBe("queued");
    await approveCampaign(tx(), rod, c.id, NOON);
    await sendCampaign(tx(), { orgId: ctx.orgId, campaignId: c.id }, NOON);
    const [m] = await tx()
      .select()
      .from(messages)
      .innerJoin(campaignRecipients, eq(campaignRecipients.messageId, messages.id))
      .where(and(eq(messages.campaignId, c.id), eq(campaignRecipients.personId, ctx.people.casey_nguyen)));
    const [d] = await tx()
      .select()
      .from(messageDeliveries)
      .where(and(eq(messageDeliveries.messageId, m.messages.id), eq(messageDeliveries.channel, "email")));
    // Casey's opt-in is withdrawn back to "unknown" before the worker runs → suppressed.
    await tx().execute(sql`update comm_preferences set consent = 'unknown' where person_id = ${ctx.people.casey_nguyen} and channel = 'email'`);
    const r = await deliverOne(tx(), d.id, { attempts: 1, maxAttempts: 5 });
    expect(r.status).toBe("suppressed");
  });

  it("SAMPLE templates can't be broadcast; quiet hours defer scheduled sends; edits return to draft; cancel cancels the job", async () => {
    const erin = await viewerFor(ctx, "erin");
    const rod = await viewerFor(ctx, "rod");
    const [sampleTpl] = await tx().select().from(messageTemplates).where(and(eq(messageTemplates.orgId, ctx.orgId), eq(messageTemplates.isSample, true)));
    const s = await createCampaign(tx(), erin, { name: "Sample", templateId: sampleTpl.id, segmentId: volleyball });
    await expect(submitCampaign(tx(), erin, s.id, NOON)).rejects.toThrow(/SAMPLE/);

    // Scheduled at 22:00 facility time → email deferred to 07:30 next morning.
    const c = await createCampaign(tx(), erin, { name: "Late", templateId, segmentId: volleyball, channels: ["email"], scheduledLocal: "2031-03-04T22:00" });
    expect(c.scheduledAt!.toISOString()).toBe("2031-03-05T03:00:00.000Z");
    const pv = await previewCampaign(tx(), erin, c.id, NOON);
    const alexEmail = pv.rows.find((r) => r.personId === ctx.people.alex_parker)!.channels.find((x) => x.channel === "email")!;
    expect(alexEmail.runAt!.toISOString()).toBe("2031-03-05T12:30:00.000Z");
    expect(pv.totals.email.deferred).toBe(1);

    await submitCampaign(tx(), erin, c.id, NOON);
    await updateCampaign(tx(), erin, c.id, { name: "Late (edited)", templateId, segmentId: volleyball, channels: ["email"], scheduledLocal: "2031-03-04T22:00" });
    expect((await tx().select().from(campaigns).where(eq(campaigns.id, c.id)))[0].status).toBe("draft");
    await submitCampaign(tx(), erin, c.id, NOON);
    await rejectCampaign(tx(), rod, c.id, "Say which Monday", NOON);
    const [returned] = await tx().select().from(campaigns).where(eq(campaigns.id, c.id));
    expect(returned).toMatchObject({ status: "draft", reviewNote: "Say which Monday" });
    await submitCampaign(tx(), erin, c.id, NOON);
    await approveCampaign(tx(), rod, c.id, NOON);
    const [job] = await tx().select().from(jobs).where(eq(jobs.dedupeKey, `campaign.send:${c.id}`));
    expect(job.runAt.toISOString()).toBe("2031-03-05T03:00:00.000Z");
    await expect(updateCampaign(tx(), erin, c.id, { name: "x", templateId, segmentId: volleyball })).rejects.toBeInstanceOf(DomainError);
    // The segment can't change under an approved campaign.
    await expect(updateSegment(tx(), erin, volleyball, { name: "x", filters: { audience: "athletes" } })).rejects.toBeInstanceOf(DomainError);
    // Not yet due → the job is a no-op.
    expect(await sendCampaign(tx(), { orgId: ctx.orgId, campaignId: c.id }, NOON)).toEqual({ skipped: "not yet due" });

    await cancelCampaign(tx(), erin, c.id, NOON);
    const [cancelledJob] = await tx().select().from(jobs).where(eq(jobs.id, job.id));
    expect(cancelledJob.status).toBe("cancelled");
    expect(await sendCampaign(tx(), { orgId: ctx.orgId, campaignId: c.id }, new Date("2031-03-06T00:00:00Z"))).toEqual({ skipped: "cancelled" });
    expect(await tx().select().from(messages).where(eq(messages.campaignId, c.id))).toHaveLength(0);
  });

  it("the campaign.send job handler sends an approved campaign", async () => {
    const erin = await viewerFor(ctx, "erin");
    const rod = await viewerFor(ctx, "rod");
    const c = await createCampaign(tx(), erin, { name: "Handler", templateId, segmentId: football });
    await submitCampaign(tx(), erin, c.id);
    // Approve and park the queued job in one transaction so no other test worker can claim it.
    await tx().transaction(async (t) => {
      await approveCampaign(t, rod, c.id);
      await t.update(jobs).set({ status: "cancelled" }).where(eq(jobs.dedupeKey, `campaign.send:${c.id}`));
    });
    const [job] = await tx().select().from(jobs).where(eq(jobs.dedupeKey, `campaign.send:${c.id}`));
    await jobHandlers["campaign.send"](job.payload, job);
    const [done] = await tx().select().from(campaigns).where(eq(campaigns.id, c.id));
    expect(done.status).toBe("sent");
    expect(done.recipientCount).toBe(3); // Sam, Casey (Leo) + Ethan's guardian
  });

  it("lead segments reach lead contacts; other orgs can't see campaigns", async () => {
    const erin = await viewerFor(ctx, "erin");
    const seg = await createSegment(tx(), erin, { name: "New leads", filters: { audience: "leads", leadStage: "new" } });
    const c = await createCampaign(tx(), erin, { name: "Assessment slots", templateId, segmentId: seg.id });
    const pv = await previewCampaign(tx(), erin, c.id, NOON);
    expect(pv.audience).toBe("leads");
    expect(pv.rows.every((r) => r.role === "lead_contact")).toBe(true);
    const other = await seedOrg("2026-03-02", { modules: [] });
    const otherRod = await viewerFor(other, "rod");
    await expect(previewCampaign(tx(), otherRod, c.id, NOON)).rejects.toBeInstanceOf(DomainError);
    expect((await tx().select().from(segments).where(eq(segments.id, seg.id)))[0].orgId).toBe(ctx.orgId);
    expect((await tx().select().from(athletes).where(eq(athletes.orgId, other.orgId))).length).toBeGreaterThan(0);
  });
});
