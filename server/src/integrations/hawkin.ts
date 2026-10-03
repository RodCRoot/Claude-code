import { DeviceAdapter, ExternalRecord, ProviderAuth } from "./types";

// Hawkin Dynamics force-plate integration (Hawkin Cloud API).
//
// Auth: an org admin creates a REFRESH token in Hawkin Cloud → Settings →
// Integrations. We exchange it for a 1-hour access token at
// {base}/api/token (Authorization: Bearer <refresh>), then pull tests from
// {base}/api/v1?syncFrom=<unix seconds> for incremental sync.
// Docs: https://connect.hawkindynamics.com/api
//
// The refresh token + region live per-org in IntegrationConfig (pasted in the
// app). HAWKIN_API_TOKEN/HAWKIN_API_URL env vars remain as a fallback, and
// HAWKIN_API_URL also lets tests point the adapter at a local mock server.

export const HAWKIN_REGIONS: Record<string, string> = {
  americas: "https://cloud.hawkindynamics.com",
  europe: "https://eu.cloud.hawkindynamics.com",
  apac: "https://apac.cloud.hawkindynamics.com",
};

function baseUrl(auth?: ProviderAuth): string {
  if (process.env.HAWKIN_API_URL) return process.env.HAWKIN_API_URL; // tests/mock
  return HAWKIN_REGIONS[auth?.region || "americas"] || HAWKIN_REGIONS.americas;
}

// Access tokens last 1h; cache per refresh token, renew 5 min early.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function accessToken(refreshToken: string, base: string): Promise<string> {
  const cached = tokenCache.get(refreshToken);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const res = await fetch(`${base}/api/token`, {
    headers: { Authorization: `Bearer ${refreshToken}` },
  });
  if (!res.ok) throw new Error(`Hawkin auth failed (${res.status}) — check the refresh token and region`);
  const data: any = await res.json();
  const token = data.access_token || data.accessToken || data.token;
  if (!token) throw new Error("Hawkin auth response had no access token");
  const ttlMs = (Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600) * 1000;
  tokenCache.set(refreshToken, { token, expiresAt: Date.now() + ttlMs - 5 * 60_000 });
  return token;
}

// ---------------------------------------------------------------------------
// Metric mapping. Hawkin returns metric fields per test type (flat or nested
// under `metrics`, names vary by account/version), so we match normalized key
// names against alias patterns and convert units defensively.
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

interface MetricRule {
  key: string; // our MetricType.key
  match: (nk: string) => boolean;
  convert?: (value: number, nk: string) => number | null;
}

const METRIC_RULES: MetricRule[] = [
  {
    key: "cmj_height",
    match: (nk) => /jumpheight/.test(nk) && !/imp|flight/.test(nk) || nk === "jumpheightm" || /jumpheightimpmom/.test(nk),
    // Hawkin reports meters; our catalog stores cm.
    convert: (v) => (v > 0 && v < 3 ? round(v * 100) : v > 3 && v < 300 ? round(v) : null),
  },
  {
    key: "cmj_rsi_mod",
    match: (nk) => /mrsi|rsimod/.test(nk),
    convert: (v) => (v > 0 && v < 2 ? round(v) : null),
  },
  {
    key: "cmj_peak_power",
    // relative peak power (W/kg) only — absolute W would skew the catalog.
    match: (nk) => /peak.*power/.test(nk.replace(/relative|rel/, "")) === false
      ? false
      : /(relative|rel|wkg|perkg|bm)/.test(nk) && /peak/.test(nk) && /power/.test(nk),
    convert: (v) => (v > 10 && v < 120 ? round(v) : null),
  },
  {
    key: "body_mass",
    match: (nk) => /^bodyweight|^weight|bodymass|^mass|systemweight/.test(nk),
    convert: (v, nk) => {
      if (/lb|pound/.test(nk)) return round(v * 0.45359237);
      if (/newton|(^|[^a-z])n$/.test(nk) || v > 400) return round(v / 9.80665); // N → kg
      return v >= 25 && v <= 250 ? round(v) : null;
    },
  },
];

