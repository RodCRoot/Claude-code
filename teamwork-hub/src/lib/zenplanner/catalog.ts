import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { externalIds, products, productVersions, type ProductKind } from "@/db/schema";
import { audit } from "@/lib/audit";
import { AuthzError, type Viewer } from "@/lib/authz/policy";
import { createProduct } from "@/lib/billing/catalog";
import { todayLocal } from "@/lib/time";

/**
 * Teamwork's real plan ladder, copied from section 4 of docs/ZENPLANNER-MAP.md (the owner's Zen
 * Planner configuration on 2026-11-13). Prices are the owner's configuration, not invented.
 * Every plan is created as an inactive, unlisted draft for the owner to confirm before use.
 *
 * What the map does NOT give is marked per plan in `unknown` and shown in the description:
 * exact Zen Planner option names, billing interval of some programs, weekly limits of some plans.
 */
export const CATALOG_LABEL = "From Zen Planner configuration, confirm before use";
export const CATALOG_CATEGORY = "From Zen Planner configuration";
export const CATALOG_SOURCE = "zenplanner_config";

export type CatalogPlan = {
  key: string;
  name: string;
  kind: ProductKind;
  priceMinor: number;
  interval: "none" | "week" | "month";
  classesPerWeek: number | null;
  unlimited: boolean;
  commitmentMonths: number;
  creditsPerPeriod?: number;
  group: "Sports Performance" | "In Season" | "College" | "Fitness Together" | "Bootcamp" | "Linton";
  /** Things the map does not state; set before the plan is used. */
  unknown?: string;
};

const FREQ: { key: string; label: string; perWeek: number | null }[] = [
  { key: "1x", label: "1x per Week", perWeek: 1 },
  { key: "2x", label: "2x per Week", perWeek: 2 },
  { key: "3x", label: "3x per Week", perWeek: 3 },
  { key: "4x", label: "4x per Week", perWeek: 4 },
  { key: "unlimited", label: "Unlimited", perWeek: null },
];

const TERMS: { key: string; label: string; months: number }[] = [
  { key: "12mo", label: "12 Months", months: 12 },
  { key: "6mo", label: "6 Months", months: 6 },
  { key: "m2m", label: "Month to Month", months: 0 },
];

/** Monthly price in cents by frequency × commitment. null = not offered (1x/week is month-to-month only). */
export const LADDER_PRICES: Record<string, Record<string, number | null>> = {
  "1x": { "12mo": null, "6mo": null, m2m: 12900 },
  "2x": { "12mo": 17899, "6mo": 19799, m2m: 23299 },
  "3x": { "12mo": 22199, "6mo": 26199, m2m: 34800 },
  "4x": { "12mo": 29599, "6mo": 37599, m2m: 46500 },
  unlimited: { "12mo": 30999, "6mo": 41999, m2m: 56900 },
};

function ladderPlans(): CatalogPlan[] {
  const out: CatalogPlan[] = [];
  for (const f of FREQ) {
    for (const t of TERMS) {
      const price = LADDER_PRICES[f.key][t.key];
      if (price == null) continue;
      out.push({
        key: `perf_${f.key}_${t.key}`,
        name: `Sports Performance ${f.label} (${t.label})`,
        kind: "recurring_membership",
        priceMinor: price,
        interval: "month",
        classesPerWeek: f.perWeek,
        unlimited: f.perWeek == null,
        commitmentMonths: t.months,
        group: "Sports Performance",
      });
    }
  }
  return out;
}

