import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { formRequests, formTemplateVersions, signatures, storedObjects, archivedDocuments } from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { UserError } from "@/lib/actions";
import { loadRequestContext } from "@/lib/forms/context";
import { signRequest, signingState } from "@/lib/forms/signing";
import { verifyRequest } from "@/lib/forms/verify";
import { objectAccess, requestAccess } from "@/lib/forms/access";
import { formsEligibility, missingForms, athleteFormStatus } from "@/lib/forms/status";
import { issueRequests, processRenewals, voidRequest, sendReminder } from "@/lib/forms/requests";
import { createDraftVersion, createTemplate, publishVersion, saveDraft, setApprovedText } from "@/lib/forms/templates";
import { contentHash, canonicalJson } from "@/lib/forms/hash";
import { parseMarkdown } from "@/lib/forms/markdown";
import { requiredRoles, validateSubmission } from "@/lib/forms/fields";
import { importArchive } from "@/lib/forms/archive";
import { objectStore, sha256Bytes } from "@/lib/storage";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
const R = () => ctx.extra.formRequests;
const ev = { ip: "198.51.100.7", userAgent: "vitest", authMethod: "session_password" };

beforeAll(async () => {
  ctx = await seedOrg();
});
afterAll(closeTestDb);

async function ctxOf(id: string) {
  return (await loadRequestContext(testDb(), ctx.orgId, id))!;
}

describe("immutability (DB triggers)", () => {
  it("signatures cannot be updated or deleted", async () => {
    const db = testDb();
    const [s] = await db.select().from(signatures).where(eq(signatures.formRequestId, R().waiverMaya));
    expect(s).toBeTruthy();
    await expect(db.update(signatures).set({ typedName: "Someone Else" }).where(eq(signatures.id, s.id))).rejects.toThrow();
    await expect(db.delete(signatures).where(eq(signatures.id, s.id))).rejects.toThrow();
    const [again] = await db.select().from(signatures).where(eq(signatures.id, s.id));
    expect(again.typedName).toBe("Alex Parker");
  });

  it("published versions cannot be edited; saving through the app is refused too", async () => {
    const db = testDb();
    const v1 = ctx.extra.formVersions.waiverV1;
    const e = await db
      .update(formTemplateVersions)
      .set({ bodyMarkdown: "changed" })
      .where(eq(formTemplateVersions.id, v1))
      .then(() => null, (err: { cause?: { message?: string } }) => err);
    expect(e?.cause?.message).toMatch(/immutable/);
    const rod = await viewerFor(ctx, "rod");
    await expect(
      db.transaction((tx) => saveDraft(tx, rod, v1, { title: "x title", bodyMarkdown: "changed body text", fields: [], signers: [{ role: "guardian", required: true }] })),
    ).rejects.toThrow(UserError);
  });
});

