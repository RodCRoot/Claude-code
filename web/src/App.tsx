import { Routes, Route, Navigate, Link, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import AthleteDetail from "./pages/AthleteDetail";
import Exercises from "./pages/Exercises";
import WorkoutBuilder from "./pages/WorkoutBuilder";
import Training from "./pages/Training";

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="center muted">Loading…</div>;
  if (!user) return <Login />;

  return (
    <div className="app">
      <Sidebar />
      <main className="content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/athletes/:id" element={<AthleteDetail />} />
          <Route path="/training" element={<Training />} />
          <Route path="/exercises" element={<Exercises />} />
          <Route path="/workouts" element={<WorkoutBuilder />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Sidebar() {
  const { user, logout } = useAuth();
  const loc = useLocation();
  const isCoach = user?.role === "COACH" || user?.role === "ADMIN";
  const link = (to: string, label: string) => (
    <Link to={to} className={loc.pathname === to ? "nav active" : "nav"}>
      {label}
    </Link>
  );
  return (
    <aside className="sidebar">
      <div className="brand">▲ Vantage</div>
      <nav>
        {link("/", isCoach ? "Roster" : "My Dashboard")}
        {link("/training", "Training")}
        {link("/exercises", "Exercises")}
        {isCoach && link("/workouts", "Workout Builder")}
      </nav>
      <div className="sidebar-foot">
        <div className="user-name">{user?.name}</div>
        <div className="muted small">{user?.role}</div>
        <button className="link-btn" onClick={logout}>Sign out</button>
      </div>
    </aside>
  );
}
