import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";

interface CalAssignment {
  id: string; date: string; status: string;
  workout: { id: string; name: string };
  athlete: { id: string; name: string };
}

function mondayOf(d: Date): Date {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}
// Local calendar day — toISOString would jump to tomorrow in evening sessions.
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default function Schedule() {
  const { user } = useAuth();
  const nav = useNavigate();
  const isCoach = user?.role === "COACH" || user?.role === "ADMIN";
  const [weekStart, setWeekStart] = useState(mondayOf(new Date()));
  const [items, setItems] = useState<CalAssignment[]>([]);
  const [copyFrom, setCopyFrom] = useState<string | null>(null); // iso date being copied
  const [busy, setBusy] = useState(false);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(d.getDate() + i); return d; }), [weekStart]);

  function load() {
    const from = iso(weekStart);
    const to = iso(days[6]);
    api.get<{ assignments: CalAssignment[] }>(`/assignments/calendar?from=${from}&to=${to}`).then((r) => setItems(r.assignments));
  }
  useEffect(() => { load(); }, [weekStart]);

  async function pasteTo(toIso: string) {
    if (!copyFrom || busy) return;
    setBusy(true);
    try {
      await api.post("/assignments/copy-day", { fromDate: copyFrom, toDates: [toIso] });
      setCopyFrom(null);
      load();
    } finally { setBusy(false); }
  }

  const byDate = useMemo(() => {
    const m: Record<string, CalAssignment[]> = {};
    for (const a of items) (m[a.date] ||= []).push(a);
    return m;
  }, [items]);

  const todayIso = iso(new Date());

  return (
    <div>
      <header className="page-head">
        <h1>Schedule</h1>
        <div className="filters">
          <button className="secondary" onClick={() => setWeekStart((w) => { const d = new Date(w); d.setDate(d.getDate() - 7); return d; })}>← Prev</button>
          <button className="secondary" onClick={() => setWeekStart(mondayOf(new Date()))}>This week</button>
          <button className="secondary" onClick={() => setWeekStart((w) => { const d = new Date(w); d.setDate(d.getDate() + 7); return d; })}>Next →</button>
        </div>
      </header>

      <div className="week-grid">
        {days.map((d) => {
          const key = iso(d);
          const list = byDate[key] ?? [];
          return (
            <div key={key} className={`card day-col ${key === todayIso ? "day-today" : ""} ${copyFrom === key ? "day-copysrc" : ""}`}>
              <div className="day-head">
                <span className="day-name">{d.toLocaleDateString(undefined, { weekday: "short" })}</span>
                <span className="muted small">{d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
              </div>
              {isCoach && (
                <div className="day-actions">
                  {copyFrom === null && list.length > 0 && (
                    <button className="link-btn" title="Copy this day's sessions" onClick={() => setCopyFrom(key)}>⧉ Copy day</button>
                  )}
                  {copyFrom === key && (
                    <button className="link-btn copying" onClick={() => setCopyFrom(null)}>Copying — pick a day ✕</button>
                  )}
                  {copyFrom !== null && copyFrom !== key && (
                    <button className="link-btn paste" disabled={busy} onClick={() => pasteTo(key)}>↳ Paste here</button>
                  )}
                </div>
              )}
              {list.length === 0 && <div className="muted small day-empty">—</div>}
              {isCoach ? <CoachDay list={list} /> : (
                list.map((a) => (
                  <button key={a.id} className="day-item as-button" onClick={() => nav(`/training?open=${a.id}`)}>
                    <span className="metric-name">{a.workout.name}</span>
                    <span className={`tier tier-${a.status === "COMPLETED" ? "elite" : a.status === "IN_PROGRESS" ? "proficient" : "developing"}`}>{a.status.replace("_", " ")}</span>
                  </button>
                ))
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Coach view: collapse a day's assignments by workout with an athlete count.
function CoachDay({ list }: { list: CalAssignment[] }) {
  const byWorkout: Record<string, { name: string; total: number; done: number }> = {};
  for (const a of list) {
    const w = (byWorkout[a.workout.id] ||= { name: a.workout.name, total: 0, done: 0 });
    w.total++;
    if (a.status === "COMPLETED") w.done++;
  }
  return (
    <>
      {Object.entries(byWorkout).map(([id, w]) => (
        <div key={id} className="day-item">
          <span className="metric-name">{w.name}</span>
          <span className="muted small">{w.done}/{w.total} done</span>
        </div>
      ))}
    </>
  );
}