describe("versions and superseding", () => {
  it("completed v1 requests keep v1 exactly; open v1 requests were superseded by v2 requests", async () => {
    const db = testDb();
    const maya = await ctxOf(R().waiverMaya);
    expect(maya.req.status).toBe("completed");
    expect(maya.version.id).toBe(ctx.extra.formVersions.waiverV1);
    expect(maya.signatures[0].templateContentHash).toBe(maya.version.contentHash);
    const v2 = (await db.select().from(formTemplateVersions).where(eq(formTemplateVersions.id, ctx.extra.formVersions.waiverV2)))[0];
    expect(v2.contentHash).not.toBe(maya.version.contentHash);
    expect(maya.version.bodyMarkdown).not.toContain("equipment-use policy");

    const harper = await ctxOf(R().waiverHarperV1);
    expect(harper.req.status).toBe("superseded");
    const next = await ctxOf(harper.req.supersededById!);
    expect(next.req.status).toBe("pending");
    expect(next.version.id).toBe(v2.id);
  });

  it("full template lifecycle: create → publish v1 → sign → publish v2 with re-sign", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const alex = await viewerFor(ctx, "alex");
    const tpl = await db.transaction((tx) => createTemplate(tx, erin, { name: "Test Policy", kind: "policy", renewalMonths: null, requiredForBooking: false }));
    const d1 = await db.transaction((tx) => createDraftVersion(tx, erin, tpl.id));
    expect(d1.created).toBe(false); // v1 draft made at creation
    await db.transaction((tx) =>
      saveDraft(tx, erin, d1.version.id, {
        title: "Test Policy",
        bodyMarkdown: "# Policy\n\nSample policy text for testing.",
        fields: [{ key: "ack", label: "I acknowledge", type: "checkbox", required: true }],
        signers: [{ role: "guardian", required: true }],
      }),
    );
    await db.transaction((tx) => publishVersion(tx, erin, d1.version.id, { requireResign: false }));
    const issued = await db.transaction((tx) => issueRequests(tx, erin, { templateId: tpl.id, target: { kind: "group", groupId: ctx.groups.youth } }));
    expect(issued.created).toBe(6);
    const again = await db.transaction((tx) => issueRequests(tx, erin, { templateId: tpl.id, target: { kind: "athlete", athleteId: ctx.athletes.eli } }));
    expect(again).toMatchObject({ created: 0, skipped: 1 });

    const [eliReq] = await db
      .select()
      .from(formRequests)
      .where(and(eq(formRequests.athleteId, ctx.athletes.eli), eq(formRequests.templateVersionId, d1.version.id)));
    await db.transaction((tx) => signRequest(tx, alex, { requestId: eliReq.id, role: "guardian", typedName: "Alex Parker", consent: true, values: { field_ack: "on" } }, ev));
    expect((await ctxOf(eliReq.id)).req.status).toBe("completed");

    const d2 = await db.transaction((tx) => createDraftVersion(tx, erin, tpl.id));
    expect(d2.version.version).toBe(2);
    expect(d2.version.isSampleText).toBe(true);
    await db.transaction((tx) => saveDraft(tx, erin, d2.version.id, { ...d2.version, bodyMarkdown: "# Policy\n\nUpdated sample policy text." }));
    const pub = await db.transaction((tx) => publishVersion(tx, erin, d2.version.id, { requireResign: true }));
    expect(pub.superseded).toBe(5);
    const eliAfter = await ctxOf(eliReq.id);
    expect(eliAfter.req.status).toBe("completed");
    expect(eliAfter.version.id).toBe(d1.version.id);
    const [v1Row] = await db.select().from(formTemplateVersions).where(eq(formTemplateVersions.id, d1.version.id));
    expect(v1Row.status).toBe("published"); // stays immutable; v2 is current (highest published)
  });

  it("only owners/admins can mark text approved", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const rod = await viewerFor(ctx, "rod");
    const v = ctx.extra.formVersions.membershipV1;
    await expect(db.transaction((tx) => setApprovedText(tx, erin, v, true))).rejects.toThrow(AuthzError);
    await db.transaction((tx) => setApprovedText(tx, rod, v, true));
    const [row] = await db.select().from(formTemplateVersions).where(eq(formTemplateVersions.id, v));
    expect(row.isSampleText).toBe(false);
    await db.transaction((tx) => setApprovedText(tx, rod, v, false));
  });
});

