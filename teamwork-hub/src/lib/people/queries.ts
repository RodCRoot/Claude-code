import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import {
  alerts,
  athletes,
  coachAssignments,
  groupMembers,
  groups,
  guardianships,
  householdMembers,
  households,
  notes,
  payerAccounts,
  payerAuthorizations,
  people,
  personTags,
  tags,
  tasks,
  users,
} from "@/db/schema";
import {
  accessibleAthleteIds,
  athleteCapabilities,
  canReadNote,
  coachAthleteIds,
  isStaff,
  type Viewer,
  AuthzError,
} from "@/lib/authz/policy";

export type PeopleFilter = {
  q?: string;
  kind?: "all" | "athletes" | "guardians" | "staff" | "leads" | "inactive";
  groupId?: string;
  tagId?: string;
  /** Custom field equality filter (key must be a defined field; caller validates). */
  custom?: { key: string; value: string };
  page?: number;
};

export const PAGE_SIZE = 25;

/**
 * Staff directory search. Coaches only see their assigned athletes (and those
 * athletes' guardians' names, not contact details). Families never use this.
 */
export async function searchPeople(tx: Tx, v: Viewer, f: PeopleFilter) {
  if (!isStaff(v)) throw new AuthzError();
  const scope = await accessibleAthleteIds(tx, v, "profile.read");
  const page = Math.max(1, f.page ?? 1);

  const conds = [eq(people.orgId, v.orgId), isNull(people.archivedAt)];
  if (f.q?.trim()) {
    const like = `%${f.q.trim()}%`;
    conds.push(
      or(
        ilike(people.firstName, like),
        ilike(people.lastName, like),
        ilike(people.email, like),
        ilike(people.phone, like),
        sql`(${people.firstName} || ' ' || ${people.lastName}) ilike ${like}`,
      )!,
    );
  }
  const kind = f.kind ?? "all";
  if (kind === "athletes") conds.push(sql`exists (select 1 from athletes a where a.person_id = ${people.id} and a.active)`);
  if (kind === "inactive") conds.push(sql`(${people.status} = 'inactive' or exists (select 1 from athletes a where a.person_id = ${people.id} and not a.active))`);
  if (kind === "guardians") conds.push(sql`exists (select 1 from guardianships g where g.guardian_person_id = ${people.id} and g.status = 'active')`);
  if (kind === "staff") conds.push(sql`exists (select 1 from users u where u.person_id = ${people.id} and u.role in ('owner','admin','operations','coach'))`);
  if (kind === "leads") conds.push(sql`(${people.status} in ('lead','prospect') or exists (select 1 from leads l where l.person_id = ${people.id} and l.converted_at is null))`);
  if (f.groupId) conds.push(sql`exists (select 1 from athletes a join group_members gm on gm.athlete_id = a.id where a.person_id = ${people.id} and gm.group_id = ${f.groupId})`);
  if (f.tagId) conds.push(sql`exists (select 1 from person_tags pt where pt.person_id = ${people.id} and pt.tag_id = ${f.tagId})`);
  if (f.custom && /^[a-z][a-z0-9_]{0,39}$/.test(f.custom.key)) conds.push(sql`(${people.customFields} ->> ${f.custom.key}) = ${f.custom.value}`);

  if (scope !== "all") {
    // Coaches: their athletes, plus guardians of those athletes.
    if (scope.length === 0) return { rows: [], total: 0, page, pageSize: PAGE_SIZE };
    conds.push(
      or(
        sql`exists (select 1 from athletes a where a.person_id = ${people.id} and a.id in ${scope})`,
        sql`exists (select 1 from guardianships g where g.guardian_person_id = ${people.id} and g.status = 'active' and g.athlete_id in ${scope})`,
      )!,
    );
  }

  const where = and(...conds);
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(people).where(where);
  const rows = await tx
    .select({
      id: people.id,
      firstName: people.firstName,
      lastName: people.lastName,
      email: people.email,
      phone: people.phone,
      status: people.status,
      dob: people.dateOfBirth,
      isDemo: people.isDemo,
      customFields: people.customFields,
      athleteId: athletes.id,
      athleteActive: athletes.active,
      sport: athletes.sport,
      level: athletes.level,
      role: users.role,
      guardianOf: sql<number>`(select count(*)::int from guardianships g where g.guardian_person_id = ${people.id} and g.status = 'active')`,
    })
    .from(people)
    .leftJoin(athletes, eq(athletes.personId, people.id))
    .leftJoin(users, eq(users.personId, people.id))
    .where(where)
    .orderBy(asc(people.lastName), asc(people.firstName))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  // Coaches don't get guardian contact details.
  const redact = v.role === "coach";
  return {
    rows: rows.map((r) => (redact && !r.athleteId ? { ...r, email: null, phone: null } : r)),
    total: n,
    page,
    pageSize: PAGE_SIZE,
  };
}

