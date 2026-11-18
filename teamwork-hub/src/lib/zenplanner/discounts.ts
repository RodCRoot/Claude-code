import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, memberships, people, productVersions, zpMembershipDetails, zpPersonDetails } from "@/db/schema";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { FAMILY_RATE_MIN_MEMBERS, familyRateConfirmed, familyRatePercent, familyRateSummary, membershipPolicy } from "@/lib/membership-policy";
import { catalogListPrices, matchCatalogPlan } from "./catalog";
import { zpRenewalOutcome } from "./renewal";

/**
 * Discount review for imported Zen Planner memberships. READ-ONLY: it lists, it never changes a
 * membership, a price or a discount. The owner decides to keep, convert or end each one.
 *
 * "List price" is not a column in the Membership grid, so it is worked out per membership and the
 * basis is always shown:
 *   catalog  = the plan matched a plan in Teamwork's ladder (name, Att. Limit and Months);
 *   highest  = no ladder match: the highest Payment Amount anyone pays on that plan in the import;
 *   none     = neither is available.
 */
export type DiscountPattern = "family" | "in_season_rate" | "other" | "unknown" | "full_price";

export type DiscountRow = {
  membershipId: string;
  athleteId: string;
  name: string;
  familyId: string | null;
  plan: string;
  status: string;
  listPriceMinor: number | null;
  listBasis: "catalog" | "highest" | "none";
  paymentMinor: number | null;
  /** List price minus Payment Amount per billing period. Negative = paying above list. Null when either is unknown. */
  differenceMinor: number | null;
  discountName: string | null;
  pattern: DiscountPattern;
  note: string;
  /** Active members (current, not on hold) sharing this member's Family ID in the import, this one included. */
  activeInFamily: number;
  /** The hub's household rate for that head count (0 below 2, or while this member is on hold). */
  expectedFamilyPercent: number;
  /** The family tier the Payment Amount equals, when it equals one. */
  paidFamilyPercent: number | null;
};

/**
 * A member of a Family ID with 2+ active members who is not paying that household's rate.
 * `wouldSaveMinor`: per period, what moving to the household rate changes (list price less the rate, against
 * what they pay now); negative when they pay less today. Null when the amounts cannot be compared.
 */
export type SiblingRow = { familyId: string; membersInFamily: number; expectedPercent: number; paidPercent: number | null; name: string; plan: string; paymentMinor: number | null; listPriceMinor: number | null; pattern: DiscountPattern; wouldSaveMinor: number | null };

/** A current fixed-term membership that Zen Planner will renew into another fixed term instead of month-to-month. */
export type FixedTermRenewalRow = { membershipId: string; name: string; plan: string; status: string; months: number; renewalType: string; endDate: string | null; paymentMinor: number | null };

export type DiscountReview = {
  /** Household rule from Settings: percent per active household member and the cap. */
  familyStepPercent: number;
  familyCapPercent: number;
  familyRule: string;
  familyCapConfirmed: boolean;
  inSeasonRateMinor: number;
  reviewed: number;
  endedExcluded: number;
  groups: Record<Exclude<DiscountPattern, "full_price">, DiscountRow[]>;
  fullPrice: number;
  siblingsWithoutFamilyDiscount: SiblingRow[];
  /** Current memberships with Months > 1 and Auto Renew on whose Renewal Type is not month-to-month. */
  renewsIntoFixedTerm: FixedTermRenewalRow[];
  /** Current fixed-term memberships with Auto Renew on and no Renewal Type in the export: cannot tell. */
  renewalTypeUnknown: number;
  totals: { family: number; in_season_rate: number; other: number };
  notes: string[];
};

const CURRENT = ["active", "trialing", "past_due", "on_hold", "pending"];
/** Counted toward the household head count, as for hub-billed memberships: current and not on hold. */
const COUNTED = ["active", "trialing", "past_due", "pending"];

/**
 * `familyPercent` is the rate expected for this member's household (0 = none). `familyTiers` are the other
 * rates the rule can produce (10, 15, 20, ...): a Payment Amount that equals one of them is still a family
 * rate, just not this household's.
 */
