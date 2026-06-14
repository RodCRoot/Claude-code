import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

interface Post {
  id: string; kind: string; title: string; body: string | null;
  metricLabel: string | null; value: number | null; unit: string | null;
  athleteName: string | null; createdAt: string; reactions: number; reacted: boolean;
}

export default function Feed() {
  const { user } = useAuth();
  const isCoach = user?.role === "COACH" || user?.role === "ADMIN";
  const [posts, setPosts] = useState<Post[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  function load() { api.get<{ posts: Post[] }>("/feed").then((r) => setPosts(r.posts)); }
  useEffect(() => { load(); }, []);

  async function announce() {
    if (!title) return;
    await api.post("/feed", { title, body });
    setTitle(""); setBody(""); load();
  }
  async function react(id: string) {
    const r = await api.post<{ reacted: boolean }>(`/feed/${id}/react`);
    setPosts((prev) => prev.map((p) => p.id === id ? { ...p, reacted: r.reacted, reactions: p.reactions + (r.reacted ? 1 : -1) } : p));
  }

  const fmt = (v: number, u: string) => `${v}${u ? (["kg", "cm", "s"].includes(u) ? " " + u : u) : ""}`;

  return (
    <div>
      <header className="page-head"><h1>Team Feed</h1></header>

      {isCoach && (
        <div className="card" style={{ marginBottom: 14 }}>
          <input className="big-input" placeholder="Post an announcement…" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input placeholder="Details (optional)" value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="builder-actions"><button onClick={announce} disabled={!title}>Post</button></div>
        </div>
      )}

      {posts.length === 0 && <div className="muted">No posts yet — log a PR to kick it off! 💪</div>}
      <div className="feed">
        {posts.map((p) => (
          <div key={p.id} className={`card feed-post feed-${p.kind.toLowerCase()}`}>
            <div className="feed-icon">{p.kind === "PR" ? "🎉" : "📣"}</div>
            <div className="feed-body">
              <div className="feed-title">{p.title}</div>
              {p.kind === "PR" && p.metricLabel && (
                <div className="feed-pr">{p.metricLabel}: <strong>{fmt(p.value ?? 0, p.unit ?? "")}</strong></div>
              )}
              {p.body && <div className="muted small">{p.body}</div>}
              <div className="feed-meta">
                <span className="muted small">{new Date(p.createdAt).toLocaleString()}</span>
                <button className={`fist ${p.reacted ? "on" : ""}`} onClick={() => react(p.id)}>👊 {p.reactions > 0 ? p.reactions : ""}</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