describe("signing rules", () => {
  it("completion requires every required role: Maya's media release waits for Jordan (second guardian)", async () => {
    const db = testDb();
    const before = await ctxOf(R().mediaMaya);
    expect(before.req.status).toBe("partially_signed");
    expect(before.req.completedPdfObjectId).toBeNull();
    const jordan = await viewerFor(ctx, "jordan");
    const st = await signingState(db, jordan, before);
    expect(st.remainingRequired).toEqual(["second_guardian"]);
    expect(st.mine.map((m) => m.role)).toEqual(["second_guardian"]);
    // Alex already signed and cannot take the second role too.
    const alex = await viewerFor(ctx, "alex");
    await expect(
      db.transaction((tx) => signRequest(tx, alex, { requestId: R().mediaMaya, role: "second_guardian", typedName: "Alex Parker", consent: true, values: {} }, ev)),
    ).rejects.toThrow(AuthzError);

    // Jordan tries to change the data — ignored: signed data is frozen.
    const res = await db.transaction((tx) =>
      signRequest(tx, jordan, { requestId: R().mediaMaya, role: "second_guardian", typedName: "Jordan Parker", consent: true, values: { field_media_permission: "Full permission" } }, ev),
    );
    expect(res.status).toBe("completed");
    const after = await ctxOf(R().mediaMaya);
    expect(after.req.submittedData).toEqual({ media_permission: "Internal coaching use only" });
    expect(new Set(after.signatures.map((s) => s.dataHash)).size).toBe(1);
    expect(after.req.integrityHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await verifyRequest(db, after, { checkPdfBytes: true })).ok).toBe(true);
  });

  it("Chris (unrelated family) cannot sign for Maya", async () => {
    const chris = await viewerFor(ctx, "chris");
    await expect(
      testDb().transaction((tx) =>
        signRequest(tx, chris, { requestId: R().membershipMaya, role: "guardian", typedName: "Chris Parker", consent: true, values: { field_billing_contact_email: "c@example.test" } }, ev),
      ),
    ).rejects.toThrow(AuthzError);
  });

  it("a minor athlete cannot sign the guardian role (assent only)", async () => {
    const maya = await viewerFor(ctx, "maya");
    await expect(
      testDb().transaction((tx) =>
        signRequest(tx, maya, { requestId: R().membershipMaya, role: "guardian", typedName: "Maya Parker", consent: true, values: { field_billing_contact_email: "m@example.test" } }, ev),
      ),
    ).rejects.toThrow(AuthzError);
    const st = await signingState(testDb(), maya, await ctxOf(R().membershipMaya));
    expect(st.mine).toEqual([]);
    expect(st.blockedReason).toMatch(/parent or guardian must/i);
  });

  it("guardians without forms.sign are refused; consent and typed name are mandatory", async () => {
    const db = testDb();
    const jordan = await viewerFor(ctx, "jordan");
    await expect(
      db.transaction((tx) => signRequest(tx, jordan, { requestId: R().membershipMaya, role: "guardian", typedName: "Jordan Parker", consent: false, values: { field_billing_contact_email: "j@example.test" } }, ev)),
    ).rejects.toThrow(/agree/);
    await expect(
      db.transaction((tx) => signRequest(tx, jordan, { requestId: R().membershipMaya, role: "guardian", typedName: "J", consent: true, values: { field_billing_contact_email: "j@example.test" } }, ev)),
    ).rejects.toThrow(/full legal name/);
    await db.execute(sql`update guardianships set can_sign_forms = false where guardian_person_id = ${ctx.people.jordan_parker} and athlete_id = ${ctx.athletes.maya}`);
    try {
      await expect(
        db.transaction((tx) => signRequest(tx, jordan, { requestId: R().membershipMaya, role: "guardian", typedName: "Jordan Parker", consent: true, values: { field_billing_contact_email: "j@example.test" } }, ev)),
      ).rejects.toThrow(AuthzError);
    } finally {
      await db.execute(sql`update guardianships set can_sign_forms = true where guardian_person_id = ${ctx.people.jordan_parker} and athlete_id = ${ctx.athletes.maya}`);
    }
  });

  it("fields are validated server-side against the version definitions", async () => {
    const alex = await viewerFor(ctx, "alex");
    const err = await testDb()
      .transaction((tx) =>
        signRequest(tx, alex, { requestId: R().healthEli, role: "guardian", typedName: "Alex Parker", consent: true, values: { field_emergency_contact_phone: "abc", field_last_physical: "2026-02-31" } }, ev),
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(Object.keys((err as UserError).fieldErrors ?? {})).toEqual(
      expect.arrayContaining(["field_emergency_contact_name", "field_emergency_contact_phone", "field_allergies", "field_last_physical", "field_consent_emergency_treatment"]),
    );
    expect((await ctxOf(R().healthEli)).req.submittedData).toBeNull();
  });

  it("an adult athlete signs their own forms; staff can record an in-person signature with witness", async () => {
    const db = testDb();
    const dana = await ctxOf(R().waiverDana);
    expect(dana.signatures[0].signerRole).toBe("adult_athlete");
    expect(dana.signatures[0].relationship).toBe("self");
    const zoe = await ctxOf(R().waiver_zoe);
    expect(zoe.signatures[0].authMethod).toMatch(/^staff_witnessed_in_person; witness=Erin .*; identity=staff_attested$/);
    expect(zoe.signatures[0].signerPersonId).toBe(ctx.people.zoe_guardian);
    // A coach cannot record in-person signatures.
    const marcus = await viewerFor(ctx, "marcus");
    await expect(
      db.transaction((tx) => signRequest(tx, marcus, { requestId: R().mediaLeo, role: "guardian", typedName: "Sam Rivera", consent: true, values: { field_media_permission: "Full permission" }, inPersonSignerPersonId: ctx.people.sam_rivera }, ev)),
    ).rejects.toThrow(AuthzError);
  });

  it("second guardian is only required when a second signing guardian exists", () => {
    const signers = [
      { role: "guardian" as const, required: true },
      { role: "second_guardian" as const, required: true },
    ];
    expect(requiredRoles(signers, { subjectIsAdult: false, signingGuardianCount: 1 })).toEqual(["guardian"]);
    expect(requiredRoles(signers, { subjectIsAdult: false, signingGuardianCount: 2 })).toEqual(["guardian", "second_guardian"]);
    expect(requiredRoles(signers, { subjectIsAdult: true, signingGuardianCount: 2 })).toEqual(["adult_athlete"]);
  });
});

