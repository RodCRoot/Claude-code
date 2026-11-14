import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  alerts,
  athletes,
  coachAssignments,
  householdMembers,
  households,
  leads,
  membershipHolds,
  memberships,
  people,
  personTags,
  products,
  productVersions,
  tags,
  users,
  zpBills,
  zpMembershipDetails,
  zpPersonDetails,
  zpPersonHealth,
} from "@/db/schema";
import { grantCredits } from "@/lib/credits";
import { ensureStages } from "@/lib/crm/stages";
import { cached, commitAttendance, ensurePerson, fillPerson, findExternal, linkExternal, linkGuardian, type CommitCtx, type Committer, type RowOutcome, type RowRecord } from "./commit";
import { ageOn } from "./normalize";

/**
 * Committers for the exact Zen Planner grid presets (schemas/zenplanner-grid.ts).
 * Everything a row creates is recorded in `out.created` so reverting the batch removes it.
 */

type Parent = { firstName: string; lastName: string; email: string | null };

export const parentKey = (familyId: string | null, p: Parent) => `${familyId ?? ""}|${p.firstName.toLowerCase()}|${p.lastName.toLowerCase()}|${(p.email ?? "").toLowerCase()}`;

async function ensureHousehold(c: CommitCtx, out: RowOutcome, hhKey: string, name: string): Promise<string> {
  return cached(c, `household:${hhKey}`, async () => {
    const existing = await findExternal(c.tx, c.orgId, c.schema.idSource, "household", hhKey);
    if (existing) return existing;
    const [h] = await c.tx.insert(households).values({ orgId: c.orgId, name }).returning({ id: households.id });
    out.created.push({ type: "household", id: h.id });
    await linkExternal(c, "household", hhKey, "household", h.id);
    return h.id;
  });
}

async function addHouseholdMember(c: CommitCtx, out: RowOutcome, householdId: string, personId: string, role: "guardian" | "child" | "adult") {
  const ins = await c.tx.insert(householdMembers).values({ householdId, personId, role }).onConflictDoNothing().returning({ p: householdMembers.personId });
  if (ins.length) out.created.push({ type: "household_member", id: `${householdId}:${personId}` });
}

/** The parent named on a Person row: confirmed match, another row of this file, a parent we created before, or a new person. */
async function resolveParent(c: CommitCtx, n: Record<string, unknown>, out: RowOutcome): Promise<string | null> {
  const parent = n.parent as Parent | null;
  if (!parent || n._guardianSkip) return null;
  if (n._guardianPersonId) return String(n._guardianPersonId);
  if (n._guardianBatchKey) {
    const hit = c.cache.get(`person:${String(n._guardianBatchKey)}`);
    if (hit) return hit;
    out.warnings.push("The parent's own row in this file was not imported; no guardian linked from this row.");
    return null;
  }
  const key = parentKey((n.familyId as string | null) ?? null, parent);
  return cached(c, `zp-parent:${key}`, async () => {
    const existing = await findExternal(c.tx, c.orgId, c.schema.idSource, "parent", key);
    if (existing) return existing;
    const [g] = await c.tx
      .insert(people)
      .values({ orgId: c.orgId, firstName: parent.firstName, lastName: parent.lastName, email: parent.email, status: "active", source: c.schema.idSource })
      .returning({ id: people.id });
    out.created.push({ type: "person", id: g.id });
    await linkExternal(c, "parent", key, "person", g.id);
    return g.id;
  });
}

