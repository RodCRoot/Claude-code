import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, memberships, people, productVersions, zpMembershipDetails, zpPersonDetails } from "@/db/schema";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { membershipPolicy } from "@/lib/membership-policy";
import { catalogListPrices, matchCatalogPlan } from "./catalog";

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
};

export type SiblingRow = { familyId: string; membersInFamily: number; name: string; plan: string; paymentMinor: number | null; listPriceMinor: number | null; pattern: DiscountPattern; wouldSaveMinor: number | null };

export type DiscountReview = {
  familyPercent: number;
  familyPercentConfirmed: boolean;
  inSeasonRateMinor: number;
  reviewed: number;
  endedExcluded: number;
  groups: Record<Exclude<DiscountPattern, "full_price">, DiscountRow[]>;
  fullPrice: number;
  siblingsWithoutFamilyDiscount: SiblingRow[];
  totals: { family: number; in_season_rate: number; other: number };
  notes: string[];
};

const CURRENT = ["active", "trialing", "past_due", "on_hold", "pending"];

export function classifyDiscount(input: { listPriceMinor: number | null; paymentMinor: number | null; discountName: string | null; familyPercent: number; inSeasonRateMinor: number; planIsInSeason: boolean }): { pattern: DiscountPattern; note: string } {
  const { listPriceMinor: list, paymentMinor: pay, discountName, familyPercent, inSeasonRateMinor, planIsInSeason } = input;
  if (pay == null) return { pattern: "unknown", note: "No Payment Amount in the export." };
  if (list == null) return discountName ? { pattern: "other", note: `Carries the discount "${discountName}"; no list price to compare.` } : { pattern: "unknown", note: "No list price to compare against." };
  const familyPrice = Math.round(list * (1 - familyPercent / 100));
  if (pay !== list && Math.abs(pay - familyPrice) <= 1) return { pattern: "family", note: `Matches the family discount at ${familyPercent}%.` };
  if (!planIsInSeason && pay === inSeasonRateMinor && pay !== list) return { pattern: "in_season_rate", note: "Paying the In Season rate on a plan that is not an In Season plan." };
  if (pay === list) return discountName ? { pattern: "other", note: `Carries the discount "${discountName}" but pays the list price.` } : { pattern: "full_price", note: "" };
  if (discountName && /family|sibling/i.test(discountName)) return { pattern: "other", note: `Discount "${discountName}" does not equal ${familyPercent}% of the list price.` };
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
    familyPercent: policy.familyDiscountPercent,
    familyPercentConfirmed: !policy.unconfirmed.includes("familyDiscountPercent"),
    inSeasonRateMinor,
    reviewed: 0,
    endedExcluded: 0,
    groups: { family: [], in_season_rate: [], other: [], unknown: [] },
    fullPrice: 0,
    siblingsWithoutFamilyDiscount: [],
    totals: { family: 0, in_season_rate: 0, other: 0 },
    notes: [
      "Read-only. Nothing on this page changes a membership or a price.",
      "List price is worked out, not exported: 'catalog' means the plan matched Teamwork's ladder by name, Att. Limit and Months; 'highest' means the highest Payment Amount on that plan in the import was used instead.",
      "The difference is per billing period (monthly, except weekly plans).",
    ],
  };
  const all: DiscountRow[] = [];
  for (const r of rows) {
    if (!CURRENT.includes(r.m.status)) {
      review.endedExcluded++;
      continue;
    }
    const cat = matchCatalogPlan({ plan: r.d.planName, attLimit: r.d.attLimit, attLimitType: r.d.attLimitType, months: r.d.months });
    let list: number | null = null;
    let basis: DiscountRow["listBasis"] = "none";
    if (cat) {
      list = prices.get(cat.key) ?? cat.priceMinor;
      basis = "catalog";
    } else if (r.versionPrice > 0) {
      list = r.versionPrice;
      basis = "highest";
    }
    const { pattern, note } = classifyDiscount({ listPriceMinor: list, paymentMinor: r.d.paymentAmountMinor, discountName: r.d.discountName, familyPercent: policy.familyDiscountPercent, inSeasonRateMinor, planIsInSeason: cat?.key === "in_season" || /in[\s-]?season/i.test(r.d.planName) });
    const row: DiscountRow = {
      membershipId: r.m.id,
      athleteId: r.m.athleteId,
      name: `${r.first} ${r.last}`,
      familyId: r.d.familyId ?? famByPerson.get(r.personId) ?? null,
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

  // Siblings: 2+ athletes with a current membership on one Family ID, where someone is not on the family discount.
  const byFamily = new Map<string, DiscountRow[]>();
  for (const r of all) if (r.familyId) byFamily.set(r.familyId, [...(byFamily.get(r.familyId) ?? []), r]);
  for (const [familyId, members] of byFamily) {
    const athletesInFamily = new Set(members.map((m) => m.athleteId)).size;
    if (athletesInFamily < 2) continue;
    for (const m of members) {
      if (m.pattern === "family") continue;
      review.siblingsWithoutFamilyDiscount.push({
        familyId,
        membersInFamily: athletesInFamily,
        name: m.name,
        plan: m.plan,
        paymentMinor: m.paymentMinor,
        listPriceMinor: m.listPriceMinor,
        pattern: m.pattern,
        wouldSaveMinor: m.pattern === "full_price" && m.listPriceMinor != null ? m.listPriceMinor - Math.round(m.listPriceMinor * (1 - policy.familyDiscountPercent / 100)) : null,
      });
    }
  }
  review.siblingsWithoutFamilyDiscount.sort((a, b) => a.familyId.localeCompare(b.familyId) || a.name.localeCompare(b.name));
  if (!review.familyPercentConfirmed) review.notes.push(`The family discount percent (${policy.familyDiscountPercent}%) is still marked "needs confirmation" in Settings; the family group uses it as it stands.`);
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
      ["Siblings without the family discount", PATTERN_LABEL[s.pattern], s.name, s.familyId, s.plan, "", money(s.listPriceMinor), "", money(s.paymentMinor), money(s.wouldSaveMinor), "", `${s.membersInFamily} athletes share this Family ID. Difference column = what ${r.familyPercent}% would take off.`]
        .map(esc)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}
