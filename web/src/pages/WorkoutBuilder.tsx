import { useEffect, useState } from "react";
import { api } from "../api";

interface Exercise { id: string; name: string; category: string; }
interface Item { exerciseId: string; sets?: number; reps?: string; load?: string; restSec?: number; notes?: string; }
interface Block { name: string; items: Item[]; }
interface WorkoutSummary { id: string; name: string; _count: { blocks: number; assignments: number }; }

export default function WorkoutBuilder() {
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [workouts, setWorkouts] = useState<WorkoutSummary[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([{ name: "A. Power", items: [] }]);
  const [msg, setMsg] = useState("");

  function loadWorkouts() {
    api.get<{ workouts: WorkoutSummary[] }>("/workouts").then((r) => setWorkouts(r.workouts));
  }
  useEffect(() => {
    api.get<{ exercises: Exercise[] }>("/exercises").then((r) => setExercises(r.exercises));
    loadWorkouts();
  }, []);

  function addBlock() {
    const letter = String.fromCharCode(65 + blocks.length);
    setBlocks([...blocks, { name: `${letter}. Block`, items: [] }]);
  }
  function addItem(bi: number) {
    if (!exercises[0]) return;
    const copy = [...blocks];
    copy[bi].items.push({ exerciseId: exercises[0].id, sets: 3, reps: "5" });
    setBlocks(copy);
  }
  function updateItem(bi: number, ii: number, patch: Partial<Item>) {
    const copy = [...blocks];
    copy[bi].items[ii] = { ...copy[bi].items[ii], ...patch };
    setBlocks(copy);
  }
  function removeItem(bi: number, ii: number) {
    const copy = [...blocks];
    copy[bi].items.splice(ii, 1);
    setBlocks(copy);
  }

  async function save() {
    setMsg("");
    try {
      await api.post("/workouts", { name, description, blocks });
      setMsg("Workout saved.");
      setName(""); setDescription(""); setBlocks([{ name: "A. Power", items: [] }]);
      loadWorkouts();
    } catch (e) { setMsg(e instanceof Error ? e.message : "Failed to save"); }
  }

  return (
    <div>
      <header className="page-head"><h1>Workout Builder</h1></header>

      <div className="card builder">
        <div className="builder-meta">
          <input className="big-input" placeholder="Workout name" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        {blocks.map((b, bi) => (
          <div key={bi} className="block">
            <input
              className="block-name"
              value={b.name}
              onChange={(e) => { const c = [...blocks]; c[bi].name = e.target.value; setBlocks(c); }}
            />
            <table className="item-table">
              <thead>
                <tr><th>Exercise</th><th>Sets</th><th>Reps</th><th>Load</th><th>Rest(s)</th><th></th></tr>
              </thead>
              <tbody>
                {b.items.map((it, ii) => (
                  <tr key={ii}>
                    <td>
                      <select value={it.exerciseId} onChange={(e) => updateItem(bi, ii, { exerciseId: e.target.value })}>
                        {exercises.map((ex) => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
                      </select>
                    </td>
                    <td><input className="tiny" type="number" value={it.sets ?? ""} onChange={(e) => updateItem(bi, ii, { sets: Number(e.target.value) })} /></td>
                    <td><input className="tiny" value={it.reps ?? ""} onChange={(e) => updateItem(bi, ii, { reps: e.target.value })} /></td>
                    <td><input className="tiny" value={it.load ?? ""} onChange={(e) => updateItem(bi, ii, { load: e.target.value })} /></td>
                    <td><input className="tiny" type="number" value={it.restSec ?? ""} onChange={(e) => updateItem(bi, ii, { restSec: Number(e.target.value) })} /></td>
                    <td><button className="link-btn" onClick={() => removeItem(bi, ii)}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="secondary" onClick={() => addItem(bi)}>+ Add exercise</button>
          </div>
        ))}

        <div className="builder-actions">
          <button className="secondary" onClick={addBlock}>+ Add block</button>
          <button onClick={save} disabled={!name || blocks.every((b) => b.items.length === 0)}>Save workout</button>
        </div>
        {msg && <div className="muted small">{msg}</div>}
      </div>

      <h2 className="section-title">Saved Workouts</h2>
      <div className="grid">
        {workouts.map((w) => (
          <div key={w.id} className="card">
            <div className="athlete-name">{w.name}</div>
            <div className="muted small">{w._count.blocks} blocks · {w._count.assignments} assigned</div>
          </div>
        ))}
      </div>
    </div>
  );
}