export const commitPersonGrid: Committer = async (c, row, out) => {
  const n = row.normalized as Record<string, unknown>;
  const status = n.status as string | null;
  const { personId, athleteId, createdPerson } = await ensurePerson(c, row, out, { sport: (n.sport as string | null) ?? null, athleteActive: status === "inactive" ? false : null });
  if (!createdPerson) await fillPerson(c, personId, n, out);
  await linkExternal(c, c.schema.recordEntityType, row.sourceRecordId!, "person", personId);

  // Sport from a sport-named tag: only fills an empty sport, never overwrites.
  if (athleteId && n.sport && !out.created.some((x) => x.type === "athlete" && x.id === athleteId)) {
    const [a] = await c.tx.select({ sport: athletes.sport }).from(athletes).where(eq(athletes.id, athleteId));
    if (a && !a.sport) {
      await c.tx.update(athletes).set({ sport: String(n.sport) }).where(eq(athletes.id, athleteId));
      out.updates.push({ type: "athlete", id: athleteId, before: { sport: null } });
    } else if (a?.sport && a.sport.toLowerCase() !== String(n.sport).toLowerCase()) {
      out.warnings.push(`Kept existing sport "${a.sport}" (tag says "${String(n.sport)}").`);
    }
  }

  // Informational columns.
  const det = await c.tx
    .insert(zpPersonDetails)
    .values({
      orgId: c.orgId,
      personId,
      importBatchId: c.batchId,
      familyId: (n.familyId as string | null) ?? null,
      zpStatus: (n.zpStatus as string | null) ?? null,
      primaryLocation: (n.primaryLocation as string | null) ?? null,
      primaryInstructor: (n.primaryInstructor as string | null) ?? null,
      signupDate: (n.signupDate as string | null) ?? null,
      hasPassword: (n.hasPassword as boolean | null) ?? null,
      signedDocuments: (n.signedDocuments as string | null) ?? null,
      flags: [...((n.flags as string[]) ?? []), ...(n.memberSource ? [`member source: ${String(n.memberSource)}`] : [])],
    })
    .onConflictDoNothing()
    .returning({ id: zpPersonDetails.id });
  if (det.length) out.created.push({ type: "zp_person_detail", id: det[0].id });

  // Health data: its own table, read only with health.read (src/lib/zenplanner/health.ts).
  const health = n.health as { specialNeeds: string | null; medications: string | null; allergies: string | null } | null;
  if (health) {
    const h = await c.tx
      .insert(zpPersonHealth)
      .values({ orgId: c.orgId, personId, importBatchId: c.batchId, specialNeeds: health.specialNeeds, medications: health.medications, allergies: health.allergies })
      .onConflictDoNothing()
      .returning({ id: zpPersonHealth.id });
    if (h.length) {
      out.created.push({ type: "zp_person_health", id: h[0].id });
      // The alert says only that something is on file; the details stay behind health access.
      const [al] = await c.tx
        .insert(alerts)
        .values({ orgId: c.orgId, personId, message: "Health information imported from Zen Planner is on file. Staff with health access can read it on the profile.", level: "warning", showAtKiosk: false, createdBy: c.viewer.userId })
        .returning({ id: alerts.id });
      out.created.push({ type: "alert", id: al.id });
    } else {
      out.warnings.push("Health information from an earlier Zen Planner import is already on file; kept as it was.");
    }
  }

  // Tags (Zen Planner groups).
  for (const name of (n.tags as string[]) ?? []) {
    const tagId = await cached(c, `tag:${name.toLowerCase()}`, async () => {
      const [t] = await c.tx.select({ id: tags.id }).from(tags).where(and(eq(tags.orgId, c.orgId), sql`lower(${tags.name}) = ${name.toLowerCase()}`));
      if (t) return t.id;
      const [nt] = await c.tx.insert(tags).values({ orgId: c.orgId, name }).returning({ id: tags.id });
      out.created.push({ type: "tag", id: nt.id });
      return nt.id;
    });
    const ins = await c.tx.insert(personTags).values({ personId, tagId }).onConflictDoNothing().returning({ t: personTags.tagId });
    if (ins.length) out.created.push({ type: "person_tag", id: `${personId}:${tagId}` });
  }

  // Household (Family ID is the key) and guardian (Parent columns).
  const familyId = (n.familyId as string | null) ?? null;
  const parent = n.parent as Parent | null;
  const dob = (n.dob as string | null) ?? null;
  const minor = dob ? ageOn(dob, new Date().toISOString().slice(0, 10)) < 18 : !!parent;
  const hhName = (n.familyName as string | null) ?? `${String(n.lastName ?? "Imported")} Household`;
  const action = out.action;
  const guardianId = await resolveParent(c, n, out);
  const hhKey = familyId ? `family:${familyId}` : parent ? `parent:${parentKey(null, parent)}` : null;
  if (guardianId && guardianId !== personId && athleteId && hhKey) {
    await linkGuardian(c, out, { guardianId, childId: personId, athleteId, householdKey: hhKey, householdName: hhName, relationship: "parent" });
  } else if (hhKey && (familyId || guardianId)) {
    const householdId = await ensureHousehold(c, out, hhKey, hhName);
    await addHouseholdMember(c, out, householdId, personId, minor ? "child" : "adult");
    if (guardianId && guardianId !== personId) await addHouseholdMember(c, out, householdId, guardianId, "guardian");
  }
  if (n._guardianSkip) out.warnings.push("The parent matched several people; no guardian linked. Link the right one in People.");

  // Prospect → CRM lead (one open lead per person).
  const prospect = n.prospect as Record<string, string | null> | null;
  if (n.isProspect && prospect) {
    const [open] = await c.tx.select({ id: leads.id }).from(leads).where(and(eq(leads.orgId, c.orgId), eq(leads.personId, personId), isNull(leads.convertedAt)));
    if (open) out.warnings.push("This person already has a lead in Teamwork; no second lead created.");
    else {
      const stages = await ensureStages(c.tx, c.orgId);
      let stage = stages.find((s) => s.key === prospect.stage);
      if (!stage) {
        stage = prospect.stage === "lost" ? stages.find((s) => s.isLost) : stages.find((s) => !s.isWon && !s.isLost);
        out.warnings.push(`Lead stage "${prospect.stage}" does not exist here; placed in "${stage?.label ?? "the first stage"}".`);
      }
      let ownerUserId: string | null = null;
      if (prospect.salesRep) {
        const reps = await c.tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.orgId, c.orgId), sql`lower(${users.displayName}) = ${prospect.salesRep.toLowerCase()}`, inArray(users.role, ["owner", "admin", "operations", "coach"]), isNull(users.disabledAt)));
        if (reps.length === 1) ownerUserId = reps[0].id;
        else out.warnings.push(`Sales Rep "${prospect.salesRep}" does not match exactly one staff login; the lead has no owner (the name is kept on the lead).`);
      }
      const [lead] = await c.tx
        .insert(leads)
        .values({
          orgId: c.orgId,
          personId,
          contactPersonId: guardianId && guardianId !== personId ? guardianId : null,
          stage: stage?.key ?? "new",
          source: prospect.source,
          interest: prospect.interest,
          ownerUserId,
          lostReason: stage?.isLost ? (prospect.status ?? "Not Interested") : null,
          inquiry: {
            importedFrom: "zenplanner",
            zenplanner: {
              prospectStatus: prospect.status,
              prospectSubStatus: prospect.subStatus,
              sourceSub: prospect.sourceSub,
              interestSub: prospect.interestSub,
              referredBy: prospect.referredBy,
              priority: prospect.priority,
              salesRep: prospect.salesRep,
              inquiryDate: prospect.inquiryDate,
              trialEndDate: prospect.trialEndDate,
            },
            ...(n.utm ? { utm: n.utm } : {}),
          },
          ...(prospect.inquiryDate ? { createdAt: new Date(`${prospect.inquiryDate}T12:00:00Z`) } : {}),
        })
        .returning({ id: leads.id });
      out.created.push({ type: "lead", id: lead.id });
    }
  }

  // Primary Instructor → assigned coach, only on an exact match to one coach login.
  const instructor = (n.primaryInstructor as string | null) ?? null;
  if (instructor && athleteId) {
    const coachId = await cached(c, `coach:${instructor.toLowerCase()}`, async () => {
      const rows = await c.tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.orgId, c.orgId), sql`lower(${users.displayName}) = ${instructor.toLowerCase()}`, inArray(users.role, ["owner", "admin", "coach"]), isNull(users.disabledAt)));
      return rows.length === 1 ? rows[0].id : "none";
    });
    if (coachId === "none") out.warnings.push(`Primary Instructor "${instructor}" does not match exactly one coach login; no coach assigned (the name is kept).`);
    else {
      const [have] = await c.tx.select({ id: coachAssignments.id }).from(coachAssignments).where(and(eq(coachAssignments.orgId, c.orgId), eq(coachAssignments.coachUserId, coachId), eq(coachAssignments.athleteId, athleteId)));
      if (!have) {
        const [ca] = await c.tx.insert(coachAssignments).values({ orgId: c.orgId, coachUserId: coachId, athleteId }).returning({ id: coachAssignments.id });
        out.created.push({ type: "coach_assignment", id: ca.id });
      }
    }
  }

  if (athleteId && !createdPerson && out.created.some((x) => x.type === "athlete")) out.warnings.push("Added an athlete record to an existing person.");
  out.action = createdPerson ? "create" : action === "update" || out.updates.length ? "update" : "link";
};

