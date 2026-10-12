import { and, eq, inArray, isNull, lte, or, gte, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import {
  athletes,
  coachAssignments,
  groupMembers,
  guardianships,
  payerAuthorizations,
  type NoteVisibility,
  type Role,
} from "@/db/schema";

/** The authenticated principal, resolved server-side on every request. */
export type Viewer = {
  userId: string;
  orgId: string;
  role: Role;
  personId: string | null;
  displayName: string;
  mfaVerified: boolean;
};

export class AuthzError extends Error {
  status = 403;
  constructor(message = "You do not have permission to do that.") {
    super(message);
    this.name = "AuthzError";
  }
}

export type Capability =
  | "profile.read"
  | "profile.write"
  | "training.read"
  | "training.write"
  | "training.log"
  | "health.read"
  | "health.write"
  | "health.review"
  | "booking.create"
  | "forms.sign"
  | "messages.send"
  | "notes.read"
  | "guardians.manage"
  | "billing.read";

export const ADMIN_ROLES: Role[] = ["owner", "admin"];
export const STAFF: Role[] = ["owner", "admin", "operations", "coach"];

export const isStaff = (v: Viewer) => STAFF.includes(v.role);
export const isAdmin = (v: Viewer) => ADMIN_ROLES.includes(v.role);

/** Org-wide capabilities that don't depend on a particular athlete. */
export type OrgCapability =
  | "people.manage"
  | "schedule.manage"
  | "schedule.checkin"
  | "billing.manage"
  | "billing.refund"
  | "billing.view_all"
  | "reports.financial"
  | "reports.operational"
  | "crm.manage"
  | "messages.inbox"
  | "forms.manage"
  | "training.manage"
  | "science.manage"
  | "imports.manage"
  | "settings.manage"
  | "integrations.manage"
  | "audit.read";

const ORG_MATRIX: Record<OrgCapability, Role[]> = {
  "people.manage": ["owner", "admin", "operations"],
  "schedule.manage": ["owner", "admin", "operations"],
  "schedule.checkin": ["owner", "admin", "operations", "coach", "kiosk"],
  "billing.manage": ["owner", "admin", "operations"],
  "billing.refund": ["owner", "admin"],
  "billing.view_all": ["owner", "admin", "operations"],
  "reports.financial": ["owner", "admin", "operations"],
  "reports.operational": ["owner", "admin", "operations", "coach"],
  "crm.manage": ["owner", "admin", "operations"],
  "messages.inbox": ["owner", "admin", "operations", "coach"],
  "forms.manage": ["owner", "admin", "operations"],
  "training.manage": ["owner", "admin", "coach"],
  "science.manage": ["owner", "admin", "coach"],
  "imports.manage": ["owner", "admin"],
  "settings.manage": ["owner", "admin"],
  "integrations.manage": ["owner", "admin"],
  "audit.read": ["owner", "admin"],
};

export function can(v: Viewer, cap: OrgCapability): boolean {
  return ORG_MATRIX[cap].includes(v.role);
}

export function assertCan(v: Viewer, cap: OrgCapability): void {
  if (!can(v, cap)) throw new AuthzError();
}

/** Which athlete-level capabilities each staff role has over athletes in scope. */
const STAFF_ATHLETE_CAPS: Record<"owner" | "admin" | "operations" | "coach", Capability[]> = {
  owner: [
    "profile.read", "profile.write", "training.read", "training.write", "training.log", "health.read",
    "health.write", "health.review", "booking.create", "messages.send", "notes.read", "guardians.manage", "billing.read",
  ],
  admin: [
    "profile.read", "profile.write", "training.read", "training.write", "training.log", "health.read",
    "health.write", "health.review", "booking.create", "messages.send", "notes.read", "guardians.manage", "billing.read",
  ],
  // Operations runs the front desk and billing; health details require explicit coach/admin role.
  operations: ["profile.read", "profile.write", "training.read", "booking.create", "messages.send", "notes.read", "guardians.manage", "billing.read"],
  // Coaches: assigned athletes only; no billing.
  coach: ["profile.read", "training.read", "training.write", "training.log", "health.read", "health.write", "health.review", "booking.create", "messages.send", "notes.read"],
};

/**
 * Whether a staff role may use health data at all (e.g. target a broadcast by a missing medical
 * form). Operations has no health access; coaches only for assigned athletes (they cannot build
 * org-wide segments anyway).
 */
export function staffHasHealthAccess(v: Viewer): boolean {
  return isStaff(v) && STAFF_ATHLETE_CAPS[v.role as keyof typeof STAFF_ATHLETE_CAPS].includes("health.read");
}

const today = () => new Date().toISOString().slice(0, 10);

/** Athlete ids a coach is assigned to, directly or through a group, on the current date. */
export async function coachAthleteIds(tx: Tx, v: Viewer): Promise<string[]> {
  const d = today();
  const active = and(
    eq(coachAssignments.coachUserId, v.userId),
    eq(coachAssignments.orgId, v.orgId),
    or(isNull(coachAssignments.startsOn), lte(coachAssignments.startsOn, d)),
    or(isNull(coachAssignments.endsOn), gte(coachAssignments.endsOn, d)),
  );
  const direct = await tx.select({ id: coachAssignments.athleteId }).from(coachAssignments).where(and(active, sql`${coachAssignments.athleteId} is not null`));
  const viaGroup = await tx
    .select({ id: groupMembers.athleteId })
    .from(coachAssignments)
    .innerJoin(groupMembers, eq(groupMembers.groupId, coachAssignments.groupId))
    .where(active);
  return [...new Set([...direct, ...viaGroup].map((r) => r.id!).filter(Boolean))];
}

export type GuardianLink = typeof guardianships.$inferSelect;

export async function guardianLinks(tx: Tx, v: Viewer): Promise<GuardianLink[]> {
  if (!v.personId) return [];
  return tx
    .select()
    .from(guardianships)
    .where(and(eq(guardianships.guardianPersonId, v.personId), eq(guardianships.orgId, v.orgId), eq(guardianships.status, "active")));
}

async function selfAthleteId(tx: Tx, v: Viewer): Promise<string | null> {
  if (!v.personId) return null;
  const [a] = await tx
    .select({ id: athletes.id })
    .from(athletes)
    .where(and(eq(athletes.personId, v.personId), eq(athletes.orgId, v.orgId)));
  return a?.id ?? null;
}

function guardianCaps(g: GuardianLink): Capability[] {
  const caps: Capability[] = ["profile.read"];
  if (g.canViewTraining) caps.push("training.read");
  if (g.canViewHealth) caps.push("health.read");
  if (g.canBook) caps.push("booking.create");
  if (g.canSignForms) caps.push("forms.sign");
  if (g.canMessageStaff) caps.push("messages.send");
  return caps;
}

const ATHLETE_SELF_CAPS: Capability[] = [
  "profile.read", "training.read", "training.log", "health.read", "health.write", "booking.create", "messages.send", "forms.sign",
];

/**
 * The single source of truth for "can this viewer do X to this athlete?".
 * Organization boundaries are always enforced first.
 */
export async function athleteCapabilities(tx: Tx, v: Viewer, athleteId: string): Promise<Set<Capability>> {
  const [a] = await tx.select({ orgId: athletes.orgId }).from(athletes).where(eq(athletes.id, athleteId));
  if (!a || a.orgId !== v.orgId) return new Set();

  switch (v.role) {
    case "owner":
    case "admin":
    case "operations":
      return new Set(STAFF_ATHLETE_CAPS[v.role]);
    case "coach": {
      const ids = await coachAthleteIds(tx, v);
      return ids.includes(athleteId) ? new Set(STAFF_ATHLETE_CAPS.coach) : new Set();
    }
    case "guardian": {
      const links = await guardianLinks(tx, v);
      const link = links.find((l) => l.athleteId === athleteId);
      const caps = new Set(link ? guardianCaps(link) : []);
      // A guardian might also be the payer; that grants billing.read only.
      if (await isPayerFor(tx, v, athleteId)) caps.add("billing.read");
      return caps;
    }
    case "athlete": {
      const self = await selfAthleteId(tx, v);
      const caps = new Set<Capability>(self === athleteId ? ATHLETE_SELF_CAPS : []);
      if (self === athleteId && (await isPayerFor(tx, v, athleteId))) caps.add("billing.read");
      return caps;
    }
    case "kiosk":
    default:
      return new Set();
  }
}

export async function isPayerFor(tx: Tx, v: Viewer, athleteId: string): Promise<boolean> {
  if (!v.personId) return false;
  const rows = await tx.execute(sql`
    select 1 from payer_authorizations pa
    join payer_beneficiaries pb on pb.payer_account_id = pa.payer_account_id
    where pa.person_id = ${v.personId} and pb.athlete_id = ${athleteId} and pa.can_view_invoices
    limit 1`);
  return rows.rows.length > 0;
}

export async function payerAccountIdsFor(tx: Tx, v: Viewer, need: "view" | "pay" = "view"): Promise<string[]> {
  if (!v.personId) return [];
  const rows = await tx
    .select({ id: payerAuthorizations.payerAccountId, canPay: payerAuthorizations.canPay, canView: payerAuthorizations.canViewInvoices })
    .from(payerAuthorizations)
    .where(eq(payerAuthorizations.personId, v.personId));
  return rows.filter((r) => (need === "pay" ? r.canPay : r.canView)).map((r) => r.id);
}

export async function canOnAthlete(tx: Tx, v: Viewer, athleteId: string, cap: Capability): Promise<boolean> {
  return (await athleteCapabilities(tx, v, athleteId)).has(cap);
}

export async function requireOnAthlete(tx: Tx, v: Viewer, athleteId: string, cap: Capability): Promise<void> {
  if (!(await canOnAthlete(tx, v, athleteId, cap))) throw new AuthzError();
}

/**
 * Athlete ids visible to the viewer for a capability. Returns "all" for org-wide
 * staff so callers can skip the filter (still scoped to org).
 */
export async function accessibleAthleteIds(tx: Tx, v: Viewer, cap: Capability): Promise<string[] | "all"> {
  switch (v.role) {
    case "owner":
    case "admin":
    case "operations":
      return STAFF_ATHLETE_CAPS[v.role].includes(cap) ? "all" : [];
    case "coach":
      return STAFF_ATHLETE_CAPS.coach.includes(cap) ? coachAthleteIds(tx, v) : [];
    case "guardian": {
      const links = await guardianLinks(tx, v);
      const ids = links.filter((l) => guardianCaps(l).includes(cap)).map((l) => l.athleteId);
      if (cap === "billing.read" && v.personId) {
        const rows = await tx.execute(sql`
          select pb.athlete_id from payer_authorizations pa
          join payer_beneficiaries pb on pb.payer_account_id = pa.payer_account_id
          where pa.person_id = ${v.personId} and pa.can_view_invoices`);
        ids.push(...rows.rows.map((r) => (r as { athlete_id: string }).athlete_id));
      }
      return [...new Set(ids)];
    }
    case "athlete": {
      const self = await selfAthleteId(tx, v);
      return self && ATHLETE_SELF_CAPS.includes(cap) ? [self] : [];
    }
    default:
      return [];
  }
}

/** Filter helper for queries: returns a SQL condition on an athlete id column. */
export function athleteScopeFilter(ids: string[] | "all", column: Parameters<typeof inArray>[0]) {
  if (ids === "all") return sql`true`;
  if (ids.length === 0) return sql`false`;
  return inArray(column, ids);
}

/** Note visibility rules — sensitive and owner-only notes are never shown to coaches/ops by default. */
export function canReadNote(v: Viewer, visibility: NoteVisibility, isAssignedCoach: boolean): boolean {
  switch (visibility) {
    case "owner_only":
      return v.role === "owner";
    case "sensitive":
      return v.role === "owner" || v.role === "admin";
    case "coaches_assigned":
      return isAdmin(v) || v.role === "operations" || (v.role === "coach" && isAssignedCoach);
    case "staff":
      return isStaff(v);
  }
}
