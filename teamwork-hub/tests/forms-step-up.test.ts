import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { formRequests, formTemplateVersions, signatures, signerStepUpChallenges, storedObjects, users } from "@/db/schema";
import { AuthzError } from "@/lib/authz/policy";
import { UserError } from "@/lib/actions";
import { loadRequestContext } from "@/lib/forms/context";
import { createRequest } from "@/lib/forms/requests";
import { signRequest, StepUpRequiredError } from "@/lib/forms/signing";
import {
  DEFAULT_STEP_UP,
  hashStepUpCode,
  maskEmail,
  sendStepUpCode,
  STEP_UP_CODE_TTL_MS,
  stepUpSettingsOf,
  stepUpStatus,
  updateStepUpSettings,
  verifyStepUpCode,
} from "@/lib/forms/step-up";
import { verifyRequest } from "@/lib/forms/verify";
import { createDraftVersion, createTemplate, publishVersion, saveDraft } from "@/lib/forms/templates";
import { renderCompletedFormPdf } from "@/lib/pdf/completed-form";
import { objectStore } from "@/lib/storage";
import { closeTestDb, seedOrg, testDb, viewerFor } from "./helpers/db";
import { codeFrom, verifyByEmail, withEmailCapture } from "./helpers/step-up";
import { extractPdfText } from "./helpers/pdf-text";