export type PersonDetail = Awaited<ReturnType<typeof getPersonDetail>>;

/** Everything shown on a person page, filtered by the viewer's capabilities. */
export async function getPersonDetail(tx: Tx, v: Viewer, personId: string) {
  const [person] = await tx.select().from(people).where(and(eq(people.id, personId), eq(people.orgId, v.orgId)));
  if (!person) return null;
  const [athlete] = await tx.select().from(athletes).where(eq(athletes.personId, personId));
  const [login] = await tx.select({ id: users.id, role: users.role, email: users.email, lastLoginAt: users.lastLoginAt, mfaEnabled: users.mfaEnabled, disabledAt: users.disabledAt }).from(users).where(eq(users.personId, personId));

  const caps = athlete ? await athleteCapabilities(tx, v, athlete.id) : new Set();
  // Guardian rows (where this person is the guardian) — visible to staff with people scope.
  const wards = await tx
    .select({ g: guardianships, athlete: athletes, child: people })
    .from(guardianships)
    .innerJoin(athletes, eq(athletes.id, guardianships.athleteId))
    .innerJoin(people, eq(people.id, athletes.personId))
    .where(and(eq(guardianships.guardianPersonId, personId), eq(guardianships.status, "active")));

  // Authorization: staff with profile scope on the athlete, or on any ward (coach sees guardian of their athlete), or self.
  let allowed = false;
  if (v.personId === personId) allowed = true;
  else if (["owner", "admin", "operations"].includes(v.role)) allowed = true;
  else if (v.role === "coach") {
    const scope = await coachAthleteIds(tx, v);
    allowed = (athlete && scope.includes(athlete.id)) || wards.some((w) => scope.includes(w.athlete.id));
  } else if (athlete && caps.has("profile.read")) allowed = true;
  if (!allowed) throw new AuthzError();

  const guardians = athlete
    ? await tx
        .select({ g: guardianships, guardian: people })
        .from(guardianships)
        .innerJoin(people, eq(people.id, guardianships.guardianPersonId))
        .where(and(eq(guardianships.athleteId, athlete.id), eq(guardianships.status, "active")))
        .orderBy(asc(people.lastName))
    : [];

  const hh = await tx
    .select({ household: households, role: householdMembers.role })
    .from(householdMembers)
    .innerJoin(households, eq(households.id, householdMembers.householdId))
    .where(eq(householdMembers.personId, personId));
  const householdIds = hh.map((h) => h.household.id);
  const householdPeople = householdIds.length
    ? await tx
        .select({ householdId: householdMembers.householdId, role: householdMembers.role, person: people })
        .from(householdMembers)
        .innerJoin(people, eq(people.id, householdMembers.personId))
        .where(inArray(householdMembers.householdId, householdIds))
    : [];

  const showBilling = ["owner", "admin", "operations"].includes(v.role) || caps.has("billing.read") || v.personId === personId;
  const payers = showBilling
    ? await tx
        .select({ payer: payerAccounts, auth: payerAuthorizations })
        .from(payerAccounts)
        .leftJoin(payerAuthorizations, and(eq(payerAuthorizations.payerAccountId, payerAccounts.id), eq(payerAuthorizations.personId, personId)))
        .where(
          and(
            eq(payerAccounts.orgId, v.orgId),
            or(
              sql`exists (select 1 from payer_authorizations pa where pa.payer_account_id = ${payerAccounts.id} and pa.person_id = ${personId})`,
              athlete ? sql`exists (select 1 from payer_beneficiaries pb where pb.payer_account_id = ${payerAccounts.id} and pb.athlete_id = ${athlete.id})` : sql`false`,
            ),
          ),
        )
    : [];

  const groupRows = athlete
    ? await tx.select({ id: groups.id, name: groups.name }).from(groupMembers).innerJoin(groups, eq(groups.id, groupMembers.groupId)).where(eq(groupMembers.athleteId, athlete.id))
    : [];
  const coaches = athlete
    ? await tx
        .selectDistinct({ id: users.id, name: users.displayName })
        .from(coachAssignments)
        .innerJoin(users, eq(users.id, coachAssignments.coachUserId))
        .where(
          or(
            eq(coachAssignments.athleteId, athlete.id),
            groupRows.length ? inArray(coachAssignments.groupId, groupRows.map((g) => g.id)) : sql`false`,
          ),
        )
    : [];

  const tagRows = await tx.select({ id: tags.id, name: tags.name, color: tags.color }).from(personTags).innerJoin(tags, eq(tags.id, personTags.tagId)).where(and(eq(personTags.personId, personId), eq(tags.orgId, v.orgId)));

  // Notes: staff only, by visibility.
  let noteRows: (typeof notes.$inferSelect & { authorName: string | null })[] = [];
  if (isStaff(v)) {
    const assigned = v.role === "coach" && athlete ? (await coachAthleteIds(tx, v)).includes(athlete.id) : false;
    const all = await tx
      .select({ n: notes, authorName: users.displayName })
      .from(notes)
      .leftJoin(users, eq(users.id, notes.authorUserId))
      .where(eq(notes.subjectPersonId, personId))
      .orderBy(desc(notes.createdAt));
    noteRows = all.filter((r) => canReadNote(v, r.n.visibility, assigned)).map((r) => ({ ...r.n, authorName: r.authorName }));
  }

  const alertRows = isStaff(v) ? await tx.select().from(alerts).where(and(eq(alerts.personId, personId), eq(alerts.active, true))) : [];
  const taskRows = isStaff(v)
    ? await tx
        .select({ t: tasks, assignee: users.displayName })
        .from(tasks)
        .leftJoin(users, eq(users.id, tasks.assigneeUserId))
        .where(and(eq(tasks.orgId, v.orgId), eq(tasks.relatedPersonId, personId), inArray(tasks.status, ["open", "in_progress"])))
        .orderBy(asc(tasks.dueAt))
    : [];

  const redactContacts = v.role === "coach" && !athlete;
  // Raw custom values may include staff-only fields; families get them via customFieldsForView.
  const safePerson = isStaff(v) ? person : { ...person, customFields: {} };
  return {
    person: redactContacts ? { ...safePerson, email: null, phone: null } : safePerson,
    athlete: athlete ?? null,
    login: ["owner", "admin"].includes(v.role) ? login ?? null : null,
    caps: [...caps] as string[],
    guardians: guardians.map((g) => ({
      ...g.g,
      guardian: v.role === "coach" ? { ...g.guardian, email: null, phone: null } : g.guardian,
    })),
    wards,
    households: hh.map((h) => ({ ...h.household, role: h.role, members: householdPeople.filter((p) => p.householdId === h.household.id) })),
    payers,
    groups: groupRows,
    coaches,
    tags: tagRows,
    notes: noteRows,
    alerts: alertRows,
    tasks: taskRows,
  };
}
