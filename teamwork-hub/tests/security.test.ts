import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import Papa from "papaparse";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { archivedDocuments, formRequests, leads, people, personTags, tasks, users } from "@/db/schema";
import { closeTestDb, seedOrg, viewerFor } from "./helpers/db";
import { db, tx } from "./imports.helpers";
import type { Viewer } from "@/lib/authz/policy";
import { buildExport, createExport, type Manifest } from "@/lib/exports/bundle";
import { objectAccess } from "@/lib/forms/access";
import { saveObject } from "@/lib/storage";
import { CSV_FORMULA_ESCAPE } from "@/lib/csv";
import { createTask, setTag } from "@/lib/people/mutations";
import { getPersonDetail } from "@/lib/people/queries";
import { createManualInvoice } from "@/lib/billing/invoices";
import { createLeadFromInquiry, RATE_LIMIT, type InquiryInput } from "@/lib/crm/intake";
import { DomainError } from "@/lib/messaging/errors";
import { recordMfaFailure, verifyCredentials } from "@/lib/auth/session";
import { disableMfa } from "@/lib/auth/accounts";

// Route handlers resolve the viewer from the session cookie; tests inject it instead.
const auth = vi.hoisted(() => ({ viewer: null as Viewer | null }));
vi.mock("@/lib/auth/viewer", () => ({ getViewer: async () => auth.viewer }));

let ctx: Awaited<ReturnType<typeof seedOrg>>;
let other: Awaited<ReturnType<typeof seedOrg>>;
let rod: Viewer;
let erin: Viewer;
let marcus: Viewer;
let staffArchiveId: string;

beforeAll(async () => {
  ctx = await seedOrg("2026-03-02", { modules: ["documents"] });
  other = await seedOrg("2026-03-02", { modules: [] });
  rod = await viewerFor(ctx, "rod");
  erin = await viewerFor(ctx, "erin");
  marcus = await viewerFor(ctx, "marcus");
  staffArchiveId = await tx(async (t) => {
    const obj = await saveObject(t, {
      orgId: ctx.orgId,
      bytes: new TextEncoder().encode("%PDF-1.4 synthetic archived physical"),
      filename: "maya physical.pdf",
      mimeType: "application/pdf",
      kind: "imported_archive",
      ownerPersonId: ctx.people.maya_parker,
      accessLevel: "staff",
    });
    await t.insert(archivedDocuments).values({ orgId: ctx.orgId, personId: ctx.people.maya_parker, objectId: obj.id, title: "Sports physical (sample)", originalSystem: "zenplanner" });
    return obj.id;
  });
});
afterAll(closeTestDb);

