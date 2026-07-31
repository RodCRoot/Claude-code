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
