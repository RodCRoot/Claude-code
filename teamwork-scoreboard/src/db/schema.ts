import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

/* ------------------------------------------------------------------ */
/* Auth & configuration                                                */
/* ------------------------------------------------------------------ */

export const roles = sqliteTable("roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  // JSON array of permission keys, e.g. ["view_dashboard","manage_users"]
  permissions: text("permissions").notNull().default("[]"),
  builtin: integer("builtin").notNull().default(0),
});

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  roleId: integer("role_id")
    .notNull()
    .references(() => roles.id),
  title: text("title"),
  active: integer("active").notNull().default(1),
  demo: integer("demo").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

// Free-form key/value application settings (JSON values).
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/* ------------------------------------------------------------------ */
/* CRM: leads, appointments, outreach                                  */
/* ------------------------------------------------------------------ */

export const leads = sqliteTable(
  "leads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    contactName: text("contact_name"), // parent/guardian for youth leads
    phone: text("phone"),
    email: text("email"),
    // referral | reactivation | community | website | paid_ads | organic_social | other
    source: text("source").notNull().default("other"),
    // new | contacted | appointment_scheduled | appointment_completed | trial | member | lost
    stage: text("stage").notNull().default("new"),
    qualified: integer("qualified").notNull().default(1),
    createdAt: text("created_at").notNull(),
    firstContactedAt: text("first_contacted_at"),
    assignedUserId: integer("assigned_user_id").references(() => users.id),
    notes: text("notes"),
    demo: integer("demo").notNull().default(0),
  },
  (t) => [index("leads_stage_idx").on(t.stage), index("leads_created_idx").on(t.createdAt)]
);

export const leadActivities = sqliteTable("lead_activities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  leadId: integer("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id),
  // call | text | email | note
  type: text("type").notNull().default("note"),
  at: text("at").notNull(),
  note: text("note"),
  demo: integer("demo").notNull().default(0),
});

export const appointments = sqliteTable(
  "appointments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    leadId: integer("lead_id").references(() => leads.id),
    athleteId: integer("athlete_id").references(() => athletes.id),
    // key into the configurable appointment types setting (e.g. success_session)
    typeKey: text("type_key").notNull().default("success_session"),
    scheduledAt: text("scheduled_at").notNull(),
    // scheduled | completed | no_show | canceled
    status: text("status").notNull().default("scheduled"),
    confirmed: integer("confirmed").notNull().default(0),
    assignedUserId: integer("assigned_user_id").references(() => users.id),
    outcomeNote: text("outcome_note"),
    createdAt: text("created_at").notNull(),
    demo: integer("demo").notNull().default(0),
  },
  (t) => [index("appts_sched_idx").on(t.scheduledAt)]
);

/* ------------------------------------------------------------------ */
/* Athletes, memberships, attendance, payments                         */
/* ------------------------------------------------------------------ */

export const athletes = sqliteTable(
  "athletes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    guardianName: text("guardian_name"),
    // deliberately only a birth year — avoid storing full DOB for minors
    birthYear: integer("birth_year"),
    program: text("program"),
    startDate: text("start_date").notNull(),
    // active | hold | canceled
    status: text("status").notNull().default("active"),
    leadSource: text("lead_source"),
    expectedSessionsPerWeek: integer("expected_sessions_per_week").notNull().default(2),
    assignedUserId: integer("assigned_user_id").references(() => users.id),
    // manual override: null (auto) | at_risk | ok
    riskOverride: text("risk_override"),
    reactivatedAt: text("reactivated_at"),
    notes: text("notes"),
    demo: integer("demo").notNull().default(0),
  },
  (t) => [index("athletes_status_idx").on(t.status)]
);

export const memberships = sqliteTable("memberships", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  athleteId: integer("athlete_id")
    .notNull()
    .references(() => athletes.id, { onDelete: "cascade" }),
  plan: text("plan").notNull(),
  monthlyRate: real("monthly_rate").notNull().default(0),
  isTrial: integer("is_trial").notNull().default(0),
  // active | hold | canceled | completed
  status: text("status").notNull().default("active"),
  startDate: text("start_date").notNull(),
  endDate: text("end_date"),
  holdStart: text("hold_start"),
  demo: integer("demo").notNull().default(0),
});

