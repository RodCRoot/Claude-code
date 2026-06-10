import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";

interface Athlete {
  id: string;
  firstName: string;
  lastName: string;
  sport: string;
  sex: string;
  position?: string | null;
}
interface Rating {
  athleteId: string;
  compositeScore: number | null;
  tier: string;
}

export default function Dashboard() {
  const { user, athleteId } = useAuth();
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [ratings, setRatings] = useState<Record<string, Rating>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<{ athletes: Athlete[] }>("/athletes").then(async (r) => {
      setAthletes(r.athletes);
      const entries = await Promise.all(
        r.athletes.map((a) =>
          api.get<Rating>(`/athletes/${a.id}/rating`).then((rt) => [a.id, rt] as const).catch(() => null)
        )
      );
      const map: Record<string, Rating> = {};
      for (const e of entries) if (e) map[e[0]] = e[1];
      setRatings(map);
      setLoading(false);
    });
  }, []);

  // Athletes land straight on their own dashboard.
  if (user?.role === "ATHLETE" && athleteId) {
    return <Navigate to={`/athletes/${athleteId}`} replace />;
  }

  if (loading) return <div className="muted">Loading roster…</div>;

  const sorted = [...athletes].sort(
    (a, b) => (ratings[b.id]?.compositeScore ?? 0) - (ratings[a.id]?.compositeScore ?? 0)
  );

  return (
    <div>
      <header className="page-head">
        <h1>Roster</h1>
        <span className="muted">{athletes.length} athletes</span>
      </header>
      <div className="grid">
        {sorted.map((a) => {
          const rt = ratings[a.id];
          return (
            <Link key={a.id} to={`/athletes/${a.id}`} className="card athlete-card">
              <ScoreRing score={rt?.compositeScore ?? null} />
              <div>
                <div className="athlete-name">{a.firstName} {a.lastName}</div>
                <div className="muted small">{a.sport} · {a.sex}</div>
                <div className={`tier tier-${(rt?.tier || "").toLowerCase()}`}>{rt?.tier ?? "Unrated"}</div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function ScoreRing({ score }: { score: number | null }) {
  const v = score ?? 0;
  const hue = Math.round((v / 100) * 130); // red→green
  return (
    <div
      className="ring"
      style={{ background: `conic-gradient(hsl(${hue} 70% 45%) ${v * 3.6}deg, #2a2f3a 0deg)` }}
    >
      <div className="ring-inner">{score === null ? "–" : Math.round(v)}</div>
    </div>
  );
}