/** Highest Payment Amount per plan key in the batch: the imported plan's price (and the discount review's fallback list price). */
export function planKeyOf(n: Record<string, unknown>): string {
  return `${String(n.plan).toLowerCase()}|w${n.classesPerWeek ?? "-"}|${n.classCardRemaining != null ? "card" : ""}`;
}

export function prepareGridExtra(schemaId: string, rows: RowRecord[]): Record<string, unknown> {
  if (schemaId !== "zenplanner.membership_grid") return {};
  const planMax: Record<string, number> = {};
  for (const r of rows) {
    const n = r.normalized as Record<string, unknown> | null;
    if (!n?.plan || typeof n.paymentAmountMinor !== "number") continue;
    const k = planKeyOf(n);
    planMax[k] = Math.max(planMax[k] ?? 0, n.paymentAmountMinor);
  }
  return { planMax };
}

export const commitMembershipGrid: Committer = async (c, row, out) => {
  const n = row.normalized as Record<string, unknown>;
  const { athleteId } = await ensurePerson(c, row, out);
  const plan = String(n.plan);
  const key = planKeyOf(n);
  const classesPerWeek = (n.classesPerWeek as number | null) ?? null;
  const classCard = (n.classCardRemaining as number | null) ?? null;
  const planMax = ((c.extra.planMax ?? {}) as Record<string, number>)[key];
  const versionId = await cached(c, `gridplan:${key}`, async () => {
    const existing = await findExternal(c.tx, c.orgId, c.schema.idSource, "grid_plan_version", key);
    if (existing) return existing;
    const [p] = await c.tx
      .insert(products)
      .values({
        orgId: c.orgId,
        name: `${plan}${classesPerWeek ? ` (${classesPerWeek}x per week)` : ""} (Zen Planner)`,
        kind: "recurring_membership",
        description:
          planMax == null
            ? "Imported Zen Planner plan. Price not imported (billed in Zen Planner). Not sold in Teamwork."
            : "Imported Zen Planner plan (billed in Zen Planner). The price is the highest Payment Amount seen for this plan in the import; each member's own amount is kept beside their membership. Not sold in Teamwork.",
        category: "imported",
        active: false,
        publiclyListed: false,
      })
      .returning({ id: products.id });
    out.created.push({ type: "product", id: p.id });
    const [v] = await c.tx
      .insert(productVersions)
      .values({
        productId: p.id,
        version: 1,
        priceMinor: planMax ?? 0,
        currency: "USD",
        interval: /college|weekly/i.test(plan) ? "week" : "month",
        classesPerWeek,
        unlimited: classesPerWeek == null && classCard == null,
        effectiveFrom: String(n.startDate),
      })
      .returning({ id: productVersions.id });
    out.created.push({ type: "product_version", id: v.id });
    await linkExternal(c, "grid_plan_version", key, "product_version", v.id);
    return v.id;
  });
  const months = (n.months as number | null) ?? null;
  const commit = months != null && [6, 12].includes(months) && n.endDate;
  const [m] = await c.tx
    .insert(memberships)
    .values({
      orgId: c.orgId,
      athleteId: athleteId!,
      productVersionId: versionId,
      status: n.status as "active",
      startDate: String(n.startDate),
      endDate: (n.endDate as string) ?? null,
      nextBillDate: null,
      cancelAt: (n.cancelDate as string) ?? null,
      cancelReason: (n.cancelReason as string) ?? null,
      // Billed by Zen Planner. Never invoiced, renewed or charged here; hub autopay stays off.
      billingProvider: "external_zenplanner",
      providerSubscriptionId: null,
      source: "zenplanner",
      kind: n.inSeason ? "in_season" : "regular",
      commitmentStartsOn: commit ? String(n.startDate) : null,
      commitmentEndsOn: commit ? String(n.endDate) : null,
      autopay: false,
      createdBy: c.viewer.userId,
    })
    .returning({ id: memberships.id });
  out.created.push({ type: "membership", id: m.id });
  await linkExternal(c, c.schema.recordEntityType, row.sourceRecordId!, "membership", m.id);

  const [d] = await c.tx
    .insert(zpMembershipDetails)
    .values({
      orgId: c.orgId,
      membershipId: m.id,
      importBatchId: c.batchId,
      planName: plan,
      familyId: (n.familyId as string | null) ?? null,
      paymentAmountMinor: (n.paymentAmountMinor as number | null) ?? null,
      months,
      autoRenew: (n.autoRenew as boolean | null) ?? null,
      renewalType: (n.renewalType as string | null) ?? null,
      trialMember: (n.trialMember as boolean | null) ?? null,
      cancelDate: (n.cancelDate as string | null) ?? null,
      cancelBy: (n.cancelBy as string | null) ?? null,
      cancelReason: (n.cancelReason as string | null) ?? null,
      cancelComments: (n.cancelComments as string | null) ?? null,
      firstBillDue: (n.firstBillDue as string | null) ?? null,
      incomeCategory: (n.incomeCategory as string | null) ?? null,
      membershipCategory: (n.membershipCategory as string | null) ?? null,
      attLimit: (n.attLimit as number | null) ?? null,
      attLimitType: (n.attLimitType as string | null) ?? null,
      classCardRemaining: classCard,
      shared: (n.shared as boolean | null) ?? null,
      autopay: (n.autopay as boolean | null) ?? null,
      discountName: (n.discountName as string | null) ?? null,
      holdReason: (n.holdReason as string | null) ?? null,
      holdStart: (n.holdStart as string | null) ?? null,
      holdEnd: (n.holdEnd as string | null) ?? null,
      flags: (n.flags as string[]) ?? [],
    })
    .returning({ id: zpMembershipDetails.id });
  out.created.push({ type: "zp_membership_detail", id: d.id });

  // Class Card Att. Remaining → an imported punch-card balance tied to this membership.
  if (classCard != null && classCard > 0) {
    const g = await grantCredits(c.tx, {
      orgId: c.orgId,
      athleteId: athleteId!,
      amount: classCard,
      sourceKind: "imported",
      membershipId: m.id,
      actorUserId: c.viewer.userId,
      reason: "Class card balance imported from Zen Planner (no expiry date in the export)",
      idempotencyKey: `zp-card:${c.orgId}:${row.sourceRecordId}`,
    });
    if (g.created) out.created.push({ type: "credit_bucket", id: g.bucket.id });
  }

  // Hold dates, when the export has them.
  if (n.holdStart && n.holdEnd && String(n.holdStart) <= String(n.holdEnd)) {
    const [h] = await c.tx
      .insert(membershipHolds)
      .values({ membershipId: m.id, startDate: String(n.holdStart), endDate: String(n.holdEnd), reason: (n.holdReason as string | null) ?? null, kind: "hold", createdBy: c.viewer.userId })
      .returning({ id: membershipHolds.id });
    out.created.push({ type: "membership_hold", id: h.id });
  } else if (n.status === "on_hold") {
    out.warnings.push("On hold in Zen Planner but the export has no hold dates; add the hold in Teamwork if the restart date matters.");
  }
  out.action = "create";
};