export const classSessions = sqliteTable(
  "class_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(), // YYYY-MM-DD
    time: text("time").notNull(), // HH:MM
    name: text("name").notNull(),
    capacity: integer("capacity").notNull().default(8),
    coachUserId: integer("coach_user_id").references(() => users.id),
    demo: integer("demo").notNull().default(0),
  },
  (t) => [index("sessions_date_idx").on(t.date)]
);

export const attendance = sqliteTable(
  "attendance",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    athleteId: integer("athlete_id")
      .notNull()
      .references(() => athletes.id, { onDelete: "cascade" }),
    sessionId: integer("session_id").references(() => classSessions.id),
    date: text("date").notNull(),
    // attended | no_show
    status: text("status").notNull().default("attended"),
    demo: integer("demo").notNull().default(0),
  },
  (t) => [index("attendance_date_idx").on(t.date)]
);

export const payments = sqliteTable(
  "payments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    athleteId: integer("athlete_id").references(() => athletes.id),
    date: text("date").notNull(),
    amount: real("amount").notNull(),
    // membership | private_training | specialty_program | rental | other
    category: text("category").notNull().default("membership"),
    // paid | failed | recovered | refunded
    status: text("status").notNull().default("paid"),
    note: text("note"),
    demo: integer("demo").notNull().default(0),
  },
  (t) => [index("payments_date_idx").on(t.date)]
);

// Outreach log for athletes (retention / at-risk / accountability contacts).
export const outreach = sqliteTable("outreach", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  athleteId: integer("athlete_id")
    .notNull()
    .references(() => athletes.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id),
  // call | text | email | note | first_workout_followup | recognition
  type: text("type").notNull().default("call"),
  at: text("at").notNull(),
  note: text("note"),
  demo: integer("demo").notNull().default(0),
});

/* ------------------------------------------------------------------ */
/* KPI engine: metric dictionary + values                              */
/* ------------------------------------------------------------------ */

export const metrics = sqliteTable("metrics", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  // demand | conversion | delivery | financial
  groupKey: text("group_key").notNull(),
  definition: text("definition"),
  formula: text("formula"),
  sourceSystem: text("source_system"),
  sourceFields: text("source_fields"),
  dataOwner: text("data_owner"),
  // weekly | monthly
  frequency: text("frequency").notNull().default("weekly"),
  // count | percent | currency | minutes | days
  unit: text("unit").notNull().default("count"),
  // up = higher is better, down = lower is better
  direction: text("direction").notNull().default("up"),
  goal: real("goal"),
  // status thresholds expressed as % of goal attainment
  redBelowPct: real("red_below_pct").notNull().default(70),
  yellowBelowPct: real("yellow_below_pct").notNull().default(90),
  // stock = point-in-time value, flow = accumulates over the period
  kind: text("kind").notNull().default("flow"),
  // when true the app computes this from operational tables; otherwise manual
  autoCompute: integer("auto_compute").notNull().default(0),
  sensitive: integer("sensitive").notNull().default(0), // requires view_financials
  notes: text("notes"),
  active: integer("active").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

export const kpiValues = sqliteTable(
  "kpi_values",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    metricId: integer("metric_id")
      .notNull()
      .references(() => metrics.id, { onDelete: "cascade" }),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    value: real("value").notNull(),
    // manual | import | auto
    source: text("source").notNull().default("manual"),
    enteredByUserId: integer("entered_by_user_id").references(() => users.id),
    sourceNote: text("source_note"),
    overrideReason: text("override_reason"),
    createdAt: text("created_at").notNull(),
    demo: integer("demo").notNull().default(0),
  },
  (t) => [index("kpi_values_metric_idx").on(t.metricId, t.periodStart)]
);

/* ------------------------------------------------------------------ */
/* Team scorecards                                                     */
/* ------------------------------------------------------------------ */

