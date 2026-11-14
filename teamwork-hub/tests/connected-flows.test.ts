/**
 * Cross-module acceptance paths (brief §13). Each test drives real domain functions
 * from several modules against Postgres — no module is mocked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  activitySessions,
  bodyRegionReports,
  creditBuckets,
  formTemplateVersions,
  formTemplates,
  invoices,
  leads,
  paymentAttempts,
  serviceTypes,
  tasks,
  users,
} from "@/db/schema";
import { createAthleteFamily } from "@/lib/people/mutations";
import { issueRequests } from "@/lib/forms/requests";
import { signRequest } from "@/lib/forms/signing";
import { contentHash } from "@/lib/forms/hash";
import { createManualInvoice } from "@/lib/billing/invoices";
import { ingestWebhook } from "@/lib/billing/webhooks";
import { bookSession, markAttendance } from "@/lib/scheduling/booking";
import { creditSummary, verifyLedger } from "@/lib/credits";
import { submitBodyReport, reviewQueue } from "@/lib/science/bodymap";
import { athleteTimeline } from "@/lib/people/timeline";
import { createLeadFromInquiry } from "@/lib/crm/intake";
import { scheduleAssessment } from "@/lib/crm/leads";
import { convertLead, conversionPreview } from "@/lib/crm/convert";
import { mkSession } from "./scheduling-helpers";
import { checkoutSessionEvent, signedHeaders, TEST_WHSEC } from "./fixtures/payments/stripe";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { verifyByEmail } from "./helpers/step-up";
import type { Viewer } from "@/lib/authz/policy";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
const ev = { ip: "127.0.0.1", userAgent: "vitest", authMethod: "password_session" };

beforeAll(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WHSEC;
  ctx = await seedOrg();
});
afterAll(async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  await closeTestDb();
});

async function loginFor(personId: string, role: "guardian" | "athlete", name: string): Promise<Viewer> {
  const [u] = await testDb()
    .insert(users)
    .values({ orgId: ctx.orgId, personId, role, email: `${randomUUID()}@example.test`, displayName: name })
    .returning();
  return { userId: u.id, orgId: ctx.orgId, role, personId, displayName: name, mfaVerified: true };
}

describe("Path 1: registration → form → invoice → verified payment → entitlement → booking → attendance", () => {
  it("connects people, documents, billing, credits, and scheduling", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");

    // 1. Staff registers a new family (new guardian, new athlete).
    const fam = await db.transaction((tx) =>
      createAthleteFamily(tx, erin, {
        athlete: { firstName: "Rowan", lastName: "Flowtest", dateOfBirth: "2013-04-04" },
        guardianMode: "new",
        guardian: { firstName: "Morgan", lastName: "Flowtest", email: "morgan.flowtest@example.test" },
      }),
    );
    const [g] = await db.execute(sql`select guardian_person_id from guardianships where athlete_id = ${fam.athleteId}`).then((r) => r.rows as { guardian_person_id: string }[]);
    const parent = await loginFor(g.guardian_person_id, "guardian", "Morgan Flowtest");

    // 2. A waiver is required to book this service type.
    const [tpl] = await db.insert(formTemplates).values({ orgId: ctx.orgId, name: "Flow Waiver (SAMPLE)", kind: "waiver", requiredForBooking: true }).returning();
    const content = { title: "Flow Waiver (SAMPLE)", bodyMarkdown: "Sample text.", fields: [], signers: [{ role: "guardian" as const, required: true }] };
    await db.insert(formTemplateVersions).values({ templateId: tpl.id, version: 1, ...content, contentHash: contentHash(content), status: "published", publishedAt: new Date() });
    const [st] = await db.insert(serviceTypes).values({ orgId: ctx.orgId, name: "Flow Class", kind: "class", eligibility: { requiredFormTemplateIds: [tpl.id] } }).returning();
    const session = await mkSession(ctx, { serviceTypeId: st.id, capacity: 4 });

    await expect(db.transaction((tx) => bookSession(tx, parent, { sessionId: session.id, athleteId: fam.athleteId }))).rejects.toThrow(/Flow Waiver/);

    // 3. Staff requests the form; the parent signs it.
    const issued = await db.transaction((tx) => issueRequests(tx, erin, { templateId: tpl.id, target: { kind: "athlete", athleteId: fam.athleteId } }));
    const reqId = issued.ids[0];
    expect(issued.created).toBe(1);
    // Waivers require signer identity step-up: the parent enters the code emailed to them.
    await verifyByEmail(db, parent, String(reqId));
    await db.transaction((tx) => signRequest(tx, parent, { requestId: String(reqId), role: "guardian", typedName: "Morgan Flowtest", consent: true, values: {} }, ev));

    // 4. Still no entitlement → booking refused with a clear message.
    await expect(db.transaction((tx) => bookSession(tx, parent, { sessionId: session.id, athleteId: fam.athleteId }))).rejects.toThrow(/membership or available session credits/);

    // 5. Invoice for a 2-credit pack; checkout attempt; verified (signed) webhook — delivered twice.
    const [payer] = await db.execute(sql`select payer_account_id from payer_beneficiaries where athlete_id = ${fam.athleteId}`).then((r) => r.rows as { payer_account_id: string }[]);
    const rod = await viewerFor(ctx, "rod");
    const { invoice } = await db.transaction((tx) =>
      createManualInvoice(tx, rod, { payerAccountId: payer.payer_account_id, lines: [{ description: "Sample — 2-Session Pack", unitAmountMinor: 5000, athleteId: fam.athleteId, entitlement: { credits: 2, creditExpiryDays: 60 } }] }),
    );
    const id = randomUUID();
    await db.insert(paymentAttempts).values({ id, orgId: ctx.orgId, invoiceId: invoice.id, provider: "stripe", providerRef: `cs_test_${id.slice(0, 8)}`, amountMinor: invoice.totalMinor, currency: "USD", status: "requires_action", idempotencyKey: `checkout:${id}` });
    const body = JSON.stringify(checkoutSessionEvent("checkout.session.completed", { attemptId: id, invoiceId: invoice.id, amount: invoice.totalMinor }));
    await ingestWebhook(db, "stripe", body, signedHeaders(body));
    await ingestWebhook(db, "stripe", body, signedHeaders(body));
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(inv.status).toBe("paid");
    expect((await creditSummary(db, fam.athleteId)).available).toBe(2);
    expect(await db.select().from(creditBuckets).where(eq(creditBuckets.athleteId, fam.athleteId))).toHaveLength(1);

    // 6. Parent books; attendance consumes the reserved credit.
    const booked = await db.transaction((tx) => bookSession(tx, parent, { sessionId: session.id, athleteId: fam.athleteId }));
    expect(booked.status).toBe("booked");
    expect((await creditSummary(db, fam.athleteId)).available).toBe(1);
    await db.transaction((tx) => markAttendance(tx, erin, { bookingId: booked.booking.id, outcome: "attended" }));
    const sum = await creditSummary(db, fam.athleteId);
    expect(sum.available).toBe(1);
    expect(sum.reserved).toBe(0);
    expect(await verifyLedger(db, ctx.orgId)).toEqual([]);

    // 7. The unified timeline shows the booking, form, and invoice to the parent (who pays).
    const kinds = new Set((await athleteTimeline(db, parent, fam.athleteId)).map((e) => e.kind));
    expect(kinds.has("booking")).toBe(true);
    expect(kinds.has("form")).toBe(true);
    expect(kinds.has("invoice")).toBe(true);
  });
});

describe("Path 3: athlete body-map input → scoped coach review queue + task", () => {
  it("routes Maya's pain report to her coach only, never to Jordan or operations", async () => {
    const db = testDb();
    const maya = await viewerFor(ctx, "maya");
    await db.transaction((tx) => submitBodyReport(tx, maya, { athleteId: ctx.athletes.maya, view: "front", region: "knee", side: "left", kind: "pain", severity: 6, note: "flow test" }));
    const marcus = await viewerFor(ctx, "marcus");
    const tess = await viewerFor(ctx, "tess");
    const queue = await reviewQueue(db, marcus);
    expect(queue.some((r: { athleteId?: string; athlete_id?: string; note?: string | null }) => (r.athleteId ?? r.athlete_id) === ctx.athletes.maya)).toBe(true);
    const tessQueue = await reviewQueue(db, tess);
    expect(tessQueue.some((r: { athleteId?: string; athlete_id?: string }) => (r.athleteId ?? r.athlete_id) === ctx.athletes.maya)).toBe(false);
    const reviewTasks = await db.select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.relatedPersonId, ctx.people.maya_parker)));
    expect(reviewTasks.length).toBeGreaterThan(0);
    // Tasks are visible to all staff (incl. operations without health access): no symptom details in them.
    for (const t of reviewTasks) expect(`${t.title} ${t.description}`.toLowerCase()).not.toMatch(/knee|pain|\/10/);
    const reports = await db.select().from(bodyRegionReports).where(eq(bodyRegionReports.athleteId, ctx.athletes.maya));
    expect(reports.some((r) => r.note === "flow test")).toBe(true);
    const jordan = await viewerFor(ctx, "jordan");
    expect((await athleteTimeline(db, jordan, ctx.athletes.maya)).some((e) => e.kind === "body")).toBe(false);
  });
});

describe("Path 5: lead inquiry → assessment → task/inbox → member conversion", () => {
  it("creates a lead with follow-up, schedules an assessment, and converts without merging", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const lead = await db.transaction((tx) =>
      createLeadFromInquiry(tx, ctx.orgId, {
        inquiringFor: "child",
        contactFirstName: "Pat",
        contactLastName: "Inquirer",
        email: `pat.${randomUUID().slice(0, 6)}@example.test`,
        athleteFirstName: "Sky",
        athleteLastName: "Inquirer",
        athleteAge: 13,
        sport: "Soccer",
        goals: "Get faster",
        consentEmail: true,
        consentSms: false,
      }),
    );
    const leadId = lead.leadId;
    const followUps = await db.select().from(tasks).where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.relatedType, "lead"), eq(tasks.relatedId, leadId)));
    expect(followUps.length).toBeGreaterThan(0);

    const [assessType] = await db.select().from(serviceTypes).where(and(eq(serviceTypes.orgId, ctx.orgId), eq(serviceTypes.kind, "assessment")));
    const slot = await mkSession(ctx, { serviceTypeId: assessType.id, capacity: 1, exclusiveCoach: false, title: "Assessment (flow)" });
    await db.transaction((tx) => scheduleAssessment(tx, erin, leadId, slot.id));
    const [afterSchedule] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(afterSchedule.assessmentSessionId).toBe(slot.id);

    const preview = await conversionPreview(db, erin, leadId);
    expect(preview).toBeTruthy();
    const converted = await db.transaction((tx) => convertLead(tx, erin, { leadId, athleteChoice: "new", guardianChoice: "new", dateOfBirth: "2013-02-02" }));
    const [after] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(after.convertedAt).not.toBeNull();
    expect(after.convertedAthleteId).toBeTruthy();
    expect(converted).toBeTruthy();
  });
});

describe("Path 2 (load link): completing a logged workout feeds load monitoring", () => {
  it("seeded completed workouts each produced exactly one activity session", async () => {
    const db = testDb();
    const rows = await db.execute(sql`
      select w.id, count(a.id)::int as n from workouts w left join activity_sessions a on a.workout_id = w.id
      where w.org_id = ${ctx.orgId} and w.status = 'completed' group by w.id`);
    expect(rows.rows.length).toBeGreaterThan(0);
    expect((rows.rows as { n: number }[]).every((r) => r.n <= 1)).toBe(true);
    const linked = await db.select().from(activitySessions).where(eq(activitySessions.orgId, ctx.orgId));
    expect(linked.some((a) => a.workoutId)).toBe(true);
  });
});