export function classifyDiscount(input: {
  listPriceMinor: number | null;
  paymentMinor: number | null;
  discountName: string | null;
  familyPercent: number;
  familyTiers?: number[];
  inSeasonRateMinor: number;
  planIsInSeason: boolean;
}): { pattern: DiscountPattern; note: string; paidFamilyPercent: number | null } {
  const r = classify(input);
  return { paidFamilyPercent: null, ...r };
}

function classify(input: Parameters<typeof classifyDiscount>[0]): { pattern: DiscountPattern; note: string; paidFamilyPercent?: number } {
  const { listPriceMinor: list, paymentMinor: pay, discountName, familyPercent, inSeasonRateMinor, planIsInSeason } = input;
  if (pay == null) return { pattern: "unknown", note: "No Payment Amount in the export." };
  if (list == null) return discountName ? { pattern: "other", note: `Carries the discount "${discountName}"; no list price to compare.` } : { pattern: "unknown", note: "No list price to compare against." };
  for (const pct of [familyPercent, ...(input.familyTiers ?? [])]) {
    if (pct <= 0 || pay === list || Math.abs(pay - Math.round(list * (1 - pct / 100))) > 1) continue;
    if (pct === familyPercent) return { pattern: "family", note: `Matches the family discount at ${pct}%.`, paidFamilyPercent: pct };
    return { pattern: "family", note: familyPercent > 0 ? `Pays a ${pct}% family rate; this household's rate is ${familyPercent}%.` : `Pays a ${pct}% family rate, but this household does not qualify for one right now.`, paidFamilyPercent: pct };
  }
  if (!planIsInSeason && pay === inSeasonRateMinor && pay !== list) return { pattern: "in_season_rate", note: "Paying the In Season rate on a plan that is not an In Season plan." };
  if (pay === list) return discountName ? { pattern: "other", note: `Carries the discount "${discountName}" but pays the list price.` } : { pattern: "full_price", note: "" };
  if (discountName && /family|sibling/i.test(discountName)) return { pattern: "other", note: familyPercent > 0 ? `Discount "${discountName}" does not equal this household's ${familyPercent}% off the list price.` : `Discount "${discountName}" does not equal a family rate off the list price.` };
  if (pay > list) return { pattern: "other", note: "Pays more than the list price." };
  return { pattern: "other", note: discountName ? `Discount "${discountName}".` : "Differs from the list price with no named discount in the export." };
}

