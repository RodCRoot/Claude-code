import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";

interface GoalRow {
  id: string; athlete: { id: string; name: string }; kind: string; label: string; unit: string;
  higherIsBetter: boolean; baseline: number | null; current: number | null; target: number;
  progressPct: number | null; deadline: string | null; status: string; achievedAt: string | null; notes: string | null;
}
interface MetricType { id: string; name: string; unit: string; }
interface Exercise { id: string; name: string; }
interface Athlete { id: string; firstName: string; lastName: string; }

export default function Goals() {
  const { user } = useAuth();
  const isCoach = user?.role === "COACH" || user?.role === "ADMIN";
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  function load() { api.get<{ goals: GoalRow[] }>("/goals").then((r) => setGoals(r.goals)); }
  useEffect(() => { load(); }, []);

  const active = goals.filter((g) => g.status === "ACTIVE");
  const achieved = goals.filter((g) => g.status === "ACHIEVED");

  return (
    <div>
      <header className="page-head">
        <h1>Goals</h1>
        <button onClick={() => setShowCreate((s) => !s)}>{showCreate ? "Close" : "+ New goal"}</button>
      </header>

      {showCreate && <CreateGoal isCoach={isCoach} onCreated={() => { setShowCreate(false); load(); }} />}

      {active.length === 0 && !showCreate && <p className="muted">No active goals — set one to give training a target.</p>}
      <div className="goals-list">
        {active.map((g) => <GoalCard key={g.id} g={g} showAthlete={isCoach} onArchive={() => api.post(`/goals/${g.id}/archive`).then(load)} />)}
      </div>

      {achieved.length > 0 && (
        <>
          <header className="page-head" style={{ marginTop: 24 }}><h2>Achieved 🎯</h2></header>
          <div className="goals-list">
            {achieved.map((g) => <GoalCard key={g.id} g={g} showAthlete={isCoach} onArchive={() => api.post(`/goals/${g.id}/archive`).then(load)} />)}
          </div>
        </>
      )}
    </div>
  );
}

function GoalCard({ g, showAthlete, onArchive }: { g: GoalRow; showAthlete: boolean; onArchive: () => void }) {
  const pct = g.progressPct ?? 0;
  const done = g.status === "ACHIEVED";
  return (
    <div className={`card goal-card ${done ? "goal-done" : ""}`}>
      <div className="goal-head">
        <div>
          <span className="goal-label">{g.label}</span>
          {showAthlete && <span className="muted small"> · <Link to={`/athletes/${g.athlete.id}`}>{g.athlete.name}</Link></span>}
        </div>
        <button className="link-btn" onClick={onArchive} title="Archive">✕</button>
      </div>
      <div className="goal-bar">
        <div className="goal-fill" style={{ width: `${done ? 100 : pct}%` }} />
      </div>
      <div className="goal-nums">
        <span className="muted small">{g.baseline != null ? `from ${g.baseline}${g.unit}` : "no baseline"}</span>
        <span className="goal-current">{g.current != null ? `${g.current}${g.unit}` : "—"}</span>
        <span className="muted small">target {g.target}{g.unit}</span>
      </div>
      <div className="muted small goal-meta">
        {done && g.achievedAt && <>achieved {new Date(g.achievedAt).toLocaleDateString()} · </>}
        {!done && g.deadline && <>by {new Date(g.deadline).toLocaleDateString(undefined, { timeZone: "UTC" })} · </>}
        {g.notes ?? ""}
      </div>
    </div>
  );
}

function CreateGoal({ isCoach, onCreated }: { isCoach: boolean; onCreated: () => void }) {
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [metrics, setMetrics] = useState<MetricType[]>([]);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [form, setForm] = useState({ athleteId: "", kind: "METRIC", metricTypeId: "", exerciseId: "", targetValue: "", deadline: "", notes: "" });
  const [err, setErr] = useState("");

  useEffect(() => {
    api.get<{ types: MetricType[] }>("/metrics/types").then((r) => { setMetrics(r.types); setForm((f) => ({ ...f, metricTypeId: r.types[0]?.id ?? "" })); });
    api.get<{ exercises: Exercise[] }>("/exercises").then((r) => { setExercises(r.exercises); setForm((f) => ({ ...f, exerciseId: r.exercises[0]?.id ?? "" })); });
    if (isCoach) api.get<{ athletes: Athlete[] }>("/athletes").then((r) => { setAthletes(r.athletes); setForm((f) => ({ ...f, athleteId: r.athletes[0]?.id ?? "" })); });
  }, [isCoach]);

  async function save() {
    setErr("");
    try {
      await api.post("/goals", {
        athleteId: isCoach ? form.athleteId : undefined,
        kind: form.kind,
        metricTypeId: form.kind === "METRIC" ? form.metricTypeId : undefined,
        exerciseId: form.kind === "E1RM" ? form.exerciseId : undefined,
        targetValue: Number(form.targetValue),
        deadline: form.deadline || undefined,
        notes: form.notes || undefined,
      });
      onCreated();
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
  }

  const unit = form.kind === "E1RM" ? "kg" : metrics.find((m) => m.id === form.metricTypeId)?.unit ?? "";
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="wellness-form">
        {isCoach && (
          <label className="label">Athlete
            <select value={form.athleteId} onChange={(e) => setForm({ ...form, athleteId: e.target.value })}>
              {athletes.map((a) => <option key={a.id} value={a.id}>{a.firstName} {a.lastName}</option>)}
            </select>
          </label>
        )}
        <label className="label">Goal type
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="METRIC">Performance metric</option>
            <option value="E1RM">Lift max (e1RM)</option>
          </select>
        </label>
        {form.kind === "METRIC" ? (
          <label className="label">Metric
            <select value={form.metricTypeId} onChange={(e) => setForm({ ...form, metricTypeId: e.target.value })}>
              {metrics.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        ) : (
          <label className="label">Exercise
            <select value={form.exerciseId} onChange={(e) => setForm({ ...form, exerciseId: e.target.value })}>
              {exercises.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
        )}
        <label className="label">Target {unit && <span className="muted small">({unit})</span>}
          <input type="number" step="0.01" value={form.targetValue} onChange={(e) => setForm({ ...form, targetValue: e.target.value })} />
        </label>
        <label className="label">Deadline <span className="muted small">(optional)</span>
          <input type="date" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
        </label>
        <label className="label">Notes
          <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Why this target?" />
        </label>
      </div>
      <div className="builder-actions">
        <button onClick={save} disabled={!form.targetValue}>Set goal</button>
        {err && <span className="small" style={{ color: "#e06a6a", alignSelf: "center" }}>{err}</span>}
      </div>
    </div>
  );
}
