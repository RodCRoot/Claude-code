import { useEffect, useState } from "react";
import { api } from "../api";

interface AssignmentSummary {
  id: string;
  status: string;
  dueDate: string | null;
  workout: { id: string; name: string; description: string | null };
  _count: { setLogs: number };
}
interface Exercise { name: string; videoUrl?: string | null; }
interface Item {
  id: string; sets: number | null; reps: string | null; load: string | null;
  restSec: number | null; notes: string | null; exercise: Exercise;
}
interface Block { id: string; name: string; items: Item[]; }
interface SetLog {
  workoutItemId: string; setNumber: number; reps: number | null;
  loadKg: number | null; rpe: number | null; completed: boolean;
}
interface FullAssignment {
  id: string; status: string;
  workout: { name: string; description: string | null; blocks: Block[] };
  setLogs: SetLog[];
}

export default function Training() {
  const [assignments, setAssignments] = useState<AssignmentSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  function load() {
    api.get<{ assignments: AssignmentSummary[] }>("/assignments").then((r) => setAssignments(r.assignments));
  }
  useEffect(() => { load(); }, []);

  if (openId) {
    return <AssignmentLogger id={openId} onBack={() => { setOpenId(null); load(); }} />;
  }

  return (
    <div>
      <header className="page-head"><h1>Training</h1></header>
      {assignments.length === 0 && <div className="muted">No workouts assigned yet.</div>}
      <div className="grid">
        {assignments.map((a) => (
          <button key={a.id} className="card athlete-card as-button" onClick={() => setOpenId(a.id)}>
            <div>
              <div className="athlete-name">{a.workout.name}</div>
              <div className="muted small">{a.workout.description}</div>
              <span className={`tier tier-${statusTier(a.status)}`}>{a.status.replace("_", " ")}</span>
              {a.dueDate && <span className="muted small"> · due {new Date(a.dueDate).toLocaleDateString()}</span>}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function statusTier(s: string) {
  if (s === "COMPLETED") return "elite";
  if (s === "IN_PROGRESS") return "proficient";
  return "developing";
}

function AssignmentLogger({ id, onBack }: { id: string; onBack: () => void }) {
  const [data, setData] = useState<FullAssignment | null>(null);
  // keyed by `${itemId}:${setNumber}` -> partial log
  const [logs, setLogs] = useState<Record<string, SetLog>>({});
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api.get<{ assignment: FullAssignment }>(`/assignments/${id}`).then((r) => {
      setData(r.assignment);
      const map: Record<string, SetLog> = {};
      for (const l of r.assignment.setLogs) map[`${l.workoutItemId}:${l.setNumber}`] = l;
      setLogs(map);
    });
  }, [id]);

  function setField(itemId: string, setNumber: number, patch: Partial<SetLog>) {
    const key = `${itemId}:${setNumber}`;
    setLogs((prev) => {
      const base: SetLog = prev[key] ?? {
        workoutItemId: itemId, setNumber, reps: null, loadKg: null, rpe: null, completed: true,
      };
      return { ...prev, [key]: { ...base, ...patch } };
    });
  }

  async function save(complete: boolean) {
    setMsg("");
    const payload = Object.values(logs).filter((l) => l.reps != null || l.loadKg != null || l.rpe != null);
    await api.post(`/assignments/${id}/logs`, { logs: payload });
    if (complete) await api.post(`/assignments/${id}/complete`);
    setMsg(complete ? "Workout completed ✓" : "Progress saved");
    if (complete) setTimeout(onBack, 600);
  }

  if (!data) return <div className="muted">Loading…</div>;

  return (
    <div>
      <header className="page-head">
        <div>
          <button className="link-btn" onClick={onBack}>← Back</button>
          <h1>{data.workout.name}</h1>
          <div className="muted">{data.workout.description}</div>
        </div>
      </header>

      {data.workout.blocks.map((b) => (
        <div key={b.id} className="card" style={{ marginBottom: 14 }}>
          <h2>{b.name}</h2>
          {b.items.map((it) => {
            const sets = it.sets ?? 1;
            return (
              <div key={it.id} className="log-item">
                <div className="log-item-head">
                  <span className="metric-name">{it.exercise.name}</span>
                  <span className="muted small">
                    {it.sets ?? "?"}×{it.reps ?? "?"}{it.load ? ` @ ${it.load}` : ""}
                    {it.exercise.videoUrl && <> · <a className="link-btn" href={it.exercise.videoUrl} target="_blank" rel="noreferrer">video</a></>}
                  </span>
                </div>
                <table className="item-table">
                  <thead><tr><th>Set</th><th>Reps</th><th>Load (kg)</th><th>RPE</th></tr></thead>
                  <tbody>
                    {Array.from({ length: sets }, (_, i) => i + 1).map((sn) => {
                      const cur = logs[`${it.id}:${sn}`];
                      return (
                        <tr key={sn}>
                          <td>{sn}</td>
                          <td><input className="tiny" type="number" value={cur?.reps ?? ""} onChange={(e) => setField(it.id, sn, { reps: e.target.value === "" ? null : Number(e.target.value) })} /></td>
                          <td><input className="tiny" type="number" value={cur?.loadKg ?? ""} onChange={(e) => setField(it.id, sn, { loadKg: e.target.value === "" ? null : Number(e.target.value) })} /></td>
                          <td><input className="tiny" type="number" value={cur?.rpe ?? ""} onChange={(e) => setField(it.id, sn, { rpe: e.target.value === "" ? null : Number(e.target.value) })} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      ))}

      <div className="builder-actions">
        <button className="secondary" onClick={() => save(false)}>Save progress</button>
        <button onClick={() => save(true)}>Mark complete</button>
        {msg && <span className="muted small" style={{ alignSelf: "center" }}>{msg}</span>}
      </div>
    </div>
  );
}
