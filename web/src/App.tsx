import { Routes, Route, Navigate, Link, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import AthleteDetail from "./pages/AthleteDetail";
import Exercises from "./pages/Exercises";
import WorkoutBuilder from "./pages/WorkoutBuilder";
import Training from "./pages/Training";
import Analytics from "./pages/Analytics";
import ReportPage from "./pages/Report";
import Today from "./pages/Today";
import Leaderboards from "./pages/Leaderboards";
import Groups from "./pages/Groups";
import Schedule from "./pages/Schedule";
import Feed from "./pages/Feed";
import Messages from "./pages/Messages";
import GymMode from "./pages/GymMode";
import Wellness from "./pages/Wellness";
import Goals from "./pages/Goals";

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="center muted">Loading…</div>;
  if (!user) return <Login />;
  const isCoach = user.role === "COACH" || user.role === "ADMIN";

  return (
    <div className="app">
      <Sidebar />
      <main className="content">
        <Routes>
          <Route path="/" element={isCoach ? <Dashboard /> : <Today />} />
          <Route path="/athletes/:id" element={<AthleteDetail />} />
          <Route path="/athletes/:id/report" element={<ReportPage />} />
          <Route path="/leaderboards" element={<Leaderboards />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/feed" element={<Feed />} />
          <Route path="/wellness" element={<Wellness />} />
          <Route path="/goals" element={<Goals />} />
          <Route path="/messages" element={<Messages />} />
          <Route path="/training" element={<Training />} />
          <Route path="/exercises" element={<Exercises />} />
          {isCoach && <Route path="/workouts" element={<WorkoutBuilder />} />}
          {isCoach && <Route path="/groups" element={<Groups />} />}
          {isCoach && <Route path="/gym" element={<GymMode />} />}
          {isCoach && <Route path="/analytics" element={<Analytics />} />}
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
        {link("/feed", "Team Feed")}
        {link("/messages", "Messages")}
        {isCoach && link("/analytics", "Analytics")}
        {link("/leaderboards", "Leaderboards")}
        {link("/schedule", "Schedule")}
        {link("/training", "Training")}
        {link("/wellness", isCoach ? "Readiness" : "Check-in")}
        {link("/goals", "Goals")}
        {link("/exercises", "Exercises")}
        {isCoach && link("/workouts", "Workout Builder")}
        {isCoach && link("/groups", "Teams & Groups")}
        {isCoach && link("/gym", "Gym Mode")}
      </nav>
      <div className="sidebar-foot">
        <div className="user-name">{user?.name}</div>
        <div className="muted small">{user?.role}</div>
        <button className="link-btn" onClick={logout}>Sign out</button>
      </div>
    </aside>
  );
}
