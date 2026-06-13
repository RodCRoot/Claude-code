import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { api } from "../api";
import { useAuth } from "../auth";
import { ScoreRing } from "./Dashboard";

interface MetricRecord {
  id: string;
  value: number;
  recordedAt: string;
  metricType: { key: string; name: string; unit: string };
}
interface Athlete {
  id: string; firstName: string; lastName: string; sport: string; sex: string;
  position?: string | null; heightCm?: number | null; weightKg?: number | null;
  metrics: MetricRecord[];
}
interface Cohort { label: string; n: number; percentile: number | null; }
interface Elite {
  level: string; mean: number; ratio: number; zScore: number | null;
  percentileOfElite: number | null; sourceName: string | null;
  confidence: string | null; matchedOn: string; notes: string | null;
}
interface MetricRating {
  metricKey: string; metricName: string; unit: string; higherIsBetter: boolean;
  relativeToBw: boolean; value: number; ratingValue: number;
  score: number; cohorts: Cohort[]; elite: Elite | null;
}
interface Rating {
  compositeScore: number | null; tier: string; ageYears: number; metrics: MetricRating[];
}

export default function AthleteDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const isCoach = user?.role !== "ATHLETE";
  const [athlete, setAthlete] = useState<Athlete | null>(null);
  const [rating, setRating] = useState<Rating | null>(null);
  const [selected, setSelected] = useState<string>("");

  async function load() {
    const [a, r] = await Promise.all([
      api.get<{ athlete: Athlete }>(`/athletes/${id}`),
      api.get<Rating>(`/athletes/${id}/rating`),
    ]);
    setAthlete(a.athlete);
    setRating(r);
    if (!selected && r.metrics[0]) setSelected(r.metrics[0].metricKey);
  }
  useEffect(() => { load(); }, [id]);

  const series = useMemo(() => {
    if (!athlete || !selected) return [];
    return athlete.metrics
      .filter((m) => m.metricType.key === selected)
      .map((m) => ({ date: new Date(m.recordedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }), value: m.value }))
      .reverse();
  }, [athlete, selected]);

  if (!athlete || !rating) return <div className="muted">Loading athlete…</div>;

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>{athlete.firstName} {athlete.lastName}</h1>
          <div className="muted">
            {athlete.sport} · {athlete.sex} · age {rating.ageYears}
            {athlete.heightCm ? ` · ${athlete.heightCm}cm` : ""}{athlete.weightKg ? ` · ${athlete.weightKg}kg` : ""}
          </div>
        </div>
        <div className="composite">
          <ScoreRing score={rating.compositeScore} />
          <div>
            <div className="muted small">Vantage Score</div>
            <div className={`tier tier-${rating.tier.toLowerCase()}`}>{rating.tier}</div>
            <Link className="link-btn" to={`/athletes/${athlete.id}/report`}>Printable report →</Link>
          </div>
        </div>
      </header>

      {isCoach && <QuickEntry athleteId={athlete.id} metrics={rating.metrics} onSaved={load} />}
      {isCoach && <MaxesPanel athleteId={athlete.id} onSaved={load} />}

      <section className="card chart-card">
        <div className="chart-head">
          <h2>Trend</h2>
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            {rating.metrics.map((m) => (
              <option key={m.metricKey} value={m.metricKey}>{m.metricName}</option>
            ))}
          </select>
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={series} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="#2a2f3a" strokeDasharray="3 3" />
            <XAxis dataKey="date" stroke="#8a93a6" fontSize={12} />
            <YAxis stroke="#8a93a6" fontSize={12} domain={["auto", "auto"]} />
            <Tooltip contentStyle={{ background: "#161a22", border: "1px solid #2a2f3a", borderRadius: 8 }} />
            <Line type="monotone" dataKey="value" stroke="#4fd1c5" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </section>

      <h2 className="section-title">Metric Ratings</h2>
      <div className="grid">
        {rating.metrics.map((m) => (
          <div key={m.metricKey} className="card metric-card">
            <div className="metric-top">
              <div>
                <div className="metric-name">{m.metricName}</div>
                <div className="metric-value">{m.value}<span className="unit"> {m.unit}</span></div>
                {m.relativeToBw && <div className="muted small">{m.ratingValue}× bodyweight</div>}
              </div>
              <ScoreRing score={m.score} />
            </div>
            <div className="cohorts">
              {m.cohorts.map((c) => (
                <div key={c.label} className="cohort-row">
                  <span className="cohort-label">{c.label} <span className="muted small">n={c.n}</span></span>
                  <Bar pct={c.percentile} />
                </div>
              ))}
            </div>
            {m.elite && (
              <div className="elite">
                <span className="badge">ELITE</span>
                {m.elite.confidence && (
                  <span className={`conf conf-${m.elite.confidence.toLowerCase()}`} title={m.elite.notes ?? ""}>
                    {m.elite.confidence === "LOW" ? "estimate" : m.elite.confidence.toLowerCase()}
                  </span>
                )}
                <span className="muted small">
                  {Math.round(m.elite.ratio * 100)}% of elite ({m.elite.mean}{m.relativeToBw ? "×BW" : m.unit ? ` ${m.unit}` : ""})
                  {m.elite.percentileOfElite != null && ` · ${m.elite.percentileOfElite}th pct`}
                  {m.elite.matchedOn !== "general" && ` · vs ${m.elite.matchedOn}`}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Bar({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="muted small">no cohort</span>;
  const hue = Math.round((pct / 100) * 130);
  return (
    <span className="bar">
      <span className="bar-fill" style={{ width: `${pct}%`, background: `hsl(${hue} 70% 45%)` }} />
      <span className="bar-label">{pct}</span>
    </span>
  );
}

// Inline metric logging for coaches.
function QuickEntry({ athleteId, metrics, onSaved }: { athleteId: string; metrics: MetricRating[]; onSaved: () => void }) {
  const [metricKey, setMetricKey] = useState(metrics[0]?.metricKey ?? "");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!value) return;
    setBusy(true);
    try {
      await api.post("/metrics", { athleteId, metricKey, value: Number(value) });
      setValue("");
      onSaved();
    } finally { setBusy(false); }
  }
  return (
    <div className="card quick-entry">
      <span className="muted small">Log result</span>
      <select value={metricKey} onChange={(e) => setMetricKey(e.target.value)}>
        {metrics.map((m) => <option key={m.metricKey} value={m.metricKey}>{m.metricName}</option>)}
      </select>
      <input placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} />
      <button disabled={busy} onClick={save}>Save</button>
    </div>
  );
}

interface ExerciseOpt { id: string; name: string; }
interface MaxRow { id: string; e1rmKg: number; method: string; recordedAt: string; notes: string | null; exercise: { name: string }; }

// Coach panel to set/track estimated 1RMs (direct, rep-max, or VBT bar speed).
function MaxesPanel({ athleteId, onSaved }: { athleteId: string; onSaved: () => void }) {
  const [exercises, setExercises] = useState<ExerciseOpt[]>([]);
  const [maxes, setMaxes] = useState<MaxRow[]>([]);
  const [exerciseId, setExerciseId] = useState("");
  const [mode, setMode] = useState<"DIRECT" | "REPMAX" | "VBT">("DIRECT");
  const [e1rm, setE1rm] = useState("");
  const [repWeight, setRepWeight] = useState("");
  const [reps, setReps] = useState("");
  const [lv, setLv] = useState([{ loadKg: "", velocity: "" }, { loadKg: "", velocity: "" }, { loadKg: "", velocity: "" }]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  function load() {
    api.get<{ maxes: MaxRow[] }>(`/athletes/${athleteId}/maxes`).then((r) => setMaxes(r.maxes));
  }
  useEffect(() => {
    api.get<{ exercises: ExerciseOpt[] }>("/exercises").then((r) => { setExercises(r.exercises); if (r.exercises[0]) setExerciseId(r.exercises[0].id); });
    load();
  }, [athleteId]);

  async function save() {
    setMsg(""); setBusy(true);
    try {
      const body: Record<string, unknown> = { exerciseId };
      if (mode === "DIRECT") body.e1rmKg = Number(e1rm);
      else if (mode === "REPMAX") { body.repWeightKg = Number(repWeight); body.reps = Number(reps); body.method = "EPLEY"; }
      else {
        body.lvPoints = lv.filter((p) => p.loadKg && p.velocity).map((p) => ({ loadKg: Number(p.loadKg), velocity: Number(p.velocity) }));
      }
      const r = await api.post<{ max: MaxRow }>(`/athletes/${athleteId}/maxes`, body);
      setMsg(`Saved: ${r.max.exercise?.name ?? "max"} ≈ ${r.max.e1rmKg} kg`);
      setE1rm(""); setRepWeight(""); setReps("");
      setLv([{ loadKg: "", velocity: "" }, { loadKg: "", velocity: "" }, { loadKg: "", velocity: "" }]);
      load(); onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    await api.del(`/athletes/maxes/${id}`);
    load(); onSaved();
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h2>Maxes / e1RM</h2>
      <div className="maxes-form">
        <select value={exerciseId} onChange={(e) => setExerciseId(e.target.value)}>
          {exercises.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="DIRECT">Direct e1RM</option>
          <option value="REPMAX">From rep-max</option>
          <option value="VBT">From bar speed (VBT)</option>
        </select>
        {mode === "DIRECT" && <input placeholder="e1RM (kg)" value={e1rm} onChange={(e) => setE1rm(e.target.value)} />}
        {mode === "REPMAX" && <>
          <input placeholder="weight (kg)" value={repWeight} onChange={(e) => setRepWeight(e.target.value)} />
          <input placeholder="reps" value={reps} onChange={(e) => setReps(e.target.value)} />
        </>}
        {mode === "VBT" && (
          <div className="lv-grid">
            <span className="muted small">load → velocity</span>
            {lv.map((p, i) => (
              <div key={i} className="lv-row">
                <input className="tiny" placeholder="kg" value={p.loadKg} onChange={(e) => setLv((prev) => prev.map((q, j) => j === i ? { ...q, loadKg: e.target.value } : q))} />
                <input className="tiny" placeholder="m/s" value={p.velocity} onChange={(e) => setLv((prev) => prev.map((q, j) => j === i ? { ...q, velocity: e.target.value } : q))} />
              </div>
            ))}
          </div>
        )}
        <button disabled={busy} onClick={save}>Save</button>
        {msg && <span className="muted small" style={{ alignSelf: "center" }}>{msg}</span>}
      </div>

      {maxes.length > 0 && (
        <table className="data-table" style={{ marginTop: 10 }}>
          <thead><tr><th>Exercise</th><th className="num">e1RM</th><th>Method</th><th>Date</th><th></th></tr></thead>
          <tbody>
            {maxes.map((m) => (
              <tr key={m.id}>
                <td>{m.exercise.name}</td>
                <td className="num">{m.e1rmKg} kg</td>
                <td className="muted small">{m.method}</td>
                <td className="muted small">{new Date(m.recordedAt).toLocaleDateString()}</td>
                <td><button className="link-btn" onClick={() => remove(m.id)}>remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
