import { eq } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";

export interface AppointmentType {
  key: string;
  label: string;
}

/** Defaults applied when a setting has not been saved yet. All editable in Admin. */
export const SETTING_DEFAULTS = {
  business_name: "Teamwork Bloomington",
  business_location: "Bloomington, Indiana",
  timezone: "America/Indiana/Indianapolis",
  demo_mode: true,
  // minutes within which a new lead should receive first contact
  lead_response_goal_minutes: 60,
  // days without attendance before an athlete is flagged at risk
  at_risk_days_without_attendance: 14,
  // consecutive below-expected weeks before an athlete is flagged at risk
  at_risk_low_weeks: 2,
  monthly_revenue_target: 25000,
  appointment_types: [
    { key: "success_session", label: "Success Session" },
    { key: "strong_start", label: "Strong Start" },
    { key: "assessment", label: "Assessment" },
    { key: "consultation", label: "Consultation" },
    { key: "strategy_session", label: "Strategy Session" },
  ] as AppointmentType[],
  lead_sources: [
    { key: "referral", label: "Referral" },
    { key: "reactivation", label: "Reactivation" },
    { key: "community", label: "Community Relationship" },
    { key: "website", label: "Website" },
    { key: "paid_ads", label: "Paid Ads" },
    { key: "organic_social", label: "Organic Social" },
    { key: "other", label: "Other" },
  ],
  programs: [
    "Youth Foundations (8-11)",
    "Middle School Performance",
    "High School Performance",
    "College/Elite",
    "Adult Training",
    "Private Training",
  ],
  /**
   * How cancellation/drop reasons are classified on the scoreboard.
   * Matching is case-insensitive and substring-based against the Zen Planner
   * drop reason (and sub-reason). Anything unmatched lands in "other".
   *
   * - expected:     churn you cannot coach your way out of (moved away,
   *                 left for college, graduated). Worth tracking, not alarming.
   * - controllable: churn that reflects an experience or follow-up gap —
   *                 e.g. "administrative drop" usually means they stopped
   *                 showing up without ever telling anyone. THIS is the
   *                 number to manage.
   */
  drop_reason_categories: {
    expected: [
      "distance too far",
      "moved",
      "relocat",
      "college",
      "graduat",
      "season ended",
      "military",
      "injur",
    ],
    controllable: [
      "administrative drop",
      "no contact",
      "stopped attending",
      "not attending",
      "dissatisf",
      "too expensive",
      "cost",
      "schedule",
    ],
  },
  /**
   * Zen Planner browser-sync login flow. The selectors default to the common
   * Zen Planner studio login form; adjust here if their markup differs.
   * Credentials are NEVER stored here — only in env vars.
   */
  zen_login_config: {
    // studio.zenplanner.com, NOT app.zenplanner.com. Hitting index.cfm signed
    // out lands on the login form; signed in it goes straight to the studio.
    loginUrl: "https://studio.zenplanner.com/zenplanner/studio/index.cfm",
    userSelector: 'input[name="username"], input[name="email"], input[type="email"]',
    passSelector: 'input[name="password"], input[type="password"]',
    submitSelector:
      'button[type="submit"], input[type="submit"], input[value*="LOGIN" i], button:has-text("Login")',
    successSelector: "",
  },
  /**
   * Reports the scheduled browser sync pulls, one job per report.
   *
   * Ships DISABLED with placeholder URLs, because only you can say which
   * reports matter and the URLs encode your facility's own report setup.
   *
   * To fill one in: open the report in Zen Planner, set its date range and
   * columns, then copy the whole address bar into `url`. Zen Planner report
   * URLs look like
   *   https://studio.zenplanner.com/zenplanner/studio/index.html#/main/iframe/
   *     zenplanner/studio/<area>/index.cfm?...&_c=<comma,separated,columns>
   * where `_c` is the column list — so the columns you pick in Zen Planner are
   * the columns this sync imports.
   *
   * Mode "table" (the default) reads the report grid straight out of the page.
   * Use it unless a report genuinely offers a CSV link, in which case set
   * mode "export" with an `exportSelector`, or mode "csv" with a `csvUrl`.
   *
   * Run each report once through Data → Import first and save the mapping under
   * `mappingName`, so the sync knows which column means what. Then set
   * enabled: true.
   */
  zen_scrape_jobs: [
    {
      name: "ZP Attendance",
      entity: "attendance",
      url: "REPLACE-WITH-ATTENDANCE-REPORT-URL",
      mode: "table",
      mappingName: "ZP Attendance Export",
      enabled: false,
    },
    {
      name: "ZP Members",
      entity: "athletes",
      url: "REPLACE-WITH-MEMBER-REPORT-URL",
      mode: "table",
      mappingName: "ZP Member Export",
      enabled: false,
    },
    {
      name: "ZP Payments",
      entity: "payments",
      url: "REPLACE-WITH-PAYMENT-REPORT-URL",
      mode: "table",
      mappingName: "ZP Payment Export",
      enabled: false,
    },
    {
      name: "ZP Cancellations",
      entity: "cancellations",
      url: "REPLACE-WITH-CANCELLED-MEMBERSHIPS-REPORT-URL",
      mode: "table",
      mappingName: "ZP Cancellations Export",
      enabled: false,
    },
  ],
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

export function getSetting<K extends SettingKey>(key: K): (typeof SETTING_DEFAULTS)[K] {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return SETTING_DEFAULTS[key];
  try {
    return JSON.parse(row.value);
  } catch {
    return SETTING_DEFAULTS[key];
  }
}

export function setSetting(key: string, value: unknown): void {
  const json = JSON.stringify(value);
  db.insert(settings)
    .values({ key, value: json })
    .onConflictDoUpdate({ target: settings.key, set: { value: json } })
    .run();
}

export function isDemoMode(): boolean {
  return getSetting("demo_mode") === true;
}
