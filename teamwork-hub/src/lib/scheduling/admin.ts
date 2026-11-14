import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { busyBlocks, cancellationPolicies, classSeries, coachAvailability, resources, serviceTypes, users } from "@/db/schema";
import { UserError } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { assertCan, AuthzError, can, STAFF, type Viewer } from "@/lib/authz/policy";
import { localToUtc } from "@/lib/time";
import { actorOf, orgTimezone } from "./common";
import { getLocation } from "@/lib/locations";

// ---------------------------------------------------------------------------
// Schemas (shared by server actions; FormData strings are coerced)
// ---------------------------------------------------------------------------

const optStr = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().nullable().optional());
const optUuid = z.preprocess((v) => (v === "" || v == null ? null : v), z.string().uuid().nullable().optional());
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const optInt = (min: number, max: number) => z.preprocess((v) => (v === "" || v == null ? null : v), z.coerce.number().int().min(min).max(max).nullable().optional());
const bool = z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean());
const hhmm = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Use HH:MM");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const optYmd = z.preprocess((v) => (v === "" || v == null ? null : v), ymd.nullable().optional());
const ids = z.preprocess((v) => (v == null || v === "" ? [] : Array.isArray(v) ? v : [v]), z.array(z.string().uuid()));
const weekdays = z.preprocess((v) => (v == null ? [] : (Array.isArray(v) ? v : [v]).map(Number)), z.array(z.number().int().min(1).max(7)).min(1, "Pick at least one weekday"));

export const resourceSchema = z.object({
  id: optUuid,
  name: z.string().trim().min(1, "Required"),
  kind: z.enum(["room", "area", "equipment"]),
  capacity: optInt(0, 1000),
  exclusive: bool,
  locationId: optUuid,
  active: bool,
});

export const policySchema = z.object({
  id: optUuid,
  name: z.string().trim().min(1, "Required"),
  lateCancelWindowMinutes: int(0, 60 * 24 * 14),
  lateCancelPenalty: z.enum(["none", "forfeit_credit", "fee"]),
  noShowPenalty: z.enum(["none", "forfeit_credit", "fee"]),
  feeMinor: int(0, 1_000_000),
  description: optStr,
});

export const serviceTypeSchema = z.object({
  id: optUuid,
  name: z.string().trim().min(1, "Required"),
  kind: z.enum(["class", "private", "semi_private", "assessment", "camp", "event"]),
  description: optStr,
  defaultDurationMinutes: int(5, 24 * 60),
  defaultCapacity: int(1, 500),
  bufferBeforeMinutes: int(0, 240),
  bufferAfterMinutes: int(0, 240),
  creditCost: int(0, 20),
  cancellationPolicyId: optUuid,
  publicBookable: bool,
  exclusiveCoach: bool,
  active: bool,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #2563eb").default("#2563eb"),
  requiresEntitlement: bool,
  minAge: optInt(0, 120),
  maxAge: optInt(0, 120),
  requiredFormTemplateIds: ids,
  locationId: optUuid,
});

export const seriesSchema = z.object({
  id: optUuid,
  serviceTypeId: z.string().uuid("Choose a service"),
  title: z.string().trim().min(1, "Required"),
  weekdays,
  startTimeLocal: hhmm,
  durationMinutes: int(5, 24 * 60),
  startsOn: ymd,
  endsOn: optYmd,
  coachUserId: optUuid,
  resourceId: optUuid,
  locationId: optUuid,
  capacity: int(1, 500),
  waitlistCapacity: int(0, 200),
  active: bool,
});

export const availabilitySchema = z.object({
  coachUserId: z.string().uuid("Choose a coach"),
  weekday: int(1, 7),
  startLocal: hhmm,
  endLocal: hhmm,
  effectiveFrom: optYmd,
  effectiveTo: optYmd,
});