describe("PDF + integrity", () => {
  it("stored PDF bytes hash to the stored sha256", async () => {
    const db = testDb();
    const c = await ctxOf(R().healthMaya);
    const [obj] = await db.select().from(storedObjects).where(eq(storedObjects.id, c.req.completedPdfObjectId!));
    expect(obj.kind).toBe("completed_form_pdf");
    expect(obj.accessLevel).toBe("subject_and_guardians");
    const bytes = await objectStore().get(obj.storageKey);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    expect(sha256Bytes(bytes)).toBe(obj.sha256);
    expect(obj.sizeBytes).toBe(bytes.byteLength);
  });

  it("verification passes untouched and detects tampering with submitted data", async () => {
    const db = testDb();
    const id = R().healthLeo;
    expect((await verifyRequest(db, await ctxOf(id), { checkPdfBytes: true })).ok).toBe(true);
    await db.execute(sql`update form_requests set submitted_data = jsonb_set(submitted_data, '{allergies}', '"Peanuts"') where id = ${id}`);
    const report = await verifyRequest(db, await ctxOf(id));
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.label.startsWith("Integrity"))?.ok).toBe(false);
    expect(report.checks.filter((c) => c.label.includes("submitted data")).every((c) => !c.ok)).toBe(true);
  });

  it("content hash is canonical (key order independent) and covers every part", () => {
    const base = { title: "T", bodyMarkdown: "B", fields: [{ key: "a", label: "A", type: "text" as const, required: true }], signers: [{ role: "guardian" as const, required: true }] };
    expect(contentHash(base)).toBe(contentHash({ signers: base.signers, fields: base.fields, bodyMarkdown: "B", title: "T" }));
    expect(contentHash({ ...base, bodyMarkdown: "B." })).not.toBe(contentHash(base));
    expect(contentHash({ ...base, signers: [{ role: "guardian", required: false }] })).not.toBe(contentHash(base));
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe("access policy", () => {
  it("coaches see status only — never data or completed PDFs; ops staff can", async () => {
    const db = testDb();
    const c = await ctxOf(R().healthMaya);
    const r = { orgId: c.req.orgId, athleteId: c.req.athleteId, subjectPersonId: c.req.subjectPersonId, templateKind: c.template.kind };
    const marcus = await viewerFor(ctx, "marcus");
    const tess = await viewerFor(ctx, "tess");
    const erin = await viewerFor(ctx, "erin");
    expect(await requestAccess(db, marcus, r)).toEqual({ view: true, viewData: false, manage: false });
    expect((await requestAccess(db, tess, r)).view).toBe(false);
    expect((await objectAccess(db, marcus, c.req.completedPdfObjectId!)).allowed).toBe(false);
    expect((await objectAccess(db, erin, c.req.completedPdfObjectId!)).allowed).toBe(true);
    expect((await objectAccess(db, await viewerFor(ctx, "maya"), c.req.completedPdfObjectId!)).allowed).toBe(true);
    expect((await objectAccess(db, await viewerFor(ctx, "jordan"), c.req.completedPdfObjectId!)).allowed).toBe(true);
    expect((await objectAccess(db, await viewerFor(ctx, "chris"), c.req.completedPdfObjectId!)).allowed).toBe(false);
    expect((await objectAccess(db, await viewerFor(ctx, "dana"), c.req.completedPdfObjectId!)).allowed).toBe(false);
  });
});

describe("requests: renewal, reminders, void", () => {
  it("expired waiver was flipped by the renewal sweep and a renewal request issued; sweep is idempotent", async () => {
    const db = testDb();
    const old = await ctxOf(R().waiverLiamOld);
    expect(old.req.status).toBe("expired");
    const st = (await athleteFormStatus(db, ctx.orgId, [ctx.athletes.liam], [{ id: ctx.extra.formTemplates.waiver, name: "Waiver" }])).get(ctx.athletes.liam)!;
    expect(st[0].state).toBe("pending");
    const again = await db.transaction((tx) => processRenewals(tx, ctx.orgId, { now: new Date("2026-03-02T12:00:00Z") }));
    expect(again).toEqual({ expired: 0, renewed: 0 });
  });

  it("completed forms expire by time even before the sweep runs", async () => {
    const db = testDb();
    const dana = await ctxOf(R().waiverDana);
    const later = new Date(dana.req.expiresAt!.getTime() + 1000);
    const res = await formsEligibility(db, ctx.athletes.dana, [ctx.extra.formTemplates.waiver], later);
    expect(res.eligible).toBe(false);
    expect(res.missing[0].state).toBe("expired");
    expect((await formsEligibility(db, ctx.athletes.dana, [ctx.extra.formTemplates.waiver], new Date(later.getTime() - 2000))).eligible).toBe(true);
  });

  it("reminders enqueue forms.reminder once per request per day", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const a = await db.transaction((tx) => sendReminder(tx, erin, R().healthAva));
    const b = await db.transaction((tx) => sendReminder(tx, erin, R().healthAva));
    expect(a.queued).toBe(true);
    expect(b.queued).toBe(false);
    const jobs = await db.execute(sql`select payload from jobs where type = 'forms.reminder' and payload->>'formRequestId' = ${R().healthAva}`);
    expect(jobs.rows).toHaveLength(1);
    const p = (jobs.rows[0] as { payload: { recipientPersonIds: string[]; link: string } }).payload;
    expect(p.recipientPersonIds).toContain(ctx.people.chris_parker);
    expect(p.link).toBe(`/documents/requests/${R().healthAva}`);
  });

  it("void & reissue replaces an open request; completed requests cannot be voided", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    await expect(db.transaction((tx) => voidRequest(tx, erin, R().waiverMaya, "test"))).rejects.toThrow(UserError);
    const res = await db.transaction((tx) => voidRequest(tx, erin, R().mediaLeo, "Wrong permission selected", { reissue: true }));
    expect(res.newId).toBeTruthy();
    expect((await ctxOf(R().mediaLeo)).req.status).toBe("voided");
    expect((await ctxOf(res.newId!)).req.status).toBe("pending");
  });
});

