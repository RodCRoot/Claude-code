import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { commPreferences, leads, organizations, people, tasks, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { enqueue } from "@/lib/jobs";
import { DomainError } from "@/lib/messaging/errors";
import { logConsentEvent } from "@/lib/messaging/preferences";
import { ensureStages } from "./stages";

export const PREFERRED_TIMES = ["Weekday mornings", "Weekday afternoons", "Weekday evenings", "Weekends"] as const;

const trimmed = (max: number) => z.string().trim().max(max);
const optional = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().max(max).optional());

export const inquirySchema = z
  .object({
    inquiringFor: z.enum(["child", "self"]),
    contactFirstName: trimmed(80).min(1, "Required"),
    contactLastName: trimmed(80).min(1, "Required"),
    email: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().toLowerCase().email("Enter a valid email").max(200).optional()),
    phone: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().trim().regex(/^\+?[\d\s().-]{7,20}$/, "Enter a valid phone number").optional(),
    ),
    athleteFirstName: optional(80),
    athleteLastName: optional(80),
    athleteAge: z.preprocess(
      (v) => (v === "" || v == null ? undefined : Number(v)),
      z.number({ error: "Enter an age" }).int("Whole years").min(5, "Ages 5 and up").max(99).optional(),
    ),
    sport: optional(80),
    goals: optional(2000),
    preferredTimes: z.array(z.enum(PREFERRED_TIMES)).default([]),
    heardFrom: optional(120),
    consentEmail: z.boolean().default(false),
    consentSms: z.boolean().default(false),
  })
  .superRefine((d, ctx) => {
    if (!d.email && !d.phone) ctx.addIssue({ code: "custom", path: ["email"], message: "Give us an email or phone number so we can reply" });
    if (d.inquiringFor === "child") {
      if (!d.athleteFirstName) ctx.addIssue({ code: "custom", path: ["athleteFirstName"], message: "Required" });
      if (!d.athleteLastName) ctx.addIssue({ code: "custom", path: ["athleteLastName"], message: "Required" });
    }
    if (d.athleteAge == null) ctx.addIssue({ code: "custom", path: ["athleteAge"], message: "Enter the athlete's age" });
    if (d.consentSms && !d.phone) ctx.addIssue({ code: "custom", path: ["phone"], message: "Add a mobile number to receive texts" });
  });

export type InquiryInput = z.input<typeof inquirySchema>;

/**
 * Per-IP limit, plus an org-wide ceiling on public web inquiries. The IP comes from forwarding
 * headers a client can forge (or may be missing), so the org-wide ceiling is what actually bounds a
 * flood of fake leads/tasks; staff-entered leads are never counted against it.
 */
export const RATE_LIMIT = { max: 5, windowMinutes: 60, orgWebMax: 30 };

export const hashIp = (ip: string | null | undefined) =>
  ip ? createHash("sha256").update(`teamwork-inquiry:${ip}`).digest("hex").slice(0, 32) : null;

export type PossibleDuplicate = { personId: string; name: string; matchedOn: "email" | "phone" };

const digits = (s: string) => s.replace(/\D/g, "").slice(-10);

/** Existing people sharing an email (case-insensitive) or phone digits. Never merged automatically. */
export async function findPossibleDuplicates(tx: Tx, orgId: string, email: string | null | undefined, phone: string | null | undefined, excludeIds: string[] = []) {
  const conds = [];
  if (email) conds.push(sql`lower(${people.email}) = ${email.toLowerCase()}`);
  if (phone && digits(phone).length >= 7) conds.push(sql`right(regexp_replace(coalesce(${people.phone}, ''), '\\D', '', 'g'), 10) = ${digits(phone)}`);
  if (!conds.length) return [];
  const rows = await tx
    .select({ id: people.id, first: people.firstName, last: people.lastName, email: people.email, phone: people.phone })
    .from(people)
    .where(and(eq(people.orgId, orgId), or(...conds), excludeIds.length ? notInArray(people.id, excludeIds) : sql`true`, sql`${people.status} <> 'archived'`));
  return rows.map<PossibleDuplicate>((r) => ({
    personId: r.id,
    name: `${r.first} ${r.last}`,
    matchedOn: email && r.email?.toLowerCase() === email.toLowerCase() ? "email" : "phone",
  }));
}

/** Configured default owner (settings.crm.defaultLeadOwnerUserId), else first operations user, else owner. */
export async function defaultLeadOwner(tx: Tx, orgId: string): Promise<string | null> {
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  const configured = ((o?.settings?.crm ?? {}) as Record<string, unknown>).defaultLeadOwnerUserId;
  const staff = await tx
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.orgId, orgId), inArray(users.role, ["owner", "admin", "operations"]), sql`${users.disabledAt} is null`))
    .orderBy(asc(users.createdAt));
  if (typeof configured === "string" && staff.some((s) => s.id === configured)) return configured;
  return staff.find((s) => s.role === "operations")?.id ?? staff.find((s) => s.role === "owner")?.id ?? staff[0]?.id ?? null;
}

export type IntakeMeta = { ip?: string | null; source?: string; actorUserId?: string | null; actorRole?: string | null; now?: Date; isDemo?: boolean };

/**
 * Creates person(s) + lead (stage `new`) + follow-up task, records consent, and flags
 * possible duplicates for staff review. Never links to or merges existing people.
 */
