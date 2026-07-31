/**
 * Seed script: builds the full demo dataset for Teamwork Bloomington.
 *   npm run db:seed
 * Idempotent-ish: refuses to run if demo data already exists (run
 * `npm run db:clear-demo` first to reseed). All sample records carry demo=1
 * so they can be removed cleanly; users, roles, metrics, templates, and
 * settings are treated as real configuration and kept.
 */
import bcrypt from "bcryptjs";
import { addDays, format, getISODay, subDays, subWeeks, startOfWeek } from "date-fns";
import { sql, eq } from "drizzle-orm";
import { db, tables } from "../src/db";
import { METRIC_CATALOG } from "../src/lib/metric-catalog";
import { DEFAULT_ROLE_PERMISSIONS } from "../src/lib/permissions";
import { templateDueOn } from "../src/lib/tasks";
import { ensureConnectorRows } from "../src/lib/connectors";

const {
  roles, users, settings, leads, leadActivities, appointments, athletes,
  memberships, classSessions, attendance, payments, outreach, metrics,
  kpiValues, scorecardTemplates, scorecardMetrics, scorecardEntries,
  scorecardWeeks, reports515, taskTemplates, tasks, onboardingSteps,
  athleteOnboarding, campaigns, marketingItems, contentThemes, syncRuns,
  importMappings, connectors,
} = tables;

// Deterministic RNG so reseeding produces the same believable dataset.
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260731);
const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const chance = (p: number) => rand() < p;
const D = (d: Date) => format(d, "yyyy-MM-dd");
const now = new Date();
const today = D(now);
const iso = (d: Date) => d.toISOString();

