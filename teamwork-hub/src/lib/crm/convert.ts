import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import {
  athletes,
  commPreferences,
  guardianships,
  householdMembers,
  households,
  leads,
  payerAccounts,
  payerAuthorizations,
  payerBeneficiaries,
  people,
  tasks,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { enqueue } from "@/lib/jobs";
import { DomainError } from "@/lib/messaging/errors";
import { logConsentEvent } from "@/lib/messaging/preferences";
import { ageOn } from "@/lib/messaging/routing";
import { todayLocal } from "@/lib/time";
import { findPossibleDuplicates } from "./intake";
import { listStages } from "./stages";

type Person = typeof people.$inferSelect;

export type Candidate = {
  personId: string;
  name: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  matchedOn: string[];
  athleteId: string | null;
  guardianOf: string[];
  households: { id: string; name: string }[];
  payerAccounts: { id: string; name: string }[];
};

async function describe(tx: Tx, orgId: string, p: Person, matchedOn: string[]): Promise<Candidate> {
  const [a] = await tx.select({ id: athletes.id }).from(athletes).where(and(eq(athletes.personId, p.id), eq(athletes.orgId, orgId)));
  const gOf = await tx
    .select({ first: people.firstName, last: people.lastName })
    .from(guardianships)
    .innerJoin(athletes, eq(athletes.id, guardianships.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(guardianships.guardianPersonId, p.id), ne(guardianships.status, "revoked")));
  const hh = await tx
    .select({ id: households.id, name: households.name })
    .from(householdMembers)
    .innerJoin(households, eq(households.id, householdMembers.householdId))
    .where(and(eq(householdMembers.personId, p.id), eq(households.orgId, orgId)));
  const pay = await tx
    .select({ id: payerAccounts.id, name: payerAccounts.name })
    .from(payerAuthorizations)
    .innerJoin(payerAccounts, eq(payerAccounts.id, payerAuthorizations.payerAccountId))
    .where(and(eq(payerAuthorizations.personId, p.id), eq(payerAccounts.orgId, orgId)));
  return {
    personId: p.id,
    name: `${p.firstName} ${p.lastName}`,
    email: p.email,
    phone: p.phone,
    dateOfBirth: p.dateOfBirth,
    matchedOn,
    athleteId: a?.id ?? null,
    guardianOf: gOf.map((g) => `${g.first} ${g.last}`),
    households: hh,
    payerAccounts: pay,
  };
}

async function candidatesFor(tx: Tx, orgId: string, p: Person, exclude: string[], byName: boolean): Promise<Candidate[]> {
  const found = new Map<string, string[]>();
  for (const d of await findPossibleDuplicates(tx, orgId, p.email, p.phone, exclude)) found.set(d.personId, [d.matchedOn]);
  if (byName) {
    const rows = await tx
      .select({ id: people.id, dob: people.dateOfBirth })
      .from(people)
      .where(
        and(
          eq(people.orgId, orgId),
          sql`lower(${people.firstName}) = ${p.firstName.toLowerCase()}`,
          sql`lower(${people.lastName}) = ${p.lastName.toLowerCase()}`,
          exclude.length ? sql`${people.id} not in (${sql.join(exclude.map((x) => sql`${x}::uuid`), sql`, `)})` : sql`true`,
          sql`${people.status} <> 'archived'`,
        ),
      );
    for (const r of rows) found.set(r.id, [...(found.get(r.id) ?? []), "name"]);
  }
  if (!found.size) return [];
  const ps = await tx.select().from(people).where(inArray(people.id, [...found.keys()]));
  return Promise.all(ps.map((x) => describe(tx, orgId, x, found.get(x.id)!)));
}

export async function conversionPreview(tx: Tx, v: Viewer, leadId: string) {
  assertCan(v, "crm.manage");
  if (!z.string().uuid().safeParse(leadId).success) throw new DomainError("Lead not found.");
  const [lead] = await tx.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.orgId, v.orgId)));
  if (!lead) throw new DomainError("Lead not found.");
  const [athletePerson] = await tx.select().from(people).where(eq(people.id, lead.personId));
  const [contactPerson] = lead.contactPersonId ? await tx.select().from(people).where(eq(people.id, lead.contactPersonId)) : [];
  const own = [lead.personId, lead.contactPersonId].filter(Boolean) as string[];
  const age = athletePerson.dateOfBirth
    ? ageOn(athletePerson.dateOfBirth, todayLocal())
    : typeof lead.inquiry.athleteAge === "number"
      ? (lead.inquiry.athleteAge as number)
      : null;
  const isMinor = !!contactPerson || (age != null && age < 18);
  const athleteCandidates = await candidatesFor(tx, v.orgId, athletePerson, own, true);
  const guardianCandidates = contactPerson ? await candidatesFor(tx, v.orgId, contactPerson, own, true) : [];
  return {
    lead,
    athletePerson,
    contactPerson: contactPerson ?? null,
    age,
    isMinor,
    athleteCandidates,
    guardianCandidates,
  };
}

