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
    loginUrl: "https://studio.zenplanner.com/zenplanner/studio/login.cfm",
    userSelector: 'input[name="username"], input[type="email"]',
    passSelector: 'input[name="password"], input[type="password"]',
    submitSelector: 'button[type="submit"], input[type="submit"]',
    successSelector: "",
  },
  /**
   * Reports the scheduled browser sync pulls. Ships DISABLED with placeholder
   * URLs: open the report in Zen Planner, copy its URL (and, if it has an
   * export/CSV link, that link's selector or direct URL), run the export once
   * through Data → Import to save a mapping under `mappingName`, then set
   * enabled: true. Each job needs either `csvUrl` OR `url` + `exportSelector`.
   */
  zen_scrape_jobs: [
    {
      name: "ZP Attendance",
      entity: "attendance",
      url: "https://studio.zenplanner.com/zenplanner/studio/report/REPLACE-WITH-ATTENDANCE-REPORT-URL",
      exportSelector: 'a:has-text("CSV"), a:has-text("Export")',
      mappingName: "ZP Attendance Export",
      enabled: false,
    },
    {
      name: "ZP Members",
      entity: "athletes",
      url: "https://studio.zenplanner.com/zenplanner/studio/report/REPLACE-WITH-MEMBER-REPORT-URL",
      exportSelector: 'a:has-text("CSV"), a:has-text("Export")',
      mappingName: "ZP Member Export",
      enabled: false,
    },
    {
      name: "ZP Payments",
      entity: "payments",
      url: "https://studio.zenplanner.com/zenplanner/studio/report/REPLACE-WITH-PAYMENT-REPORT-URL",
      exportSelector: 'a:has-text("CSV"), a:has-text("Export")',
      mappingName: "ZP Payment Export",
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
