import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

interface Option { kind: "METRIC" | "E1RM"; key: string; label: string; unit: string; }
interface Options { metrics: Option[]; exercises: Option[]; ageGroups: string[]; sexes: string[]; }
interface Row { athleteId: string; name: string; sex: string; ageGroup: string; value: number; recordedAt: string; }
interface Board { kind: string; key: string; label: string; unit: string; higherIsBetter: boolean; rows: Row[]; }

export default function Leaderboards() {
  const { athleteId } = useAuth();
  const [opts, setOpts] = useState<Options | null>(null);
  const [sel, setSel] = useState<Option | null>(null);
  const [ageGroup, setAgeGroup] = useState("");
  const [sex, setSex] = useState("");
  const [board, setBoard] = useState<Board | null>(null);

  useEffect(() => {
    api.get<Options>("/leaderboards/options").then((o) => {
      setOpts(o);
      setSel(o.metrics[0] ?? o.exercises[0] ?? null);
    });
  }, []);

  useEffect(() => {
    if (!sel) return;
    const q = new URLSearchParams({ kind: sel.kind, key: sel.key });
    if (ageGroup) q.set("ageGroup", ageGroup);
    if (sex) q.set("sex", sex);
    api.get<Board>(`/leaderboards?${q.toString()}`).then(setBoard);
  }, [sel, ageGroup, sex]);

  const allOptions = useMemo(() => (opts ? [...opts.metrics, ...opts.exercises] : []), [opts]);
  const fmt = (v: number, u: string) => `${v}${u ? (["kg", "cm", "s"].includes(u) ? " " + u : u) : ""}`;

  return (
    <div>
      <header className="page-head"><h1>Leaderboards</h1></header>

      <div className="card">
        <div className="filters">
          <select value={sel ? `${sel.kind}:${sel.key}` : ""} onChange={(e) => setSel(allOptions.find((o) => `${o.kind}:${o.key}` === e.target.value) ?? null)}>
            <optgroup label="Tests">
              {opts?.metrics.map((m) => <option key={m.key} value={`METRIC:${m.key}`}>{m.label}</option>)}
            </optgroup>
            <optgroup label="Lifts (e1RM)">
              {opts?.exercises.map((m) => <option key={m.key} value={`E1RM:${m.key}`}>{m.label}</option>)}
            </optgroup>
          </select>
          <select value={ageGroup} onChange={(e) => setAgeGroup(e.target.value)}>
            <option value="">All ages</option>
            {opts?.ageGroups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <select value={sex} onChange={(e) => setSex(e.target.value)}>
            <option value="">All</option>
            <option value="M">Boys</option>
            <option value="F">Girls</option>
          </select>
        </div>

        <table className="data-table" style={{ marginTop: 12 }}>
          <thead><tr><th>#</th><th>Athlete</th><th>Age</th><th className="num">{board?.label ?? "Value"}</th></tr></thead>
          <tbody>
            {board?.rows.map((r, i) => (
              <tr key={r.athleteId} className={r.athleteId === athleteId ? "me-row" : ""}>
                <td className="muted">{i + 1}</td>
                <td>{r.name}{r.athleteId === athleteId && <span className="badge" style={{ marginLeft: 6 }}>you</span>}</td>
                <td className="muted small">{r.ageGroup} · {r.sex === "M" ? "B" : "G"}</td>
                <td className="num">{fmt(r.value, board.unit)}</td>
              </tr>
            ))}
            {board && board.rows.length === 0 && <tr><td colSpan={4} className="muted">No data for this filter yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
