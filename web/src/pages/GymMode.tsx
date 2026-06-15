import { useEffect, useState } from "react";
import { api } from "../api";

// Weight-room kiosk: a shared facility browser (logged in as coach) where any
// athlete can quickly pull up today's session and log between stations.

interface Athlete { id: string; firstName: string; lastName: string; sport: string; }
interface AssignmentSummary { id: string; status: string; workout: { name: string; description: string | null }; }
interface Target { targetLoadKg: number | null; targetVelocity: number | null; zone: string | null; display: string; }
interface Item { id: string; sets: number | null; reps: string | null; notes: string | null; exercise: { name: string }; targets?: Target; }
interface Block { id: string; name: string; items: Item[]; }
interface SetLog { workoutItemId: string; setNumber: number; reps: number | null; loadKg: number | null; velocity: number | null; rpe: number | null; completed: boolean; }
interface FullAssignment { id: string; workout: { name: string; blocks: Block[] }; setLogs: SetLog[]; }

function velClass(logged: number | null, target: number | null): string {
  if (logged == null || target == null) return "";
  if (logged >= target * 0.95) return "vel-good";
  if (logged >= target * 0.85) return "vel-warn";
  return "vel-low";
}

export default function GymMode() {
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [athlete, setAthlete] = useState<Athlete | null>(null);
  const [assignmentId, setAssignmentId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => { api.get<{ athletes: Athlete[] }>("/athletes").then((r) => setAthletes(r.athletes)); }, []);

  if (assignmentId && athlete) {
    return <KioskLogger id={assignmentId} athleteName={`${athlete.firstName} ${athlete.lastName}`} onDone={() => { setAssignmentId(null); setAthlete(null); }} />;
  }
  if (athlete) {
    return <SessionPicker athlete={athlete} onPick={setAssignmentId} onBack={() => setAthlete(null)} />;
  }

  const filtered = athletes.filter((a) => `${a.firstName} ${a.lastName}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="kiosk">
      <header className="kiosk-head">
        <h1>🏋️ Gym Mode</h1>
        <input className="kiosk-search" placeholder="Search athlete…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      </header>
      <div className="kiosk-grid">
        {filtered.map((a) => (
          <button key={a.id} className="kiosk-tile" onClick={() => setAthlete(a)}>
            <span className="kiosk-name">{a.firstName} {a.lastName}</span>
            <span className="muted small">{a.sport}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SessionPicker({ athlete, onPick, onBack }: { athlete: Athlete; onPick: (id: string) => void; onBack: () => void }) {
  const [items, setItems] = useState<AssignmentSummary[]>([]);
  useEffect(() => {
    api.get<{ assignments: AssignmentSummary[] }>(`/assignments?athleteId=${athlete.id}`).then((r) => setItems(r.assignments.filter((a) => a.status !== "COMPLETED")));
  }, [athlete.id]);
  return (
    <div className="kiosk">
      <header className="kiosk-head">
        <button className="kiosk-back" onClick={onBack}>← Athletes</button>
        <h1>{athlete.firstName} {athlete.lastName}</h1>
      </header>
      <div className="kiosk-grid">
        {items.length === 0 && <div className="muted">No sessions to do — all done! 🎉</div>}
        {items.map((a) => (
          <button key={a.id} className="kiosk-tile" onClick={() => onPick(a.id)}>
            <span className="kiosk-name">{a.workout.name}</span>
            <span className="muted small">{a.status.replace("_", " ")}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function KioskLogger({ id, athleteName, onDone }: { id: string; athleteName: string; onDone: () => void }) {
  const [data, setData] = useState<FullAssignment | null>(null);
  const [logs, setLogs] = useState<Record<string, SetLog>>({});

  useEffect(() => {
    api.get<{ assignment: FullAssignment }>(`/assignments/${id}`).then((r) => {
      setData(r.assignment);
      const map: Record<string, SetLog> = {};
      for (const l of r.assignment.setLogs) map[`${l.workoutItemId}:${l.setNumber}`] = l;
      setLogs(map);
    });
  }, [id]);

  function setField(itemId: string, sn: number, patch: Partial<SetLog>) {
    const key = `${itemId}:${sn}`;
    setLogs((prev) => ({ ...prev, [key]: { ...(prev[key] ?? { workoutItemId: itemId, setNumber: sn, reps: null, loadKg: null, velocity: null, rpe: null, completed: true }), ...patch } }));
  }
  async function finish() {
    const payload = Object.values(logs).filter((l) => l.reps != null || l.loadKg != null || l.velocity != null);
    await api.post(`/assignments/${id}/logs`, { logs: payload });
    await api.post(`/assignments/${id}/complete`);
    onDone();
  }

  if (!data) return <div className="kiosk muted">Loading…</div>;
  return (
    <div className="kiosk">
      <header className="kiosk-head">
        <button className="kiosk-back" onClick={onDone}>← Done</button>
        <h1>{data.workout.name} <span className="muted">· {athleteName}</span></h1>
      </header>
      {data.workout.blocks.map((b) => (
        <div key={b.id} className="kiosk-block">
          <h2>{b.name}</h2>
          {b.items.map((it) => {
            const sets = it.sets ?? 1;
            const tv = it.targets?.targetVelocity ?? null;
            return (
              <div key={it.id} className="kiosk-item">
                <div className="kiosk-ex">{it.exercise.name}
                  {it.targets?.display && <span className="target-text"> · {it.targets.display}</span>}
                </div>
                <div className="kiosk-sets">
                  {Array.from({ length: sets }, (_, i) => i + 1).map((sn) => {
                    const cur = logs[`${it.id}:${sn}`];
                    return (
                      <div key={sn} className="kiosk-set">
                        <span className="kiosk-setnum">Set {sn}</span>
                        <input className="kiosk-input" type="number" inputMode="numeric" placeholder={it.reps ?? "reps"} value={cur?.reps ?? ""} onChange={(e) => setField(it.id, sn, { reps: e.target.value === "" ? null : Number(e.target.value) })} />
                        <input className="kiosk-input" type="number" inputMode="decimal" placeholder={it.targets?.targetLoadKg != null ? `${it.targets.targetLoadKg}kg` : "kg"} value={cur?.loadKg ?? ""} onChange={(e) => setField(it.id, sn, { loadKg: e.target.value === "" ? null : Number(e.target.value) })} />
                        <input className={`kiosk-input ${velClass(cur?.velocity ?? null, tv)}`} type="number" inputMode="decimal" step="0.01" placeholder={tv != null ? `${tv}` : "m/s"} value={cur?.velocity ?? ""} onChange={(e) => setField(it.id, sn, { velocity: e.target.value === "" ? null : Number(e.target.value) })} />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ))}
      <button className="kiosk-finish" onClick={finish}>✓ Finish session</button>
    </div>
  );
}