export const scorecardTemplates = sqliteTable("scorecard_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  roleName: text("role_name").notNull(),
  active: integer("active").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const scorecardMetrics = sqliteTable("scorecard_metrics", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  templateId: integer("template_id")
    .notNull()
    .references(() => scorecardTemplates.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // count | percent
  unit: text("unit").notNull().default("count"),
  weeklyGoal: real("weekly_goal").notNull().default(0),
  direction: text("direction").notNull().default("up"),
  // optional link to a metric-dictionary key for automatic calculation
  autoKey: text("auto_key"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: integer("active").notNull().default(1),
});

export const scorecardEntries = sqliteTable(
  "scorecard_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scorecardMetricId: integer("scorecard_metric_id")
      .notNull()
      .references(() => scorecardMetrics.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    weekStart: text("week_start").notNull(), // Monday, YYYY-MM-DD
    value: real("value").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull(),
    demo: integer("demo").notNull().default(0),
  },
  (t) => [
    uniqueIndex("scorecard_entry_unique").on(t.scorecardMetricId, t.userId, t.weekStart),
  ]
);

// One row per staff member per week: notes, owner comments, submitted state.
export const scorecardWeeks = sqliteTable(
  "scorecard_weeks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    weekStart: text("week_start").notNull(),
    staffNote: text("staff_note"),
    ownerComment: text("owner_comment"),
    submittedAt: text("submitted_at"),
    demo: integer("demo").notNull().default(0),
  },
  (t) => [uniqueIndex("scorecard_week_unique").on(t.userId, t.weekStart)]
);

/* ------------------------------------------------------------------ */
/* 5-15 reports                                                        */
/* ------------------------------------------------------------------ */

export const reports515 = sqliteTable(
  "reports_515",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    weekStart: text("week_start").notNull(),
    rating: integer("rating"), // 1-10 overall week rating
    wins: text("wins"),
    kpiWins: text("kpi_wins"),
    commitmentsCompleted: text("commitments_completed"),
    commitmentsMissed: text("commitments_missed"),
    challenges: text("challenges"),
    clientConcerns: text("client_concerns"),
    facilityConcerns: text("facility_concerns"),
    helpNeeded: text("help_needed"),
    nextPriorities: text("next_priorities"),
    managerResponse: text("manager_response"),
    // pending | reviewed
    managerStatus: text("manager_status").notNull().default("pending"),
    followUpActions: text("follow_up_actions"),
    submittedAt: text("submitted_at"),
    demo: integer("demo").notNull().default(0),
  },
  (t) => [uniqueIndex("report_515_unique").on(t.userId, t.weekStart)]
);

export const reportComments = sqliteTable("report_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reportId: integer("report_id")
    .notNull()
    .references(() => reports515.id, { onDelete: "cascade" }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
  demo: integer("demo").notNull().default(0),
});

/* ------------------------------------------------------------------ */
/* Recurring tasks (operations, cleaning, marketing)                   */
/* ------------------------------------------------------------------ */

export const taskTemplates = sqliteTable("task_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description"),
  // operations | cleaning | marketing
  category: text("category").notNull().default("operations"),
  // free-form grouping: opening, closing, daily, weekly, monthly ...
  subcategory: text("subcategory"),
  // daily | weekly | monthly | quarterly | once
  recurrence: text("recurrence").notNull().default("daily"),
  dayOfWeek: integer("day_of_week"), // 1=Mon .. 7=Sun (for weekly)
  dayOfMonth: integer("day_of_month"), // 1-28 (for monthly/quarterly)
  assignedRole: text("assigned_role"),
  assignedUserId: integer("assigned_user_id").references(() => users.id),
  requiresApproval: integer("requires_approval").notNull().default(0),
  requiresProof: integer("requires_proof").notNull().default(0),
  active: integer("active").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
  demo: integer("demo").notNull().default(0),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    templateId: integer("template_id").references(() => taskTemplates.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    category: text("category").notNull().default("operations"),
    subcategory: text("subcategory"),
    dueDate: text("due_date").notNull(), // YYYY-MM-DD
    assignedRole: text("assigned_role"),
    assignedUserId: integer("assigned_user_id").references(() => users.id),
    // open | done
    status: text("status").notNull().default("open"),
    completedAt: text("completed_at"),
    completedByUserId: integer("completed_by_user_id").references(() => users.id),
    completedLate: integer("completed_late").notNull().default(0),
    proofNote: text("proof_note"),
    proofUrl: text("proof_url"),
    requiresApproval: integer("requires_approval").notNull().default(0),
    approvedByUserId: integer("approved_by_user_id").references(() => users.id),
    createdAt: text("created_at").notNull(),
    demo: integer("demo").notNull().default(0),
  },
  (t) => [
    uniqueIndex("task_template_due_unique").on(t.templateId, t.dueDate),
    index("tasks_due_idx").on(t.dueDate),
  ]
);

/* ------------------------------------------------------------------ */
/* Onboarding                                                          */
/* ------------------------------------------------------------------ */

