import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditEvents, commConsentEvents, commPreferences, messageDeliveries, messages } from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { DomainError } from "@/lib/messaging/errors";
import { canManageOwnPreferences, myPreferences, staffConsentView, staffRecordConsent, updateMyPreferences } from "@/lib/messaging/preferences";
import { startStaffThread } from "@/lib/messaging/threads";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
const tx = () => testDb();
// Far-future instants so the delivery jobs we create are never claimed by other test files' workers.
const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  ctx = await seedOrg();
});
afterAll(async () => {
  await closeTestDb();
});

const pref = async (personId: string, channel: "email" | "sms") =>
  (await tx().select().from(commPreferences).where(and(eq(commPreferences.personId, personId), eq(commPreferences.channel, channel))))[0];

describe("family communication preferences", () => {
  it("a guardian sees their own consent, quiet hours and history (seeded with source + timestamp)", async () => {
    const alex = await viewerFor(ctx, "alex");
    const p = await myPreferences(tx(), alex);
    expect(p.editable).toBe(true);
    expect(p.person.id).toBe(ctx.people.alex_parker);
    expect(p.email?.consent).toBe("opted_in");
    expect(p.sms?.consent).toBe("opted_in");
    expect(p.quietHours).toBeNull();
    expect(p.facilityQuietHours).toEqual({ start: "21:00", end: "07:30" });
    expect(p.history.length).toBeGreaterThanOrEqual(2);
    expect(p.history.every((h) => h.source && h.createdAt instanceof Date)).toBe(true);
  });

  it("updates consent per channel and personal quiet hours, with history + audit; delivery honours them", async () => {
    const alex = await viewerFor(ctx, "alex");
    const r = await updateMyPreferences(tx(), alex, { email: "opted_in", sms: "opted_out", quietMode: "custom", quietStart: "20:00", quietEnd: "08:00" });
    expect(r.changes).toEqual(["Text messages: off", "Quiet hours: 20:00–08:00"]);
    expect((await pref(ctx.people.alex_parker, "sms")).consent).toBe("opted_out");
    expect((await pref(ctx.people.alex_parker, "email")).quietStartLocal).toBe("20:00:00");
    expect((await pref(ctx.people.alex_parker, "sms")).quietEndLocal).toBe("08:00:00");

    const events = await tx().select().from(commConsentEvents).where(eq(commConsentEvents.personId, ctx.people.alex_parker));
    const smsOff = events.find((e) => e.kind === "consent" && e.channel === "sms" && e.consent === "opted_out");
    expect(smsOff).toMatchObject({ source: "family_portal", previousConsent: "opted_in", actorUserId: alex.userId });
    expect(events.filter((e) => e.kind === "quiet_hours")).toHaveLength(2); // one per channel
    const audits = await tx()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, ctx.people.alex_parker), eq(auditEvents.actorUserId, alex.userId)));
    expect(audits.map((a) => a.action).sort()).toEqual(["messaging.consent_changed", "messaging.quiet_hours_changed"]);

    // Unchanged values write no new history.
    const before = events.length;
    await updateMyPreferences(tx(), alex, { email: "opted_in", sms: "opted_out", quietMode: "custom", quietStart: "20:00", quietEnd: "08:00" });
    expect((await tx().select().from(commConsentEvents).where(eq(commConsentEvents.personId, ctx.people.alex_parker))).length).toBe(before);

    // 20:30 EST is inside Alex's personal window (but outside the facility's 21:00 start): email deferred to 08:00, SMS suppressed.
    const erin = await viewerFor(ctx, "erin");
    const evening = at("2031-03-05T01:30:00Z"); // 2031-03-04 20:30 EST
    const res = await startStaffThread(tx(), erin, { athleteId: ctx.athletes.maya, subject: "Evening note", body: "Hi", channels: ["email", "sms"] }, evening);
    const [m] = await tx().select().from(messages).where(eq(messages.threadId, res.threadIds[0]));
    const ds = await tx().select().from(messageDeliveries).where(eq(messageDeliveries.messageId, m.id));
    const email = ds.find((d) => d.recipientPersonId === ctx.people.alex_parker && d.channel === "email")!;
    const sms = ds.find((d) => d.recipientPersonId === ctx.people.alex_parker && d.channel === "sms")!;
    expect(email.status).toBe("queued");
    expect(email.statusReason).toMatch(/personal window 20:00–08:00/);
    expect(sms.status).toBe("suppressed");

    // Back to the facility default.
    await updateMyPreferences(tx(), alex, { quietMode: "facility" });
    expect((await pref(ctx.people.alex_parker, "email")).quietStartLocal).toBeNull();
  });

  it("can't opt in to texts without a mobile number on file; bad quiet hours are rejected", async () => {
    const sam = await viewerFor(ctx, "sam");
    await expect(updateMyPreferences(tx(), sam, { sms: "opted_in" })).rejects.toBeInstanceOf(DomainError);
    await expect(updateMyPreferences(tx(), sam, { quietMode: "custom", quietStart: "21:00", quietEnd: "21:00" })).rejects.toBeInstanceOf(DomainError);
  });

  it("each guardian manages only their own record (Jordan's change never touches Alex)", async () => {
    const jordan = await viewerFor(ctx, "jordan");
    const alexEmailBefore = (await pref(ctx.people.alex_parker, "email")).consent;
    await updateMyPreferences(tx(), jordan, { email: "opted_in" });
    expect((await pref(ctx.people.jordan_parker, "email")).consent).toBe("opted_in");
    expect((await pref(ctx.people.alex_parker, "email")).consent).toBe(alexEmailBefore);
    await updateMyPreferences(tx(), jordan, { email: "opted_out" });
  });

  it("adult athletes manage their own; minor athletes cannot", async () => {
    const dana = await viewerFor(ctx, "dana");
    expect((await canManageOwnPreferences(tx(), dana)).ok).toBe(true);
    await updateMyPreferences(tx(), dana, { email: "opted_out" });
    expect((await pref(ctx.people.dana_brooks, "email")).consent).toBe("opted_out");
    await updateMyPreferences(tx(), dana, { email: "opted_in" });

    const maya = await viewerFor(ctx, "maya");
    const access = await canManageOwnPreferences(tx(), maya);
    expect(access.ok).toBe(false);
    expect((await myPreferences(tx(), maya)).editable).toBe(false);
    await expect(updateMyPreferences(tx(), maya, { email: "opted_out" })).rejects.toBeInstanceOf(AuthzError);

    const rod = await viewerFor(ctx, "rod");
    await expect(updateMyPreferences(tx(), rod, { email: "opted_out" })).rejects.toBeInstanceOf(AuthzError);
  });
});