describe("eligibility + missing forms", () => {
  it("formsEligibility reports missing / pending forms", async () => {
    const db = testDb();
    const t = ctx.extra.formTemplates;
    const leo = await formsEligibility(db, ctx.athletes.leo, [t.waiver, t.health]);
    expect(leo).toEqual({ eligible: true, missing: [] });
    const eli = await formsEligibility(db, ctx.athletes.eli, [t.waiver, t.health]);
    expect(eli.eligible).toBe(false);
    expect(eli.missing).toEqual([expect.objectContaining({ templateId: t.health, state: "pending" })]);
    const harper = await formsEligibility(db, ctx.athletes.harper, [t.waiver, t.health, "00000000-0000-0000-0000-000000000000"]);
    expect(harper.missing.map((m) => m.state).sort()).toEqual(["missing", "missing", "pending"]);
    expect(await formsEligibility(db, ctx.athletes.harper, [])).toEqual({ eligible: true, missing: [] });
  });

  it("missingForms lists only athletes with problems, scoped by org", async () => {
    const rows = await missingForms(testDb(), ctx.orgId);
    const names = rows.map((r) => r.name);
    expect(names).toContain("Harper Lindqvist");
    expect(names).not.toContain("Leo Rivera");
    expect(names).not.toContain("Noah Kim"); // inactive
    const eli = rows.find((r) => r.name === "Eli Parker")!;
    expect(eli.items.map((i) => i.state)).toEqual(["pending"]);
    const scoped = await missingForms(testDb(), ctx.orgId, { athleteIds: [ctx.athletes.harper] });
    expect(scoped).toHaveLength(1);
  });
});