const existing = db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM athletes WHERE demo = 1`);
if (existing && existing.n > 0) {
  console.log("Demo data already present — run `npm run db:clear-demo` first to reseed.");
  process.exit(0);
}

console.log("Seeding Teamwork Bloomington demo data…");

/* ------------------------------ Roles & users ------------------------------ */

function upsertRole(name: string, perms: string[]): number {
  const row = db.select().from(roles).where(eq(roles.name, name)).get();
  if (row) return row.id;
  return Number(
    db.insert(roles).values({ name, permissions: JSON.stringify(perms), builtin: 1 }).run()
      .lastInsertRowid
  );
}
const roleIds: Record<string, number> = {};
for (const [name, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
  roleIds[name] = upsertRole(name, perms);
}
roleIds["Client Experience"] = upsertRole("Client Experience", [
  "view_dashboard", "submit_scorecard", "complete_tasks", "edit_records", "manage_marketing",
]);

const DEMO_PASSWORD = "teamwork1";
const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
function upsertUser(name: string, email: string, role: string, title: string): number {
  const row = db.select().from(users).where(eq(users.email, email)).get();
  if (row) return row.id;
  return Number(
    db.insert(users)
      .values({ name, email, passwordHash: hash, roleId: roleIds[role], title, active: 1, createdAt: iso(now) })
      .run().lastInsertRowid
  );
}
const rodId = upsertUser("Rod Root", "rod@teamworkbloomington.com", "Owner/Admin", "Owner");
const erinId = upsertUser("Erin Parks", "erin@teamworkbloomington.com", "Manager", "Co-owner / Admin");
const coachId = upsertUser("Marcus Webb", "coach@teamworkbloomington.com", "Coach", "Performance Coach");
const cxId = upsertUser("Jordan Ellis", "frontdesk@teamworkbloomington.com", "Client Experience", "Client Experience Lead");
upsertUser("Guest Viewer", "viewer@teamworkbloomington.com", "Read-Only", "Read-only access");
const staffIds = [erinId, coachId, cxId];

/* -------------------------------- Settings -------------------------------- */

const put = (key: string, value: unknown) =>
  db.insert(settings)
    .values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value) } })
    .run();
put("demo_mode", true);
put("monthly_revenue_target", 25000);

/* -------------------------------- Metrics --------------------------------- */

METRIC_CATALOG.forEach((m, i) => {
  const row = db.select().from(metrics).where(eq(metrics.key, m.key)).get();
  if (row) return;
  db.insert(metrics).values({
    key: m.key, name: m.name, groupKey: m.groupKey, definition: m.definition,
    formula: m.formula, sourceSystem: m.sourceSystem, sourceFields: m.sourceFields ?? null,
    dataOwner: m.dataOwner, frequency: m.frequency, unit: m.unit, direction: m.direction,
    goal: m.goal, kind: m.kind, autoCompute: m.autoCompute ? 1 : 0,
    sensitive: m.sensitive ? 1 : 0, notes: m.notes ?? null, sortOrder: i,
    updatedAt: iso(now),
  }).run();
});

/* --------------------------- Scorecard templates --------------------------- */

function seedTemplate(roleName: string, rows: [string, string, number, string | null][]) {
  const existingT = db.select().from(scorecardTemplates).all().find((t) => t.roleName === roleName);
  if (existingT) return existingT.id;
  const tid = Number(db.insert(scorecardTemplates).values({ roleName, active: 1 }).run().lastInsertRowid);
  rows.forEach(([name, unit, weeklyGoal, autoKey], i) => {
    db.insert(scorecardMetrics).values({
      templateId: tid, name, unit, weeklyGoal, direction: "up", autoKey, sortOrder: i, active: 1,
    }).run();
  });
  return tid;
}
const coachTemplate = seedTemplate("Coach", [
  ["Session utilization rate", "percent", 70, "session_utilization"],
  ["Client meetings / assessments / strategy sessions", "count", 4, null],
  ["Client reach-outs (phone, text, email)", "count", 25, null],
  ["Messaging response rate", "percent", 50, null],
  ["Handwritten letters or notes", "count", 5, null],
  ["Cleaning checklist completion", "percent", 100, null],
  ["Community communication", "count", 1, null],
  ["Conversion conversations", "count", 1, null],
]);
const cxTemplate = seedTemplate("Client Experience/Admin", [
  ["Leads called or personally contacted", "count", 15, "leads_contacted"],
  ["Consultations / Success Sessions booked", "count", 7, "appts_booked"],
  ["Client recognition items captured & posted", "count", 3, null],
  ["New clients fully onboarded", "count", 6, "new_athletes"],
  ["Handwritten letters or notes", "count", 6, null],
  ["Cleaning checklist completion", "percent", 100, null],
  ["Community communications or posts", "count", 5, null],
  ["Conversion conversations", "count", 5, null],
]);

/* ---------------------------- Onboarding steps ----------------------------- */

const ONBOARDING: [string, number][] = [
  ["Zen Planner profile created", 1],
  ["Membership agreement complete", 1],
  ["Payment method & autopay verified", 2],
  ["Waiver uploaded", 2],
  ["Initial assessment / Strong Start booked", 3],
  ["Athlete profile complete", 5],
  ["Goals & relevant training notes entered", 5],
  ["TeamBuildr account created & program assigned", 5],
  ["Correct messaging campaign assigned", 3],
  ["Recurring training schedule established", 7],
  ["Welcome communication sent", 2],
  ["Thank-you / welcome card completed", 7],
  ["Day-one photo or recognition completed", 7],
  ["First-workout follow-up completed", 10],
];
if (db.select().from(onboardingSteps).all().length === 0) {
  ONBOARDING.forEach(([name, due], i) => {
    db.insert(onboardingSteps).values({ name, dueOffsetDays: due, sortOrder: i + 1, active: 1 }).run();
  });
}
const stepRows = db.select().from(onboardingSteps).all();

/* ----------------------------- Task templates ------------------------------ */

type TT = {
  title: string; category: string; subcategory: string; recurrence: string;
  dayOfWeek?: number; dayOfMonth?: number; assignedRole?: string;
};
const OPS_DAILY = [
  "Review the session schedule",
  "Confirm upcoming consultations, assessments, meetings, and first sessions",
  "Lead tracking and follow-up",
  "New-athlete onboarding",
  "Call or message athletes after their first workout",
  "Prepare welcome materials and recognition items",
  "Contact no-shows and athletes requiring accountability",
  "Complete public social & private-community communication",
  "Reach inbox zero across email and messaging channels",
  "Answer or return phone calls and voicemails",
  "Review declined payments, trial payments, and unresolved appointments",
];
const OPS_WEEKLY: [string, number][] = [
  ["Client memo or communication", 1],
  ["Team memo", 1],
  ["Team meeting", 2],
  ["Update team scoreboard", 5],
  ["Complete scoreboard and 5-15", 5],
  ["Write thank-you and recognition notes", 3],
  ["Review at-risk athletes", 2],
  ["Review canceled and suspended memberships", 4],
  ["Review account balances and overdue accounts", 4],
  ["Review trial / introductory clients", 3],
  ["Implement current marketing calendar", 1],
  ["Schedule newsletters, promotional emails, and weekly wins", 1],
  ["Check welcome-material and retail inventory", 4],
];
const OPS_MONTHLY: [string, number][] = [
  ["Athlete-recognition boards & frequent-attender recognition", 1],
  ["Birthday posts", 1],
  ["Anniversary letters and shirts", 3],
  ["Athlete / client reach-out reports", 5],
  ["Monthly marketing calendar", 25],
  ["Programming review", 15],
  ["Team and client scheduling review", 20],
  ["Spending-plan review", 10],
  ["Outstanding-session report", 12],
  ["Google Business Profile updates", 8],
  ["Testimonials and athlete spotlights", 18],
  ["Inventory review", 22],
];
const CLEAN_DAILY: [string, string][] = [
  ["Opening: lights, displays, audio, tablets, and programming ready", "opening"],
  ["Bathrooms cleaned", "daily"],
  ["Paper products, soap, wipes, towels, and supplies stocked", "daily"],
  ["Dust, cobwebs, corners, and baseboards checked", "daily"],
  ["Training floor and lobby ready", "daily"],
  ["Closing: equipment reset, floors vacuumed, trash emptied, towels restocked, electronics and lights handled", "closing"],
];
const CLEAN_WEEKLY: [string, number][] = [
  ["Mop rubber flooring", 1],
  ["Vacuum turf", 2],
  ["Remove and organize weights", 3],
  ["Wipe shelves", 3],
  ["Clean behind equipment and training pods", 4],
  ["Wash windows", 5],
  ["Clean cubbies", 5],
  ["Dust walls and baseboards", 4],
];
const CLEAN_MONTHLY: [string, number][] = [
  ["Inspect training equipment for damage", 2],
  ["Check bands and balls for leaks, tears, or wear", 2],
  ["Organize utility and storage areas", 9],
  ["Check clocks", 9],
  ["Identify paint touch-ups", 16],
  ["Log equipment or supply items requiring replacement", 16],
];
const MARKETING_TT: TT[] = [
  { title: "Schedule 3 newsletter emails this week", category: "marketing", subcategory: "weekly", recurrence: "weekly", dayOfWeek: 1 },
  { title: "Post weekly content themes (Mon–Fri)", category: "marketing", subcategory: "weekly", recurrence: "weekly", dayOfWeek: 5 },
  { title: "Launch monthly referral campaign", category: "marketing", subcategory: "monthly", recurrence: "monthly", dayOfMonth: 1 },
  { title: "Send 2 engagement emails/texts", category: "marketing", subcategory: "monthly", recurrence: "monthly", dayOfMonth: 15 },
];

if (db.select().from(taskTemplates).all().length === 0) {
  const all: TT[] = [
    ...OPS_DAILY.map((t) => ({ title: t, category: "operations", subcategory: "daily", recurrence: "daily" })),
    ...OPS_WEEKLY.map(([t, d]) => ({ title: t, category: "operations", subcategory: "weekly", recurrence: "weekly", dayOfWeek: d })),
    ...OPS_MONTHLY.map(([t, d]) => ({ title: t, category: "operations", subcategory: "monthly", recurrence: "monthly", dayOfMonth: d })),
    ...CLEAN_DAILY.map(([t, sub]) => ({ title: t, category: "cleaning", subcategory: sub, recurrence: "daily" })),
    ...CLEAN_WEEKLY.map(([t, d]) => ({ title: t, category: "cleaning", subcategory: "weekly", recurrence: "weekly", dayOfWeek: d })),
    ...CLEAN_MONTHLY.map(([t, d]) => ({ title: t, category: "cleaning", subcategory: "monthly", recurrence: "monthly", dayOfMonth: d })),
    ...MARKETING_TT,
  ];
  all.forEach((t, i) => {
    db.insert(taskTemplates).values({
      title: t.title, category: t.category, subcategory: t.subcategory,
      recurrence: t.recurrence, dayOfWeek: t.dayOfWeek ?? null, dayOfMonth: t.dayOfMonth ?? null,
      assignedRole: t.category === "cleaning" ? "Coach" : null,
      sortOrder: i, active: 1,
    }).run();
  });
}

/* ---------------------------- Content themes ------------------------------- */

if (db.select().from(contentThemes).all().length === 0) {
  const THEMES: [number, string][] = [
    [1, "Coach education or mic'd-up coaching"],
    [2, "Testimonial or review"],
    [3, "Athlete win"],
    [4, "Educational or infotainment video"],
    [5, "Weekly highlight reel"],
  ];
  for (const [dow, theme] of THEMES) {
    db.insert(contentThemes).values({ dayOfWeek: dow, theme }).run();
  }
}

/* ------------------------------- Athletes ---------------------------------- */
// Fictional names only — no real client or minor data.

const FIRST = ["Avery", "Blake", "Carter", "Dana", "Emerson", "Finley", "Gray", "Harper", "Indie", "Jules", "Kai", "Lane", "Micah", "Nova", "Oakley", "Peyton", "Quinn", "Reese", "Sage", "Tatum", "Urban", "Vale", "Wren", "Xen", "Yael", "Zion", "Ari", "Brook"];
const LAST = ["Adams", "Baker", "Cole", "Drake", "Ellis", "Frost", "Gaines", "Hayes", "Irwin", "James", "Kerr", "Lowe", "Meyer", "Nolan", "Otis", "Pike", "Reed", "Stone", "Tate", "Voss", "Ward", "York"];
const PROGRAMS = ["Youth Foundations (8-11)", "Middle School Performance", "High School Performance", "College/Elite", "Adult Training"];
const PLANS: [string, number][] = [["2x/week membership", 149], ["3x/week membership", 199], ["Unlimited membership", 249], ["Youth Foundations 2x", 129]];

interface SeedAthlete {
  id: number; startDate: string; status: string; expected: number;
  atRisk?: "contacted" | "uncontacted"; monthlyRate: number; startDay: number;
}
const seededAthletes: SeedAthlete[] = [];
const usedNames = new Set<string>();
function athleteName(): string {
  for (;;) {
    const n = `${pick(FIRST)} ${pick(LAST)}`;
    if (!usedNames.has(n)) {
      usedNames.add(n);
      return n;
    }
  }
}

function addSeedAthlete(opts: {
  startDaysAgo: number; status?: string; expected?: number;
  atRisk?: "contacted" | "uncontacted"; trial?: boolean; canceledDaysAgo?: number;
  holdDaysAgo?: number; reactivated?: boolean; onboardingDone?: number; // fraction
}) {
  const name = athleteName();
  const start = subDays(now, opts.startDaysAgo);
  const program = pick(PROGRAMS);
  const [plan, rate] = pick(PLANS);
  const status = opts.status ?? "active";
  const id = Number(
    db.insert(athletes).values({
      name,
      guardianName: program.includes("Adult") ? null : `${pick(FIRST)} ${name.split(" ")[1]}`,
      birthYear: program.includes("Adult") ? 1988 + Math.floor(rand() * 12) : 2009 + Math.floor(rand() * 8),
      program,
      startDate: D(start),
      status,
      leadSource: pick(["referral", "website", "paid_ads", "organic_social", "community", "other"]),
      expectedSessionsPerWeek: opts.expected ?? (plan.includes("3x") || plan.includes("Unlimited") ? 3 : 2),
      assignedUserId: pick([coachId, cxId]),
      reactivatedAt: opts.reactivated ? iso(subDays(now, 12)) : null,
      demo: 1,
    }).run().lastInsertRowid
  );

  if (opts.reactivated) {
    // prior canceled membership
    db.insert(memberships).values({
      athleteId: id, plan, monthlyRate: rate, status: "canceled",
      startDate: D(subDays(now, 400)), endDate: D(subDays(now, 90)), demo: 1,
    }).run();
  }
  const memStatus = status === "canceled" ? "canceled" : status === "hold" ? "hold" : "active";
  db.insert(memberships).values({
    athleteId: id, plan, monthlyRate: rate, isTrial: opts.trial ? 1 : 0,
    status: memStatus,
    startDate: opts.reactivated ? D(subDays(now, 12)) : D(start),
    endDate: opts.canceledDaysAgo !== undefined ? D(subDays(now, opts.canceledDaysAgo)) : null,
    holdStart: opts.holdDaysAgo !== undefined ? D(subDays(now, opts.holdDaysAgo)) : null,
    demo: 1,
  }).run();

  // Onboarding records for every athlete; fraction done
  const doneFraction = opts.onboardingDone ?? 1;
  stepRows.forEach((s, i) => {
    const done = i / stepRows.length < doneFraction;
    db.insert(athleteOnboarding).values({
      athleteId: id, stepId: s.id, status: done ? "done" : "pending",
      completedAt: done ? iso(addDays(start, Math.min(s.dueOffsetDays, 10))) : null,
      completedByUserId: done ? cxId : null,
      demo: 1,
    }).onConflictDoNothing().run();
  });

  const a: SeedAthlete = {
    id, startDate: D(start), status, expected: opts.expected ?? 2,
    atRisk: opts.atRisk, monthlyRate: rate, startDay: start.getDate(),
  };
  seededAthletes.push(a);
  return a;
}

// 18 established active athletes
for (let i = 0; i < 18; i++) {
  addSeedAthlete({ startDaysAgo: 90 + Math.floor(rand() * 500), expected: chance(0.4) ? 3 : 2 });
}
// 3 at-risk (stopped attending), 1 already contacted
addSeedAthlete({ startDaysAgo: 200, atRisk: "uncontacted" });
addSeedAthlete({ startDaysAgo: 320, atRisk: "uncontacted" });
addSeedAthlete({ startDaysAgo: 150, atRisk: "contacted" });
// 4 recent athletes in onboarding
addSeedAthlete({ startDaysAgo: 4, onboardingDone: 0.35, trial: false });
addSeedAthlete({ startDaysAgo: 9, onboardingDone: 0.6 });
addSeedAthlete({ startDaysAgo: 14, onboardingDone: 0.8 });
addSeedAthlete({ startDaysAgo: 20, onboardingDone: 1 });
// 2 active trials
addSeedAthlete({ startDaysAgo: 6, trial: true, onboardingDone: 0.5 });
addSeedAthlete({ startDaysAgo: 12, trial: true, onboardingDone: 0.7 });
// holds & cancels
addSeedAthlete({ startDaysAgo: 250, status: "hold", holdDaysAgo: 10 });
addSeedAthlete({ startDaysAgo: 300, status: "hold", holdDaysAgo: 25 });
addSeedAthlete({ startDaysAgo: 400, status: "canceled", canceledDaysAgo: 12 });
addSeedAthlete({ startDaysAgo: 380, status: "canceled", canceledDaysAgo: 45 });
addSeedAthlete({ startDaysAgo: 500, status: "canceled", canceledDaysAgo: 80 });
// 1 reactivation this month
addSeedAthlete({ startDaysAgo: 400, reactivated: true });

/* --------------------------- Sessions & attendance -------------------------- */

const sessionsByDate = new Map<string, number[]>();
for (let i = 56; i >= -7; i--) {
  const d = subDays(now, i);
  const dow = getISODay(d);
  const slots =
    dow <= 5
      ? [["16:00", "Youth Performance"], ["17:00", "MS Performance"], ["18:00", "HS Performance"], ["19:00", "Adult / Elite"]]
      : dow === 6
      ? [["09:00", "Saturday Speed"], ["10:00", "Open Training"]]
      : [];
  const ids: number[] = [];
  for (const [time, name] of slots) {
    const id = Number(
      db.insert(classSessions).values({
        date: D(d), time, name, capacity: 8 + Math.floor(rand() * 3), coachUserId: coachId, demo: 1,
      }).run().lastInsertRowid
    );
    ids.push(id);
  }
  sessionsByDate.set(D(d), ids);
}

for (const a of seededAthletes) {
  if (a.status === "canceled" && rand() < 0.3) continue;
  const stopDaysAgo = a.atRisk ? 16 + Math.floor(rand() * 14) : a.status !== "active" ? 20 : 0;
  for (let i = 56; i >= 0; i--) {
    const d = subDays(now, i);
    const ds = D(d);
    if (ds < a.startDate) continue;
    if (i < stopDaysAgo) continue;
    const dow = getISODay(d);
    if (dow === 7) continue;
    // Attend roughly `expected` days/week
    const pAttend = a.expected / 6;
    if (rand() < pAttend) {
      const ids = sessionsByDate.get(ds) ?? [];
      if (ids.length === 0) continue;
      const status = chance(0.045) ? "no_show" : "attended";
      db.insert(attendance).values({
        athleteId: a.id, sessionId: pick(ids), date: ds, status, demo: 1,
      }).run();
    }
  }
}

// Outreach for the contacted at-risk athlete + recent follow-ups
for (const a of seededAthletes) {
  if (a.atRisk === "contacted") {
    db.insert(outreach).values({
      athleteId: a.id, userId: cxId, type: "call", at: iso(subDays(now, 5)),
      note: "Checked in — traveling for two weeks, returning next Monday.", demo: 1,
    }).run();
  }
}
for (const a of seededAthletes.slice(-8)) {
  if (chance(0.6)) {
    db.insert(outreach).values({
      athleteId: a.id, userId: pick(staffIds), type: "first_workout_followup",
      at: iso(subDays(now, Math.floor(rand() * 10))), note: "First-workout follow-up call — going great.", demo: 1,
    }).run();
  }
}

/* --------------------------------- Leads ----------------------------------- */

const SOURCES = ["referral", "referral", "website", "website", "paid_ads", "paid_ads", "organic_social", "community", "reactivation", "other"];
const STAGES_FLOW = ["contacted", "appointment_scheduled", "appointment_completed", "trial", "member", "lost"];

let upcomingApptCount = 0;
for (let i = 0; i < 68; i++) {
  const daysAgo = Math.floor(rand() * 70);
  const created = subDays(now, daysAgo);
  created.setHours(9 + Math.floor(rand() * 9), Math.floor(rand() * 60));
  const source = pick(SOURCES);
  const name = athleteName();
  const isRecentUncontacted = i < 5 && daysAgo === 0;
  const recent = daysAgo <= 1;

  let stage = "new";
  let firstContactedAt: string | null = null;
  if (!isRecentUncontacted) {
    const minutes = chance(0.7) ? 10 + Math.floor(rand() * 55) : 70 + Math.floor(rand() * 600);
    firstContactedAt = iso(new Date(created.getTime() + minutes * 60000));
    stage = recent ? "contacted" : pick(STAGES_FLOW);
  }
  const leadId = Number(
    db.insert(leads).values({
      name,
      contactName: chance(0.7) ? `${pick(FIRST)} ${name.split(" ")[1]}` : null,
      phone: `812-555-0${100 + Math.floor(rand() * 900)}`,
      email: `${name.toLowerCase().replace(" ", ".")}@example.com`,
      source, stage,
      qualified: chance(0.9) ? 1 : 0,
      createdAt: iso(created),
      firstContactedAt,
      assignedUserId: pick([cxId, erinId]),
      demo: 1,
    }).run().lastInsertRowid
  );
  if (firstContactedAt) {
    db.insert(leadActivities).values({
      leadId, userId: cxId, type: pick(["call", "text", "email"]),
      at: firstContactedAt, note: "First contact", demo: 1,
    }).run();
  }
  // Appointments for leads that progressed
  if (["appointment_scheduled", "appointment_completed", "trial", "member"].includes(stage)) {
    const past = stage !== "appointment_scheduled";
    const when = past
      ? addDays(created, 1 + Math.floor(rand() * 4))
      : addDays(now, Math.floor(rand() * 3));
    when.setHours(10 + Math.floor(rand() * 8), 0, 0, 0);
    const status = past ? (chance(0.82) ? "completed" : "no_show") : "scheduled";
    const confirmed = status === "scheduled" ? (upcomingApptCount++ < 2 ? 0 : 1) : 1;
    db.insert(appointments).values({
      leadId,
      typeKey: pick(["success_session", "strong_start", "assessment", "consultation"]),
      scheduledAt: iso(when), status, confirmed,
      assignedUserId: pick([cxId, erinId]),
      createdAt: iso(addDays(created, 1)),
      demo: 1,
    }).run();
  }
}

// A handful of Success Sessions booked THIS week (recent leads moving fast)
const recentLeads = db.all<{ id: number }>(sql`
  SELECT id FROM leads WHERE demo = 1 AND stage = 'contacted'
  ORDER BY created_at DESC LIMIT 5