export const TEAMWORK_CATALOG: CatalogPlan[] = [
  ...ladderPlans(),
  {
    key: "in_season",
    name: "In Season",
    kind: "recurring_membership",
    priceMinor: 9900,
    interval: "month",
    classesPerWeek: 1,
    unlimited: false,
    commitmentMonths: 0,
    group: "In Season",
    unknown: "The map gives the price only. The 1x per week limit comes from the hub's existing In Season reference plan.",
  },
  {
    key: "college",
    name: "College Plan (weekly)",
    kind: "recurring_membership",
    priceMinor: 5000,
    interval: "week",
    classesPerWeek: null,
    unlimited: true,
    commitmentMonths: 0,
    group: "College",
    unknown: "Billed every 7 days and unlimited, per the hub's existing college plan logic. The map gives the price only.",
  },
  {
    key: "ft_drop_in",
    name: "Fitness Together Drop-in",
    kind: "drop_in",
    priceMinor: 1000,
    interval: "none",
    classesPerWeek: null,
    unlimited: false,
    commitmentMonths: 0,
    creditsPerPeriod: 1,
    group: "Fitness Together",
    unknown: "The map gives the range ($10 drop-in to $60 unlimited). Options between the two are not listed and are not created.",
  },
  {
    key: "ft_unlimited",
    name: "Fitness Together Unlimited",
    kind: "recurring_membership",
    priceMinor: 6000,
    interval: "month",
    classesPerWeek: null,
    unlimited: true,
    commitmentMonths: 0,
    group: "Fitness Together",
    unknown: "Monthly billing is assumed; the map gives the price only.",
  },
  {
    key: "bootcamp",
    name: "Bootcamp",
    kind: "recurring_membership",
    priceMinor: 7500,
    interval: "month",
    classesPerWeek: null,
    unlimited: true,
    commitmentMonths: 0,
    group: "Bootcamp",
    unknown: "Monthly billing and no weekly limit are assumed; the map gives the price only.",
  },
  {
    key: "linton_60",
    name: "Linton Plan ($60)",
    kind: "recurring_membership",
    priceMinor: 6000,
    interval: "month",
    classesPerWeek: null,
    unlimited: false,
    commitmentMonths: 0,
    group: "Linton",
    unknown: "The map lists two Linton prices ($60 and $75) without saying what each covers. Set the weekly limit and the Linton location before use.",
  },
  {
    key: "linton_75",
    name: "Linton Plan ($75)",
    kind: "recurring_membership",
    priceMinor: 7500,
    interval: "month",
    classesPerWeek: null,
    unlimited: false,
    commitmentMonths: 0,
    group: "Linton",
    unknown: "The map lists two Linton prices ($60 and $75) without saying what each covers. Set the weekly limit and the Linton location before use.",
  },
];

/**
 * Short-run programs in the Zen Planner configuration that are NOT memberships. They are listed
 * (never created) as candidates for the events module.
 */
export const EVENT_CANDIDATES: { name: string; price: string }[] = [
  { name: "6-week challenges", price: "$229 to $299" },
  { name: "Summer 8-week program", price: "$249" },
  { name: "Vertical Jump program", price: "$349.99 (add-ons $149.99 and $229.99)" },
  { name: "All-Girl Speed & Strength", price: "$229 and $279.99" },
];

const dollars = (minor: number) => `$${(minor / 100).toFixed(2)}`;

export function catalogDescription(p: CatalogPlan): string {
  const per = p.interval === "week" ? " per week" : p.interval === "month" ? " per month" : "";
  return `${CATALOG_LABEL}. Price ${dollars(p.priceMinor)}${per} is from the owner's Zen Planner configuration (2026-11-13).${p.unknown ? ` Not in the configuration map: ${p.unknown}` : ""}`;
}

export type CatalogStatus = { plan: CatalogPlan; productId: string | null; active: boolean | null; publiclyListed: boolean | null };

/** Which catalog plans already exist in this org (by the catalog's own registry, never by name). */
export async function catalogStatus(tx: Tx, orgId: string): Promise<CatalogStatus[]> {
  const ext = await tx
    .select({ sourceId: externalIds.sourceId, localId: externalIds.localId })
    .from(externalIds)
    .where(and(eq(externalIds.orgId, orgId), eq(externalIds.source, CATALOG_SOURCE), eq(externalIds.sourceEntityType, "catalog_plan")));
  const ids = ext.map((e) => e.localId);
  const prods = ids.length ? await tx.select().from(products).where(and(eq(products.orgId, orgId), inArray(products.id, ids))) : [];
  const byKey = new Map(ext.map((e) => [e.sourceId, prods.find((p) => p.id === e.localId) ?? null]));
  return TEAMWORK_CATALOG.map((plan) => {
    const p = byKey.get(plan.key) ?? null;
    return { plan, productId: p?.id ?? null, active: p?.active ?? null, publiclyListed: p?.publiclyListed ?? null };
  });
}

/**
 * "Load Teamwork plan catalog": owner only, idempotent, audited. Creates each ladder plan once as
 * an inactive, unlisted draft. Never touches existing products (including the demo "Sample" plans)
 * and never recreates a plan it created before, even if the owner renamed, repriced or archived it.
 */
