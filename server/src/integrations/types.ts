// A normalized test result coming from an external provider (Hawkin, OVR, …),
// before it's matched to a roster athlete and stored as a MetricRecord.
export interface ExternalRecord {
  externalId: string; // provider's unique id for this result (used to dedupe)
  athleteName: string; // for matching to a Vantage athlete
  metricKey: string; // maps to a Vantage MetricType.key
  value: number;
  recordedAt: string; // ISO timestamp
  raw: unknown; // original provider payload (stored on the record)
}

export interface DeviceAdapter {
  key: string; // matches MetricRecord.source, e.g. "HAWKIN" | "OVR"
  name: string; // human label
  /** Which env vars hold this provider's credentials (for the status UI). */
  credentialEnv: string[];
  /** True when credentials are present and a live sync is possible. */
  configured(): boolean;
  /**
   * Pull results from the provider. When `sample` is true, returns realistic
   * demo data without calling the live API (so the flow is testable without
   * credentials). When false and not configured, throws.
   */
  fetch(opts: { since?: Date; sample?: boolean }): Promise<ExternalRecord[]>;
}