`);
recentLeads.forEach((l, i) => {
  const when = addDays(now, 1 + (i % 3));
  when.setHours(15 + (i % 4), 0, 0, 0);
  db.insert(appointments).values({
    leadId: l.id,
    typeKey: pick(["success_session", "strong_start", "assessment"]),
    scheduledAt: iso(when), status: "scheduled", confirmed: i < 3 ? 1 : 0,
    assignedUserId: cxId,
    createdAt: iso(subDays(now, i % 3)),
    demo: 1,
  }).run();
  db.update(leads).set({ stage: "appointment_scheduled" }).where(eq(leads.id, l.id)).run();
});

/* -------------------------------- Payments --------------------------------- */

for (const a of seededAthletes) {
  if (a.status === "canceled") continue;
  for (let m = 0; m < 4; m++) {
    const d = new Date(now.getFullYear(), now.getMonth() - m, Math.min(a.startDay, 28));
    if (d > now) continue;
    if (D(d) < a.startDate) continue;
    db.insert(payments).values({
      athleteId: a.id, date: D(d), amount: a.monthlyRate, category: "membership",
      status: "paid", demo: 1,
    }).run();
  }
}
// failures: 3 in last 3 weeks, one recovered
const failCandidates = seededAthletes.filter((a) => a.status === "active").slice(0, 3);
failCandidates.forEach((a, i) => {
  db.insert(payments).values({
    athleteId: a.id, date: D(subDays(now, 4 + i * 6)), amount: a.monthlyRate,
    category: "membership", status: "failed", note: "Card declined on autopay", demo: 1,
  }).run();
});
db.insert(payments).values({
  athleteId: failCandidates[0].id, date: D(subDays(now, 2)), amount: failCandidates[0].monthlyRate,
  category: "membership", status: "recovered", note: "Card updated, payment recovered", demo: 1,
}).run();
// private training / specialty / rental
for (let i = 0; i < 16; i++) {
  db.insert(payments).values({
    athleteId: pick(seededAthletes).id, date: D(subDays(now, Math.floor(rand() * 56))),
    amount: 75, category: "private_training", status: "paid", demo: 1,
  }).run();
}
for (let i = 0; i < 6; i++) {
  db.insert(payments).values({
    athleteId: pick(seededAthletes).id, date: D(subDays(now, Math.floor(rand() * 56))),
    amount: 150, category: "specialty_program", status: "paid", demo: 1,
  }).run();
}
db.insert(payments).values({
  athleteId: null, date: D(subDays(now, 20)), amount: 200, category: "rental",
  status: "paid", note: "Facility rental — travel team", demo: 1,
}).run();

/* --------------------- Scorecards, 5-15s, manual KPIs ----------------------- */

const weekStarts: string[] = [];
for (let i = 6; i >= 1; i--) {
  weekStarts.push(D(startOfWeek(subWeeks(now, i), { weekStartsOn: 1 })));
}
const lastWeek = weekStarts[weekStarts.length - 1];

const coachMetricsRows = db.select().from(scorecardMetrics).all().filter((m) => m.templateId === coachTemplate);
const cxMetricsRows = db.select().from(scorecardMetrics).all().filter((m) => m.templateId === cxTemplate);

function seedScores(userId: number, rows: typeof coachMetricsRows, skipLastWeek: boolean) {
  for (const w of weekStarts) {
    if (skipLastWeek && w === lastWeek) continue;
    for (const m of rows) {
      const jitter = 0.7 + rand() * 0.55;
      const value = m.unit === "percent"
        ? Math.min(100, Math.round(m.weeklyGoal * jitter))
        : Math.max(0, Math.round(m.weeklyGoal * jitter));
      db.insert(scorecardEntries).values({
        scorecardMetricId: m.id, userId, weekStart: w, value,
        createdAt: iso(now), demo: 1,
      }).onConflictDoNothing().run();
    }
    db.insert(scorecardWeeks).values({
      userId, weekStart: w,
      staffNote: chance(0.5) ? pick([
        "Strong week on the floor — two athletes hit PRs.",
        "Phones were busy; focused on follow-ups.",
        "Short-staffed Tuesday, still covered all sessions.",
      ]) : null,
      ownerComment: w < lastWeek && chance(0.4) ? "Nice work — keep pushing reach-outs." : null,
      submittedAt: iso(addDays(new Date(w + "T17:00:00"), 4)),
      demo: 1,
    }).onConflictDoNothing().run();
  }
}
seedScores(cxId, cxMetricsRows, false);
seedScores(coachId, coachMetricsRows, true); // Marcus missing last week → accountability alert
seedScores(erinId, cxMetricsRows, false);

function seed515(userId: number, weeks: string[], opts: { missingLast?: boolean }) {
  for (const w of weeks) {
    if (opts.missingLast && w === lastWeek) continue;
    const isLast = w === lastWeek;
    db.insert(reports515).values({
      userId, weekStart: w, rating: 6 + Math.floor(rand() * 4),
      wins: pick([
        "Two Strong Starts converted to memberships.",
        "Great energy in the HS group; parents commented on it.",
        "Cleared the entire follow-up backlog.",
      ]),
      kpiWins: "Beat weekly reach-out goal.",
      commitmentsCompleted: "Weekly cleaning, at-risk review, thank-you notes.",
      commitmentsMissed: chance(0.4) ? "Didn't finish the testimonial edit." : null,
      challenges: chance(0.5) ? "Tuesday 6pm session is over capacity." : null,
      clientConcerns: chance(0.4) ? "One athlete's attendance is slipping — flagged at-risk." : null,
      facilityConcerns: chance(0.3) ? "Turf seam near rack 3 lifting slightly." : null,
      helpNeeded: chance(0.3) ? "Need approval for new mini-bands order." : null,
      nextPriorities: "At-risk outreach, referral asks at the front desk, spotlight post.",
      managerResponse: isLast ? null : "Reviewed — good week. Prioritize the at-risk list.",
      managerStatus: isLast ? "pending" : "reviewed",
      submittedAt: iso(addDays(new Date(w + "T17:30:00"), 4)),
      demo: 1,
    }).onConflictDoNothing().run();
  }
}
seed515(cxId, weekStarts, {});
seed515(coachId, weekStarts, { missingLast: true });
seed515(erinId, weekStarts.slice(-3), {});

// Manual KPI values (metrics without auto-compute)
const metricId = (key: string) => db.select().from(metrics).where(eq(metrics.key, key)).get()!.id;
function weeklyKpi(key: string, base: number, spread = 0.5) {
  const id = metricId(key);
  for (const w of weekStarts) {
    db.insert(kpiValues).values({
      metricId: id, periodStart: w, periodEnd: D(addDays(new Date(w + "T00:00:00"), 6)),
      value: Math.max(0, Math.round(base * (1 - spread / 2 + rand() * spread))),
      source: "manual", enteredByUserId: erinId, sourceNote: "Weekly tally",
      createdAt: iso(now), demo: 1,
    }).run();
  }
}
weeklyKpi("conversion_conversations", 6);
weeklyKpi("handwritten_notes", 11);
weeklyKpi("recognition_actions", 3);
const monthStart = today.slice(0, 8) + "01";
const prevMonthStart = D(new Date(now.getFullYear(), now.getMonth() - 1, 1));
for (const [key, cur, prev] of [
  ["google_reviews", 3, 4],
  ["testimonials", 2, 1],
  ["athlete_spotlights", 1, 2],
  ["membership_upgrades", 2, 1],
  ["specialty_enrollments", 3, 4],
] as [string, number, number][]) {
  const id = metricId(key);
  db.insert(kpiValues).values({
    metricId: id, periodStart: monthStart, periodEnd: today, value: cur,
    source: "manual", enteredByUserId: rodId, sourceNote: "Monthly tally", createdAt: iso(now), demo: 1,
  }).run();
  db.insert(kpiValues).values({
    metricId: id, periodStart: prevMonthStart, periodEnd: D(subDays(new Date(monthStart + "T00:00:00"), 1)),
    value: prev, source: "manual", enteredByUserId: rodId, sourceNote: "Monthly tally", createdAt: iso(now), demo: 1,
  }).run();
}
db.insert(kpiValues).values({
  metricId: metricId("outstanding_balances"), periodStart: today, periodEnd: today,
  value: 420, source: "manual", enteredByUserId: rodId,
  sourceNote: "Zen Planner balance report", createdAt: iso(now), demo: 1,
}).run();

/* ------------------------------- Marketing --------------------------------- */

db.insert(campaigns).values({
  name: "Fall Strength Kickoff — 6-Week Challenge",
  audience: "Middle & high school athletes",
  startDate: monthStart, endDate: D(addDays(now, 21)),
  goal: "10 new enrollments",
  checklist: JSON.stringify({
    lead_form: "done", email_campaign: "done", text_campaign: "done",
    paid_ads: "done", organic_posts: "planned", website_updates: "done", social_bios: "planned",
  }),
  leadsGenerated: 14, appointmentsBooked: 8, enrollments: 5, revenue: 3200,
  status: "active", demo: 1,
}).run();

const month = today.slice(0, 7);
const MI: [string, string, number | null, number, string][] = [
  // pillar, name, target, actual, status
  ["referrals", "Evergreen referral offer live & visible", 1, 1, "done"],
  ["referrals", "Monthly referral campaign", 1, 1, "done"],
  ["referrals", "Referral asks at front desk", 20, 12, "in_progress"],
  ["referrals", "Referrals received", 5, 3, "in_progress"],
  ["referrals", "Referral appointments", 4, 2, "in_progress"],
  ["referrals", "Referral memberships", 3, 1, "in_progress"],
  ["reactivations", "Birthday reactivation outreach", 8, 8, "done"],
  ["reactivations", "Former-athlete list assigned", 15, 15, "done"],
  ["reactivations", "Former athletes contacted", 15, 9, "in_progress"],
  ["reactivations", "Responses", null, 4, "in_progress"],
  ["reactivations", "Reactivation appointments", 3, 1, "in_progress"],
  ["reactivations", "Reactivated athletes", 2, 1, "in_progress"],
  ["relationships", "Strategic-partner outreach (PT clinic)", 2, 1, "in_progress"],
  ["relationships", "Local-business visits", 3, 3, "done"],
  ["relationships", "Community event booth (Fall Fest)", 1, 0, "planned"],
  ["relationships", "Coffee meetings with coaches", 2, 1, "in_progress"],
  ["internal", "Day-one photos", 4, 4, "done"],
  ["internal", "Frequent-attender recognition", 5, 3, "in_progress"],
  ["internal", "Goals board refresh", 1, 1, "done"],
  ["internal", "Anniversary recognition", 3, 2, "in_progress"],
  ["internal", "Workshop: college recruiting Q&A", 1, 0, "planned"],
  ["social_proof", "Google reviews collected", 4, 2, "in_progress"],
  ["social_proof", "Video testimonial", 1, 1, "done"],
  ["social_proof", "Athlete spotlight", 2, 1, "in_progress"],
  ["social_proof", "Client wins posted", 8, 6, "in_progress"],
  ["digital", "Meta ads running", 1, 1, "done"],
  ["digital", "Google Business Profile posts", 4, 2, "in_progress"],
  ["digital", "Website: fall program page update", 1, 1, "done"],
  ["digital", "SEO: refresh top-3 blog posts", 3, 0, "planned"],
  ["email_321", "Newsletter emails (3/week)", 12, 9, "in_progress"],
  ["email_321", "Engagement emails/texts (2/month)", 2, 1, "in_progress"],
  ["email_321", "Deadline-driven promo sequence", 1, 1, "done"],
];
MI.forEach(([pillar, name, target, actual, status], i) => {
  db.insert(marketingItems).values({
    pillar, name, month, target, actual, status, sortOrder: i, demo: 1,
  }).run();
});

/* ------------------------- Tasks: history & today --------------------------- */

const templatesAll = db.select().from(taskTemplates).all();
for (let i = 21; i >= 0; i--) {
  const d = subDays(now, i);
  const ds = D(d);
  for (const t of templatesAll) {
    if (!templateDueOn(t, d)) continue;
    const isPast = i > 0;
    // older history mostly complete; the current week has a few stragglers
    const done = isPast ? chance(i > 7 ? 0.99 : 0.92) : chance(0.5);
    const late = done && chance(0.08);
    db.insert(tasks).values({
      templateId: t.id, title: t.title, category: t.category, subcategory: t.subcategory,
      dueDate: ds, assignedRole: t.assignedRole, assignedUserId: t.assignedUserId,
      status: done ? "done" : "open",
      completedAt: done ? iso(addDays(d, late ? 1 : 0)) : null,
      completedByUserId: done ? pick(staffIds) : null,
      completedLate: late ? 1 : 0,
      requiresApproval: t.requiresApproval,
      createdAt: iso(now), demo: 1,
    }).onConflictDoNothing().run();
  }
}

/* ----------------------- Connectors & sync history -------------------------- */

ensureConnectorRows();
const connByKey = (k: string) => db.select().from(connectors).where(eq(connectors.key, k)).get()!;
function demoRun(key: string, daysAgo: number, status: string, processed: number, rejected: number, message: string) {
  const c = connByKey(key);
  const t = iso(subDays(now, daysAgo));
  db.insert(syncRuns).values({
    connectorId: c.id, startedAt: t, finishedAt: t, status, trigger: "import",
    recordsProcessed: processed, recordsRejected: rejected, message, demo: 1,
  }).run();
  if (status !== "error") {
    db.update(connectors).set({ lastSyncAt: t, lastSyncStatus: status }).where(eq(connectors.id, c.id)).run();
  }
}
demoRun("csv", 1, "success", 182, 0, "Demo: Zen Planner attendance CSV — 182 rows imported");
demoRun("csv", 7, "partial", 64, 3, "Demo: CRM lead export — 3 rows missing names were rejected");
demoRun("google_sheets", 3, "success", 40, 0, "Demo: legacy tracking sheet import");
demoRun("zen_planner", 2, "error", 0, 0, "Zen Planner is not connected: missing ZEN_PLANNER_API_KEY, ZEN_PLANNER_SUBDOMAIN. Add credentials to .env, or use the CSV import fallback (Data → Import).");

db.insert(importMappings).values({
  name: "ZP Attendance Export", targetEntity: "attendance", connectorKey: "csv",
  mapping: JSON.stringify({ "Athlete": "athlete_name", "Date": "date", "Status": "status" }),
  createdAt: iso(now), demo: 1,
}).run();

console.log("✔ Seed complete.");
console.log("  Demo logins (password for all: %s):", DEMO_PASSWORD);
console.log("   Owner/Admin        rod@teamworkbloomington.com");
console.log("   Manager            erin@teamworkbloomington.com");
console.log("   Coach              coach@teamworkbloomington.com");
console.log("   Client Experience  frontdesk@teamworkbloomington.com");
console.log("   Read-Only          viewer@teamworkbloomington.com");
