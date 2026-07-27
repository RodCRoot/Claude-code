import { useEffect, useState } from "react";
import { api } from "../api";
const localIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;


interface Exercise { id: string; name: string; category: string; }
interface Item {
  exerciseId: string; sets?: number; reps?: string; load?: string; restSec?: number; notes?: string;
  prescribeBy?: "PCT" | "VELOCITY" | "ZONE" | "TEXT";
  targetPctE1rm?: number; targetVelocity?: number; velocityZone?: string;
}
interface Block { name: string; items: Item[]; }
interface WorkoutSummary { id: string; name: string; _count: { blocks: number; assignments: number }; }
interface GroupOpt { id: string; name: string; _count: { memberships: number }; }

export default function WorkoutBuilder() {
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [workouts, setWorkouts] = useState<WorkoutSummary[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([{ name: "A. Power", items: [] }]);
  const [msg, setMsg] = useState("");
  const [groups, setGroups] = useState<GroupOpt[]>([]);

  function loadWorkouts() {
    api.get<{ workouts: WorkoutSummary[] }>("/workouts").then((r) => setWorkouts(r.workouts));
  }
  useEffect(() => {
    api.get<{ exercises: Exercise[] }>("/exercises").then((r) => setExercises(r.exercises));
    api.get<{ groups: GroupOpt[] }>("/groups").then((r) => setGroups(r.groups));
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
                <tr><th>Exercise</th><th>Sets</th><th>Reps</th><th>Prescribe by</th><th>Target</th><th>Rest(s)</th><th></th></tr>
              </thead>
              <tbody>
                {b.items.map((it, ii) => {
                  const by = it.prescribeBy ?? "TEXT";
                  return (
                  <tr key={ii}>
                    <td>
                      <select value={it.exerciseId} onChange={(e) => updateItem(bi, ii, { exerciseId: e.target.value })}>
                        {exercises.map((ex) => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
                      </select>
                    </td>
                    <td><input className="tiny" type="number" value={it.sets ?? ""} onChange={(e) => updateItem(bi, ii, { sets: Number(e.target.value) })} /></td>
                    <td><input className="tiny" value={it.reps ?? ""} onChange={(e) => updateItem(bi, ii, { reps: e.target.value })} /></td>
                    <td>
                      <select value={by} onChange={(e) => updateItem(bi, ii, { prescribeBy: e.target.value as Item["prescribeBy"], targetPctE1rm: undefined, targetVelocity: undefined, velocityZone: undefined })}>
                        <option value="TEXT">Text/Load</option>
                        <option value="PCT">% e1RM</option>
                        <option value="VELOCITY">Velocity</option>
                        <option value="ZONE">Zone</option>
                      </select>
                    </td>
                    <td>
                      {by === "TEXT" && <input className="tiny" placeholder="e.g. RPE 8" value={it.load ?? ""} onChange={(e) => updateItem(bi, ii, { load: e.target.value })} />}
                      {by === "PCT" && <input className="tiny" type="number" placeholder="% (e.g. 75)" value={it.targetPctE1rm != null ? Math.round(it.targetPctE1rm * 100) : ""} onChange={(e) => updateItem(bi, ii, { targetPctE1rm: e.target.value === "" ? undefined : Number(e.target.value) / 100 })} />}
                      {by === "VELOCITY" && <input className="tiny" type="number" step="0.01" placeholder="m/s" value={it.targetVelocity ?? ""} onChange={(e) => updateItem(bi, ii, { targetVelocity: e.target.value === "" ? undefined : Number(e.target.value) })} />}
                      {by === "ZONE" && (
                        <select value={it.velocityZone ?? ""} onChange={(e) => updateItem(bi, ii, { velocityZone: e.target.value })}>
                          <option value="">—</option>
                          <option value="STRENGTH">Strength</option>
                          <option value="STRENGTH_SPEED">Strength-Speed</option>
                          <option value="SPEED_STRENGTH">Speed-Strength</option>
                          <option value="SPEED">Speed</option>
                        </select>
                      )}
                    </td>
                    <td><input className="tiny" type="number" value={it.restSec ?? ""} onChange={(e) => updateItem(bi, ii, { restSec: Number(e.target.value) })} /></td>
                    <td><button className="link-btn" onClick={() => removeItem(bi, ii)}>✕</button></td>
                  </tr>
                  );
                })}
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
            <AssignControl workoutId={w.id} groups={groups} onAssigned={loadWorkouts} />
          </div>
        ))}
      </div>
    </div>
  );
}

const WEEKDAYS = [
  { js: 1, label: "M" }, { js: 2, label: "T" }, { js: 3, label: "W" }, { js: 4, label: "Th" },
  { js: 5, label: "F" }, { js: 6, label: "Sa" }, { js: 0, label: "Su" },
];

// Build the list of session dates from a start date, selected weekdays, and a
// number of weeks (recurring schedule). Falls back to [start] if no weekday set.
function buildDates(start: string, weekdays: Set<number>, weeks: number): string[] {
  if (weekdays.size === 0) return [start];
  const s = new Date(start + "T00:00:00");
  const monday = new Date(s);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const out: string[] = [];
  for (let w = 0; w < weeks; w++) {
    for (const js of weekdays) {
      const offset = (js + 6) % 7; // Mon=0..Sun=6
      const d = new Date(monday);
      d.setDate(monday.getDate() + w * 7 + offset);
      if (d >= s) out.push(localIso(d));
    }
  }
  return out.length ? out.sort() : [start];
}

// Assign a saved workout to a group (or everyone), once or on a recurring schedule.
function AssignControl({ workoutId, groups, onAssigned }: { workoutId: string; groups: GroupOpt[]; onAssigned: () => void }) {
  const [open, setOpen] = useState(false);
  const [groupId, setGroupId] = useState("");
  const [date, setDate] = useState(localIso(new Date()));
  const [repeat, setRepeat] = useState(false);
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set());
  const [weeks, setWeeks] = useState(4);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  function toggleDay(js: number) {
    setWeekdays((prev) => { const n = new Set(prev); n.has(js) ? n.delete(js) : n.add(js); return n; });
  }

  async function assign() {
    if (!groupId) return;
    setBusy(true); setMsg("");
    try {
      const body: Record<string, unknown> = { groupId };
      if (repeat) body.dates = buildDates(date, weekdays, weeks);
      else body.assignedDate = date;
      const r = await api.post<{ assigned: number; athletes: number; sessions: number }>(`/workouts/${workoutId}/assign`, body);
      setMsg(`Assigned ${r.sessions} session${r.sessions === 1 ? "" : "s"} to ${r.athletes} athlete${r.athletes === 1 ? "" : "s"}.`);
      onAssigned();
    } catch (e) { setMsg(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(false); }
  }

  if (!open) return <button className="link-btn" onClick={() => setOpen(true)}>Assign →</button>;
  return (
    <div className="assign-control">
      <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
        <option value="">Pick a group…</option>
        {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g._count.memberships})</option>)}
      </select>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <label className="repeat-toggle"><input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> repeat</label>
      {repeat && (
        <div className="repeat-opts">
          <div className="weekday-row">
            {WEEKDAYS.map((d) => (
              <button key={d.js} type="button" className={`weekday ${weekdays.has(d.js) ? "on" : ""}`} onClick={() => toggleDay(d.js)}>{d.label}</button>
            ))}
          </div>
          <label className="muted small">for <input className="tiny" type="number" min={1} max={26} value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} /> weeks</label>
        </div>
      )}
      <button disabled={busy || !groupId} onClick={assign}>Assign</button>
      {msg && <div className="muted small">{msg}</div>}
    </div>
  );
}
