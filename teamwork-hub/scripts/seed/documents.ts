import { SEEDED_AS_SAMPLE } from "../../src/lib/sample-text";
import { createRequire } from "node:module";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { formTemplates, formTemplateVersions, organizations, type FormField, type SignerRequirement } from "../../src/db/schema";
import type { Viewer } from "../../src/lib/authz/policy";
import type { Role } from "../../src/db/schema";
import { addDaysYmd, localToUtc } from "../../src/lib/time";
import type { SeedCtx } from "./context";
import { TEAMWORK_MEDIA_PERMISSION_OPTIONS, TEAMWORK_MEDIA_RELEASE_BODY, TEAMWORK_MINOR_RELEASE_BODY, TEAMWORK_USER_AGREEMENT_BODY } from "../../src/lib/forms/teamwork-drafts";

/**
 * Documents seed: four SAMPLE-text templates (waiver, user agreement and media release carry Teamwork's
 * draft wording pending attorney review) with published versions (the waiver
 * gets a v2 that supersedes open v1 requests), and requests in every state —
 * completed (real PDFs generated through src/lib/pdf), pending, partially signed
 * (waiting on a second guardian), superseded, and expired with a renewal issued.
 * All signatures are produced by the same signing code the app uses.
 */

// The form libraries import "server-only" (via storage/actions). Outside Next's
// react-server condition that marker throws, so register an empty module for it
// before loading them. Tests alias it to a stub already; this is a no-op there.
function allowServerOnlyInScripts() {
  try {
    const req = createRequire(path.join(process.cwd(), "package.json"));
    const resolved = req.resolve("server-only");
    if (!req.cache[resolved]) {
      req.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: {} } as unknown as NodeJS.Module;
    }
  } catch {
    /* not resolvable: nothing to stub */
  }
}

// v1: the waiver section of the release Teamwork used in Zen Planner from Jan 2025 (shortened). v2: Teamwork's
// draft minor participant release (src/lib/forms/teamwork-drafts.ts), published with "Require re-signing".
const WAIVER_V1 = `# Teamwork Waiver and Release of Liability

**SAMPLE TEXT: earlier Teamwork wording kept for the demo history. Superseded by v2.**

## Acknowledgment of risk

I acknowledge that participation in athletic events, training, and exercise programs with T2 Indiana, Inc. involves inherent risks, including but not limited to:

- Physical injuries (bones, joints, muscles, internal organs)
- Severe physical contact
- Equipment failure or inadequacy
- Exposure to communicable diseases

I voluntarily assume these risks and waive any claims for property damage, personal injury, or illness arising from my participation.

## Release of liability

I release T2 Indiana, Inc., its staff, contractors, officers, and agents from any claims, including those due to negligence, that may result from my participation in activities conducted or sponsored by T2 Indiana, Inc.

## Parental consent

This waiver must be signed by a parent or legal guardian for athletes under 18. Participants 18 or older must sign this waiver themselves.
`;

const WAIVER_V2 = TEAMWORK_MINOR_RELEASE_BODY;

const HEALTH = `# Athlete Health & Emergency Information

**SAMPLE TEXT and SAMPLE FIELDS — replace with Teamwork-approved language and a reviewed field list.**

Please provide accurate health and emergency information so Teamwork coaches can train the athlete safely and respond in an emergency. This information is visible only to Teamwork staff with health access and to the athlete's authorized guardians.

Update this form whenever anything changes.
`;

const WAIVER_SIGNERS: SignerRequirement[] = [
  { role: "guardian", required: true },
  { role: "adult_athlete", required: true },
  { role: "athlete_assent", required: false },
  { role: "staff_witness", required: false },
];

const HEALTH_FIELDS: FormField[] = [
  { key: "emergency_contact_name", label: "Emergency contact name", type: "text", required: true },
  { key: "emergency_contact_phone", label: "Emergency contact phone", type: "phone", required: true },
  { key: "allergies", label: "Allergies (or 'none')", type: "textarea", required: true },
  { key: "medications", label: "Current medications", type: "textarea", required: false },
  { key: "conditions", label: "Medical conditions, prior injuries, or concussions", type: "textarea", required: false },
  { key: "physician_name", label: "Primary physician", type: "text", required: false },
  { key: "last_physical", label: "Date of last sports physical", type: "date", required: false },
  { key: "consent_emergency_treatment", label: "I consent to emergency treatment if I cannot be reached", type: "checkbox", required: true },
];