export async function createLeadFromInquiry(tx: Tx, orgId: string, input: InquiryInput, meta: IntakeMeta = {}) {
  const d = inquirySchema.parse(input);
  const now = meta.now ?? new Date();
  const ipHash = hashIp(meta.ip);
  const since = new Date(now.getTime() - RATE_LIMIT.windowMinutes * 60_000);

  if ((meta.source ?? "web_inquiry") === "web_inquiry") {
    // Serialize public submissions per org so concurrent requests can't all pass the count.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"crm-inquiry:" + orgId}))`);
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), gt(leads.createdAt, since), eq(leads.source, "web_inquiry")));
    if (n >= RATE_LIMIT.orgWebMax) throw new DomainError("We're receiving an unusual number of inquiries right now. Please try again later or call the front desk.");
  }

  if (ipHash) {
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(leads)
      .where(and(eq(leads.orgId, orgId), gt(leads.createdAt, since), sql`${leads.inquiry}->>'ipHash' = ${ipHash}`));
    if (n >= RATE_LIMIT.max) throw new DomainError("We've received several inquiries from this connection recently. Please try again later or call the front desk.");
  }

  await ensureStages(tx, orgId);
  const source = meta.source ?? "web_inquiry";
  const [contact] = await tx
    .insert(people)
    .values({ orgId, firstName: d.contactFirstName, lastName: d.contactLastName, email: d.email ?? null, phone: d.phone ?? null, status: "lead", source, isDemo: !!meta.isDemo })
    .returning();
  let athletePersonId = contact.id;
  if (d.inquiringFor === "child") {
    const [ath] = await tx
      .insert(people)
      .values({ orgId, firstName: d.athleteFirstName!, lastName: d.athleteLastName!, status: "lead", source, isDemo: !!meta.isDemo, customFields: { inquiryAge: d.athleteAge } })
      .returning();
    athletePersonId = ath.id;
  } else {
    await tx.update(people).set({ customFields: { inquiryAge: d.athleteAge } }).where(eq(people.id, contact.id));
  }

  const dupes = await findPossibleDuplicates(tx, orgId, d.email, d.phone, [contact.id, athletePersonId]);
  const ownerUserId = await defaultLeadOwner(tx, orgId);
  const [lead] = await tx
    .insert(leads)
    .values({
      orgId,
      personId: athletePersonId,
      contactPersonId: d.inquiringFor === "child" ? contact.id : null,
      stage: "new",
      source,
      interest: d.sport ?? null,
      ownerUserId,
      isDemo: !!meta.isDemo,
      inquiry: {
        inquiringFor: d.inquiringFor,
        athleteAge: d.athleteAge,
        sport: d.sport ?? null,
        goals: d.goals ?? null,
        preferredTimes: d.preferredTimes,
        heardFrom: d.heardFrom ?? null,
        submittedAt: now.toISOString(),
        ipHash,
        possibleDuplicates: dupes,
        duplicateReview: dupes.length ? "pending" : "none",
      },
    })
    .returning();

  // Consent is recorded on the contact person with source + timestamp. Unchecked = no consent.
  for (const [channel, given] of [["email", d.consentEmail], ["sms", d.consentSms]] as const) {
    const consentSource = `${source} form${given ? " checkbox" : " (not checked)"}`;
    const inserted = await tx
      .insert(commPreferences)
      .values({ orgId, personId: contact.id, channel, consent: given ? "opted_in" : "unknown", consentSource, capturedAt: now })
      .onConflictDoNothing()
      .returning({ id: commPreferences.id });
    if (inserted.length) await logConsentEvent(tx, { orgId, personId: contact.id, channel, consent: given ? "opted_in" : "unknown", source: "inquiry_form", detail: consentSource, now });
  }

  const name = `${d.inquiringFor === "child" ? d.athleteFirstName : d.contactFirstName} ${d.inquiringFor === "child" ? d.athleteLastName : d.contactLastName}`;
  await tx.insert(tasks).values({
    orgId,
    title: `Follow up with new lead: ${name}`,
    description: `Contact ${d.contactFirstName} ${d.contactLastName}${d.email ? ` · ${d.email}` : ""}${d.phone ? ` · ${d.phone}` : ""}${dupes.length ? `\nPossible duplicate of existing people — review before converting.` : ""}`,
    dueAt: new Date(now.getTime() + 24 * 3_600_000),
    assigneeUserId: ownerUserId,
    relatedPersonId: athletePersonId,
    relatedType: "lead",
    relatedId: lead.id,
    priority: dupes.length ? "high" : "normal",
    source: "crm_intake",
    dedupeKey: `lead-followup:${lead.id}`,
    isDemo: !!meta.isDemo,
  });

  await audit(tx, { orgId, actorUserId: meta.actorUserId ?? null, actorRole: meta.actorRole ?? "public" }, "crm.lead_created", "lead", lead.id, {
    summary: `Lead created from ${source}: ${name}${dupes.length ? ` (possible duplicate of ${dupes.map((x) => x.name).join(", ")})` : ""}`,
    after: { stage: "new", source, consentEmail: d.consentEmail, consentSms: d.consentSms },
  });
  await enqueue(tx, {
    type: "automation.evaluate",
    orgId,
    payload: { orgId, trigger: "lead_created", leadId: lead.id },
    dedupeKey: `automation.evaluate:lead_created:${lead.id}`,
  });
  return { leadId: lead.id, possibleDuplicates: dupes };
}