let ctx: Awaited<ReturnType<typeof seedOrg>>;
const ev = { ip: "198.51.100.9", userAgent: "vitest", authMethod: "session_password" };
const T0 = new Date("2026-03-02T15:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const R = () => ctx.extra.formRequests;

beforeAll(async () => {
  ctx = await seedOrg();
});
afterAll(closeTestDb);

/** A fresh open request on the current waiver (v2) for a seeded athlete. */
async function freshWaiver(athleteKey: string, personKey: string, version: "waiverV2" | "membershipV1" | "healthV1" = "waiverV2") {
  const r = await testDb().transaction((tx) =>
    createRequest(tx, {
      orgId: ctx.orgId,
      versionId: ctx.extra.formVersions[version],
      athleteId: ctx.athletes[athleteKey],
      subjectPersonId: ctx.people[personKey],
      requestedBy: ctx.users.erin,
      notify: false,
    }),
  );
  return r.id;
}

const challengesOf = (requestId: string) =>
  testDb().select().from(signerStepUpChallenges).where(eq(signerStepUpChallenges.formRequestId, requestId)).orderBy(signerStepUpChallenges.createdAt);

const signAlex = async (requestId: string, now = T0) => {
  const alex = await viewerFor(ctx, "alex");
  return testDb().transaction((tx) => signRequest(tx, alex, { requestId, role: "guardian", typedName: "Alex Parker", consent: true, values: {} }, ev, now));
};

describe("signer identity step-up: settings", () => {
  it("defaults to ON for waivers and agreements, MFA accepted; only owners/admins change it", async () => {
    expect(stepUpSettingsOf({})).toEqual(DEFAULT_STEP_UP);
    expect(DEFAULT_STEP_UP.requireForKinds).toEqual(["waiver", "agreement"]);
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    await expect(db.transaction((tx) => updateStepUpSettings(tx, erin, { requireForKinds: [], allowSessionMfa: true }))).rejects.toThrow(AuthzError);
    const ctxWaiver = (await loadRequestContext(db, ctx.orgId, await freshWaiver("maya", "maya_parker")))!;
    const alex = await viewerFor(ctx, "alex");
    const st = await stepUpStatus(db, alex, ctxWaiver, T0);
    expect(st).toMatchObject({ required: true, satisfiedByMfa: false, emailOnFile: maskEmail("alex.parker@example.test"), emailConfigured: false, latest: null });
    const intake = (await loadRequestContext(db, ctx.orgId, R().healthEli))!;
    expect((await stepUpStatus(db, alex, intake, T0)).required).toBe(false);
  });
});


describe("signer identity step-up: enforcement", () => {
  it("refuses a waiver signature without step-up and writes nothing", async () => {
    const id = await freshWaiver("maya", "maya_parker");
    const err = await signAlex(id).catch((e) => e);
    expect(err).toBeInstanceOf(StepUpRequiredError);
    expect((err as UserError).fieldErrors).toHaveProperty("stepUpCode");
    const c = (await loadRequestContext(testDb(), ctx.orgId, id))!;
    expect(c.signatures).toHaveLength(0);
    expect(c.req.submittedData).toBeNull();
    expect(c.req.status).toBe("pending");
  });

  it("without email configured: the send is recorded as not_configured, the code is unusable, signing stays blocked", async () => {
    const db = testDb();
    const id = await freshWaiver("maya", "maya_parker");
    const alex = await viewerFor(ctx, "alex");
    const res = await sendStepUpCode(db, alex, id, T0);
    expect(res.status).toBe("not_configured");
    expect(res.reason).toMatch(/EMAIL_PROVIDER/);
    const [ch] = await challengesOf(id);
    expect(ch).toMatchObject({ status: "undeliverable", deliveryStatus: "not_configured", address: "alex.parker@example.test" });
    // Even the right code (we can't know it — only its HMAC is stored) is refused; any guess is refused.
    const v = await db.transaction((tx) => verifyStepUpCode(tx, alex, id, "123456", at(1000)));
    expect(v.ok).toBe(false);
    await expect(signAlex(id, at(2000))).rejects.toThrow(StepUpRequiredError);
  });

  it("email OTP: code sent to the email on file, hashed at rest, verified once, recorded in evidence and the PDF", async () => {
    const db = testDb();
    const id = await freshWaiver("maya", "maya_parker");
    const alex = await viewerFor(ctx, "alex");
    const code = await withEmailCapture(async (outbox) => {
      const res = await sendStepUpCode(db, alex, id, T0);
      expect(res).toMatchObject({ status: "sent", to: maskEmail("alex.parker@example.test") });
      expect(outbox).toHaveLength(1);
      expect(outbox[0].to).toBe("alex.parker@example.test");
      return codeFrom(outbox[0]);
    });
    const [ch] = await challengesOf(id);
    expect(ch.status).toBe("pending");
    expect(ch.deliveryStatus).toBe("sent");
    expect(ch.codeHash).toBe(hashStepUpCode(ch.id, code));
    expect(JSON.stringify(ch)).not.toContain(code);
    expect(ch.expiresAt.getTime() - T0.getTime()).toBe(STEP_UP_CODE_TTL_MS);

    const wrong = code === "000000" ? "000001" : "000000";
    const bad = await db.transaction((tx) => verifyStepUpCode(tx, alex, id, wrong, at(5_000)));
    expect(bad).toMatchObject({ ok: false, attemptsLeft: 4 });
    // Another guardian cannot use Alex's code.
    const jordan = await viewerFor(ctx, "jordan");
    expect((await db.transaction((tx) => verifyStepUpCode(tx, jordan, id, code, at(6_000)))).ok).toBe(false);

    const ok = await db.transaction((tx) => verifyStepUpCode(tx, alex, id, code, at(10_000)));
    expect(ok.ok).toBe(true);
    const res = await signAlex(id, at(20_000));
    expect(res.status).toBe("completed");

    const c = (await loadRequestContext(db, ctx.orgId, id))!;
    const sig = c.signatures[0];
    expect(sig.authMethod).toBe(`session_password; step_up=email_otp; challenge=${ch.id}`);
    const [after] = await challengesOf(id);
    expect(after).toMatchObject({ status: "consumed", signatureId: sig.id, attempts: 1 });
    expect((await verifyRequest(db, c, { checkPdfBytes: true })).ok).toBe(true);

    const [obj] = await db.select().from(storedObjects).where(eq(storedObjects.id, c.req.completedPdfObjectId!));
    const pdf = await extractPdfText(await objectStore().get(obj.storageKey));
    expect(pdf.text).toContain("one-time code sent to the signer's email on file");
    expect(pdf.text).toContain(`step_up=email_otp; challenge=${ch.id}`);
    expect(pdf.text).toMatch(/no claim is made about legal enforceability/);
  });

  it("locks after 5 wrong attempts; expires after 10 minutes", async () => {
    const db = testDb();
    const alex = await viewerFor(ctx, "alex");
    const id = await freshWaiver("eli", "eli_parker");
    const code = await withEmailCapture(async (outbox) => {
      await sendStepUpCode(db, alex, id, T0);
      return codeFrom(outbox[0]);
    });
    const wrong = code === "999999" ? "999998" : "999999";
    for (let i = 0; i < 5; i++) await db.transaction((tx) => verifyStepUpCode(tx, alex, id, wrong, at(1000 + i)));
    expect((await challengesOf(id))[0]).toMatchObject({ status: "locked", attempts: 5 });
    expect(await db.transaction((tx) => verifyStepUpCode(tx, alex, id, code, at(2000)))).toMatchObject({ ok: false, attemptsLeft: 0 });

    // A new code (after the resend cooldown) works until it expires.
    const code2 = await withEmailCapture(async (outbox) => {
      await sendStepUpCode(db, alex, id, at(61_000));
      return codeFrom(outbox[0]);
    });
    const late = await db.transaction((tx) => verifyStepUpCode(tx, alex, id, code2, at(61_000 + STEP_UP_CODE_TTL_MS + 1)));
    expect(late).toMatchObject({ ok: false });
    expect((late as { error: string }).error).toMatch(/expired/);
    await expect(signAlex(id, at(61_000 + STEP_UP_CODE_TTL_MS + 2))).rejects.toThrow(StepUpRequiredError);
  });

  it("rate-limits resends (60 s cooldown, 5 per hour) and supersedes the previous code", async () => {
    const db = testDb();
    const alex = await viewerFor(ctx, "alex");
    const id = await freshWaiver("maya", "maya_parker");
    await withEmailCapture(async (outbox) => {
      await sendStepUpCode(db, alex, id, T0);
      await expect(sendStepUpCode(db, alex, id, at(30_000))).rejects.toThrow(/wait \d+ seconds/);
      await sendStepUpCode(db, alex, id, at(61_000));
      const first = codeFrom(outbox[0]);
      const rows = await challengesOf(id);
      expect(rows.map((r) => r.status)).toEqual(["superseded", "pending"]);
      // The superseded code no longer works (unless it happens to equal the new one).
      if (first !== codeFrom(outbox[1])) expect((await db.transaction((tx) => verifyStepUpCode(tx, alex, id, first, at(62_000)))).ok).toBe(false);
      for (let i = 2; i < 5; i++) await sendStepUpCode(db, alex, id, at(61_000 * i));
      await expect(sendStepUpCode(db, alex, id, at(61_000 * 5 + 1))).rejects.toThrow(/Too many codes/);
      expect(outbox).toHaveLength(5);
    });
  });

  it("DELIVERY_TEST_RECIPIENTS redirects the code to the test address and records it", async () => {
    const db = testDb();
    const alex = await viewerFor(ctx, "alex");
    const id = await freshWaiver("eli", "eli_parker");
    await withEmailCapture(
      async (outbox) => {
        const res = await sendStepUpCode(db, alex, id, T0);
        expect(res.status).toBe("test_redirected");
        expect(outbox[0].to).toBe("qa@teamwork-hub.test");
        expect(outbox[0].subject).toMatch(/^\[TEST → originally alex\.parker@example\.test\]/);
      },
      { DELIVERY_TEST_RECIPIENTS: "qa@teamwork-hub.test" },
    );
    const [ch] = await challengesOf(id);
    expect(ch).toMatchObject({ status: "pending", deliveryStatus: "test_redirected", deliveryReason: "Redirected to test recipient qa@teamwork-hub.test" });
  });

  it("a session that completed MFA satisfies step-up when allowed (and only for users with MFA enabled)", async () => {
    const db = testDb();
    const id = await freshWaiver("dana", "dana_brooks");
    const dana = await viewerFor(ctx, "dana"); // mfaVerified: true, but MFA not enabled on the account
    const sign = (now: Date) =>
      db.transaction((tx) => signRequest(tx, dana, { requestId: id, role: "adult_athlete", typedName: "Dana Brooks", consent: true, values: {} }, { ...ev, authMethod: "session_password_mfa" }, now));
    await expect(sign(T0)).rejects.toThrow(StepUpRequiredError);
    await db.update(users).set({ mfaEnabled: true }).where(eq(users.id, ctx.users.dana));
    const rod = await viewerFor(ctx, "rod");
    try {
      await db.transaction((tx) => updateStepUpSettings(tx, rod, { requireForKinds: ["waiver", "agreement"], allowSessionMfa: false }));
      await expect(sign(at(1000))).rejects.toThrow(StepUpRequiredError);
      await db.transaction((tx) => updateStepUpSettings(tx, rod, DEFAULT_STEP_UP));
      const res = await sign(at(2000));
      expect(res.status).toBe("completed");
      const c = (await loadRequestContext(db, ctx.orgId, id))!;
      expect(c.signatures[0].authMethod).toBe("session_password_mfa; step_up=session_mfa");
    } finally {
      await db.update(users).set({ mfaEnabled: false }).where(eq(users.id, ctx.users.dana));
    }
  });

  it("staff-assisted in person: identity attestation is required and recorded as staff_witnessed_in_person", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const id = R().waiver_jackson;
    const input = { requestId: id, role: "guardian", typedName: "Guardian Mbeki", consent: true, values: {}, inPersonSignerPersonId: ctx.people.jackson_guardian };
    const err = await db.transaction((tx) => signRequest(tx, erin, input, ev, T0)).catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as UserError).fieldErrors).toHaveProperty("identityAttested");
    const res = await db.transaction((tx) => signRequest(tx, erin, { ...input, identityAttested: true }, ev, T0));
    expect(res.status).toBe("completed");
    const c = (await loadRequestContext(db, ctx.orgId, id))!;
    expect(c.signatures[0].authMethod).toBe(`staff_witnessed_in_person; witness=${erin.displayName} [${erin.userId}]; identity=staff_attested`);
  });

  it("turning the requirement off for a kind lets that kind sign without step-up (recorded as the plain session)", async () => {
    const db = testDb();
    const rod = await viewerFor(ctx, "rod");
    const id = await freshWaiver("maya", "maya_parker");
    await db.transaction((tx) => updateStepUpSettings(tx, rod, { requireForKinds: ["agreement"], allowSessionMfa: true }));
    try {
      const res = await signAlex(id, T0);
      expect(res.status).toBe("completed");
      const [sig] = await db.select().from(signatures).where(eq(signatures.formRequestId, id));
      expect(sig.authMethod).toBe("session_password");
    } finally {
      await db.transaction((tx) => updateStepUpSettings(tx, rod, DEFAULT_STEP_UP));
    }
  });

  it("a verified code is bound to its request and used once", async () => {
    const db = testDb();
    const alex = await viewerFor(ctx, "alex");
    const a = await freshWaiver("maya", "maya_parker");
    const b = await freshWaiver("eli", "eli_parker");
    await verifyByEmail(db, alex, a, T0);
    await expect(signAlex(b, at(1000))).rejects.toThrow(StepUpRequiredError);
    await signAlex(a, at(2000));
    const [ch] = await db.select().from(signerStepUpChallenges).where(and(eq(signerStepUpChallenges.formRequestId, a), eq(signerStepUpChallenges.status, "consumed")));
    expect(ch.signatureId).toBeTruthy();
    // The code cannot be "re-verified" for another signature.
    expect((await db.transaction((tx) => verifyStepUpCode(tx, alex, a, "000000", at(3000)))).ok).toBe(false);
  });
});

