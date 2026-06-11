import { DeviceAdapter, ExternalRecord } from "./types";

// Hawkin Dynamics force-plate integration.
//
// Live sync uses the Hawkin Cloud API (https://cloud.hawkindynamics.com/api).
// Set HAWKIN_API_TOKEN (and optionally HAWKIN_API_URL) to enable it. Without
// credentials, callers can still run a `sample` sync to see the flow end-to-end.

const SAMPLE_ATHLETES = ["Jordan Smith", "Taylor Johnson", "Alex Lee", "Morgan Garcia"];

// Maps Hawkin "test type + metric" to our MetricType keys.
const HAWKIN_METRICS = [
  { key: "cmj_height", base: 38, spread: 9 }, // cm
  { key: "cmj_rsi_mod", base: 0.45, spread: 0.18 },
  { key: "cmj_peak_power", base: 52, spread: 10 }, // W/kg
];

export const hawkinAdapter: DeviceAdapter = {
  key: "HAWKIN",
  name: "Hawkin Dynamics",
  credentialEnv: ["HAWKIN_API_TOKEN"],

  configured() {
    return !!process.env.HAWKIN_API_TOKEN;
  },

  async fetch({ since, sample }) {
    if (sample || !this.configured()) {
      if (!sample) throw new Error("Hawkin is not configured (set HAWKIN_API_TOKEN).");
      return sampleRecords();
    }
    return liveFetch(since);
  },
};

function sampleRecords(): ExternalRecord[] {
  const now = Date.now();
  const out: ExternalRecord[] = [];
  SAMPLE_ATHLETES.forEach((name, ai) => {
    HAWKIN_METRICS.forEach((m) => {
      // Deterministic-ish spread per athlete so the demo is stable.
      const value = round(m.base + ((ai * 7) % 10) / 10 * m.spread);
      const recordedAt = new Date(now - ai * 36e5).toISOString();
      out.push({
        externalId: `hawkin-${m.key}-${name}-${recordedAt.slice(0, 10)}`,
        athleteName: name,
        metricKey: m.key,
        value,
        recordedAt,
        raw: { provider: "hawkin", testType: "CMJ", metric: m.key, value },
      });
    });
  });
  return out;
}

// Best-effort live fetch. The exact response shape depends on your Hawkin
// account; adjust the mapping below to your org's metric configuration.
async function liveFetch(since?: Date): Promise<ExternalRecord[]> {
  const base = process.env.HAWKIN_API_URL || "https://cloud.hawkindynamics.com/api/dev";
  const from = since ? `?from=${Math.floor(since.getTime() / 1000)}` : "";
  const res = await fetch(`${base}/tests${from}`, {
    headers: { Authorization: `Bearer ${process.env.HAWKIN_API_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Hawkin API error ${res.status}`);
  const data: any = await res.json();
  const tests: any[] = Array.isArray(data) ? data : data.data || [];

  const out: ExternalRecord[] = [];
  for (const t of tests) {
    const athleteName = [t.athlete?.name, `${t.athlete?.firstName ?? ""} ${t.athlete?.lastName ?? ""}`.trim()].find(Boolean);
    const recordedAt = new Date((t.timestamp ?? t.testDate ?? Date.now()) * (t.timestamp ? 1000 : 1)).toISOString();
    const pushIf = (metricKey: string, value: unknown) => {
      if (athleteName && typeof value === "number") {
        out.push({ externalId: `hawkin-${metricKey}-${t.id}`, athleteName, metricKey, value, recordedAt, raw: t });
      }
    };
    pushIf("cmj_height", t.jumpHeight ?? t.metrics?.jumpHeight);
    pushIf("cmj_rsi_mod", t.rsiModified ?? t.metrics?.rsiModified);
    pushIf("cmj_peak_power", t.peakPowerBm ?? t.metrics?.peakPowerPerKg);
  }
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;
