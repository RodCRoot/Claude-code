import { useEffect, useState } from "react";
import { api } from "../api";

interface MetricType { id: string; name: string; unit: string; }
interface ProtocolItem { metricType: MetricType; }
interface Protocol { id: string; name: string; description: string | null; items: ProtocolItem[]; _count: { sessions: number }; }
interface SessionSummary { id: string; date: string; notes: string | null; protocol: { id: string; name: string }; _count: { results: number }; }
interface Athlete { id: string; firstName: string; lastName: string; sport: string; }
interface FullSession {
  id: string; date: string; notes: string | null;
  protocol: { id: string; name: string; items: { metricType: MetricType }[] };
  results: { athleteId: string; metricTypeId: string; value: number }[];
}

const localIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default function Evaluations() {
  const [protocols, setProtocols] = useState<Protocol[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [openSession, setOpenSession] = useState<string | null>(null);
  const [showBuilder, setShowBuilder] = useState(false);

  function load() {
    api.get<{ protocols: Protocol[] }>("/evals/protocols").then((r) => setProtocols(r.protocols));
    api.get<{ sessions: SessionSummary[] }>("/evals/sessions").then((r) => setSessions(r.sessions));
  }
  useEffect(() => { load(); }, []);

  async function runSession(protocolId: string) {
    const r = await api.post<{ session: { id: string } }>("/evals/sessions", { protocolId, date: localIso(new Date()) });
    setOpenSession(r.session.id);
    load();
  }

  if (openSession) return <SessionGrid id={openSession} onClose={() => { setOpenSession(null); load(); }} />;

  return (
    <div>
      <header className="page-head">
        <h1>Evaluations</h1>
        <button onClick={() => setShowBuilder((s) => !s)}>{showBuilder ? "Close" : "+ New protocol"}</button>
      </header>
      <p className="muted small">Build a testing battery once, run it as dated sessions. Results feed ratings, leaderboards and trends automatically.</p>

      {showBuilder && <ProtocolBuilder onCreated={() => { setShowBuilder(false); load(); }} />}

      <div className="goals-list" style={{ marginBottom: 22 }}>
        {protocols.map((p) => (
          <div key={p.id} className="card goal-card">
            <div className="goal-head">
              <span className="goal-label">{p.name}</span>
              <span className="muted small">{p._count.sessions} session{p._count.sessions === 1 ? "" : "s"}</span>
            </div>
            <div className="muted small">{p.items.map((i) => i.metricType.name).join(" · ")}</div>
            {p.description && <div className="muted small">{p.description}</div>}
            <div className="builder-actions">
              <button onClick={() => runSession(p.id)}>▶ Run testing session (today)</button>
            </div>
          </div>
        ))}
        {protocols.length === 0 && !showBuilder && <p className="muted">No protocols yet — build your first testing battery.</p>}
      </div>

      {sessions.length > 0 && (
        <>
          <header className="page-head"><h2>Past sessions</h2></header>
          <table className="data-table">
            <thead><tr><th>Date</th><th>Protocol</th><th>Results</th><th></th></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{new Date(s.date).toLocaleDateString(undefined, { timeZone: "UTC" })}</td>
                  <td>{s.protocol.name}</td>
                  <td className="num">{s._count.results}</td>
                  <td><button className="link-btn" onClick={() => setOpenSession(s.id)}>Open →</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function ProtocolBuilder({ onCreated }: { onCreated: () => void }) {
  const [metrics, setMetrics] = useState<MetricType[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState("");

  useEffect(() => { api.get<{ types: MetricType[] }>("/metrics/types").then((r) => setMetrics(r.types)); }, []);

  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }
  async function save() {
    setErr("");
    try {
      await api.post("/evals/protocols", { name, description: description || undefined, metricTypeIds: picked });
      onCreated();
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="wellness-form">
        <label className="label">Protocol name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring Combine" />
        </label>
        <label className="label">Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Pre-season testing battery" />
        </label>
      </div>
      <div className="muted small" style={{ margin: "10px 0 6px" }}>Tests — tap to add in order:</div>
      <div className="eval-picks">
        {metrics.map((m) => {
          const idx = picked.indexOf(m.id);
          return (
            <button key={m.id} className={`pick ${idx >= 0 ? "picked" : ""}`} onClick={() => toggle(m.id)}>
              {idx >= 0 && <span className="pick-order">{idx + 1}</span>}{m.name}
            </button>
          );
        })}
      </div>
      <div className="builder-actions">
        <button onClick={save} disabled={!name || picked.length === 0}>Create protocol</button>
        {err && <span className="small" style={{ color: "#e06a6a", alignSelf: "center" }}>{err}</span>}
      </div>
    </div>
  );
}

function SessionGrid({ id, onClose }: { id: string; onClose: () => void }) {
  const [session, setSession] = useState<FullSession | null>(null);
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [values, setValues] = useState<Record<string, string>>({}); // `${athleteId}:${metricId}` -> input
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api.get<{ session: FullSession }>(`/evals/sessions/${id}`).then((r) => {
      setSession(r.session);
      const v: Record<string, string> = {};
      for (const res of r.session.results) v[`${res.athleteId}:${res.metricTypeId}`] = String(res.value);
      setValues(v);
    });
    api.get<{ athletes: Athlete[] }>("/athletes").then((r) => setAthletes(r.athletes));
  }, [id]);

  async function save() {
    if (!session) return;
    setMsg("");
    const results = Object.entries(values)
      .filter(([, v]) => v !== "" && !Number.isNaN(Number(v)))
      .map(([k, v]) => {
        const [athleteId, metricTypeId] = k.split(":");
        return { athleteId, metricTypeId, value: Number(v) };
      });
    if (!results.length) { setMsg("Nothing to save yet"); return; }
    const r = await api.post<{ saved: number }>(`/evals/sessions/${id}/results`, { results });
    setMsg(`Saved ${r.saved} results ✓`);
  }

  if (!session) return <div className="muted">Loading…</div>;
  const cols = session.protocol.items.map((i) => i.metricType);

  return (
    <div>
      <header className="page-head">
        <button className="secondary" onClick={onClose}>← Evaluations</button>
        <h1>{session.protocol.name} <span className="muted">· {new Date(session.date).toLocaleDateString(undefined, { timeZone: "UTC" })}</span></h1>
      </header>
      <div className="table-scroll">
        <table className="data-table eval-grid">
          <thead>
            <tr>
              <th>Athlete</th>
              {cols.map((c) => <th key={c.id} className="num">{c.name}{c.unit ? ` (${c.unit})` : ""}</th>)}
            </tr>
          </thead>
          <tbody>
            {athletes.map((a) => (
              <tr key={a.id}>
                <td>{a.firstName} {a.lastName} <span className="muted small">{a.sport}</span></td>
                {cols.map((c) => {
                  const k = `${a.id}:${c.id}`;
                  return (
                    <td key={c.id} className="num">
                      <input
                        className="eval-cell"
                        type="number"
                        step="0.01"
                        value={values[k] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="builder-actions" style={{ marginTop: 12 }}>
        <button onClick={save}>Save results</button>
        {msg && <span className="muted small" style={{ alignSelf: "center" }}>{msg}</span>}
      </div>
    </div>
  );
}