describe("form version status guard (DB trigger)", () => {
  it("published versions cannot go back to draft or be retired, deleted, or edited via raw SQL", async () => {
    const db = testDb();
    const v1 = ctx.extra.formVersions.waiverV1;
    const err = (p: Promise<unknown>) => p.then(() => null, (e: { cause?: { message?: string } }) => e?.cause?.message ?? String(e));
    expect(await err(db.execute(sql`update form_template_versions set status = 'draft' where id = ${v1}`))).toMatch(/cannot change status \(published -> draft\)/);
    expect(await err(db.execute(sql`update form_template_versions set status = 'retired' where id = ${v1}`))).toMatch(/published -> retired/);
    expect(await err(db.execute(sql`update form_template_versions set status = 'draft', body_markdown = 'x' where id = ${v1}`))).toMatch(/published/);
    expect(await err(db.execute(sql`delete from form_template_versions where id = ${v1}`))).toMatch(/only drafts can be deleted/);
    const [row] = await db.select().from(formTemplateVersions).where(eq(formTemplateVersions.id, v1));
    expect(row.status).toBe("published");
    // Non-content columns stay editable (approve sample text).
    await db.execute(sql`update form_template_versions set is_sample_text = is_sample_text where id = ${v1}`);
  });

  it("drafts stay editable and deletable; retired rows never return to draft or change content", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const tpl = await db.transaction((tx) => createTemplate(tx, erin, { name: "Guard Test", kind: "policy", renewalMonths: null, requiredForBooking: false }));
    const d = await db.transaction((tx) => createDraftVersion(tx, erin, tpl.id));
    await db.transaction((tx) => saveDraft(tx, erin, d.version.id, { title: "Guard Test", bodyMarkdown: "Sample body for the guard test.", fields: [], signers: [{ role: "guardian", required: true }] }));
    await db.execute(sql`update form_template_versions set status = 'retired' where id = ${d.version.id}`);
    const err = (p: Promise<unknown>) => p.then(() => null, (e: { cause?: { message?: string } }) => e?.cause?.message ?? String(e));
    expect(await err(db.execute(sql`update form_template_versions set status = 'draft' where id = ${d.version.id}`))).toMatch(/cannot return to draft/);
    expect(await err(db.execute(sql`update form_template_versions set body_markdown = 'edited' where id = ${d.version.id}`))).toMatch(/immutable/);
    // A fresh draft publishes normally and can't be unpublished.
    const d2 = await db.transaction((tx) => createDraftVersion(tx, erin, tpl.id));
    await db.transaction((tx) => saveDraft(tx, erin, d2.version.id, { title: "Guard Test", bodyMarkdown: "Second sample body.", fields: [], signers: [{ role: "guardian", required: true }] }));
    await db.transaction((tx) => publishVersion(tx, erin, d2.version.id, { requireResign: false }));
    expect(await err(db.execute(sql`update form_template_versions set status = 'draft' where id = ${d2.version.id}`))).toMatch(/published -> draft/);
    const d3 = await db.transaction((tx) => createDraftVersion(tx, erin, tpl.id));
    await db.delete(formTemplateVersions).where(eq(formTemplateVersions.id, d3.version.id));
  });
});

