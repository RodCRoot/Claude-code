import bcrypt from "bcryptjs";
import {
  alerts,
  athletes,
  coachAssignments,
  groupMembers,
  groups,
  guardianships,
  householdMembers,
  households,
  integrations,
  notes,
  payerAccounts,
  payerAuthorizations,
  payerBeneficiaries,
  people,
  skillDefinitions,
  tags,
  personTags,
  tasks,
  users,
  type Role,
} from "../../src/db/schema";
import { DEMO_PASSWORD, type SeedCtx } from "./context";
import { addDaysYmd } from "../../src/lib/time";

type PersonSeed = { key: string; first: string; last: string; dob?: string; email?: string; phone?: string; status?: "active" | "inactive" | "lead" };

/** Birthdate N years before today (approximate, for synthetic ages). */
const yearsAgo = (today: string, years: number, offsetDays = 40) => addDaysYmd(`${Number(today.slice(0, 4)) - years}${today.slice(4)}`, -offsetDays);

export async function seedCore(ctx: SeedCtx) {
  const { tx, orgId, today } = ctx;
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);

  async function person(p: PersonSeed) {
    const [row] = await tx
      .insert(people)
      .values({
        orgId,
        firstName: p.first,
        lastName: p.last,
        dateOfBirth: p.dob ?? null,
        email: p.email ?? null,
        phone: p.phone ?? null,
        status: p.status ?? "active",
        isDemo: true,
      })
      .returning({ id: people.id });
    ctx.people[p.key] = row.id;
    return row.id;
  }

  async function login(key: string, role: Role, email: string, displayName: string, personKey?: string) {
    const [u] = await tx
      .insert(users)
      .values({
        orgId,
        email,
        role,
        displayName,
        personId: personKey ? ctx.people[personKey] : null,
        passwordHash: hash,
        isDemo: true,
      })
      .returning({ id: users.id });
    ctx.users[key] = u.id;
    return u.id;
  }

  async function athlete(key: string, personKey: string, extra: Partial<typeof athletes.$inferInsert> = {}) {
    const [a] = await tx
      .insert(athletes)
      .values({ orgId, personId: ctx.people[personKey], isDemo: true, ...extra })
      .returning({ id: athletes.id });
    ctx.athletes[key] = a.id;
    return a.id;
  }

  // --- Staff (synthetic contact details; .test domain is non-routable) -------------
  await person({ key: "rod", first: "Rod", last: "Owner (Demo)", email: "rod.demo@teamwork-hub.test" });
  await person({ key: "erin", first: "Erin", last: "Operations (Demo)", email: "erin.demo@teamwork-hub.test" });
  await person({ key: "marcus", first: "Marcus", last: "Hale", email: "marcus.demo@teamwork-hub.test" });
  await person({ key: "tess", first: "Tess", last: "Morales", email: "tess.demo@teamwork-hub.test" });
  await login("rod", "owner", "rod.demo@teamwork-hub.test", "Rod (Owner)", "rod");
  await login("erin", "operations", "erin.demo@teamwork-hub.test", "Erin (Operations)", "erin");
  await login("marcus", "coach", "marcus.demo@teamwork-hub.test", "Coach Marcus Hale", "marcus");
  await login("tess", "coach", "tess.demo@teamwork-hub.test", "Coach Tess Morales", "tess");
  await login("kiosk", "kiosk", "kiosk.demo@teamwork-hub.test", "Front Desk Kiosk");

  // --- Household 1: two guardians, two children ----------------------------------
  await person({ key: "alex_parker", first: "Alex", last: "Parker", email: "alex.parker@example.test", phone: "+1 812 555 0101" });
  await person({ key: "jordan_parker", first: "Jordan", last: "Parker", email: "jordan.parker@example.test", phone: "+1 812 555 0102" });
  await person({ key: "maya_parker", first: "Maya", last: "Parker", dob: yearsAgo(today, 15) });
  await person({ key: "eli_parker", first: "Eli", last: "Parker", dob: yearsAgo(today, 12) });
  await athlete("maya", "maya_parker", { sport: "Volleyball", position: "Outside hitter", gradYear: Number(today.slice(0, 4)) + 3, school: "Bloomington North (sample)", level: "Level 2" });
  await athlete("eli", "eli_parker", { sport: "Soccer", gradYear: Number(today.slice(0, 4)) + 6, level: "Level 1" });
  await login("alex", "guardian", "alex.parker@example.test", "Alex Parker", "alex_parker");
  await login("jordan", "guardian", "jordan.parker@example.test", "Jordan Parker", "jordan_parker");
  await login("maya", "athlete", "maya.parker@example.test", "Maya Parker", "maya_parker");

  const [h1] = await tx.insert(households).values({ orgId, name: "Parker Household (Alex & Jordan)", isDemo: true }).returning();
  ctx.households.parker = h1.id;
  await tx.insert(householdMembers).values([
    { householdId: h1.id, personId: ctx.people.alex_parker, role: "guardian", isPrimaryContact: true },
    { householdId: h1.id, personId: ctx.people.jordan_parker, role: "guardian" },
    { householdId: h1.id, personId: ctx.people.maya_parker, role: "child" },
    { householdId: h1.id, personId: ctx.people.eli_parker, role: "child" },
  ]);
  // Alex: full access incl. health. Jordan: independent guardian, training yes, health no.
  await tx.insert(guardianships).values([
    { orgId, guardianPersonId: ctx.people.alex_parker, athleteId: ctx.athletes.maya, relationship: "parent", canViewHealth: true },
    { orgId, guardianPersonId: ctx.people.alex_parker, athleteId: ctx.athletes.eli, relationship: "parent", canViewHealth: true },
    { orgId, guardianPersonId: ctx.people.jordan_parker, athleteId: ctx.athletes.maya, relationship: "parent", canViewHealth: false },
    { orgId, guardianPersonId: ctx.people.jordan_parker, athleteId: ctx.athletes.eli, relationship: "parent", canViewHealth: false },
  ]);
  const [p1] = await tx.insert(payerAccounts).values({ orgId, name: "Alex Parker (card on file)", householdId: h1.id, billingEmail: "alex.parker@example.test", isDemo: true }).returning();
  ctx.payers.parker = p1.id;
  // Alex pays; Jordan can view invoices but cannot pay or manage methods.
  await tx.insert(payerAuthorizations).values([
    { payerAccountId: p1.id, personId: ctx.people.alex_parker, canViewInvoices: true, canPay: true, canManageMethods: true },
    { payerAccountId: p1.id, personId: ctx.people.jordan_parker, canViewInvoices: true, canPay: false, canManageMethods: false },
  ]);
  await tx.insert(payerBeneficiaries).values([
    { payerAccountId: p1.id, athleteId: ctx.athletes.maya },
    { payerAccountId: p1.id, athleteId: ctx.athletes.eli },
  ]);

  // --- Household 2: UNRELATED family sharing the Parker surname (must never merge) --
  await person({ key: "chris_parker", first: "Chris", last: "Parker", email: "chris.parker@example.test", phone: "+1 812 555 0199" });
  await person({ key: "ava_parker", first: "Ava", last: "Parker", dob: yearsAgo(today, 12, 200) });
  await athlete("ava", "ava_parker", { sport: "Basketball", level: "Level 1" });
  await login("chris", "guardian", "chris.parker@example.test", "Chris Parker", "chris_parker");
  const [h2] = await tx.insert(households).values({ orgId, name: "Parker Household (Chris)", isDemo: true }).returning();
  ctx.households.chris_parker = h2.id;
  await tx.insert(householdMembers).values([
    { householdId: h2.id, personId: ctx.people.chris_parker, role: "guardian", isPrimaryContact: true },
    { householdId: h2.id, personId: ctx.people.ava_parker, role: "child" },
  ]);
  await tx.insert(guardianships).values({ orgId, guardianPersonId: ctx.people.chris_parker, athleteId: ctx.athletes.ava, canViewHealth: true });
  const [p2] = await tx.insert(payerAccounts).values({ orgId, name: "Chris Parker", householdId: h2.id, isDemo: true }).returning();
  ctx.payers.chris_parker = p2.id;
  await tx.insert(payerAuthorizations).values({ payerAccountId: p2.id, personId: ctx.people.chris_parker, canManageMethods: true });
  await tx.insert(payerBeneficiaries).values({ payerAccountId: p2.id, athleteId: ctx.athletes.ava });

  // --- Separated co-parents: two households, one child; only Sam pays -------------
  await person({ key: "sam_rivera", first: "Sam", last: "Rivera", email: "sam.rivera@example.test" });
  await person({ key: "casey_nguyen", first: "Casey", last: "Nguyen", email: "casey.nguyen@example.test" });
  await person({ key: "leo_rivera", first: "Leo", last: "Rivera", dob: yearsAgo(today, 16, 90) });
  await athlete("leo", "leo_rivera", { sport: "Football", position: "WR", gradYear: Number(today.slice(0, 4)) + 2, level: "Level 3" });
  await login("sam", "guardian", "sam.rivera@example.test", "Sam Rivera", "sam_rivera");
  await login("casey", "guardian", "casey.nguyen@example.test", "Casey Nguyen", "casey_nguyen");
  const [h3a] = await tx.insert(households).values({ orgId, name: "Rivera Household", isDemo: true }).returning();
  const [h3b] = await tx.insert(households).values({ orgId, name: "Nguyen Household", isDemo: true }).returning();
  ctx.households.rivera = h3a.id;
  ctx.households.nguyen = h3b.id;
  await tx.insert(householdMembers).values([
    { householdId: h3a.id, personId: ctx.people.sam_rivera, role: "guardian", isPrimaryContact: true },
    { householdId: h3a.id, personId: ctx.people.leo_rivera, role: "child" },
    { householdId: h3b.id, personId: ctx.people.casey_nguyen, role: "guardian", isPrimaryContact: true },
    { householdId: h3b.id, personId: ctx.people.leo_rivera, role: "child" },
  ]);
  await tx.insert(guardianships).values([
    { orgId, guardianPersonId: ctx.people.sam_rivera, athleteId: ctx.athletes.leo, canViewHealth: true },
    { orgId, guardianPersonId: ctx.people.casey_nguyen, athleteId: ctx.athletes.leo, canViewHealth: true, canBook: false },
  ]);
  const [p3] = await tx.insert(payerAccounts).values({ orgId, name: "Sam Rivera", householdId: h3a.id, isDemo: true }).returning();
  ctx.payers.rivera = p3.id;
  await tx.insert(payerAuthorizations).values({ payerAccountId: p3.id, personId: ctx.people.sam_rivera, canManageMethods: true });
  await tx.insert(payerBeneficiaries).values({ payerAccountId: p3.id, athleteId: ctx.athletes.leo });

  // --- Adult athlete paying for herself -------------------------------------------
  await person({ key: "dana_brooks", first: "Dana", last: "Brooks", dob: yearsAgo(today, 22), email: "dana.brooks@example.test" });
  await athlete("dana", "dana_brooks", { sport: "Track & Field", position: "Sprints", level: "Adult Performance" });
  await login("dana", "athlete", "dana.brooks@example.test", "Dana Brooks", "dana_brooks");
  const [p4] = await tx.insert(payerAccounts).values({ orgId, name: "Dana Brooks", isDemo: true }).returning();
  ctx.payers.dana = p4.id;
  await tx.insert(payerAuthorizations).values({ payerAccountId: p4.id, personId: ctx.people.dana_brooks, canManageMethods: true });
  await tx.insert(payerBeneficiaries).values({ payerAccountId: p4.id, athleteId: ctx.athletes.dana });

  // --- Inactive athlete -------------------------------------------------------------
  await person({ key: "noah_kim", first: "Noah", last: "Kim", dob: yearsAgo(today, 17), status: "inactive" });
  await athlete("noah", "noah_kim", { sport: "Baseball", active: false, inactiveReason: "Moved away (sample)" });

  // --- Roster filler: additional synthetic athletes with guardians ----------------
  const filler: [string, string, string, number, string][] = [
    ["Ethan", "Cole", "Football", 16, "Level 2"],
    ["Sofia", "Reyes", "Soccer", 14, "Level 2"],
    ["Liam", "Okafor", "Basketball", 15, "Level 2"],
    ["Harper", "Lindqvist", "Volleyball", 13, "Level 1"],
    ["Mason", "Patel", "Baseball", 17, "Level 3"],
    ["Zoe", "Whitaker", "Softball", 16, "Level 2"],
    ["Jackson", "Mbeki", "Track & Field", 15, "Level 2"],
    ["Ella", "Novak", "Swimming", 12, "Level 1"],
    ["Owen", "Fitzgerald", "Hockey", 14, "Level 1"],
    ["Aria", "Castellanos", "Tennis", 13, "Level 1"],
  ];
  for (const [first, last, sport, age, level] of filler) {
    const k = first.toLowerCase();
    await person({ key: `${k}_${last.toLowerCase()}`, first, last, dob: yearsAgo(today, age, 15 * age) });
    await person({ key: `${k}_guardian`, first: `Guardian of ${first}`, last, email: `${k}.guardian@example.test` });
    await athlete(k, `${k}_${last.toLowerCase()}`, { sport, level });
    await tx.insert(guardianships).values({ orgId, guardianPersonId: ctx.people[`${k}_guardian`], athleteId: ctx.athletes[k] });
    const [pa] = await tx.insert(payerAccounts).values({ orgId, name: `${first} ${last} family`, isDemo: true }).returning();
    ctx.payers[k] = pa.id;
    await tx.insert(payerAuthorizations).values({ payerAccountId: pa.id, personId: ctx.people[`${k}_guardian`] });
    await tx.insert(payerBeneficiaries).values({ payerAccountId: pa.id, athleteId: ctx.athletes[k] });
  }

  // --- Groups & coach scope -----------------------------------------------------------
  const [g1] = await tx.insert(groups).values({ orgId, name: "HS Speed & Strength", kind: "training_group", isDemo: true }).returning();
  const [g2] = await tx.insert(groups).values({ orgId, name: "Youth Athletic Development", kind: "training_group", isDemo: true }).returning();
  const [g3] = await tx.insert(groups).values({ orgId, name: "Adult Performance", kind: "training_group", isDemo: true }).returning();
  ctx.groups.hs = g1.id;
  ctx.groups.youth = g2.id;
  ctx.groups.adult = g3.id;
  const hs = ["maya", "leo", "ethan", "sofia", "liam", "mason", "zoe", "jackson"];
  const youth = ["eli", "ava", "harper", "ella", "owen", "aria"];
  await tx.insert(groupMembers).values([
    ...hs.map((k) => ({ groupId: g1.id, athleteId: ctx.athletes[k] })),
    ...youth.map((k) => ({ groupId: g2.id, athleteId: ctx.athletes[k] })),
    { groupId: g3.id, athleteId: ctx.athletes.dana },
  ]);
  // Marcus coaches the HS group + Dana; Tess coaches Youth. Neither coaches the other's athletes.
  await tx.insert(coachAssignments).values([
    { orgId, coachUserId: ctx.users.marcus, groupId: g1.id },
    { orgId, coachUserId: ctx.users.marcus, athleteId: ctx.athletes.dana },
    { orgId, coachUserId: ctx.users.tess, groupId: g2.id },
  ]);

  // --- Tags, skills, notes, alerts, tasks -----------------------------------------
  const [tVip] = await tx.insert(tags).values({ orgId, name: "College recruit", color: "#7c3aed" }).returning();
  const [tNew] = await tx.insert(tags).values({ orgId, name: "New this month", color: "#0891b2" }).returning();
  await tx.insert(personTags).values([
    { personId: ctx.people.leo_rivera, tagId: tVip.id },
    { personId: ctx.people.dana_brooks, tagId: tNew.id },
  ]);
  await tx.insert(skillDefinitions).values(
    ["Level 1", "Level 2", "Level 3", "Adult Performance"].map((name, i) => ({ orgId, name, category: "level", sortOrder: i })),
  );
  await tx.insert(notes).values([
    { orgId, subjectPersonId: ctx.people.maya_parker, authorUserId: ctx.users.marcus, body: "Great intent on approach jumps this week. (sample note)", visibility: "coaches_assigned" },
    { orgId, subjectPersonId: ctx.people.leo_rivera, authorUserId: ctx.users.rod, body: "Custody arrangement on file: both parents may receive training updates. (sample sensitive note)", visibility: "sensitive", category: "family" },
    { orgId, subjectPersonId: ctx.people.dana_brooks, authorUserId: ctx.users.erin, body: "Prefers early-morning sessions.", visibility: "staff" },
  ]);
  await tx.insert(alerts).values({
    orgId,
    personId: ctx.people.eli_parker,
    message: "Please see front desk",
    level: "warning",
    showAtKiosk: true,
    createdBy: ctx.users.erin,
  });
  await tx.insert(tasks).values([
    { orgId, title: "Call Parker family about summer camp", assigneeUserId: ctx.users.erin, relatedPersonId: ctx.people.alex_parker, dueAt: new Date(), isDemo: true },
    { orgId, title: "Review Leo's sprint mechanics video", assigneeUserId: ctx.users.marcus, relatedPersonId: ctx.people.leo_rivera, priority: "high", isDemo: true },
  ]);

  // --- Integration state: honest defaults -------------------------------------------
  for (const provider of ["stripe", "paypal", "venmo", "hawkin", "google_calendar", "email", "sms", "teambuildr", "zenplanner", "gohighlevel", "object_storage"] as const) {
    await tx.insert(integrations).values({
      orgId,
      provider,
      status: provider === "object_storage" ? "connected" : "not_configured",
      mode: provider === "object_storage" ? "test" : "none",
      config: provider === "object_storage" ? { backend: "local_disk" } : {},
    });
  }
}