describe("exports & file downloads", () => {
  it("a coach's per-athlete export omits completed form PDFs and staff archives the coach cannot open", async () => {
    const [completed] = await db()
      .select({ id: formRequests.id, pdf: formRequests.completedPdfObjectId })
      .from(formRequests)
      .where(and(eq(formRequests.orgId, ctx.orgId), eq(formRequests.athleteId, ctx.athletes.maya), eq(formRequests.status, "completed")));
    expect(completed?.pdf).toBeTruthy();
    // Coaches never get form PDFs or staff-level archives through /api/files…
    expect((await objectAccess(db(), marcus, completed.pdf!)).allowed).toBe(false);
    expect((await objectAccess(db(), marcus, staffArchiveId)).allowed).toBe(false);

    // …so their export must not contain them either.
    const coach = await tx((t) => buildExport(t, marcus, { kind: "athlete", athleteId: ctx.athletes.maya }));
    const files = unzipSync(coach.bytes);
    const m = JSON.parse(strFromU8(files["manifest.json"])) as Manifest;
    expect(m.links.filter((l) => l.entity === "form_request" || l.entity === "archived_document")).toEqual([]);
    expect(Object.keys(files).some((p) => p.startsWith("files/forms/") || p.startsWith("files/archived_documents/"))).toBe(false);
    expect(JSON.parse(strFromU8(files["data/archived_documents.json"]))).toEqual([]);
    expect(m.notes.some((n) => /excluded: the exporter cannot open them/.test(n))).toBe(true);

    // The owner (imports.manage) still gets everything.
    const full = await tx((t) => buildExport(t, rod, { kind: "athlete", athleteId: ctx.athletes.maya }));
    expect(full.manifest.links.some((l) => l.entity === "form_request")).toBe(true);
    expect(full.manifest.links.some((l) => l.entity === "archived_document")).toBe(true);
  });

  it("export zips are never served by the generic /api/files route (not even to the athlete they are about)", async () => {
    const { object } = await tx((t) => createExport(t, rod, { kind: "athlete", athleteId: ctx.athletes.maya }));
    const maya = await viewerFor(ctx, "maya");
    expect(object.ownerPersonId).toBe(maya.personId);
    for (const v of [maya, rod]) expect((await objectAccess(db(), v, object.id)).allowed).toBe(false);

    const { GET } = await import("@/app/api/files/[id]/route");
    auth.viewer = maya;
    const res = await GET(new NextRequest(`http://localhost/api/files/${object.id}`), { params: Promise.resolve({ id: object.id }) });
    expect(res.status).toBe(404);
    auth.viewer = null;
  });

  it("CSV exports neutralize spreadsheet formulas but keep numbers intact", async () => {
    const evil = '=HYPERLINK("http://evil.example","x")';
    await db().update(people).set({ firstName: evil, preferredName: "-2+3" }).where(eq(people.id, ctx.people.maya_parker));
    try {
      const { bytes } = await tx((t) => buildExport(t, rod, { kind: "athlete", athleteId: ctx.athletes.maya }));
      const csv = strFromU8(unzipSync(bytes)["data/people.csv"]);
      const rows = Papa.parse<Record<string, string>>(csv, { header: true }).data;
      const maya = rows.find((r) => r.id === ctx.people.maya_parker)!;
      expect(maya.firstName).toBe(`'${evil}`);
      expect(maya.preferredName).toBe("'-2+3");
    } finally {
      await db().update(people).set({ firstName: "Maya", preferredName: null }).where(eq(people.id, ctx.people.maya_parker));
    }
    const out = Papa.unparse([["@SUM(A1)", "+1", "-12.5", -3, "\tcmd", "plain"]], { escapeFormulae: CSV_FORMULA_ESCAPE });
    expect(Papa.parse<string[]>(out).data[0]).toEqual(["'@SUM(A1)", "+1", "-12.5", "-3", "'\tcmd", "plain"]);
  });
});

describe("org boundary on client-supplied ids", () => {
  it("tasks cannot be assigned to another org's user or attached to another org's person", async () => {
    await expect(tx((t) => createTask(t, erin, { title: "x", assigneeUserId: other.users.rod }))).rejects.toThrow(/staff member/);
    await expect(tx((t) => createTask(t, erin, { title: "x", relatedPersonId: other.people.maya_parker }))).rejects.toThrow(/not found/);
    // Families can't be made task assignees either.
    await expect(tx((t) => createTask(t, erin, { title: "x", assigneeUserId: ctx.users.alex }))).rejects.toThrow(/staff member/);
    const ok = await tx((t) => createTask(t, erin, { title: "Call about camp", assigneeUserId: ctx.users.marcus, relatedPersonId: ctx.people.maya_parker }));
    expect(ok.orgId).toBe(ctx.orgId);
    const foreign = await db().select().from(tasks).where(eq(tasks.relatedPersonId, other.people.maya_parker));
    expect(foreign.filter((t) => t.orgId === ctx.orgId)).toEqual([]);
  });

  it("tags cannot be attached to another org's person, and person pages ignore foreign tasks/tags", async () => {
    await expect(tx((t) => setTag(t, erin, other.people.maya_parker, "Injected", true))).rejects.toThrow(/not found/);
    expect(await db().select().from(personTags).where(eq(personTags.personId, other.people.maya_parker))).toEqual([]);

    // Even if a legacy cross-org row exists, the other org's person page does not show it.
    await db().insert(tasks).values({ orgId: ctx.orgId, title: "Legacy cross-org task", relatedPersonId: other.people.maya_parker });
    const otherRod = await viewerFor(other, "rod");
    const d = await tx((t) => getPersonDetail(t, otherRod, other.people.maya_parker));
    expect(d!.tasks.map((t) => t.t.title)).not.toContain("Legacy cross-org task");
  });

  it("manual invoice lines cannot reference another org's athlete", async () => {
    const lines = [{ description: "Private session", quantity: 1, unitAmountMinor: 5000, athleteId: other.athletes.maya }];
    await expect(tx((t) => createManualInvoice(t, erin, { payerAccountId: ctx.payers.parker, lines }))).rejects.toThrow(/Athlete not found/);
    const r = await tx((t) => createManualInvoice(t, erin, { payerAccountId: ctx.payers.parker, lines: [{ ...lines[0], athleteId: ctx.athletes.maya }] }));
    expect(r.invoice.totalMinor).toBe(5000);
  });
});

