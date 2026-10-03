import { useEffect, useState } from "react";
import { api } from "../api";

// GymAware / VBT device CSV import. Two-step: dry-run preview (see exactly
// which athletes/exercises/sets matched), then confirm to write.

interface ImportedSet { setNumber: number; reps: number | null; loadKg: number | null; velocity: number | null; peakVelocity: number | null; }
interface PreviewSession { athleteId: string; athlete: string; date: string; exercises: { exercise: string; sets: ImportedSet[] }[]; }
interface Preview { sessions: PreviewSession[]; skipped: { row: number; reason: string }[]; wouldImportSets: number; detected: Record<string, string>; }
interface Result { imported: { sessions: number; sets: number }; maxUpdates: { athlete: string; exercise: string; e1rmKg: number }[]; skipped: { row: number; reason: string }[]; }
interface Athlete { id: string; firstName: string; lastName: string; }

interface IntegrationInfo {
  key: string; name: string; configured: boolean; region: string | null; regions: string[];
  tokenMasked: string | null; autoSync: boolean; lastSyncAt: string | null; lastSyncNote: string | null;
}

function Integrations() {
  const [items, setItems] = useState<IntegrationInfo[]>([]);
  const [token, setToken] = useState("");
  const [region, setRegion] = useState("americas");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  function load() { api.get<{ integrations: IntegrationInfo[] }>("/integrations").then((r) => setItems(r.integrations)); }
  useEffect(() => { load(); }, []);

  const hawkin = items.find((i) => i.key === "HAWKIN");

  async function save() {
    setMsg(""); setBusy(true);
    try {
      await api.put("/integrations/HAWKIN/config", { refreshToken: token || undefined, region });
      setToken("");
      setMsg("Saved ✓ — now hit Sync");
      load();
    } catch (e) { setMsg(e instanceof Error ? e.message : "Save failed"); }
    finally { setBusy(false); }
  }
  async function sync(sample: boolean) {
    setMsg(""); setBusy(true);
    try {
      const r = await api.post<{ created: number; skipped: number; unmatchedNames: string[]; mode: string }>(
        "/integrations/HAWKIN/sync", sample ? { sample: true } : {});
      setMsg(`${r.mode === "sample" ? "Sample sync" : "Sync"}: ${r.created} new results${r.unmatchedNames.length ? ` · unmatched: ${r.unmatchedNames.join(", ")}` : ""}`);
      load();
    } catch (e) { setMsg(e instanceof Error ? e.message : "Sync failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="chart-head"><h2>Hawkin Dynamics force plates</h2>
        {hawkin?.tokenMasked && <span className="muted small">token {hawkin.tokenMasked} · {hawkin.region} {hawkin.lastSyncAt ? `· last sync ${new Date(hawkin.lastSyncAt).toLocaleString()}` : ""}</span>}
      </div>
      <p className="muted small">
        Jump tests, RSI, peak power and body mass sync straight from Hawkin Cloud — body mass then powers ×BW relative
        strength. Create a refresh token in <strong>Hawkin Cloud → Settings → Integrations</strong>, paste it here once;
        after that Vantage syncs automatically every hour (plus the button below).
      </p>
      <div className="wellness-form">
        <label className="label">Refresh token {hawkin?.tokenMasked && <span className="muted small">(saved — paste to replace)</span>}
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="paste Hawkin refresh token" />
        </label>
        <label className="label">Region
          <select value={region} onChange={(e) => setRegion(e.target.value)}>
            {["americas", "europe", "apac"].map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
      </div>
      <div className="builder-actions">
        <button className="secondary" onClick={save} disabled={busy || (!token && !hawkin?.tokenMasked)}>Save</button>
        <button onClick={() => sync(false)} disabled={busy || !hawkin?.configured}>⟳ Sync now</button>
        <button className="secondary" onClick={() => sync(true)} disabled={busy}>Try with sample data</button>
        {msg && <span className="muted small" style={{ alignSelf: "center" }}>{msg}</span>}
      </div>
      {hawkin?.lastSyncNote && <div className="muted small" style={{ marginTop: 6 }}>{hawkin.lastSyncNote}</div>}
    </div>
  );
}

export default function DataImport() {
  const [csv, setCsv] = useState("");
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [forceAthlete, setForceAthlete] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get<{ athletes: Athlete[] }>("/athletes").then((r) => setAthletes(r.athletes)); }, []);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    f.text().then((t) => { setCsv(t); setPreview(null); setResult(null); });
  }

  const qs = forceAthlete ? `&athleteId=${forceAthlete}` : "";

  async function runPreview() {
    setErr(""); setResult(null); setBusy(true);
    try {
      setPreview(await api.postCsv<Preview>(`/import/vbt-csv?dryRun=1${qs}`, csv));
    } catch (e) { setErr(e instanceof Error ? e.message : "Preview failed"); }
    finally { setBusy(false); }
  }

  async function confirm() {
    setErr(""); setBusy(true);
    try {
      setResult(await api.postCsv<Result>(`/import/vbt-csv?x=1${qs}`, csv));
      setPreview(null);
    } catch (e) { setErr(e instanceof Error ? e.message : "Import failed"); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <header className="page-head"><h1>Devices & Data</h1></header>
      <Integrations />
      <p className="muted small">
        Export a session as CSV from the GymAware app (no cloud subscription needed) and upload it here.
        Sets land in the athlete's training history with bar speeds; sessions with multiple loads refresh
        their load-velocity e1RM (and can set PRs). Columns are auto-detected — preview before importing.
      </p>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="wellness-form">
          <label className="label">CSV file
            <input type="file" accept=".csv,text/csv" onChange={onFile} />
          </label>
          <label className="label">Whole file is one athlete? <span className="muted small">(optional — used when the CSV has no athlete column)</span>
            <select value={forceAthlete} onChange={(e) => setForceAthlete(e.target.value)}>
              <option value="">No — match by name column</option>
              {athletes.map((a) => <option key={a.id} value={a.id}>{a.firstName} {a.lastName}</option>)}
            </select>
          </label>
        </div>
        <label className="label" style={{ marginTop: 8 }}>…or paste CSV text
          <textarea rows={5} value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); setResult(null); }} placeholder={"Athlete,Exercise,Date,Set,Reps,Weight (kg),Mean Velocity (m/s),Peak Velocity (m/s)\nJordan Smith,Back Squat,2026-07-06,1,3,80,0.62,0.95"} />
        </label>
        <div className="builder-actions">
          <button className="secondary" disabled={!csv.trim() || busy} onClick={runPreview}>Preview (dry run)</button>
          {preview && <button disabled={busy} onClick={confirm}>✓ Import {preview.wouldImportSets} sets</button>}
          {err && <span className="small" style={{ color: "#e06a6a", alignSelf: "center" }}>{err}</span>}
        </div>
      </div>

      {preview && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>Preview</h2>
          {preview.sessions.map((s) => (
            <div key={s.athleteId + s.date} className="kiosk-block" style={{ marginTop: 10 }}>
              <strong>{s.athlete}</strong> <span className="muted small">· {s.date}</span>
              {s.exercises.map((ex) => (
                <div key={ex.exercise} className="muted small" style={{ marginTop: 4 }}>
                  {ex.exercise}: {ex.sets.map((st) => `${st.reps ?? "?"}×${st.loadKg ?? "?"}kg${st.velocity != null ? ` @${st.velocity.toFixed(2)}m/s` : ""}`).join(" · ")}
                </div>
              ))}
            </div>
          ))}
          {preview.skipped.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <strong className="txt-risk">{preview.skipped.length} rows skipped</strong>
              <ul className="muted small">
                {preview.skipped.slice(0, 8).map((s, i) => <li key={i}>Row {s.row}: {s.reason}</li>)}
                {preview.skipped.length > 8 && <li>…and {preview.skipped.length - 8} more</li>}
              </ul>
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="card">
          <h2>Imported ✓</h2>
          <p>{result.imported.sessions} session{result.imported.sessions === 1 ? "" : "s"}, {result.imported.sets} sets written to training history.</p>
          {result.maxUpdates.length > 0 && (
            <>
              <strong>e1RM profiles updated:</strong>
              <ul className="muted small">
                {result.maxUpdates.map((m, i) => <li key={i}>{m.athlete} — {m.exercise}: <strong>{m.e1rmKg}kg</strong></li>)}
              </ul>
            </>
          )}
          {result.skipped.length > 0 && <p className="muted small">{result.skipped.length} rows skipped.</p>}
        </div>
      )}
    </div>
  );
}