describe("staff view of consent history", () => {
  it("CRM staff see the full history; coaches don't; staff-recorded changes need a note", async () => {
    const erin = await viewerFor(ctx, "erin");
    const view = await staffConsentView(tx(), erin, ctx.people.alex_parker);
    expect(view.history.some((h) => h.source === "family_portal" && h.actorName)).toBe(true);
    expect(view.history.some((h) => h.source === "seed")).toBe(true);
    const marcus = await viewerFor(ctx, "marcus");
    await expect(staffConsentView(tx(), marcus, ctx.people.alex_parker)).rejects.toBeInstanceOf(AuthzError);

    await expect(staffRecordConsent(tx(), erin, { personId: ctx.people.sam_rivera, channel: "email", consent: "opted_in", note: "" })).rejects.toThrow();
    await staffRecordConsent(tx(), erin, { personId: ctx.people.sam_rivera, channel: "email", consent: "opted_in", note: "Phone call with Sam (test)" });
    const [e] = await tx()
      .select()
      .from(commConsentEvents)
      .where(and(eq(commConsentEvents.personId, ctx.people.sam_rivera), eq(commConsentEvents.source, "staff")));
    expect(e).toMatchObject({ consent: "opted_in", detail: "Phone call with Sam (test)", actorUserId: erin.userId });

    // Another org's person is invisible.
    const other = await seedOrg("2026-03-02", { modules: [] });
    await expect(staffConsentView(tx(), erin, other.people.alex_parker)).rejects.toBeInstanceOf(DomainError);
  });

  it("consent history is append-only", async () => {
    const cause = (p: Promise<unknown>) => p.then(() => "no error", (e: { cause?: { message?: string } }) => e.cause?.message ?? String(e));
    expect(await cause(tx().execute(sql`update comm_consent_events set source = 'x' where person_id = ${ctx.people.alex_parker}`))).toMatch(/append-only/);
    expect(await cause(tx().execute(sql`delete from comm_consent_events where person_id = ${ctx.people.alex_parker}`))).toMatch(/append-only/);
  });
});