export const onboardingSteps = sqliteTable("onboarding_steps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  dueOffsetDays: integer("due_offset_days").notNull().default(7),
  sortOrder: integer("sort_order").notNull().default(0),
  active: integer("active").notNull().default(1),
});

export const athleteOnboarding = sqliteTable(
  "athlete_onboarding",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    athleteId: integer("athlete_id")
      .notNull()
      .references(() => athletes.id, { onDelete: "cascade" }),
    stepId: integer("step_id")
      .notNull()
      .references(() => onboardingSteps.id, { onDelete: "cascade" }),
    // pending | done | na
    status: text("status").notNull().default("pending"),
    completedAt: text("completed_at"),
    completedByUserId: integer("completed_by_user_id").references(() => users.id),
    note: text("note"),
    demo: integer("demo").notNull().default(0),
  },
  (t) => [uniqueIndex("athlete_onboarding_unique").on(t.athleteId, t.stepId)]
);

/* ------------------------------------------------------------------ */
/* Marketing                                                           */
/* ------------------------------------------------------------------ */

export const campaigns = sqliteTable("campaigns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  audience: text("audience"),
  startDate: text("start_date"),
  endDate: text("end_date"),
  goal: text("goal"),
  // JSON object: { lead_form: "done", email_campaign: "in_progress", ... }
  checklist: text("checklist").notNull().default("{}"),
  leadsGenerated: integer("leads_generated").notNull().default(0),
  appointmentsBooked: integer("appointments_booked").notNull().default(0),
  enrollments: integer("enrollments").notNull().default(0),
  revenue: real("revenue").notNull().default(0),
  // planned | active | complete
  status: text("status").notNull().default("planned"),
  notes: text("notes"),
  demo: integer("demo").notNull().default(0),
});

export const marketingItems = sqliteTable("marketing_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // referrals | reactivations | relationships | internal | social_proof | digital | email_321
  pillar: text("pillar").notNull(),
  name: text("name").notNull(),
  month: text("month").notNull(), // YYYY-MM
  target: real("target"),
  actual: real("actual").notNull().default(0),
  unit: text("unit").notNull().default("count"),
  // planned | in_progress | done | skipped
  status: text("status").notNull().default("planned"),
  notes: text("notes"),
  sortOrder: integer("sort_order").notNull().default(0),
  demo: integer("demo").notNull().default(0),
});

export const contentThemes = sqliteTable("content_themes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dayOfWeek: integer("day_of_week").notNull(), // 1=Mon .. 7=Sun
  theme: text("theme").notNull(),
});

/* ------------------------------------------------------------------ */
/* Integrations: connectors, sync runs, import mappings                */
/* ------------------------------------------------------------------ */

export const connectors = sqliteTable("connectors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(), // zen_planner | crm | teambuildr | google_sheets | csv
  name: text("name").notNull(),
  description: text("description"),
  // api | webhook | sheets | csv | manual
  mode: text("mode").notNull().default("csv"),
  // not_configured | ready | error | disabled
  status: text("status").notNull().default("not_configured"),
  // JSON array of env var names this connector needs (names only, never values)
  envVars: text("env_vars").notNull().default("[]"),
  configNote: text("config_note"),
  lastSyncAt: text("last_sync_at"),
  lastSyncStatus: text("last_sync_status"),
  // minutes between scheduled syncs (informational until API creds exist)
  syncIntervalMinutes: integer("sync_interval_minutes").notNull().default(1440),
});

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    connectorId: integer("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    // success | partial | error
    status: text("status").notNull().default("success"),
    // manual | scheduled | webhook | import
    trigger: text("trigger").notNull().default("manual"),
    recordsProcessed: integer("records_processed").notNull().default(0),
    recordsRejected: integer("records_rejected").notNull().default(0),
    message: text("message"),
    demo: integer("demo").notNull().default(0),
  },
  (t) => [index("sync_runs_connector_idx").on(t.connectorId, t.startedAt)]
);

export const importMappings = sqliteTable("import_mappings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  // leads | athletes | attendance | payments | kpi_values
  targetEntity: text("target_entity").notNull(),
  connectorKey: text("connector_key"),
  // JSON object: { csvColumnName: canonicalFieldName, ... }
  mapping: text("mapping").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  demo: integer("demo").notNull().default(0),
});