export async function loadTeamworkCatalog(tx: Tx, v: Viewer, today = todayLocal()): Promise<{ created: string[]; existing: string[] }> {
  if (v.role !== "owner") throw new AuthzError("Only the owner can load the plan catalog.");
  const created: string[] = [];
  const existing: string[] = [];
  for (const plan of TEAMWORK_CATALOG) {
    // The registry row is the lock: a concurrent second load conflicts here and skips.
    const [have] = await tx
      .select({ id: externalIds.id })
      .from(externalIds)
      .where(and(eq(externalIds.orgId, v.orgId), eq(externalIds.source, CATALOG_SOURCE), eq(externalIds.sourceEntityType, "catalog_plan"), eq(externalIds.sourceId, plan.key)));
    if (have) {
      existing.push(plan.key);
      continue;
    }
    const { product, version } = await createProduct(tx, v, {
      name: plan.name,
      kind: plan.kind,
      description: catalogDescription(plan),
      category: CATALOG_CATEGORY,
      publiclyListed: false,
      version: {
        priceMinor: plan.priceMinor,
        interval: plan.interval,
        classesPerWeek: plan.classesPerWeek,
        unlimited: plan.unlimited,
        commitmentMonths: plan.commitmentMonths,
        creditsPerPeriod: plan.creditsPerPeriod ?? null,
        effectiveFrom: today,
      },
    });
    // Draft: not sellable until the owner activates it in Billing → Products.
    await tx.update(products).set({ active: false }).where(eq(products.id, product.id));
    await tx.insert(externalIds).values({ orgId: v.orgId, source: CATALOG_SOURCE, sourceEntityType: "catalog_plan", sourceId: plan.key, localEntityType: "product", localId: product.id });
    await tx.insert(externalIds).values({ orgId: v.orgId, source: CATALOG_SOURCE, sourceEntityType: "catalog_plan_version", sourceId: plan.key, localEntityType: "product_version", localId: version.id });
    created.push(plan.key);
  }
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "zenplanner.catalog_loaded", "organization", v.orgId, {
    summary: `Loaded Teamwork plan catalog: ${created.length} draft plan(s) created, ${existing.length} already present`,
    after: { created, existing },
  });
  return { created, existing };
}

/** List prices by catalog key for the discount review (current version of each catalog product, falling back to the map). */
export async function catalogListPrices(tx: Tx, orgId: string): Promise<Map<string, number>> {
  const out = new Map(TEAMWORK_CATALOG.map((p) => [p.key, p.priceMinor]));
  const ext = await tx
    .select({ sourceId: externalIds.sourceId, localId: externalIds.localId })
    .from(externalIds)
    .where(and(eq(externalIds.orgId, orgId), eq(externalIds.source, CATALOG_SOURCE), eq(externalIds.sourceEntityType, "catalog_plan")));
  for (const e of ext) {
    const vs = await tx.select({ price: productVersions.priceMinor, version: productVersions.version }).from(productVersions).where(eq(productVersions.productId, e.localId));
    const latest = vs.sort((a, b) => b.version - a.version)[0];
    if (latest) out.set(e.sourceId, latest.price);
  }
  return out;
}

/**
 * Best-effort match of a Zen Planner membership to a catalog plan, for the discount review only.
 * Zen Planner's option names are not in the map, so this reads the plan name plus the Att. Limit
 * and Months columns. Returns null when it cannot tell (the report then says so).
 */
export function matchCatalogPlan(input: { plan: string; attLimit: number | null; attLimitType: string | null; months: number | null }): CatalogPlan | null {
  const name = input.plan.toLowerCase();
  const find = (key: string) => TEAMWORK_CATALOG.find((p) => p.key === key) ?? null;
  if (/in[\s-]?season/.test(name)) return find("in_season");
  if (/college/.test(name)) return find("college");
  if (/boot\s?camp/.test(name)) return find("bootcamp");
  if (/fitness together/.test(name)) return /drop/.test(name) ? find("ft_drop_in") : /unlimited/.test(name) ? find("ft_unlimited") : null;
  if (/linton/.test(name)) return null;
  if (/challenge|camp|vertical|summer|all[\s-]girl/.test(name)) return null;
  let freq: string | null = null;
  const digit = /\b([1-4])\s*x\b|\b([1-4])\s*(?:times|days|sessions|classes)\s*(?:a|per|\/)\s*w/.exec(name);
  const word = /\b(one|two|three|four)\b/.exec(name);
  const words: Record<string, string> = { one: "1", two: "2", three: "3", four: "4" };
  if (/unlimited/.test(name)) freq = "unlimited";
  else if (digit) freq = `${digit[1] ?? digit[2]}x`;
  else if (word) freq = `${words[word[1]]}x`;
  else if (input.attLimit != null && input.attLimit >= 1 && input.attLimit <= 4 && /week/i.test(input.attLimitType ?? "")) freq = `${input.attLimit}x`;
  if (!freq) return null;
  let term: string | null = null;
  if (/month[\s-]to[\s-]month|m2m|monthly/.test(name)) term = "m2m";
  else if (/\b12[\s-]*(?:mo|month)|annual|year/.test(name)) term = "12mo";
  else if (/\b6[\s-]*(?:mo|month)/.test(name)) term = "6mo";
  else if (input.months === 12) term = "12mo";
  else if (input.months === 6) term = "6mo";
  else if (input.months === 1 || input.months === 0) term = "m2m";
  if (!term) return null;
  return find(`perf_${freq}_${term}`);
}