/** Bills are history only: a row in zp_bills. Never an invoice, never payable. */
export const commitBillGrid: Committer = async (c, row, out) => {
  const n = row.normalized as Record<string, unknown>;
  const { personId } = await ensurePerson(c, row, out);
  const [a] = await c.tx.select({ id: athletes.id }).from(athletes).where(and(eq(athletes.personId, personId), eq(athletes.orgId, c.orgId)));
  let membershipId: string | null = null;
  const desc = (n.description as string | null) ?? null;
  if (a && desc) {
    const ms = await c.tx
      .select({ id: memberships.id })
      .from(zpMembershipDetails)
      .innerJoin(memberships, eq(memberships.id, zpMembershipDetails.membershipId))
      .where(and(eq(zpMembershipDetails.orgId, c.orgId), eq(memberships.athleteId, a.id), sql`lower(${zpMembershipDetails.planName}) = ${desc.toLowerCase()}`));
    if (ms.length === 1) membershipId = ms[0].id;
  }
  const ins = await c.tx
    .insert(zpBills)
    .values({
      orgId: c.orgId,
      personId,
      athleteId: a?.id ?? null,
      membershipId,
      importBatchId: c.batchId,
      sourceRecordId: row.sourceRecordId!,
      description: desc,
      dueDate: String(n.dueDate),
      amountDueMinor: (n.amountDueMinor as number | null) ?? null,
      amountPaidMinor: (n.amountPaidMinor as number | null) ?? null,
      amountUnpaidMinor: (n.amountUnpaidMinor as number | null) ?? null,
      discountTotalMinor: (n.discountTotalMinor as number | null) ?? null,
      paidOnTime: (n.paidOnTime as boolean | null) ?? null,
      zpStatus: (n.zpStatus as string | null) ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: zpBills.id });
  if (!ins.length) {
    out.action = "skip";
    out.warnings.push("This bill is already in the imported history; not duplicated.");
    return;
  }
  out.created.push({ type: "zp_bill", id: ins[0].id });
  await linkExternal(c, c.schema.recordEntityType, row.sourceRecordId!, "zp_bill", ins[0].id);
  out.action = "create";
};

export const ZP_GRID_COMMITTERS: Record<string, Committer> = {
  "zenplanner.person_grid": commitPersonGrid,
  "zenplanner.membership_grid": commitMembershipGrid,
  "zenplanner.bill_grid": commitBillGrid,
  "zenplanner.attendance_grid": commitAttendance,
};
