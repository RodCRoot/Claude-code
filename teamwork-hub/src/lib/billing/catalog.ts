import { and, asc, desc, eq, isNull, lte, or, gte, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { memberships, products, productVersions, type ProductKind } from "@/db/schema";
import { assertLocationIds } from "@/lib/locations";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { audit } from "@/lib/audit";
import { UserError } from "./errors";
import { addDaysYmd } from "@/lib/time";
import { actorOf, assertMinor } from "./util";

export const PRODUCT_KINDS: { value: ProductKind; label: string }[] = [
  { value: "recurring_membership", label: "Recurring membership" },
  { value: "package", label: "Package (N credits)" },
  { value: "one_time", label: "One-time" },
  { value: "drop_in", label: "Drop-in" },
  { value: "assessment", label: "Assessment" },
  { value: "camp", label: "Camp" },
  { value: "trial", label: "Trial" },
  { value: "retail", label: "Retail" },
];

export type VersionInput = {
  priceMinor: number;
  currency?: string;
  interval?: "none" | "week" | "month" | "year";
  intervalCount?: number;
  creditsPerPeriod?: number | null;
  unlimited?: boolean;
  /** Classes per ISO week; null/undefined = no weekly cap. */
  classesPerWeek?: number | null;
  creditExpiryDays?: number | null;
  rolloverMax?: number;
  trialDays?: number;
  commitmentMonths?: number;
  cancellationNoticeDays?: number;
  siblingPercentOff?: number | null;
  serviceTypeIds?: string[];
  effectiveFrom: string;
};

function validateVersion(kind: ProductKind, v: VersionInput) {
  assertMinor(v.priceMinor, "price");
  if (v.priceMinor < 0) throw new UserError("Price cannot be negative.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.effectiveFrom)) throw new UserError("Effective date is required.");
  if (kind === "recurring_membership" && (!v.interval || v.interval === "none")) throw new UserError("Recurring memberships need a billing interval.");
  if (kind !== "recurring_membership" && v.interval && v.interval !== "none") throw new UserError("Only recurring memberships have a billing interval.");
  if (v.siblingPercentOff != null && (v.siblingPercentOff < 0 || v.siblingPercentOff > 100)) throw new UserError("Sibling discount must be 0–100%.");
  if (v.creditsPerPeriod != null && (!Number.isInteger(v.creditsPerPeriod) || v.creditsPerPeriod <= 0)) throw new UserError("Credits must be a positive whole number.");
  if (kind === "package" && !v.creditsPerPeriod) throw new UserError("Packages must grant a number of credits.");
  if (v.classesPerWeek != null) {
    if (!Number.isInteger(v.classesPerWeek) || v.classesPerWeek <= 0 || v.classesPerWeek > 14) throw new UserError("Classes per week must be a whole number from 1 to 14 (leave empty for unlimited).");
    if (kind !== "recurring_membership") throw new UserError("Only recurring memberships have a weekly class limit.");
  }
}

function versionValues(productId: string, version: number, v: VersionInput, createdBy: string | null) {
  return {
    productId,
    version,
    priceMinor: v.priceMinor,
    currency: (v.currency ?? "USD").toUpperCase(),
    interval: v.interval ?? "none",
    intervalCount: v.intervalCount ?? 1,
    creditsPerPeriod: v.creditsPerPeriod ?? null,
    unlimited: v.unlimited ?? false,
    classesPerWeek: v.classesPerWeek ?? null,
    creditExpiryDays: v.creditExpiryDays ?? null,
    rolloverMax: v.rolloverMax ?? 0,
    serviceTypeIds: v.serviceTypeIds ?? [],
    trialDays: v.trialDays ?? 0,
    commitmentMonths: v.commitmentMonths ?? 0,
    cancellationNoticeDays: v.cancellationNoticeDays ?? 0,
    familyDiscount: v.siblingPercentOff ? { siblingPercentOff: v.siblingPercentOff } : {},
    effectiveFrom: v.effectiveFrom,
    createdBy,
  };
}

export async function createProduct(
  tx: Tx,
  v: Viewer,
  input: { name: string; kind: ProductKind; description?: string | null; category?: string | null; sku?: string | null; trackInventory?: boolean; publiclyListed?: boolean; isDemo?: boolean; version: VersionInput },
) {
  assertCan(v, "billing.manage");
  if (!input.name.trim()) throw new UserError("Name is required.");
  validateVersion(input.kind, input.version);
  const [p] = await tx
    .insert(products)
    .values({
      orgId: v.orgId,
      name: input.name.trim(),
      kind: input.kind,
      description: input.description ?? null,
      category: input.category ?? null,
      sku: input.sku ?? null,
      trackInventory: input.kind === "retail" ? (input.trackInventory ?? true) : false,
      publiclyListed: input.publiclyListed ?? false,
      isDemo: input.isDemo ?? false,
    })
    .returning();
  const [ver] = await tx.insert(productVersions).values(versionValues(p.id, 1, input.version, v.userId)).returning();
  await audit(tx, actorOf(v), "billing.product.create", "product", p.id, { summary: `Created product ${p.name}`, after: { product: p, version: ver } });
  return { product: p, version: ver };
}

/**
 * Price/terms change = a NEW immutable version. The previous open-ended version is closed the day
 * before the new effective date; existing memberships keep pointing at the version they bought.
 * (A DB trigger rejects edits to any version's terms.)
 */
export async function createProductVersion(tx: Tx, v: Viewer, productId: string, input: VersionInput) {
  assertCan(v, "billing.manage");
  const [p] = await tx.select().from(products).where(and(eq(products.id, productId), eq(products.orgId, v.orgId))).for("update");
  if (!p) throw new UserError("Product not found.");
  validateVersion(p.kind, input);
  const existing = await tx.select().from(productVersions).where(eq(productVersions.productId, productId)).orderBy(desc(productVersions.version));
  const latest = existing[0];
  if (latest && input.effectiveFrom <= latest.effectiveFrom) {
    throw new UserError(`New version must take effect after ${latest.effectiveFrom} (the latest version's start).`);
  }
  for (const old of existing.filter((e) => e.effectiveTo == null || e.effectiveTo >= input.effectiveFrom)) {
    await tx.update(productVersions).set({ effectiveTo: addDaysYmd(input.effectiveFrom, -1) }).where(eq(productVersions.id, old.id));
  }
  const [ver] = await tx.insert(productVersions).values(versionValues(productId, (latest?.version ?? 0) + 1, input, v.userId)).returning();
  await audit(tx, actorOf(v), "billing.product.version", "product", productId, {
    summary: `New version v${ver.version} of ${p.name} effective ${ver.effectiveFrom}`,
    before: latest ? { version: latest.version, priceMinor: latest.priceMinor } : null,
    after: { version: ver.version, priceMinor: ver.priceMinor },
  });
  return ver;
}

/**
 * Limit where a product's memberships and credits can be used (empty = every location).
 * Scope is not a price term, so it lives on the product and applies to existing memberships too.
 * Credits already granted keep the scope they were granted with.
 */
export async function setProductLocations(tx: Tx, v: Viewer, productId: string, locationIds: string[]) {
  assertCan(v, "billing.manage");
  const ids = await assertLocationIds(tx, v.orgId, locationIds);
  const [before] = await tx.select().from(products).where(and(eq(products.id, productId), eq(products.orgId, v.orgId)));
  if (!before) throw new UserError("Product not found.");
  await tx.update(products).set({ locationIds: ids }).where(eq(products.id, productId));
  await audit(tx, actorOf(v), "billing.product.locations", "product", productId, {
    summary: ids.length ? `Limited ${before.name} to ${ids.length} location(s)` : `${before.name} valid at every location`,
    before: { locationIds: before.locationIds },
    after: { locationIds: ids },
  });
}

/** Per-membership location override (null = follow the product). */
export async function setMembershipLocations(tx: Tx, v: Viewer, membershipId: string, locationIds: string[] | null) {
  assertCan(v, "billing.manage");
  const ids = locationIds === null ? null : await assertLocationIds(tx, v.orgId, locationIds);
  const [before] = await tx.select().from(memberships).where(and(eq(memberships.id, membershipId), eq(memberships.orgId, v.orgId)));
  if (!before) throw new UserError("Membership not found.");
  await tx.update(memberships).set({ locationIds: ids, updatedAt: new Date() }).where(eq(memberships.id, membershipId));
  await audit(tx, actorOf(v), "billing.membership.locations", "membership", membershipId, { before: { locationIds: before.locationIds }, after: { locationIds: ids } });
}

export async function setProductActive(tx: Tx, v: Viewer, productId: string, active: boolean) {
  assertCan(v, "billing.manage");
  const [p] = await tx.update(products).set({ active }).where(and(eq(products.id, productId), eq(products.orgId, v.orgId))).returning();
  if (!p) throw new UserError("Product not found.");
  await audit(tx, actorOf(v), active ? "billing.product.activate" : "billing.product.archive", "product", productId, { summary: `${active ? "Activated" : "Archived"} ${p.name}` });
  return p;
}

/** The version in effect on a date (or the latest if the date precedes all versions' end). */
export async function versionOn(tx: Tx, productId: string, onDate: string) {
  const [ver] = await tx
    .select()
    .from(productVersions)
    .where(
      and(
        eq(productVersions.productId, productId),
        lte(productVersions.effectiveFrom, onDate),
        or(isNull(productVersions.effectiveTo), gte(productVersions.effectiveTo, onDate)),
      ),
    )
    .orderBy(desc(productVersions.version))
    .limit(1);
  return ver ?? null;
}

export async function listCatalog(tx: Tx, orgId: string, today: string) {
  const ps = await tx.select().from(products).where(eq(products.orgId, orgId)).orderBy(asc(products.kind), asc(products.name));
  const vs = ps.length
    ? await tx
        .select()
        .from(productVersions)
        .where(sql`${productVersions.productId} in ${ps.map((p) => p.id)}`)
        .orderBy(asc(productVersions.version))
    : [];
  return ps.map((p) => {
    const versions = vs.filter((x) => x.productId === p.id);
    const current =
      versions.filter((x) => x.effectiveFrom <= today && (x.effectiveTo == null || x.effectiveTo >= today)).pop() ?? null;
    const upcoming = versions.filter((x) => x.effectiveFrom > today);
    return { product: p, versions, current, upcoming };
  });
}