export async function seedDocuments(ctx: SeedCtx) {
  allowServerOnlyInScripts();
  const { contentHash } = await import("../../src/lib/forms/hash");
  const { createRequest, processRenewals } = await import("../../src/lib/forms/requests");
  const { publishVersion } = await import("../../src/lib/forms/templates");
  const { signRequest } = await import("../../src/lib/forms/signing");

  const { tx, orgId, today } = ctx;
  const at = (daysAgo: number, hm = "10:00") => localToUtc(addDaysYmd(today, -daysAgo), hm, ctx.tz);
  const viewer = (key: string, role: Role, personKey: string | null, displayName: string): Viewer => ({
    userId: ctx.users[key],
    orgId,
    role,
    personId: personKey ? ctx.people[personKey] : null,
    displayName,
    mfaVerified: true,
  });
  const rod = viewer("rod", "owner", "rod", "Rod (Owner)");
  const erin = viewer("erin", "operations", "erin", "Erin (Operations)");
  const alex = viewer("alex", "guardian", "alex_parker", "Alex Parker");
  const jordan = viewer("jordan", "guardian", "jordan_parker", "Jordan Parker");
  const chris = viewer("chris", "guardian", "chris_parker", "Chris Parker");
  const sam = viewer("sam", "guardian", "sam_rivera", "Sam Rivera");
  const dana = viewer("dana", "athlete", "dana_brooks", "Dana Brooks");
  const evidence = (n: number) => ({ ip: `203.0.113.${n}`, userAgent: "Seed script (synthetic demo data)", authMethod: "session_password" });

  async function template(name: string, kind: (typeof formTemplates.$inferInsert)["kind"], renewalMonths: number | null, requiredForBooking: boolean) {
    const [t] = await tx.insert(formTemplates).values({ orgId, name, kind, renewalMonths, requiredForBooking }).returning();
    return t;
  }
  async function draft(templateId: string, version: number, title: string, bodyMarkdown: string, fields: FormField[], signers: SignerRequirement[]) {
    const content = { title, bodyMarkdown, fields, signers };
    const [v] = await tx
      .insert(formTemplateVersions)
      .values({ templateId, version, ...content, contentHash: contentHash(content), isSampleText: SEEDED_AS_SAMPLE, status: "draft" })
      .returning();
    return v;
  }
  const issue = (versionId: string, athleteKey: string, personKey: string, dueInDays: number | null = 14) =>
    createRequest(tx, {
      orgId,
      versionId,
      athleteId: ctx.athletes[athleteKey],
      subjectPersonId: ctx.people[personKey],
      requestedBy: ctx.users.erin,
      dueDate: dueInDays === null ? null : addDaysYmd(today, dueInDays),
      isDemo: true,
      reason: "seed",
      notify: false,
    });
  type Sign = { v: Viewer; role: string; name: string; values?: Record<string, unknown>; inPerson?: string; when: Date; ip: number };
  const sign = (requestId: string, s: Sign) =>
    signRequest(
      tx,
      s.v,
      {
        requestId,
        role: s.role,
        typedName: s.name,
        consent: true,
        values: s.values ?? {},
        inPersonSignerPersonId: s.inPerson ? ctx.people[s.inPerson] : null,
        identityAttested: !!s.inPerson,
      },
      evidence(s.ip),
      s.when,
    );

  // The synthetic history below predates signer identity step-up (no email is ever sent by
  // the seed), so the requirement is switched off explicitly while it is generated: those
  // signatures honestly record `session_password`. The override is removed at the end, so
  // the org runs on the default (step-up ON for waivers and agreements).
  const setStepUpOverride = (value: object | null) =>
    tx
      .update(organizations)
      .set({ settings: value ? sql`${organizations.settings} || ${JSON.stringify({ formsStepUp: value })}::jsonb` : sql`${organizations.settings} - 'formsStepUp'` })
      .where(eq(organizations.id, orgId));
  await setStepUpOverride({ requireForKinds: [], allowSessionMfa: true });

  // --- Templates -------------------------------------------------------------------
  const waiver = await template("Release of Liability", "waiver", 12, true);
  const membership = await template("Member User Agreement", "agreement", null, false);
  const health = await template("Athlete Health & Emergency Info", "intake", 12, true);
  const media = await template("Photo, Video, Name, and Likeness Permission", "media_release", null, false);
  ctx.extra.formTemplates = { waiver: waiver.id, membership: membership.id, health: health.id, media: media.id };

  const wv1 = await draft(waiver.id, 1, "Waiver and Release of Liability", WAIVER_V1, [], WAIVER_SIGNERS);
  await publishVersion(tx, rod, wv1.id, { requireResign: false });
  const mv1 = await draft(
    membership.id,
    1,
    "Member User Agreement",
    TEAMWORK_USER_AGREEMENT_BODY,
    [{ key: "billing_contact_email", label: "Account holder email for notices", type: "email", required: true }],
    [
      { role: "guardian", required: true },
      { role: "adult_athlete", required: true },
    ],
  );
  await publishVersion(tx, rod, mv1.id, { requireResign: false });
  const hv1 = await draft(health.id, 1, "Athlete Health & Emergency Information", HEALTH, HEALTH_FIELDS, [
    { role: "guardian", required: true },
    { role: "adult_athlete", required: true },
  ]);
  await publishVersion(tx, rod, hv1.id, { requireResign: false });
  const dv1 = await draft(
    media.id,
    1,
    "Photo, Video, Name, and Likeness Permission",
    TEAMWORK_MEDIA_RELEASE_BODY,
    [{ key: "media_permission", label: "Permission level", type: "select", required: true, options: TEAMWORK_MEDIA_PERMISSION_OPTIONS }],
    [
      { role: "guardian", required: true },
      { role: "second_guardian", required: true },
      { role: "athlete_assent", required: false },
    ],
  );
  await publishVersion(tx, rod, dv1.id, { requireResign: false });

  const req: Record<string, string> = {};

  // --- Waiver v1: completed by families -------------------------------------------
  req.waiverMaya = (await issue(wv1.id, "maya", "maya_parker")).id;
  await sign(req.waiverMaya, { v: alex, role: "guardian", name: "Alex Parker", when: at(100), ip: 10 });
  req.waiverEli = (await issue(wv1.id, "eli", "eli_parker")).id;
  await sign(req.waiverEli, { v: jordan, role: "guardian", name: "Jordan Parker", when: at(90), ip: 11 });
  req.waiverAva = (await issue(wv1.id, "ava", "ava_parker")).id;
  await sign(req.waiverAva, { v: chris, role: "guardian", name: "Chris Parker", when: at(50), ip: 12 });
  req.waiverLeo = (await issue(wv1.id, "leo", "leo_rivera")).id;
  await sign(req.waiverLeo, { v: sam, role: "guardian", name: "Sam Rivera", when: at(60), ip: 13 });
  req.waiverDana = (await issue(wv1.id, "dana", "dana_brooks")).id;
  await sign(req.waiverDana, { v: dana, role: "adult_athlete", name: "Dana Brooks", when: at(30), ip: 14 });
  // Filler families have no logins: signed in person at the front desk, witnessed by staff.
  for (const [k, last, d] of [
    ["ethan", "Cole", 45],
    ["sofia", "Reyes", 40],
    ["zoe", "Whitaker", 20],
  ] as const) {
    req[`waiver_${k}`] = (await issue(wv1.id, k, `${k}_${last.toLowerCase()}`)).id;
    await sign(req[`waiver_${k}`], { v: erin, role: "guardian", name: `Guardian ${last}`, inPerson: `${k}_guardian`, when: at(d), ip: 20 });
  }
  // Liam: completed over a year ago → expired → renewal request issued by the sweep.
  req.waiverLiamOld = (await issue(wv1.id, "liam", "liam_okafor")).id;
  await sign(req.waiverLiamOld, { v: erin, role: "guardian", name: "Guardian Okafor", inPerson: "liam_guardian", when: at(400), ip: 21 });

  // Open v1 requests that will be superseded when v2 requires re-signing.
  req.waiverHarperV1 = (await issue(wv1.id, "harper", "harper_lindqvist", 7)).id;
  req.waiverMasonV1 = (await issue(wv1.id, "mason", "mason_patel", 7)).id;

  // --- Waiver v2 (re-signing required) ---------------------------------------------
  const wv2 = await draft(waiver.id, 2, "Minor Participant Release of Liability", WAIVER_V2, [], WAIVER_SIGNERS);
  await publishVersion(tx, rod, wv2.id, { requireResign: true });
  ctx.extra.formVersions = { waiverV1: wv1.id, waiverV2: wv2.id, membershipV1: mv1.id, healthV1: hv1.id, mediaV1: dv1.id };

  await processRenewals(tx, orgId, { now: at(0, "06:00"), actorUserId: null });
  for (const [k, last] of [
    ["jackson", "Mbeki"],
    ["ella", "Novak"],
    ["owen", "Fitzgerald"],
  ] as const) {
    req[`waiver_${k}`] = (await issue(wv2.id, k, `${k}_${last.toLowerCase()}`, -3)).id; // overdue
  }

  // --- Health intake ----------------------------------------------------------------
  const healthValues = (name: string, phone: string) => ({
    field_emergency_contact_name: name,
    field_emergency_contact_phone: phone,
    field_allergies: "None known (sample)",
    field_medications: "",
    field_conditions: "",
    field_physician_name: "Sample Family Clinic",
    field_last_physical: addDaysYmd(today, -200),
    field_consent_emergency_treatment: "on",
  });
  req.healthMaya = (await issue(hv1.id, "maya", "maya_parker")).id;
  await sign(req.healthMaya, { v: alex, role: "guardian", name: "Alex Parker", values: healthValues("Alex Parker", "+1 812 555 0101"), when: at(100, "10:05"), ip: 10 });
  req.healthLeo = (await issue(hv1.id, "leo", "leo_rivera")).id;
  await sign(req.healthLeo, { v: sam, role: "guardian", name: "Sam Rivera", values: healthValues("Casey Nguyen", "+1 812 555 0177"), when: at(60, "10:05"), ip: 13 });
  req.healthDana = (await issue(hv1.id, "dana", "dana_brooks")).id;
  await sign(req.healthDana, { v: dana, role: "adult_athlete", name: "Dana Brooks", values: healthValues("Pat Brooks", "+1 812 555 0150"), when: at(30, "10:05"), ip: 14 });
  req.healthEli = (await issue(hv1.id, "eli", "eli_parker", 10)).id; // pending — Alex or Jordan can sign
  req.healthAva = (await issue(hv1.id, "ava", "ava_parker", 10)).id; // pending — Chris

  // --- Membership agreement ---------------------------------------------------------
  req.membershipDana = (await issue(mv1.id, "dana", "dana_brooks", null)).id;
  await sign(req.membershipDana, { v: dana, role: "adult_athlete", name: "Dana Brooks", values: { field_billing_contact_email: "dana.brooks@example.test" }, when: at(30, "10:10"), ip: 14 });
  req.membershipMaya = (await issue(mv1.id, "maya", "maya_parker", 21)).id; // pending

  // --- Media release: partially signed (needs second guardian) ----------------------
  req.mediaMaya = (await issue(dv1.id, "maya", "maya_parker", 14)).id;
  await sign(req.mediaMaya, { v: alex, role: "guardian", name: "Alex Parker", values: { field_media_permission: "Limited permission" }, when: at(5), ip: 10 });
  req.mediaLeo = (await issue(dv1.id, "leo", "leo_rivera", 14)).id; // pending — Sam and Casey

  await setStepUpOverride(null);
  ctx.extra.formRequests = req;
  // Sanity: both waiver versions are published (v1 stays immutable; v2 is current).
  const pub = await tx.select({ id: formTemplateVersions.id, status: formTemplateVersions.status }).from(formTemplateVersions).where(eq(formTemplateVersions.templateId, waiver.id));
  if (pub.filter((p) => p.status === "published").length !== 2) throw new Error("documents seed: waiver v2 not published");
}