function extractMetrics(test: any): { key: string; value: number }[] {
  // Collect candidate numeric fields from the test object and any nested
  // `metrics` container (array of {name/field, value} or plain object).
  const candidates: Record<string, number> = {};
  const add = (k: string, v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) candidates[norm(k)] = v;
  };
  for (const [k, v] of Object.entries(test)) add(k, v);
  const m = (test as any).metrics;
  if (Array.isArray(m)) for (const e of m) add(e?.name ?? e?.field ?? e?.id ?? "", e?.value);
  else if (m && typeof m === "object") for (const [k, v] of Object.entries(m)) add(k, v);

  const out: { key: string; value: number }[] = [];
  for (const rule of METRIC_RULES) {
    for (const [nk, v] of Object.entries(candidates)) {
      if (rule.match(nk)) {
        const converted = rule.convert ? rule.convert(v, nk) : v;
        if (converted != null) { out.push({ key: rule.key, value: converted }); break; }
      }
    }
  }
  return out;
}

function athleteNameOf(test: any): string | null {
  return (
    test?.athlete?.name ||
    [test?.athlete?.firstName, test?.athlete?.lastName].filter(Boolean).join(" ") ||
    test?.athlete_name ||
    null
  );
}

export const hawkinAdapter: DeviceAdapter = {
  key: "HAWKIN",
  name: "Hawkin Dynamics",
  credentialEnv: ["HAWKIN_API_TOKEN"],

  configured() {
    return !!process.env.HAWKIN_API_TOKEN;
  },

  async fetch({ since, sample, auth }) {
    const refreshToken = auth?.token || process.env.HAWKIN_API_TOKEN;
    if (sample || !refreshToken) {
      if (!sample) throw new Error("Hawkin is not configured — paste a refresh token from Hawkin Cloud → Settings → Integrations.");
      return sampleRecords();
    }
    const base = baseUrl(auth);
    const access = await accessToken(refreshToken, base);
    const qs = since ? `?syncFrom=${Math.floor(since.getTime() / 1000)}` : "";
    const res = await fetch(`${base}/api/v1${qs}`, { headers: { Authorization: `Bearer ${access}` } });
    if (!res.ok) throw new Error(`Hawkin API error ${res.status}`);
    const data: any = await res.json();
    const tests: any[] = Array.isArray(data) ? data : data.data || [];

    const out: ExternalRecord[] = [];
    for (const t of tests) {
      const athleteName = athleteNameOf(t);
      if (!athleteName) continue;
      const ts = typeof t.timestamp === "number" ? new Date(t.timestamp * 1000) : new Date(t.testDate ?? Date.now());
      const recordedAt = (isNaN(ts.getTime()) ? new Date() : ts).toISOString();
      for (const m of extractMetrics(t)) {
        out.push({
          externalId: `hawkin-${m.key}-${t.id}`,
          athleteName,
          metricKey: m.key,
          value: m.value,
          recordedAt,
          raw: { id: t.id, testType: t.testType?.name ?? t.test_type_name ?? t.segment, metric: m.key },
        });
      }
    }
    return out;
  },
};

const SAMPLE_ATHLETES = ["Jordan Smith", "Taylor Johnson", "Alex Lee", "Morgan Garcia"];

function sampleRecords(): ExternalRecord[] {
  const now = Date.now();
  const out: ExternalRecord[] = [];
  SAMPLE_ATHLETES.forEach((name, ai) => {
    const vals: [string, number][] = [
      ["cmj_height", round(38 + ((ai * 7) % 10))],
      ["cmj_rsi_mod", round(0.42 + ai * 0.05)],
      ["cmj_peak_power", round(48 + ai * 3)],
      ["body_mass", round(68 + ai * 6)],
    ];
    const recordedAt = new Date(now - ai * 36e5).toISOString();
    for (const [metricKey, value] of vals) {
      out.push({
        externalId: `hawkin-${metricKey}-${name}-${recordedAt.slice(0, 10)}`,
        athleteName: name,
        metricKey,
        value,
        recordedAt,
        raw: { provider: "hawkin-sample", metric: metricKey, value },
      });
    }
  });
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;