export async function discountReview(tx: Tx, v: Viewer, opts: { batchId?: string | null } = {}): Promise<DiscountReview> {
  assertCan(v, "imports.manage");
  const policy = await membershipPolicy(tx, v.orgId);
  const prices = await catalogListPrices(tx, v.orgId);
  const inSeasonRateMinor = prices.get("in_season") ?? 9900;
  const conds = [eq(zpMembershipDetails.orgId, v.orgId), eq(memberships.orgId, v.orgId)];
  if (opts.batchId) conds.push(eq(zpMembershipDetails.importBatchId, opts.batchId));
  const rows = await tx
    .select({ d: zpMembershipDetails, m: memberships, versionPrice: productVersions.priceMinor, first: people.firstName, last: people.lastName, personId: people.id })
    .from(zpMembershipDetails)
    .innerJoin(memberships, eq(memberships.id, zpMembershipDetails.membershipId))
    .innerJoin(productVersions, eq(productVersions.id, memberships.productVersionId))
    .innerJoin(athletes, eq(athletes.id, memberships.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(...conds));
  // Family ID may be on the Membership grid or only on the Person grid.
  const personIds = [...new Set(rows.map((r) => r.personId))];
  const fam = personIds.length ? await tx.select({ personId: zpPersonDetails.personId, familyId: zpPersonDetails.familyId }).from(zpPersonDetails).where(and(eq(zpPersonDetails.orgId, v.orgId), inArray(zpPersonDetails.personId, personIds))) : [];
  const famByPerson = new Map(fam.map((f) => [f.personId, f.familyId]));

  const review: DiscountReview = {
    familyStepPercent: policy.familyDiscountStepPercent,
    familyCapPercent: policy.familyDiscountCapPercent,
    familyRule: familyRateSummary(policy),
    familyCapConfirmed: familyRateConfirmed(policy),
    inSeasonRateMinor,
    reviewed: 0,
    endedExcluded: 0,
    groups: { family: [], in_season_rate: [], other: [], unknown: [] },
    fullPrice: 0,
    siblingsWithoutFamilyDiscount: [],
    renewsIntoFixedTerm: [],
    renewalTypeUnknown: 0,
    totals: { family: 0, in_season_rate: 0, other: 0 },
    notes: [
      "Read-only. Nothing on this page changes a membership or a price.",
      "List price is worked out, not exported: 'catalog' means the plan matched Teamwork's ladder by name, Att. Limit and Months; 'highest' means the highest Payment Amount on that plan in the import was used instead.",
      "The difference is per billing period (monthly, except weekly plans).",
      "Household = the Zen Planner Family ID. A household's expected family rate counts its active members in this import (current and not on hold). This is a comparison only: imported memberships do not count toward the family rate the hub applies to memberships it bills.",
    ],
  };
  // Head count per Family ID: distinct athletes with a current membership that is not on hold.
  const familyOf = (r: (typeof rows)[number]) => r.d.familyId ?? famByPerson.get(r.personId) ?? null;
  const activeByFamily = new Map<string, Set<string>>();
  for (const r of rows) {
    const f = familyOf(r);
    if (f && COUNTED.includes(r.m.status)) activeByFamily.set(f, (activeByFamily.get(f) ?? new Set()).add(r.m.athleteId));
  }
  const familyTiers: number[] = [];
  for (let n = FAMILY_RATE_MIN_MEMBERS; n <= 20; n++) {
    const t = familyRatePercent(policy, n).percent;
    if (t > 0 && !familyTiers.includes(t)) familyTiers.push(t);
  }
  const all: DiscountRow[] = [];
  for (const r of rows) {
    if (!CURRENT.includes(r.m.status)) {
      review.endedExcluded++;
      continue;
    }
    const renewal = zpRenewalOutcome({ months: r.d.months, autoRenew: r.d.autoRenew, renewalType: r.d.renewalType });
    if (renewal === "unknown") review.renewalTypeUnknown++;
    if (renewal === "fixed_term") {
      review.renewsIntoFixedTerm.push({ membershipId: r.m.id, name: `${r.first} ${r.last}`, plan: r.d.planName, status: r.m.status, months: r.d.months!, renewalType: r.d.renewalType!, endDate: r.m.endDate, paymentMinor: r.d.paymentAmountMinor });
    }
    const cat = matchCatalogPlan({ plan: r.d.planName, attLimit: r.d.attLimit, attLimitType: r.d.attLimitType, months: r.d.months });
    let list: number | null = null;
    let basis: DiscountRow["listBasis"] = "none";
    if (cat) {
      list = prices.get(cat.key) ?? cat.priceMinor;
      basis = "catalog";
    } else if (r.versionPrice > 0 && !r.d.planName.startsWith("No label:")) {
      // Items sold without a Membership Label (drop-ins, tuition, one-off items) share one made-up plan per Income
      // Category, so "the highest amount on the plan" is not a list price. They are listed as unknown instead.
      list = r.versionPrice;
      basis = "highest";
    }
    const familyId = familyOf(r);
    const activeInFamily = familyId ? (activeByFamily.get(familyId)?.size ?? 0) : COUNTED.includes(r.m.status) ? 1 : 0;
    const expectedFamilyPercent = COUNTED.includes(r.m.status) ? familyRatePercent(policy, activeInFamily).percent : 0;
    const { pattern, note, paidFamilyPercent } = classifyDiscount({ listPriceMinor: list, paymentMinor: r.d.paymentAmountMinor, discountName: r.d.discountName, familyPercent: expectedFamilyPercent, familyTiers, inSeasonRateMinor, planIsInSeason: cat?.key === "in_season" || /in[\s-]?season/i.test(r.d.planName) });
    const row: DiscountRow = {
      membershipId: r.m.id,
      athleteId: r.m.athleteId,
      name: `${r.first} ${r.last}`,
      familyId,
      activeInFamily,
      expectedFamilyPercent,
      paidFamilyPercent,
      plan: r.d.planName,
      status: r.m.status,
      listPriceMinor: list,
      listBasis: basis,
      paymentMinor: r.d.paymentAmountMinor,
      differenceMinor: list != null && r.d.paymentAmountMinor != null ? list - r.d.paymentAmountMinor : null,
      discountName: r.d.discountName,
      pattern,
      note: basis === "highest" && pattern !== "full_price" ? `${note} List price is the highest amount on this plan in the import.`.trim() : note,
    };
    all.push(row);
    review.reviewed++;
    if (pattern === "full_price") review.fullPrice++;
    else {
      review.groups[pattern].push(row);
      if (pattern !== "unknown") review.totals[pattern] += row.differenceMinor ?? 0;
    }
  }
  for (const g of Object.values(review.groups)) g.sort((a, b) => (b.differenceMinor ?? 0) - (a.differenceMinor ?? 0) || a.name.localeCompare(b.name));

  // Households (Family IDs) with 2+ active members where an active member is not paying the household's rate:
  // either no family rate at all, or a family rate for a different head count.
  for (const m of all) {
    if (!m.familyId || m.expectedFamilyPercent <= 0) continue;
    if (m.pattern === "family" && m.paidFamilyPercent === m.expectedFamilyPercent) continue;
    const comparable = (m.pattern === "full_price" || m.pattern === "family") && m.listPriceMinor != null && m.paymentMinor != null;
    review.siblingsWithoutFamilyDiscount.push({
      familyId: m.familyId,
      membersInFamily: m.activeInFamily,
      expectedPercent: m.expectedFamilyPercent,
      paidPercent: m.paidFamilyPercent,
      name: m.name,
      plan: m.plan,
      paymentMinor: m.paymentMinor,
      listPriceMinor: m.listPriceMinor,
      pattern: m.pattern,
      wouldSaveMinor: comparable ? m.paymentMinor! - Math.round(m.listPriceMinor! * (1 - m.expectedFamilyPercent / 100)) : null,
    });
  }
  review.renewsIntoFixedTerm.sort((a, b) => (a.endDate ?? "9999").localeCompare(b.endDate ?? "9999") || a.name.localeCompare(b.name));
  review.siblingsWithoutFamilyDiscount.sort((a, b) => a.familyId.localeCompare(b.familyId) || a.name.localeCompare(b.name));
  if (!review.familyCapConfirmed) review.notes.push(`The family rate cap (${policy.familyDiscountCapPercent}%) is still marked "needs confirmation" in Settings; households past it are shown at the cap.`);
  return review;
}

const PATTERN_LABEL: Record<DiscountPattern, string> = {
  family: "Family discount",
  in_season_rate: "In Season rate",
  other: "Other",
  unknown: "Cannot tell",
  full_price: "List price",
};
export const patternLabel = (p: DiscountPattern) => PATTERN_LABEL[p];

const money = (m: number | null) => (m == null ? "" : (m / 100).toFixed(2));
const esc = (v: unknown) => {
  if (v == null) return "";
  const s = String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function discountReviewCsv(r: DiscountReview): string {
  const lines = [["Section", "Pattern", "Name", "Family ID", "Plan", "Status", "List price (USD)", "List price basis", "Payment Amount (USD)", "Difference per period (USD)", "Discount", "Note"].join(",")];
  for (const key of ["family", "in_season_rate", "other", "unknown"] as const) {
    for (const x of r.groups[key]) {
      lines.push(["Discounts", PATTERN_LABEL[key], x.name, x.familyId, x.plan, x.status, money(x.listPriceMinor), x.listBasis, money(x.paymentMinor), money(x.differenceMinor), x.discountName, x.note].map(esc).join(","));
    }
  }
  for (const s of r.siblingsWithoutFamilyDiscount) {
    lines.push(
      ["Not on the household family rate", PATTERN_LABEL[s.pattern], s.name, s.familyId, s.plan, "", money(s.listPriceMinor), "", money(s.paymentMinor), money(s.wouldSaveMinor), "", `${s.membersInFamily} active members share this Family ID, so the household rate is ${s.expectedPercent}% each${s.paidPercent ? `; pays a ${s.paidPercent}% family rate now` : ""}. Difference column = Payment Amount less the list price at ${s.expectedPercent}% off.`]
        .map(esc)
        .join(","),
    );
  }
  for (const x of r.renewsIntoFixedTerm) {
    lines.push(
      ["Set to renew into another fixed term", "", x.name, "", x.plan, x.status, "", "", money(x.paymentMinor), "", "", `${x.months}-month term${x.endDate ? ` ending ${x.endDate}` : ""}; Renewal Type in Zen Planner: ${x.renewalType}. The member agreement rolls a fixed term to month-to-month at the committed rate.`]
        .map(esc)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}