export const convertSchema = z.object({
  leadId: z.string().uuid(),
  /** "new" = use the lead's own person record; otherwise an existing candidate person id. */
  athleteChoice: z.string().optional(),
  guardianChoice: z.string().optional(),
  /** "new" | existing household id | "none" (adults only) */
  household: z.string().default("new"),
  /** "new" | existing payer account id */
  payer: z.string().default("new"),
  dateOfBirth: z.preprocess((x) => (x === "" ? undefined : x), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional()),
  sport: z.preprocess((x) => (x === "" ? undefined : x), z.string().trim().max(80).optional()),
  relationship: z.string().trim().max(40).default("parent"),
});

const LINK = "link:";

/**
 * Converts a lead into an active athlete (+ guardian, household, payer account with
 * authorization). Possible duplicates must be resolved by an explicit choice — the
 * function refuses to guess, and never merges two person records.
 */
export async function convertLead(tx: Tx, v: Viewer, input: z.input<typeof convertSchema>, now = new Date()) {
  assertCan(v, "crm.manage");
  assertCan(v, "people.manage");
  const d = convertSchema.parse(input);
  const [locked] = await tx.select().from(leads).where(and(eq(leads.id, d.leadId), eq(leads.orgId, v.orgId))).for("update");
  if (!locked) throw new DomainError("Lead not found.");
  if (locked.convertedAt) throw new DomainError("This lead has already been converted.");
  const pv = await conversionPreview(tx, v, d.leadId);
  const lead = pv.lead;

  const resolve = (choice: string | undefined, candidates: Candidate[], own: string, label: string): { personId: string; linked: boolean } => {
    if (candidates.length && !choice) {
      throw new DomainError(`Possible duplicate ${label} found (${candidates.map((c) => c.name).join(", ")}). Choose "link existing" or "create new" — records are never merged automatically.`, {
        [`${label}Choice`]: "Choose link existing or create new",
      });
    }
    if (!choice || choice === "new") return { personId: own, linked: false };
    if (!choice.startsWith(LINK)) throw new DomainError("Invalid choice.");
    const id = choice.slice(LINK.length);
    if (!candidates.some((c) => c.personId === id)) throw new DomainError(`You can only link the ${label} to one of the listed possible matches.`);
    return { personId: id, linked: true };
  };

  const ath = resolve(d.athleteChoice, pv.athleteCandidates, lead.personId, "athlete");
  const guard = pv.contactPerson ? resolve(d.guardianChoice, pv.guardianCandidates, pv.contactPerson.id, "guardian") : null;
  if (guard && guard.personId === ath.personId) throw new DomainError("The guardian and athlete cannot be the same person.");

  const archiveLinked = async (ownId: string, linkedTo: string) => {
    // The intake-created record is kept (never deleted or merged) but archived with a pointer.
    const [p] = await tx.select().from(people).where(eq(people.id, ownId));
    await tx
      .update(people)
      .set({ status: "archived", archivedAt: now, customFields: { ...p.customFields, linkedToPersonId: linkedTo, linkedFromLeadId: lead.id }, updatedAt: now })
      .where(eq(people.id, ownId));
    // Carry consent over only where the existing person has no preference recorded (never overrides an opt-out).
    const prefs = await tx.select().from(commPreferences).where(eq(commPreferences.personId, ownId));
    for (const pr of prefs) {
      const consentSource = `${pr.consentSource ?? "lead"} (via lead conversion)`;
      const inserted = await tx
        .insert(commPreferences)
        .values({ orgId: v.orgId, personId: linkedTo, channel: pr.channel, consent: pr.consent, consentSource, capturedAt: pr.capturedAt })
        .onConflictDoNothing()
        .returning({ id: commPreferences.id });
      if (inserted.length) {
        await logConsentEvent(tx, { orgId: v.orgId, personId: linkedTo, channel: pr.channel, consent: pr.consent, source: "lead_conversion", detail: consentSource, actorUserId: v.userId, now });
      }
    }
  };
  if (ath.linked) await archiveLinked(lead.personId, ath.personId);
  if (guard?.linked) await archiveLinked(pv.contactPerson!.id, guard.personId);

  // --- Athlete -----------------------------------------------------------------
  const [athPerson] = await tx.select().from(people).where(eq(people.id, ath.personId));
  await tx
    .update(people)
    .set({ status: "active", dateOfBirth: athPerson.dateOfBirth ?? d.dateOfBirth ?? null, updatedAt: now })
    .where(eq(people.id, ath.personId));
  const [existingAthlete] = await tx.select().from(athletes).where(eq(athletes.personId, ath.personId));
  let athleteId: string;
  if (existingAthlete) {
    athleteId = existingAthlete.id;
    if (!existingAthlete.active) await tx.update(athletes).set({ active: true, inactiveReason: null }).where(eq(athletes.id, athleteId));
  } else {
    const [a] = await tx
      .insert(athletes)
      .values({ orgId: v.orgId, personId: ath.personId, sport: d.sport ?? lead.interest ?? null, active: true, isDemo: lead.isDemo })
      .returning();
    athleteId = a.id;
  }

  // --- Guardian ----------------------------------------------------------------
  let guardianshipId: string | null = null;
  if (guard) {
    await tx.update(people).set({ status: "active", updatedAt: now }).where(and(eq(people.id, guard.personId), ne(people.status, "archived")));
    const [g] = await tx
      .select()
      .from(guardianships)
      .where(and(eq(guardianships.guardianPersonId, guard.personId), eq(guardianships.athleteId, athleteId), ne(guardianships.status, "revoked")));
    if (g) guardianshipId = g.id;
    else {
      const [ng] = await tx
        .insert(guardianships)
        .values({ orgId: v.orgId, guardianPersonId: guard.personId, athleteId, relationship: d.relationship || "parent", status: "active", createdBy: v.userId })
        .returning();
      guardianshipId = ng.id;
    }
  }

  // --- Household ---------------------------------------------------------------
  const anchorPersonId = guard?.personId ?? ath.personId;
  const [anchor] = await tx.select().from(people).where(eq(people.id, anchorPersonId));
  let householdId: string | null = null;
  if (d.household === "none") {
    if (guard) throw new DomainError("A minor's guardian needs a household.");
  } else if (d.household === "new") {
    const [h] = await tx.insert(households).values({ orgId: v.orgId, name: `${anchor.lastName} Household`, isDemo: lead.isDemo }).returning();
    householdId = h.id;
  } else {
    const [h] = await tx
      .select({ id: households.id })
      .from(householdMembers)
      .innerJoin(households, eq(households.id, householdMembers.householdId))
      .where(and(eq(householdMembers.householdId, d.household), eq(householdMembers.personId, anchorPersonId), eq(households.orgId, v.orgId)));
    if (!h) throw new DomainError("Choose a household the guardian already belongs to, or create a new one.");
    householdId = h.id;
  }
  if (householdId) {
    const members = guard
      ? [
          { personId: guard.personId, role: "guardian" as const, isPrimaryContact: true },
          { personId: ath.personId, role: "child" as const, isPrimaryContact: false },
        ]
      : [{ personId: ath.personId, role: "adult" as const, isPrimaryContact: true }];
    for (const m of members) await tx.insert(householdMembers).values({ householdId, ...m }).onConflictDoNothing();
  }

  // --- Payer -------------------------------------------------------------------
  let payerAccountId: string;
  if (d.payer === "new") {
    const [pa] = await tx
      .insert(payerAccounts)
      .values({ orgId: v.orgId, name: `${anchor.firstName} ${anchor.lastName}`, householdId, billingEmail: anchor.email, isDemo: lead.isDemo })
      .returning();
    payerAccountId = pa.id;
    await tx.insert(payerAuthorizations).values({ payerAccountId, personId: anchorPersonId, canViewInvoices: true, canPay: true, canManageMethods: true });
  } else {
    const [auth] = await tx
      .select({ id: payerAuthorizations.payerAccountId })
      .from(payerAuthorizations)
      .innerJoin(payerAccounts, eq(payerAccounts.id, payerAuthorizations.payerAccountId))
      .where(and(eq(payerAuthorizations.payerAccountId, d.payer), eq(payerAuthorizations.personId, anchorPersonId), eq(payerAccounts.orgId, v.orgId)));
    if (!auth) throw new DomainError("Choose a payer account the guardian is already authorized on, or create a new one.");
    payerAccountId = auth.id;
  }
  await tx.insert(payerBeneficiaries).values({ payerAccountId, athleteId }).onConflictDoNothing();

  // --- Lead --------------------------------------------------------------------
  const stages = await listStages(tx, v.orgId);
  const won = stages.find((s) => s.isWon);
  const decisions = {
    athlete: ath.linked ? `linked existing person ${ath.personId}` : pv.athleteCandidates.length ? "created new (staff chose not to link)" : "created new",
    guardian: guard ? (guard.linked ? `linked existing person ${guard.personId}` : pv.guardianCandidates.length ? "created new (staff chose not to link)" : "created new") : null,
  };
  await tx
    .update(leads)
    .set({
      stage: won?.key ?? lead.stage,
      convertedAthleteId: athleteId,
      convertedAt: now,
      updatedAt: now,
      inquiry: { ...lead.inquiry, duplicateReview: pv.athleteCandidates.length || pv.guardianCandidates.length ? "resolved" : (lead.inquiry.duplicateReview ?? "none"), conversionDecisions: decisions },
    })
    .where(eq(leads.id, lead.id));
  await tx
    .update(tasks)
    .set({ status: "done", completedAt: now, completedBy: v.userId })
    .where(and(eq(tasks.orgId, v.orgId), eq(tasks.dedupeKey, `lead-followup:${lead.id}`), inArray(tasks.status, ["open", "in_progress"])));

  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "crm.lead_converted", "lead", lead.id, {
    summary: `Converted to athlete (${decisions.athlete}${decisions.guardian ? `; guardian ${decisions.guardian}` : ""}) · Stage → ${won?.label ?? lead.stage}`,
    before: { stage: lead.stage },
    after: { stage: won?.key, athleteId, guardianshipId, householdId, payerAccountId, decisions },
  });
  await enqueue(tx, {
    type: "crm.lead_converted",
    orgId: v.orgId,
    payload: { orgId: v.orgId, leadId: lead.id, athleteId, guardianPersonId: guard?.personId ?? null, payerAccountId, convertedBy: v.userId },
    dedupeKey: `crm.lead_converted:${lead.id}`,
  });
  return { athleteId, guardianshipId, householdId, payerAccountId };
}