describe("archive + markdown + fields", () => {
  it("imports a historical PDF as an archive without creating signatures", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const bytes = new TextEncoder().encode("%PDF-1.4\n% synthetic archive\n%%EOF\n");
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(signatures);
    const res = await db.transaction((tx) =>
      importArchive(tx, erin, {
        personId: ctx.people.ava_parker,
        title: "2024 Waiver (paper)",
        originalSystem: "Zen Planner",
        originalSignedDate: "2024-05-01",
        evidenceNotes: "Scanned paper copy",
        visibility: "subject_and_guardians",
        bytes,
        filename: "waiver.pdf",
      }),
    );
    expect(res.object.kind).toBe("imported_archive");
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(signatures);
    expect(after[0].n).toBe(before[0].n);
    const [doc] = await db.select().from(archivedDocuments).where(eq(archivedDocuments.id, res.doc.id));
    expect(doc.originalSystem).toBe("Zen Planner");
    expect((await objectAccess(db, await viewerFor(ctx, "chris"), res.object.id)).allowed).toBe(true);
    expect((await objectAccess(db, await viewerFor(ctx, "alex"), res.object.id)).allowed).toBe(false);
    await expect(
      db.transaction((tx) =>
        importArchive(tx, erin, { personId: ctx.people.ava_parker, title: "Not a pdf", originalSystem: "X system", originalSignedDate: null, evidenceNotes: "", visibility: "staff", bytes: new TextEncoder().encode("hello"), filename: "x.txt" }),
      ),
    ).rejects.toThrow(/PDF/);
    const marcus = await viewerFor(ctx, "marcus");
    await expect(
      db.transaction((tx) =>
        importArchive(tx, marcus, { personId: ctx.people.ava_parker, title: "x", originalSystem: "X system", originalSignedDate: null, evidenceNotes: "", visibility: "staff", bytes, filename: "x.pdf" }),
      ),
    ).rejects.toThrow(AuthzError);
  });

  it("markdown never passes raw HTML through", () => {
    const blocks = parseMarkdown('# Hi\n\n<script>alert(1)</script> **bold** <img src=x onerror=alert(1)>\n\n- a\n- b');
    expect(blocks[0]).toMatchObject({ type: "heading", level: 1 });
    expect(blocks[1].type).toBe("paragraph");
    const text = blocks[1].type === "paragraph" ? blocks[1].inlines.map((i) => i.text).join("") : "";
    expect(text).toContain("<script>alert(1)</script>");
    expect(blocks[2]).toMatchObject({ type: "list", ordered: false });
  });

  it("validateSubmission drops unknown keys and types values", () => {
    const res = validateSubmission(
      [
        { key: "a", label: "A", type: "email", required: true },
        { key: "b", label: "B", type: "checkbox", required: false },
        { key: "c", label: "C", type: "select", required: true, options: ["x", "y"] },
      ],
      { field_a: " p@example.test ", field_c: "y", field_zzz: "evil" },
    );
    expect(res).toEqual({ ok: true, data: { a: "p@example.test", b: false, c: "y" } });
  });
});
