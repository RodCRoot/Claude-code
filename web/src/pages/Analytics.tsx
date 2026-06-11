import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { api } from "../api";

interface Metric { key: string; name: string; unit: string; higherIsBetter: boolean; }
interface Overview {
  athleteCount: number;
  sports: { sport: string; count: number }[];
  records: { total: number; last30Days: number };
  assignments: { assigned: number; inProgress: number; completed: number; completionRate: number; completedLast30Days: number };
}
interface LeaderRow { athleteId: string; name: string; sport: string; position: string | null; value: number; recordedAt: string; }
interface Mover { athleteId: string; name: string; sport: string; from: number; to: number; delta: number; pct: number; samples: number; }
interface ComplianceRow { athleteId: string; name: string; sport: string; total: number; completed: number; inProgress: number; notStarted: number; completionRate: number; lastActivity: string | null; }
interface Integration { key: string; name: string; configured: boolean; credentialEnv: string[]; }

export default function Analytics() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [metricKey, setMetricKey] = useState("");
  const [sport, setSport] = useState("");

  useEffect(() => {
    api.get<Overview>("/analytics/overview").then(setOverview);
    api.get<{ types: Metric[] }>("/metrics/types").then((r) => {
      setMetrics(r.types);
      if (r.types[0]) setMetricKey(r.types[0].key);
    });
  }, []);

  return (
    <div>
      <header className="page-head"><h1>Team Analytics</h1></header>

      {overview && (
        <div className="grid stat-grid">
          <Stat label="Athletes" value={overview.athleteCount} />
          <Stat label="Results logged" value={overview.records.total} sub={`+${overview.records.last30Days} last 30d`} />
          <Stat label="Workout completion" value={`${overview.assignments.completionRate}%`} sub={`${overview.assignments.completed} done · ${overview.assignments.inProgress} active`} />
          <Stat label="Sessions (30d)" value={overview.assignments.completedLast30Days} sub="completed workouts" />
        </div>
      )}

      <section className="card" style={{ marginTop: 16 }}>
        <div className="chart-head">
          <h2>Metric explorer</h2>
          <div className="filters">
            <select value={metricKey} onChange={(e) => setMetricKey(e.target.value)}>
              {metrics.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
            </select>
            <select value={sport} onChange={(e) => setSport(e.target.value)}>
              <option value="">All sports</option>
              {overview?.sports.map((s) => <option key={s.sport} value={s.sport}>{s.sport}</option>)}
            </select>
          </div>
        </div>
        {metricKey && <MetricExplorer metricKey={metricKey} sport={sport} />}
      </section>

      <Compliance />
      <Integrations onSynced={() => api.get<Overview>("/analytics/overview").then(setOverview)} />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="card stat">
      <div className="stat-value">{value}</div>
      <div className="muted small">{label}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}

function MetricExplorer({ metricKey, sport }: { metricKey: string; sport: string }) {
  const [leaders, setLeaders] = useState<LeaderRow[]>([]);
  const [trend, setTrend] = useState<{ month: string; average: number }[]>([]);
  const [improving, setImproving] = useState<Mover[]>([]);
  const [declining, setDeclining] = useState<Mover[]>([]);
  const [unit, setUnit] = useState("");

  useEffect(() => {
    const q = `metricKey=${metricKey}${sport ? `&sport=${encodeURIComponent(sport)}` : ""}`;
    api.get<{ metric: Metric; rows: LeaderRow[] }>(`/analytics/leaderboard?${q}&limit=10`).then((r) => { setLeaders(r.rows); setUnit(r.metric.unit); });
    api.get<{ points: { month: string; average: number }[] }>(`/analytics/trends?${q}`).then((r) => setTrend(r.points));
    api.get<{ improving: Mover[]; declining: Mover[] }>(`/analytics/movers?${q}`).then((r) => { setImproving(r.improving.slice(0, 5)); setDeclining(r.declining.slice(0, 5)); });
  }, [metricKey, sport]);

  return (
    <div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={trend} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="#2a2f3a" strokeDasharray="3 3" />
          <XAxis dataKey="month" stroke="#8a93a6" fontSize={12} />
          <YAxis stroke="#8a93a6" fontSize={12} domain={["auto", "auto"]} />
          <Tooltip contentStyle={{ background: "#161a22", border: "1px solid #2a2f3a", borderRadius: 8 }} />
          <Line type="monotone" dataKey="average" name="Team avg" stroke="#4fd1c5" strokeWidth={2} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>

      <div className="analytics-cols">
        <div>
          <h3 className="section-title">Leaderboard</h3>
          <table className="data-table">
            <thead><tr><th>#</th><th>Athlete</th><th>Best</th></tr></thead>
            <tbody>
              {leaders.map((r, i) => (
                <tr key={r.athleteId}>
                  <td className="muted">{i + 1}</td>
                  <td><Link to={`/athletes/${r.athleteId}`}>{r.name}</Link> <span className="muted small">{r.sport}</span></td>
                  <td className="num">{r.value}<span className="unit"> {unit}</span></td>
                </tr>
              ))}
              {leaders.length === 0 && <tr><td colSpan={3} className="muted">No data yet.</td></tr>}
            </tbody>
          </table>
        </div>

        <div>
          <h3 className="section-title">Biggest movers</h3>
          <table className="data-table">
            <thead><tr><th>Athlete</th><th>Change</th></tr></thead>
            <tbody>
              {improving.map((m) => (
                <tr key={m.athleteId}>
                  <td><Link to={`/athletes/${m.athleteId}`}>{m.name}</Link></td>
                  <td className="num up">▲ {Math.abs(m.delta)} ({m.pct > 0 ? "+" : ""}{m.pct}%)</td>
                </tr>
              ))}
              {declining.map((m) => (
                <tr key={m.athleteId}>
                  <td><Link to={`/athletes/${m.athleteId}`}>{m.name}</Link></td>
                  <td className="num down">▼ {Math.abs(m.delta)} ({m.pct}%)</td>
                </tr>
              ))}
              {improving.length + declining.length === 0 && <tr><td colSpan={2} className="muted">Need ≥2 results to show change.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Compliance() {
  const [rows, setRows] = useState<ComplianceRow[]>([]);
  useEffect(() => { api.get<{ rows: ComplianceRow[] }>("/analytics/compliance").then((r) => setRows(r.rows)); }, []);
  if (rows.length === 0) return null;
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2>Workout compliance</h2>
      <p className="muted small">Lowest completion first — these athletes may need a nudge.</p>
      <table className="data-table">
        <thead><tr><th>Athlete</th><th>Completion</th><th>Done</th><th>Active</th><th>Not started</th><th>Last activity</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.athleteId}>
              <td><Link to={`/athletes/${r.athleteId}`}>{r.name}</Link> <span className="muted small">{r.sport}</span></td>
              <td style={{ minWidth: 120 }}>
                <span className="bar">
                  <span className="bar-fill" style={{ width: `${r.completionRate}%`, background: `hsl(${Math.round((r.completionRate / 100) * 130)} 70% 45%)` }} />
                  <span className="bar-label">{r.completionRate}%</span>
                </span>
              </td>
              <td className="num">{r.completed}</td>
              <td className="num">{r.inProgress}</td>
              <td className="num">{r.notStarted}</td>
              <td className="muted small">{r.lastActivity ? new Date(r.lastActivity).toLocaleDateString() : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Integrations({ onSynced }: { onSynced: () => void }) {
  const [items, setItems] = useState<Integration[]>([]);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  function load() { api.get<{ integrations: Integration[] }>("/integrations").then((r) => setItems(r.integrations)); }
  useEffect(() => { load(); }, []);

  async function sync(key: string, sample: boolean) {
    setBusy(key); setMsg("");
    try {
      const r = await api.post<{ created: number; skipped: number; unmatchedAthlete: number; mode: string }>(`/integrations/${key.toLowerCase()}/sync`, { sample });
      setMsg(`${key}: imported ${r.created}, skipped ${r.skipped} already-synced${r.unmatchedAthlete ? `, ${r.unmatchedAthlete} unmatched` : ""} (${r.mode}).`);
      onSynced();
    } catch (e) {
      setMsg(`${key}: ${(e as Error).message}`);
    } finally { setBusy(""); }
  }

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2>Device integrations</h2>
      <p className="muted small">Pull force-plate & jump data automatically. Add API credentials to enable live sync, or run a sample import to try it.</p>
      <div className="grid">
        {items.map((it) => (
          <div key={it.key} className="card integration">
            <div className="metric-name">{it.name}</div>
            <div className="muted small">
              {it.configured ? <span className="chip">connected</span> : <span className="muted">not configured · set {it.credentialEnv.join(", ")}</span>}
            </div>
            <div className="builder-actions" style={{ marginTop: 10 }}>
              <button disabled={busy === it.key} onClick={() => sync(it.key, false)}>Sync now</button>
              <button className="secondary" disabled={busy === it.key} onClick={() => sync(it.key, true)}>Import sample</button>
            </div>
          </div>
        ))}
      </div>
      {msg && <div className="muted small" style={{ marginTop: 10 }}>{msg}</div>}
    </section>
  );
}
