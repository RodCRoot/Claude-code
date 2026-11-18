import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { athletes, guardianships, organizations, people, users } from "@/db/schema";
import { DEFAULT_TZ, todayLocal } from "@/lib/time";
import { parseQuietHours, type QuietHours } from "./quiet-hours";

export type MessagingSettings = {
  timezone: string;
  quietHours: QuietHours | null;
  /** Org policy: may minor athletes receive / send messages directly? Default false. */
  minorAthletesMayMessage: boolean;
  orgName: string;
};

export async function messagingSettings(tx: Tx, orgId: string): Promise<MessagingSettings> {
  const [o] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
  const s = (o?.settings ?? {}) as Record<string, unknown>;
  const m = (s.messaging ?? {}) as Record<string, unknown>;
  return {
    timezone: o?.timezone ?? DEFAULT_TZ,
    quietHours: parseQuietHours(s.quietHours),
    minorAthletesMayMessage: m.minorAthletesMayMessage === true,
    orgName: o?.branding?.displayName ?? o?.name ?? "Teamwork",
  };
}

/** Whole years between a YYYY-MM-DD birth date and a local date. */
export function ageOn(dob: string, onYmd: string): number {
  const [by, bm, bd] = dob.split("-").map(Number);
  const [y, m, d] = onYmd.split("-").map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age--;
  return age;
}

export type Recipient = {
  personId: string;
  userId: string | null;
  role: "guardian" | "athlete" | "lead_contact" | "staff";
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
};

export type AthleteRouting = {
  athleteId: string;
  athletePersonId: string;
  athleteFirstName: string;
  athleteLastName: string;
  isMinor: boolean;
  recipients: Recipient[];
  /** Guardians who were skipped and why (for previews/audit). */
  excluded: { personId: string; name: string; reason: string }[];
};

/**
 * Who receives a family message about an athlete.
 * - Minor: each ACTIVE guardian whose link allows messaging staff (canMessageStaff), independently.
 *   The minor themselves only if org policy `messaging.minorAthletesMayMessage` is true.
 * - Adult: the athlete themselves.
 * A missing date of birth is treated as a minor when the athlete has guardians (conservative).
 */
export async function routeForAthlete(tx: Tx, orgId: string, athleteId: string, settings?: MessagingSettings): Promise<AthleteRouting | null> {
  const s = settings ?? (await messagingSettings(tx, orgId));
  const [a] = await tx
    .select({ id: athletes.id, personId: athletes.personId, first: people.firstName, last: people.lastName, dob: people.dateOfBirth, email: people.email, phone: people.phone })
    .from(athletes)
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(athletes.id, athleteId), eq(athletes.orgId, orgId)));
  if (!a) return null;

  const links = await tx
    .select({
      personId: guardianships.guardianPersonId,
      status: guardianships.status,
      canMessage: guardianships.canMessageStaff,
      first: people.firstName,
      last: people.lastName,
      email: people.email,
      phone: people.phone,
    })
    .from(guardianships)
    .innerJoin(people, eq(people.id, guardianships.guardianPersonId))
    .where(and(eq(guardianships.athleteId, athleteId), eq(guardianships.orgId, orgId)));
  const activeLinks = links.filter((l) => l.status === "active");

  const today = todayLocal(s.timezone);
  const isMinor = a.dob ? ageOn(a.dob, today) < 18 : activeLinks.length > 0;

  const personIds = [a.personId, ...activeLinks.map((l) => l.personId)];
  const logins = personIds.length
    ? await tx.select({ id: users.id, personId: users.personId }).from(users).where(and(inArray(users.personId, personIds), eq(users.orgId, orgId)))
    : [];
  const loginFor = (pid: string) => logins.find((u) => u.personId === pid)?.id ?? null;

  const recipients: Recipient[] = [];
  const excluded: AthleteRouting["excluded"] = [];
  const self: Recipient = { personId: a.personId, userId: loginFor(a.personId), role: "athlete", firstName: a.first, lastName: a.last, email: a.email, phone: a.phone };

  if (isMinor) {
    for (const l of activeLinks) {
      if (l.canMessage) {
        recipients.push({ personId: l.personId, userId: loginFor(l.personId), role: "guardian", firstName: l.first, lastName: l.last, email: l.email, phone: l.phone });
      } else {
        excluded.push({ personId: l.personId, name: `${l.first} ${l.last}`, reason: "Guardian link does not allow messaging" });
      }
    }
    for (const l of links.filter((x) => x.status !== "active")) {
      excluded.push({ personId: l.personId, name: `${l.first} ${l.last}`, reason: `Guardian link is ${l.status}` });
    }
    if (s.minorAthletesMayMessage) recipients.push(self);
    else excluded.push({ personId: a.personId, name: `${a.first} ${a.last}`, reason: "Minor — org policy routes messages to guardians" });
  } else {
    recipients.push(self);
  }
  return { athleteId: a.id, athletePersonId: a.personId, athleteFirstName: a.first, athleteLastName: a.last, isMinor, recipients, excluded };
}

export async function recipientForPerson(tx: Tx, orgId: string, personId: string, role: Recipient["role"]): Promise<Recipient | null> {
  const [p] = await tx.select().from(people).where(and(eq(people.id, personId), eq(people.orgId, orgId)));
  if (!p) return null;
  const [u] = await tx.select({ id: users.id }).from(users).where(and(eq(users.personId, personId), eq(users.orgId, orgId)));
  return { personId: p.id, userId: u?.id ?? null, role, firstName: p.firstName, lastName: p.lastName, email: p.email, phone: p.phone };
}
