import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";

interface Target { targetLoadKg: number | null; targetVelocity: number | null; zone: string | null; display: string; }
interface PlanItem { exercise: string; sets: number | null; reps: string | null; targets: Target; }
interface PlanBlock { name: string; items: PlanItem[]; }
interface PlanWorkout { name: string; description: string | null; blocks: PlanBlock[]; }
interface PlanAssignment { id: string; status: string; dueToday: boolean; workout: PlanWorkout; }
interface PB { name: string; value: number; unit: string; achievedAt: string; }
interface PR { label: string; value: number; unit: string; achievedAt: string; }
interface Rank { label: string; rank: number; of: number; value: number; unit: string; }
interface TodayData {
  athlete: { firstName: string; lastName: string; sex: string; ageYears: number; ageGroup: string };
  plan: PlanAssignment[];
  personalBests: { lifts: PB[]; tests: PB[] };
  recentPRs: PR[];
  ranks: Rank[];
}

export default function Today() {
  const { athleteId } = useAuth();
  const nav = useNavigate();
  const [data, setData] = useState<TodayData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get<TodayData>("/me/today").then(setData).catch((e) => setError((e as Error).message));
  }, []);

  if (error) return <div className="card error">Couldn't load your dashboard: {error}</div>;
  if (!data) return <div className="muted">Loading your day…</div>;

  const a = data.athlete;
  const fmt = (v: number, u: string) => `${v}${u ? (u === "kg" || u === "cm" || u === "s" ? " " + u : u) : ""}`;

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>Hi, {a.firstName} 👋</h1>
          <div className="muted">{a.ageGroup} · {a.sex === "M" ? "Male" : "Female"} · age {a.ageYears}</div>
        </div>
      </header>

      {data.recentPRs.length > 0 && (
        <div className="card pr-banner">
          <span className="badge">🎉 NEW PR{data.recentPRs.length > 1 ? "s" : ""}</span>
          <span className="pr-list">
            {data.recentPRs.slice(0, 4).map((p, i) => (
              <span key={i} className="pr-chip">{p.label}: <strong>{fmt(p.value, p.unit)}</strong></span>
            ))}
          </span>
        </div>
      )}

      <h2 className="section-title">Your rankings <span className="muted small">in {a.ageGroup} {a.sex === "M" ? "boys" : "girls"}</span></h2>
      <div className="grid stat-grid">
        {data.ranks.length === 0 && <div className="muted">No ranked tests yet.</div>}
        {data.ranks.map((r, i) => (
          <div key={i} className="card stat rank-card">
            <div className="stat-value">#{r.rank}<span className="muted small"> / {r.of}</span></div>
            <div className="muted small">{r.label}</div>
            <div className="rank-value">{fmt(r.value, r.unit)}</div>
          </div>
        ))}
      </div>

      <h2 className="section-title">Today's plan</h2>
      {data.plan.length === 0 && <div className="muted">Nothing scheduled — nice recovery day.</div>}
      {data.plan.map((p) => (
        <div key={p.id} className="card" style={{ marginBottom: 14 }}>
          <div className="page-head" style={{ marginBottom: 8 }}>
            <div>
              <div className="athlete-name">{p.workout.name} {p.dueToday && <span className="tier tier-proficient">today</span>}</div>
              <div className="muted small">{p.workout.description}</div>
            </div>
            <button onClick={() => nav(`/training?open=${p.id}`)}>{p.status === "IN_PROGRESS" ? "Continue" : "Start"}</button>
          </div>
          {p.workout.blocks.map((b, bi) => (
            <div key={bi} className="plan-block">
              <div className="block-name">{b.name}</div>
              {b.items.map((it, ii) => (
                <div key={ii} className="plan-item">
                  <span className="metric-name">{it.exercise}</span>
                  <span className="muted small">{it.sets ?? "?"}×{it.reps ?? "?"}</span>
                  {it.targets.display && <span className="target-text">{it.targets.display}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}

      <h2 className="section-title">Personal bests</h2>
      <div className="grid">
        <div className="card">
          <div className="muted small">Lifts (est. 1RM)</div>
          {data.personalBests.lifts.length === 0 && <div className="muted small">—</div>}
          {data.personalBests.lifts.map((l, i) => (
            <div key={i} className="pb-row"><span>{l.name}</span><strong>{fmt(l.value, l.unit)}</strong></div>
          ))}
        </div>
        <div className="card">
          <div className="muted small">Tests</div>
          {data.personalBests.tests.length === 0 && <div className="muted small">—</div>}
          {data.personalBests.tests.map((l, i) => (
            <div key={i} className="pb-row"><span>{l.name}</span><strong>{fmt(l.value, l.unit)}</strong></div>
          ))}
        </div>
      </div>
    </div>
  );
}