describe("Unicode PDFs", () => {
  const NAME = "Zoë Ångström-Nguyễn 王小明 さくら 김민준";

  it("names with diacritics, CJK and Hangul round-trip through the completed PDF with real glyphs", async () => {
    const db = testDb();
    const erin = await viewerFor(ctx, "erin");
    const id = R().waiver_ella;
    const res = await db.transaction((tx) =>
      signRequest(
        tx,
        erin,
        { requestId: id, role: "guardian", typedName: NAME, consent: true, values: {}, inPersonSignerPersonId: ctx.people.ella_guardian, identityAttested: true },
        ev,
        T0,
      ),
    );
    expect(res.status).toBe("completed");
    const [r] = await db.select().from(formRequests).where(eq(formRequests.id, id));
    const [obj] = await db.select().from(storedObjects).where(eq(storedObjects.id, r.completedPdfObjectId!));
    const pdf = await extractPdfText(await objectStore().get(obj.storageKey));
    expect(pdf.text).toContain(NAME);
    expect(pdf.text).not.toContain("Zo? ");
    expect(pdf.blankGlyphs).toEqual([]);
    expect(pdf.fonts.some((f) => f.includes("NotoSans-Regular"))).toBe(true);
    expect(pdf.fonts.some((f) => f.includes("NotoSansSC"))).toBe(true);
    expect(pdf.fonts.some((f) => f.includes("NotoSansKR"))).toBe(true);
    expect((await verifyRequest(db, (await loadRequestContext(db, ctx.orgId, id))!, { checkPdfBytes: true })).ok).toBe(true);
  });

  it("Latin-only PDFs embed no CJK fallback; long unbroken CJK text wraps; uncovered symbols degrade to '?'", async () => {
    const base = {
      orgName: "Teamwork",
      timezone: "America/Indiana/Indianapolis",
      requestId: "00000000-0000-0000-0000-000000000000",
      templateName: "Waiver",
      title: "Waiver",
      version: 1,
      contentHash: "a".repeat(64),
      isSampleText: true,
      subjectName: "Renée Lefèvre",
      fields: [],
      values: {},
      signatures: [],
      completedAt: T0,
      integrityHash: "b".repeat(64),
    };
    const latin = await extractPdfText(await renderCompletedFormPdf({ ...base, bodyMarkdown: "Ça va — naïve café, Øre, Łódź, Ελληνικά, Русский." }));
    expect(latin.text).toContain("Ça va — naïve café, Øre, Łódź, Ελληνικά, Русский.");
    expect(latin.fonts.some((f) => f.includes("NotoSansSC") || f.includes("NotoSansKR"))).toBe(false);

    const longCjk = "运动员家长须知".repeat(40);
    const cjk = await extractPdfText(await renderCompletedFormPdf({ ...base, bodyMarkdown: `${longCjk}\n\nEmoji 🙂 here` }));
    expect(cjk.text.replace(/\n/g, "")).toContain(longCjk);
    expect(cjk.text).toContain("Emoji ? here");
    expect(cjk.blankGlyphs).toEqual([]);
  });
});
