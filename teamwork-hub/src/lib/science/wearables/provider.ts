/**
 * Wearable provider adapter boundary.
 *
 * Teamwork Hub is a web app: it has NO native device access (no Apple HealthKit, no Google
 * Health Connect, no Bluetooth). Data arrives only through (a) CSV export files imported by staff,
 * (b) manual entry, or (c) a future server-to-server vendor API using OAuth on behalf of the athlete.
 * No live connection is implemented; every adapter below reports `not_configured` honestly.
 */

export type NormalizedObservation = {
  athleteRef: { email?: string; externalId?: string };
  provider: string;
  metricKey: string;
  observedOn: string | null;
  observedAt: Date | null;
  value: number | null;
  unit: string;
  quality: "measured" | "missing" | "device_estimate";
  sourceRecordId: string;
};

export interface WearableProvider {
  key: string;
  name: string;
  /** How data could be obtained. "oauth2" providers need a vendor developer account + per-athlete consent. */
  access: "oauth2_api" | "file_export_only" | "file";
  /** Env vars a live connection would require (none are read today). */
  requiredEnv: string[];
  notes: string;
  status(): "not_configured" | "file_import";
  /** Live pull. Not implemented: throws so callers can never fake a sync. */
  fetchObservations(input: { since: Date }): Promise<NormalizedObservation[]>;
}

class NotConnected extends Error {
  constructor(name: string) {
    super(`${name} live sync is not configured. Import a CSV export or enter values manually.`);
    this.name = "NotConnected";
  }
}

function oauthProvider(key: string, name: string, env: string[], notes: string): WearableProvider {
  return {
    key,
    name,
    access: "oauth2_api",
    requiredEnv: env,
    notes,
    status: () => "not_configured",
    fetchObservations: async () => {
      throw new NotConnected(name);
    },
  };
}

export const WEARABLE_PROVIDERS: WearableProvider[] = [
  {
    key: "csv",
    name: "CSV import (any device export)",
    access: "file",
    requiredEnv: [],
    notes: "Staff map columns (date, athlete email or external id, metric, value, unit). Provenance is kept per import batch.",
    status: () => "file_import",
    fetchObservations: async () => {
      throw new Error("CSV data is imported through the import form, not pulled.");
    },
  },
  oauthProvider("whoop", "WHOOP", ["WHOOP_CLIENT_ID", "WHOOP_CLIENT_SECRET"], "WHOOP Developer API (OAuth 2.0, per-member consent): recovery, HRV, resting HR, sleep."),
  oauthProvider("oura", "Oura", ["OURA_CLIENT_ID", "OURA_CLIENT_SECRET"], "Oura API v2 (OAuth 2.0): sleep, readiness, HRV, resting HR."),
  oauthProvider("garmin", "Garmin", ["GARMIN_CONSUMER_KEY", "GARMIN_CONSUMER_SECRET"], "Garmin Health API (partner program approval + OAuth): dailies, sleep, HRV."),
  oauthProvider("polar", "Polar", ["POLAR_CLIENT_ID", "POLAR_CLIENT_SECRET"], "Polar AccessLink API (OAuth 2.0): training sessions, sleep, nightly recharge."),
  oauthProvider("fitbit", "Fitbit", ["FITBIT_CLIENT_ID", "FITBIT_CLIENT_SECRET"], "Fitbit Web API (OAuth 2.0): sleep, resting HR, HRV."),
  {
    key: "apple_health",
    name: "Apple Health",
    access: "file_export_only",
    requiredEnv: [],
    notes: "HealthKit is on-device only; there is no web API. Athletes would need a native app or a manual export → CSV.",
    status: () => "not_configured",
    fetchObservations: async () => {
      throw new NotConnected("Apple Health");
    },
  },
];

/** Canonical metric keys + units used by the dashboard. Imports with other units are rejected unless convertible. */
export const WEARABLE_METRICS: Record<string, { label: string; unit: string; higherIsBetter: boolean | null }> = {
  sleep_hours: { label: "Sleep duration", unit: "h", higherIsBetter: true },
  hrv_rmssd: { label: "HRV (rMSSD)", unit: "ms", higherIsBetter: true },
  resting_hr: { label: "Resting heart rate", unit: "bpm", higherIsBetter: false },
};
