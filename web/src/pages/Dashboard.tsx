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
interface AdherenceRow {
  athleteId: string; name: string; sport: string;
  weeks: number[]; completedInWindow: number; assignedInWindow: number;
  completionRate: number | null; daysSinceLast: number | null; atRisk: boolean;
}
interface Adherence { weekLabels: string[]; weekCount: number; atRiskCount: number; rows: AdherenceRow[]; }

export default function Dashboard() {
  const { user, athleteId } = useAuth();
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [ratings, setRatings] = useState<Record<string, Rating>>({});
  const [adherence, setAdherence] = useState<Adherence | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user?.role === "ATHLETE") return;
    api.get<Adherence>("/analytics/adherence?weeks=4").then(setAdherence).catch(() => {});
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
  }, [user]);

  // Athletes land straight on their own dashboard.
  if (user?.role === "ATHLETE" && athleteId) {
    return <Navigate to={`/athletes/${athleteId}`} replace />;
  }

  if (loading) return <div className="muted">Loading…</div>;

  const sorted = [...athletes].sort(
    (a, b) => (ratings[b.id]?.compositeScore ?? 0) - (ratings[a.id]?.compositeScore ?? 0)
  );

  return (
    <div>
      <header className="page-head">
        <h1>Coach Home</h1>
        <span className="muted">{athletes.length} athletes</span>
      </header>

      {adherence && <AdherenceBoard data={adherence} />}

      <header className="page-head" style={{ marginTop: 28 }}>
        <h2>Roster</h2>
        <span className="muted small">by composite rating</span>
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

function heat(n: number): string {
  if (n <= 0) return "transparent";
  const cap = Math.min(n, 5);
  return `hsl(150 55% ${22 + cap * 5}%)`; // brighter green with more volume
}

function AdherenceBoard({ data }: { data: Adherence }) {
  const [showAll, setShowAll] = useState(false);
  const flagged = data.rows.filter((r) => r.atRisk);
  // Show flagged-only by default; fall back to everyone if nobody is flagged.
  const visible = showAll ? data.rows : (flagged.length ? flagged : data.rows);

  return (
    <div className="card">
      <div className="chart-head" style={{ marginBottom: 10 }}>
        <h2>Adherence — who's training & who's fallen off</h2>
        <div className="filters">
          {data.atRiskCount > 0 && <span className="pill pill-risk">{data.atRiskCount} need attention</span>}
          <button className="secondary" onClick={() => setShowAll((s) => !s)}>
            {showAll ? "Show flagged only" : "Show all athletes"}
          </button>
        </div>
      </div>
      <div className="table-scroll">
        <table className="data-table adherence-table">
          <thead>
            <tr>
              <th>Athlete</th>
              {data.weekLabels.map((w, i) => (
                <th key={i} className="num">{w}{i === data.weekLabels.length - 1 ? " (now)" : ""}</th>
              ))}
              <th className="num">Rate</th>
              <th>Last session</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.athleteId} className={r.atRisk ? "row-risk" : ""}>
                <td><Link to={`/athletes/${r.athleteId}`}>{r.name}</Link> <span className="muted small">{r.sport}</span></td>
                {r.weeks.map((n, i) => (
                  <td key={i} className="num cell-heat" style={{ background: heat(n) }}>{n || "·"}</td>
                ))}
                <td className="num">{r.completionRate == null ? "—" : `${r.completionRate}%`}</td>
                <td className={r.atRisk ? "txt-risk" : "muted"}>
                  {r.daysSinceLast == null ? "never" : r.daysSinceLast === 0 ? "today" : `${r.daysSinceLast}d ago`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