describe("public inquiry abuse limits", () => {
  const inquiry = (i: number): InquiryInput => ({
    inquiringFor: "self",
    contactFirstName: "Flood",
    contactLastName: `Test${i}`,
    email: `flood${i}@example.test`,
    athleteAge: 30,
    preferredTimes: [],
    consentEmail: false,
    consentSms: false,
  });

  it("rotating or missing client IPs cannot bypass the org-wide ceiling; staff-entered leads are not capped", async () => {
    const orgId = other.orgId;
    const existing = await db().select().from(leads).where(and(eq(leads.orgId, orgId), eq(leads.source, "web_inquiry")));
    const room = RATE_LIMIT.orgWebMax - existing.length;
    for (let i = 0; i < room; i++) {
      await tx((t) => createLeadFromInquiry(t, orgId, inquiry(i), { ip: i % 2 ? `198.51.100.${i}` : null, source: "web_inquiry" }));
    }
    await expect(tx((t) => createLeadFromInquiry(t, orgId, inquiry(999), { ip: "203.0.113.77", source: "web_inquiry" }))).rejects.toBeInstanceOf(DomainError);
    await expect(tx((t) => createLeadFromInquiry(t, orgId, inquiry(998), { ip: null, source: "web_inquiry" }))).rejects.toBeInstanceOf(DomainError);
    const staff = await tx((t) => createLeadFromInquiry(t, orgId, inquiry(1000), { source: "staff", actorUserId: other.users.erin, actorRole: "operations" }));
    expect(staff.leadId).toBeTruthy();
  });
});

describe("authentication hardening", () => {
  // Seeded orgs share demo emails and sign-in looks users up by email alone, so give each test user a unique one.
  const emailOf = async (userId: string) => {
    const email = `sec-${userId}@example.test`;
    await db().update(users).set({ email }).where(eq(users.id, userId));
    return email;
  };

  it("a locked account gets the same reply as an unknown email (no enumeration via lockout)", async () => {
    const email = await emailOf(other.users.dana);
    const unknown = await verifyCredentials("nobody-here@example.test", "wrong-password-1");
    for (let i = 0; i < 5; i++) await verifyCredentials(email, "wrong-password-1");
    const locked = await verifyCredentials(email, "teamwork-demo-1");
    expect(locked).toEqual(unknown);
    expect(locked.ok).toBe(false);
  });

  it("wrong second-factor codes count toward the lockout", async () => {
    const id = other.users.sam;
    const email = await emailOf(id);
    for (let i = 0; i < 4; i++) {
      const [u] = await db().select().from(users).where(eq(users.id, id));
      expect(await recordMfaFailure(u)).toBe(false);
    }
    const [u] = await db().select().from(users).where(eq(users.id, id));
    expect(await recordMfaFailure(u)).toBe(true);
    const [after] = await db().select().from(users).where(eq(users.id, id));
    expect(after.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect((await verifyCredentials(email, "teamwork-demo-1")).ok).toBe(false);
  });

  it("only an owner can turn off another owner's or admin's two-step verification", async () => {
    await db().update(users).set({ mfaEnabled: true, mfaSecret: "JBSWY3DPEHPK3PXP" }).where(eq(users.id, ctx.users.rod));
    const admin: Viewer = { ...erin, role: "admin" };
    await expect(tx((t) => disableMfa(t, admin, ctx.users.rod))).rejects.toThrow(/permission/);
    await expect(tx((t) => disableMfa(t, erin, ctx.users.rod))).rejects.toThrow(/permission/);
    const [still] = await db().select().from(users).where(eq(users.id, ctx.users.rod));
    expect(still.mfaEnabled).toBe(true);
    await tx((t) => disableMfa(t, rod, ctx.users.rod));
    const [off] = await db().select().from(users).where(eq(users.id, ctx.users.rod));
    expect(off.mfaEnabled).toBe(false);
  });
});

describe("route handlers", () => {
  it("the import upload handler refuses cross-origin posts before doing anything", async () => {
    const { POST } = await import("@/app/(app)/imports/upload/route");
    auth.viewer = rod;
    const res = await POST(new NextRequest("http://localhost:3101/imports/upload", { method: "POST", headers: { origin: "https://evil.example", host: "localhost:3101" }, body: new FormData() }));
    expect(res.status).toBe(403);
    auth.viewer = null;
  });
});