export const timeOffSchema = z.object({
  coachUserId: z.string().uuid("Choose a coach"),
  startDate: ymd,
  startTime: hhmm,
  endDate: ymd,
  endTime: hhmm,
  reason: optStr,
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function saveResource(tx: Tx, v: Viewer, input: z.infer<typeof resourceSchema>) {
  assertCan(v, "schedule.manage");
  if (input.locationId) await getLocation(tx, v.orgId, input.locationId);
  const values = { name: input.name, kind: input.kind, capacity: input.capacity ?? null, exclusive: input.exclusive, locationId: input.locationId ?? null, active: input.active };
  if (input.id) {
    const [before] = await tx.select().from(resources).where(and(eq(resources.id, input.id), eq(resources.orgId, v.orgId)));
    if (!before) throw new UserError("Resource not found.");
    await tx.update(resources).set(values).where(eq(resources.id, input.id));
    await audit(tx, actorOf(v), "resource.update", "resource", input.id, { summary: `Updated resource ${input.name}`, before, after: values });
    return input.id;
  }
  const [r] = await tx.insert(resources).values({ orgId: v.orgId, ...values }).returning();
  await audit(tx, actorOf(v), "resource.create", "resource", r.id, { summary: `Created resource ${r.name}`, after: values });
  return r.id;
}

export async function savePolicy(tx: Tx, v: Viewer, input: z.infer<typeof policySchema>) {
  assertCan(v, "schedule.manage");
  const values = {
    name: input.name,
    lateCancelWindowMinutes: input.lateCancelWindowMinutes,
    lateCancelPenalty: input.lateCancelPenalty,
    noShowPenalty: input.noShowPenalty,
    feeMinor: input.feeMinor,
    description: input.description ?? null,
  };
  if ((values.lateCancelPenalty === "fee" || values.noShowPenalty === "fee") && values.feeMinor <= 0) {
    throw new UserError("Set a fee amount when a penalty is “fee”.", { feeMinor: "Required for fee penalties" });
  }
  if (input.id) {
    const [before] = await tx.select().from(cancellationPolicies).where(and(eq(cancellationPolicies.id, input.id), eq(cancellationPolicies.orgId, v.orgId)));
    if (!before) throw new UserError("Policy not found.");
    await tx.update(cancellationPolicies).set(values).where(eq(cancellationPolicies.id, input.id));
    await audit(tx, actorOf(v), "cancellation_policy.update", "cancellation_policy", input.id, { summary: `Updated policy ${input.name}`, before, after: values });
    return input.id;
  }
  const [p] = await tx.insert(cancellationPolicies).values({ orgId: v.orgId, ...values }).returning();
  await audit(tx, actorOf(v), "cancellation_policy.create", "cancellation_policy", p.id, { summary: `Created policy ${p.name}`, after: values });
  return p.id;
}

export async function saveServiceType(tx: Tx, v: Viewer, input: z.infer<typeof serviceTypeSchema>) {
  assertCan(v, "schedule.manage");
  if (input.minAge != null && input.maxAge != null && input.minAge > input.maxAge) throw new UserError("Minimum age is above maximum age.", { minAge: "Check ages" });
  if (input.locationId) await getLocation(tx, v.orgId, input.locationId);
  if (input.cancellationPolicyId) {
    const [p] = await tx.select({ id: cancellationPolicies.id }).from(cancellationPolicies).where(and(eq(cancellationPolicies.id, input.cancellationPolicyId), eq(cancellationPolicies.orgId, v.orgId)));
    if (!p) throw new UserError("Policy not found.");
  }
  const eligibility: { requiredFormTemplateIds?: string[]; requiresEntitlement?: boolean; minAge?: number; maxAge?: number } = {};
  if (input.requiredFormTemplateIds.length) eligibility.requiredFormTemplateIds = input.requiredFormTemplateIds;
  if (!input.requiresEntitlement) eligibility.requiresEntitlement = false;
  if (input.minAge != null) eligibility.minAge = input.minAge;
  if (input.maxAge != null) eligibility.maxAge = input.maxAge;
  const values = {
    name: input.name,
    kind: input.kind,
    description: input.description ?? null,
    defaultDurationMinutes: input.defaultDurationMinutes,
    defaultCapacity: input.defaultCapacity,
    bufferBeforeMinutes: input.bufferBeforeMinutes,
    bufferAfterMinutes: input.bufferAfterMinutes,
    creditCost: input.creditCost,
    cancellationPolicyId: input.cancellationPolicyId ?? null,
    publicBookable: input.publicBookable,
    exclusiveCoach: input.exclusiveCoach,
    active: input.active,
    color: input.color,
    eligibility,
    locationId: input.locationId ?? null,
  };
  if (input.id) {
    const [before] = await tx.select().from(serviceTypes).where(and(eq(serviceTypes.id, input.id), eq(serviceTypes.orgId, v.orgId)));
    if (!before) throw new UserError("Service type not found.");
    await tx.update(serviceTypes).set(values).where(eq(serviceTypes.id, input.id));
    await audit(tx, actorOf(v), "service_type.update", "service_type", input.id, { summary: `Updated service ${input.name} (applies to newly created sessions)`, before, after: values });
    return input.id;
  }
  const [st] = await tx.insert(serviceTypes).values({ orgId: v.orgId, ...values }).returning();
  await audit(tx, actorOf(v), "service_type.create", "service_type", st.id, { summary: `Created service ${st.name}`, after: values });
  return st.id;
}

export async function saveSeries(tx: Tx, v: Viewer, input: z.infer<typeof seriesSchema>) {
  assertCan(v, "schedule.manage");
  if (input.endsOn && input.endsOn < input.startsOn) throw new UserError("End date is before the start date.", { endsOn: "Check dates" });
  const [st] = await tx.select({ id: serviceTypes.id }).from(serviceTypes).where(and(eq(serviceTypes.id, input.serviceTypeId), eq(serviceTypes.orgId, v.orgId)));
  if (!st) throw new UserError("Service not found.");
  if (input.coachUserId) await assertStaffUser(tx, v.orgId, input.coachUserId);
  if (input.resourceId) {
    const [r] = await tx.select({ id: resources.id }).from(resources).where(and(eq(resources.id, input.resourceId), eq(resources.orgId, v.orgId)));
    if (!r) throw new UserError("Resource not found.");
  }
  const loc = input.locationId ? await getLocation(tx, v.orgId, input.locationId) : null;
  const tz = loc?.timezone ?? (await orgTimezone(tx, v.orgId));
  const values = {
    serviceTypeId: input.serviceTypeId,
    title: input.title,
    weekdays: [...new Set(input.weekdays)].sort(),
    startTimeLocal: input.startTimeLocal.slice(0, 5),
    durationMinutes: input.durationMinutes,
    startsOn: input.startsOn,
    endsOn: input.endsOn ?? null,
    coachUserId: input.coachUserId ?? null,
    resourceId: input.resourceId ?? null,
    locationId: loc?.id ?? null,
    capacity: input.capacity,
    waitlistCapacity: input.waitlistCapacity,
    active: input.active,
    timezone: tz,
  };
  if (input.id) {
    const [before] = await tx.select().from(classSeries).where(and(eq(classSeries.id, input.id), eq(classSeries.orgId, v.orgId)));
    if (!before) throw new UserError("Series not found.");
    await tx.update(classSeries).set(values).where(eq(classSeries.id, input.id));
    await audit(tx, actorOf(v), "series.update", "class_series", input.id, { summary: `Updated series ${input.title} (existing sessions unchanged)`, before, after: values });
    return input.id;
  }
  const [s] = await tx.insert(classSeries).values({ orgId: v.orgId, ...values }).returning();
  await audit(tx, actorOf(v), "series.create", "class_series", s.id, { summary: `Created series ${s.title}`, after: values });
  return s.id;
}

async function assertStaffUser(tx: Tx, orgId: string, userId: string) {
  const [u] = await tx.select({ role: users.role, orgId: users.orgId }).from(users).where(eq(users.id, userId));
  if (!u || u.orgId !== orgId || !STAFF.includes(u.role)) throw new UserError("Choose a staff member.");
}

/** Schedule managers can manage anyone's availability; a coach can manage only their own. */
function assertCanManageCoach(v: Viewer, coachUserId: string) {
  if (can(v, "schedule.manage")) return;
  if (v.role === "coach" && v.userId === coachUserId) return;
  throw new AuthzError("You can only manage your own availability.");
}

export async function addAvailability(tx: Tx, v: Viewer, input: z.infer<typeof availabilitySchema>) {
  assertCanManageCoach(v, input.coachUserId);
  await assertStaffUser(tx, v.orgId, input.coachUserId);
  if (input.endLocal.slice(0, 5) <= input.startLocal.slice(0, 5)) throw new UserError("End time must be after start time.", { endLocal: "After start" });
  if (input.effectiveFrom && input.effectiveTo && input.effectiveTo < input.effectiveFrom) throw new UserError("“Until” is before “From”.", { effectiveTo: "Check dates" });
  const [a] = await tx
    .insert(coachAvailability)
    .values({ orgId: v.orgId, coachUserId: input.coachUserId, weekday: input.weekday, startLocal: input.startLocal.slice(0, 5), endLocal: input.endLocal.slice(0, 5), effectiveFrom: input.effectiveFrom ?? null, effectiveTo: input.effectiveTo ?? null })
    .returning();
  await audit(tx, actorOf(v), "availability.create", "coach_availability", a.id, { summary: `Added availability (weekday ${a.weekday} ${a.startLocal}–${a.endLocal})` });
  return a.id;
}

export async function removeAvailability(tx: Tx, v: Viewer, id: string) {
  const [a] = await tx.select().from(coachAvailability).where(and(eq(coachAvailability.id, id), eq(coachAvailability.orgId, v.orgId)));
  if (!a) throw new UserError("Availability window not found.");
  assertCanManageCoach(v, a.coachUserId);
  await tx.delete(coachAvailability).where(eq(coachAvailability.id, id));
  await audit(tx, actorOf(v), "availability.delete", "coach_availability", id, { summary: "Removed availability window", before: a });
}

export async function addTimeOff(tx: Tx, v: Viewer, input: z.infer<typeof timeOffSchema>) {
  assertCanManageCoach(v, input.coachUserId);
  await assertStaffUser(tx, v.orgId, input.coachUserId);
  const tz = await orgTimezone(tx, v.orgId);
  const startsAt = localToUtc(input.startDate, input.startTime, tz);
  const endsAt = localToUtc(input.endDate, input.endTime, tz);
  if (endsAt <= startsAt) throw new UserError("Time off must end after it starts.", { endTime: "After start" });
  const [b] = await tx.insert(busyBlocks).values({ orgId: v.orgId, coachUserId: input.coachUserId, startsAt, endsAt, source: "time_off", reason: input.reason ?? null }).returning();
  await audit(tx, actorOf(v), "time_off.create", "busy_block", b.id, { summary: `Added time off ${input.startDate} ${input.startTime} → ${input.endDate} ${input.endTime}` });
  return b.id;
}

export async function removeBusyBlock(tx: Tx, v: Viewer, id: string) {
  const [b] = await tx.select().from(busyBlocks).where(and(eq(busyBlocks.id, id), eq(busyBlocks.orgId, v.orgId)));
  if (!b) throw new UserError("Time off not found.");
  assertCanManageCoach(v, b.coachUserId);
  if (b.source === "google_freebusy") throw new UserError("Imported Google busy time is refreshed automatically and can't be removed here.");
  await tx.delete(busyBlocks).where(eq(busyBlocks.id, id));
  await audit(tx, actorOf(v), "time_off.delete", "busy_block", id, { summary: "Removed time off", before: b });
}
