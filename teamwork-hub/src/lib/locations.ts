import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { locations, organizations, users } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, type Viewer } from "@/lib/authz/policy";
import { DEFAULT_TZ } from "@/lib/time";

/**
 * Multi-location support.
 *
 * - A location is a physical facility (e.g. Bloomington, Linton). Sessions carry `location_id`
 *   (resolved at creation from: explicit choice → series → resource → service type).
 * - Products (and optionally a single membership) carry `location_ids`: empty = valid everywhere.
 *   Credits copy their product's/membership's locations at grant time.
 * - A session with no location is org-wide: any membership or credit covers it.
 * - Kiosk logins may be bound to a location (`users.location_id`) and then only see that location.
 */

export type Location = typeof locations.$inferSelect;

export async function listLocations(tx: Tx, orgId: string, opts: { activeOnly?: boolean } = {}): Promise<Location[]> {
  return tx
    .select()
    .from(locations)
    .where(and(eq(locations.orgId, orgId), opts.activeOnly ? eq(locations.active, true) : undefined))
    .orderBy(asc(locations.sortOrder), asc(locations.name));
}

/** Load a location of this org (throws a friendly error otherwise). */
export async function getLocation(tx: Tx, orgId: string, id: string): Promise<Location> {
  const [l] = await tx.select().from(locations).where(and(eq(locations.id, id), eq(locations.orgId, orgId)));
  if (!l) throw new UserError("Location not found.", { locationId: "Choose a location" });
  return l;
}

/** Validate a list of location ids belongs to the org; returns them de-duplicated. */
export async function assertLocationIds(tx: Tx, orgId: string, ids: string[]): Promise<string[]> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return [];
  const rows = await tx.select({ id: locations.id }).from(locations).where(and(eq(locations.orgId, orgId), inArray(locations.id, uniq)));
  if (rows.length !== uniq.length) throw new UserError("One of the chosen locations was not found.", { locationIds: "Check locations" });
  return uniq;
}

export async function locationNames(tx: Tx, orgId: string, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await tx.select({ id: locations.id, name: locations.name }).from(locations).where(and(eq(locations.orgId, orgId), inArray(locations.id, ids)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Join names as "Bloomington", "Bloomington and Linton", "A, B and C" (no dashes). */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Does a location scope cover a session location?
 * Empty scope = every location; a session without a location is covered by any scope.
 */
export function scopeCovers(scope: string[] | null | undefined, sessionLocationId: string | null | undefined): boolean {
  if (!sessionLocationId) return true;
  if (!scope || scope.length === 0) return true;
  return scope.includes(sessionLocationId);
}

/** The location a kiosk (or any) login is bound to, or null for all locations. */
export async function boundLocationId(tx: Tx, v: Pick<Viewer, "userId" | "orgId">): Promise<string | null> {
  const [u] = await tx.select({ locationId: users.locationId }).from(users).where(and(eq(users.id, v.userId), eq(users.orgId, v.orgId)));
  return u?.locationId ?? null;
}

/** Parse a `?location=` query value: a uuid or null ("" / "all" / junk → null). */
export function parseLocationParam(v: string | undefined | null): string | null {
  return v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
}

const optStr = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(300).nullable().optional());

export const locationSchema = z.object({
  id: z.preprocess((v) => (v === "" || v == null ? null : v), z.string().uuid().nullable().optional()),
  name: z.string().trim().min(1, "Required").max(80),
  address: optStr,
  timezone: optStr,
  active: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()),
  sortOrder: z.preprocess((v) => (v === "" || v == null ? 0 : v), z.coerce.number().int().min(0).max(999)),
});

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function saveLocation(tx: Tx, v: Viewer, input: z.input<typeof locationSchema>): Promise<string> {
  assertCan(v, "schedule.manage");
  const d = locationSchema.parse(input);
  const [org] = await tx.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, v.orgId));
  const timezone = d.timezone ?? org?.timezone ?? DEFAULT_TZ;
  if (!validTz(timezone)) throw new UserError("Use an IANA timezone like America/Indiana/Indianapolis.", { timezone: "Unknown timezone" });
  const values = { name: d.name, address: d.address ?? null, timezone, active: d.active, sortOrder: d.sortOrder };
  const all = await listLocations(tx, v.orgId);
  if (all.some((l) => l.name.toLowerCase() === d.name.toLowerCase() && l.id !== d.id)) throw new UserError("A location with that name already exists.", { name: "Name in use" });
  const actor = { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role };
  if (d.id) {
    const before = await getLocation(tx, v.orgId, d.id);
    await tx.update(locations).set(values).where(eq(locations.id, d.id));
    await audit(tx, actor, "location.update", "location", d.id, { summary: `Updated location ${d.name}`, before, after: values });
    return d.id;
  }
  const [l] = await tx.insert(locations).values({ orgId: v.orgId, ...values }).returning();
  await audit(tx, actor, "location.create", "location", l.id, { summary: `Created location ${l.name}`, after: values });
  return l.id;
}

/** Bind (or unbind with null) a kiosk login to a location. */
export async function setKioskLocation(tx: Tx, v: Viewer, input: { userId: string; locationId: string | null }) {
  assertCan(v, "schedule.manage");
  const [u] = await tx.select({ id: users.id, role: users.role, locationId: users.locationId }).from(users).where(and(eq(users.id, input.userId), eq(users.orgId, v.orgId)));
  if (!u || u.role !== "kiosk") throw new UserError("Choose a kiosk login.");
  if (input.locationId) await getLocation(tx, v.orgId, input.locationId);
  await tx.update(users).set({ locationId: input.locationId }).where(eq(users.id, u.id));
  await audit(tx, { orgId: v.orgId, actorUserId: v.userId, actorRole: v.role }, "kiosk.location_bind", "user", u.id, {
    summary: input.locationId ? "Kiosk login bound to a location" : "Kiosk login unbound (all locations)",
    before: { locationId: u.locationId },
    after: { locationId: input.locationId },
  });
}

export async function kioskLogins(tx: Tx, orgId: string) {
  return tx.select({ id: users.id, displayName: users.displayName, locationId: users.locationId }).from(users).where(and(eq(users.orgId, orgId), eq(users.role, "kiosk"))).orderBy(asc(users.displayName));
}
