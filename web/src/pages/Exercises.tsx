import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

interface Exercise {
  id: string; name: string; description?: string | null; videoUrl?: string | null;
  category: string; equipment?: string | null; muscleGroups: string[]; tags: string[];
}

const CATEGORIES = ["LOWER", "UPPER", "OLYMPIC", "PLYO", "CORE", "CONDITIONING"];

export default function Exercises() {
  const { user } = useAuth();
  const isCoach = user?.role !== "ATHLETE";
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [adding, setAdding] = useState(false);

  function load() {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (cat) params.set("category", cat);
    api.get<{ exercises: Exercise[] }>(`/exercises?${params}`).then((r) => setExercises(r.exercises));
  }
  useEffect(() => { load(); }, [q, cat]);

  return (
    <div>
      <header className="page-head">
        <h1>Exercise Library</h1>
        {isCoach && <button onClick={() => setAdding(true)}>+ New Exercise</button>}
      </header>
      <div className="filters">
        <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {adding && <NewExercise onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}

      <div className="grid">
        {exercises.map((e) => (
          <div key={e.id} className="card exercise-card">
            {e.videoUrl && (
              <a className="thumb" href={e.videoUrl} target="_blank" rel="noreferrer">▶ Video</a>
            )}
            <div className="exercise-name">{e.name}</div>
            <div className="muted small">{e.category}{e.equipment ? ` · ${e.equipment}` : ""}</div>
            {e.description && <p className="exercise-desc">{e.description}</p>}
            <div className="chips">
              {e.muscleGroups.map((m) => <span key={m} className="chip">{m}</span>)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NewExercise({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("LOWER");
  const [videoUrl, setVideoUrl] = useState("");
  const [equipment, setEquipment] = useState("");
  const [description, setDescription] = useState("");
  const [muscleGroups, setMuscleGroups] = useState("");
  const [err, setErr] = useState("");

  async function save() {
    setErr("");
    try {
      await api.post("/exercises", {
        name, category, videoUrl: videoUrl || undefined, equipment: equipment || undefined,
        description: description || undefined,
        muscleGroups: muscleGroups ? muscleGroups.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      });
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <h2>New Exercise</h2>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label>Video URL<input value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://…" /></label>
        <label>Equipment<input value={equipment} onChange={(e) => setEquipment(e.target.value)} /></label>
        <label>Muscle groups (comma-separated)<input value={muscleGroups} onChange={(e) => setMuscleGroups(e.target.value)} /></label>
        <label>Description<textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        {err && <div className="error">{err}</div>}
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
