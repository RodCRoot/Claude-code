import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { api } from "../api";
import { useAuth } from "../auth";

interface Checkin {
  date: string; readiness: number | null; sleepHours: number | null; sleepQuality: number | null;
  soreness: number | null; mood: number | null; energy: number | null; stress: number | null; notes: string | null;
}

export default function Wellness() {
  const { user } = useAuth();
  const isCoach = user?.role === "COACH" || user?.role === "ADMIN";
  return isCoach ? <CoachReadiness /> : <AthleteCheckin />;
}

function readinessColor(r: number | null) {
  if (r == null) return "var(--muted)";
  const hue = Math.round((r / 100) * 130);
  return `hsl(${hue} 70% 45%)`;
}

function AthleteCheckin() {
  const [checkins, setCheckins] = useState<Checkin[]>([]);
  const [submittedToday, setSubmittedToday] = useState(false);
  const [form, setForm] = useState({ sleepHours: 8, sleepQuality: 3, soreness: 3, mood: 3, energy: 3, stress: 3, notes: "" });
  const [msg, setMsg] = useState("");

  function load() {
    api.get<{ checkins: Checkin[]; submittedToday: boolean }>("/wellness/me").then((r) => { setCheckins(r.checkins); setSubmittedToday(r.submittedToday); });
  }
  useEffect(() => { load(); }, []);

  async function submit() {
    setMsg("");
    await api.post("/wellness", { ...form, notes: form.notes || undefined });
    setMsg("Check-in saved ✓");
    load();
  }

  const trend = checkins.filter((c) => c.readiness != null).map((c) => ({ date: new Date(c.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }), readiness: c.readiness }));
  const latest = checkins[checkins.length - 1];

  return (
    <div>
      <header className="page-head"><h1>Daily Check-in</h1></header>

      <div className="card" style={{ marginBottom: 14 }}>
        {submittedToday && <div className="muted small" style={{ marginBottom: 8 }}>You've checked in today — updating will overwrite it. Latest readiness: <strong style={{ color: readinessColor(latest?.readiness ?? null) }}>{latest?.readiness ?? "–"}</strong></div>}
        <div className="wellness-form">
          <label className="label">Sleep (hours)
            <input type="number" step="0.5" value={form.sleepHours} onChange={(e) => setForm({ ...form, sleepHours: Number(e.target.value) })} />
          </label>
          {([["sleepQuality", "Sleep quality"], ["soreness", "Soreness"], ["mood", "Mood"], ["energy", "Energy"], ["stress", "Stress"]] as const).map(([k, label]) => (
            <label key={k} className="label">{label} <span className="muted small">{k === "soreness" || k === "stress" ? "(5 = worst)" : "(5 = best)"}</span>
              <select value={(form as any)[k]} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          ))}
          <label className="label">Notes
            <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Anything bugging you?" />
          </label>
        </div>
        <div className="builder-actions">
          <button onClick={submit}>{submittedToday ? "Update check-in" : "Submit check-in"}</button>
          {msg && <span className="muted small" style={{ alignSelf: "center" }}>{msg}</span>}
        </div>
      </div>

      {trend.length > 1 && (
        <div className="card chart-card">
          <div className="chart-head"><h2>Readiness trend</h2></div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={trend} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
              <CartesianGrid stroke="#2a2f3a" strokeDasharray="3 3" />
              <XAxis dataKey="date" stroke="#8a93a6" fontSize={12} />
              <YAxis domain={[0, 100]} stroke="#8a93a6" fontSize={12} />
              <Tooltip contentStyle={{ background: "#161a22", border: "1px solid #2a2f3a", borderRadius: 8 }} />
              <Line type="monotone" dataKey="readiness" stroke="#4fd1c5" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

interface FlagRow { athleteId: string; name: string; sport: string; readiness: number | null; soreness: number | null; date: string | null; notes: string | null; }

function CoachReadiness() {
  const [rows, setRows] = useState<FlagRow[]>([]);
  useEffect(() => { api.get<{ rows: FlagRow[] }>("/wellness/flags").then((r) => setRows(r.rows)); }, []);
  const withData = rows.filter((r) => r.readiness != null);

  return (
    <div>
      <header className="page-head"><h1>Team Readiness</h1></header>
      <p className="muted small">Lowest readiness first — check in with these athletes before loading them up.</p>
      {withData.length === 0 && <div className="muted">No check-ins yet.</div>}
      <table className="data-table">
        <thead><tr><th>Athlete</th><th>Readiness</th><th>Soreness</th><th>When</th><th>Notes</th></tr></thead>
        <tbody>
          {withData.map((r) => (
            <tr key={r.athleteId}>
              <td><Link to={`/athletes/${r.athleteId}`}>{r.name}</Link> <span className="muted small">{r.sport}</span></td>
              <td>
                <span className="bar">
                  <span className="bar-fill" style={{ width: `${r.readiness}%`, background: readinessColor(r.readiness) }} />
                  <span className="bar-label">{r.readiness}</span>
                </span>
              </td>
              <td className="num">{r.soreness ?? "—"}</td>
              <td className="muted small">{r.date ? new Date(r.date).toLocaleDateString() : "—"}</td>
              <td className="muted small">{r.notes ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
