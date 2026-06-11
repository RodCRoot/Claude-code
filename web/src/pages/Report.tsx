import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { LineChart, Line, ResponsiveContainer } from "recharts";
import { api } from "../api";
import { ScoreRing } from "./Dashboard";

interface Elite { mean: number; ratio: number; percentileOfElite: number | null; matchedOn: string; }
interface MetricRating {
  metricKey: string; metricName: string; unit: string; relativeToBw: boolean;
  value: number; score: number; elite: Elite | null;
  cohorts: { label: string; n: number; percentile: number | null }[];
}
interface Report {
  athlete: {
    firstName: string; lastName: string; sex: string; sport: string;
    position: string | null; gradYear: number | null; heightCm: number | null;
    weightKg: number | null; orgName: string;
  };
  rating: { compositeScore: number | null; tier: string; ageYears: number; metrics: MetricRating[] };
  history: Record<string, { value: number; recordedAt: string }[]>;
  compliance: { total: number; completed: number; inProgress: number; notStarted: number; completionRate: number;
    recent: { name: string; status: string; assignedDate: string; completedAt: string | null }[] };
  generatedAt: string;
}

export default function ReportPage() {
  const { id } = useParams();
  const [data, setData] = useState<Report | null>(null);

  useEffect(() => { api.get<Report>(`/athletes/${id}/report`).then(setData); }, [id]);
  if (!data) return <div className="muted">Building report…</div>;

  const a = data.athlete;
  const topPeer = (m: MetricRating) => m.cohorts.find((c) => c.percentile != null);

  return (
    <div className="report">
      <div className="report-toolbar no-print">
        <Link className="link-btn" to={`/athletes/${id}`}>← Back to athlete</Link>
        <button onClick={() => window.print()}>Print / Save PDF</button>
      </div>

      <header className="report-head">
        <div>
          <h1>{a.firstName} {a.lastName}</h1>
          <div className="muted">
            {a.sport}{a.position ? ` · ${a.position}` : ""} · {a.sex} · age {data.rating.ageYears}
            {a.gradYear ? ` · Class of ${a.gradYear}` : ""}
          </div>
          <div className="muted small">
            {a.heightCm ? `${a.heightCm} cm` : ""}{a.weightKg ? ` · ${a.weightKg} kg` : ""} · {a.orgName}
          </div>
        </div>
        <div className="composite">
          <ScoreRing score={data.rating.compositeScore} />
          <div>
            <div className="muted small">Vantage Score</div>
            <div className={`tier tier-${data.rating.tier.toLowerCase()}`}>{data.rating.tier}</div>
          </div>
        </div>
      </header>

      <h2 className="section-title">Performance summary</h2>
      <table className="data-table report-metrics">
        <thead>
          <tr><th>Metric</th><th>Best</th><th>Score</th><th>Peer</th><th>vs Elite</th><th>Trend</th></tr>
        </thead>
        <tbody>
          {data.rating.metrics.map((m) => {
            const peer = topPeer(m);
            const series = (data.history[m.metricKey] || []).map((h) => ({ v: h.value }));
            return (
              <tr key={m.metricKey}>
                <td>{m.metricName}</td>
                <td className="num">{m.value}<span className="unit"> {m.unit}</span></td>
                <td className="num"><span className={`tier tier-${tierFor(m.score)}`}>{m.score}</span></td>
                <td className="num">{peer && peer.percentile != null ? `${peer.percentile}th` : "—"}</td>
                <td className="num">{m.elite ? `${Math.round(m.elite.ratio * 100)}%` : "—"}</td>
                <td className="spark">
                  {series.length > 1 ? (
                    <ResponsiveContainer width={90} height={28}>
                      <LineChart data={series}><Line type="monotone" dataKey="v" stroke="#4fd1c5" strokeWidth={1.5} dot={false} isAnimationActive={false} /></LineChart>
                    </ResponsiveContainer>
                  ) : <span className="muted small">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2 className="section-title">Training compliance</h2>
      <div className="grid stat-grid">
        <div className="card stat"><div className="stat-value">{data.compliance.completionRate}%</div><div className="muted small">completed</div></div>
        <div className="card stat"><div className="stat-value">{data.compliance.completed}</div><div className="muted small">workouts done</div></div>
        <div className="card stat"><div className="stat-value">{data.compliance.inProgress}</div><div className="muted small">in progress</div></div>
        <div className="card stat"><div className="stat-value">{data.compliance.notStarted}</div><div className="muted small">not started</div></div>
      </div>
      {data.compliance.recent.length > 0 && (
        <table className="data-table" style={{ marginTop: 12 }}>
          <thead><tr><th>Recent workout</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>
            {data.compliance.recent.map((w, i) => (
              <tr key={i}>
                <td>{w.name}</td>
                <td><span className={`tier tier-${w.status === "COMPLETED" ? "elite" : w.status === "IN_PROGRESS" ? "proficient" : "developing"}`}>{w.status.replace("_", " ")}</span></td>
                <td className="muted small">{new Date(w.completedAt || w.assignedDate).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <footer className="report-foot muted small">
        Generated {new Date(data.generatedAt).toLocaleString()} · Vantage
      </footer>
    </div>
  );
}

function tierFor(score: number) {
  if (score >= 85) return "elite";
  if (score >= 70) return "advanced";
  if (score >= 50) return "proficient";
  if (score >= 30) return "developing";
  return "foundational";
}
