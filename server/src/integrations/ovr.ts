import { DeviceAdapter, ExternalRecord } from "./types";

// OVRtrain integration (jump / RSI testing).
//
// Live sync expects OVR_API_KEY (and optionally OVR_API_URL). Without
// credentials a `sample` sync returns realistic demo data.

const SAMPLE_ATHLETES = ["Casey Brown", "Riley Davis", "Jamie Martinez", "Drew Clark"];

const OVR_METRICS = [
  { key: "vertical_jump", base: 52, spread: 12 }, // cm
  { key: "dj_rsi", base: 1.6, spread: 0.6 },
];

export const ovrAdapter: DeviceAdapter = {
  key: "OVR",
  name: "OVRtrain",
  credentialEnv: ["OVR_API_KEY"],

  configured() {
    return !!process.env.OVR_API_KEY;
  },

  async fetch({ since, sample }) {
    if (sample || !this.configured()) {
      if (!sample) throw new Error("OVR is not configured (set OVR_API_KEY).");
      return sampleRecords();
    }
    return liveFetch(since);
  },
};

function sampleRecords(): ExternalRecord[] {
  const now = Date.now();
  const out: ExternalRecord[] = [];
  SAMPLE_ATHLETES.forEach((name, ai) => {
    OVR_METRICS.forEach((m) => {
      const value = round(m.base + ((ai * 5) % 10) / 10 * m.spread);
      const recordedAt = new Date(now - ai * 36e5).toISOString();
      out.push({
        externalId: `ovr-${m.key}-${name}-${recordedAt.slice(0, 10)}`,
        athleteName: name,
        metricKey: m.key,
        value,
        recordedAt,
        raw: { provider: "ovr", metric: m.key, value },
      });
    });
  });
  return out;
}

async function liveFetch(since?: Date): Promise<ExternalRecord[]> {
  const base = process.env.OVR_API_URL || "https://api.ovrtrain.com/v1";
  const from = since ? `?since=${since.toISOString()}` : "";
  const res = await fetch(`${base}/results${from}`, {
    headers: { "x-api-key": process.env.OVR_API_KEY as string },
  });
  if (!res.ok) throw new Error(`OVR API error ${res.status}`);
  const data: any = await res.json();
  const results: any[] = Array.isArray(data) ? data : data.results || [];

  const out: ExternalRecord[] = [];
  for (const r of results) {
    const athleteName = r.athleteName || `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim();
    const recordedAt = new Date(r.date ?? r.recordedAt ?? Date.now()).toISOString();
    const pushIf = (metricKey: string, value: unknown) => {
      if (athleteName && typeof value === "number") {
        out.push({ externalId: `ovr-${metricKey}-${r.id}`, athleteName, metricKey, value, recordedAt, raw: r });
      }
    };
    pushIf("vertical_jump", r.jumpHeight ?? r.verticalJump);
    pushIf("dj_rsi", r.rsi ?? r.reactiveStrengthIndex);
  }
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;
