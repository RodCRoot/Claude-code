import "dotenv/config";
import path from "path";
import fs from "fs";
import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth";
import { athletesRouter } from "./routes/athletes";
import { metricsRouter } from "./routes/metrics";
import { importRouter } from "./routes/import";
import { exercisesRouter } from "./routes/exercises";
import { workoutsRouter } from "./routes/workouts";
import { assignmentsRouter } from "./routes/assignments";
import { benchmarksRouter } from "./routes/benchmarks";
import { analyticsRouter } from "./routes/analytics";
import { integrationsRouter } from "./routes/integrations";
import { meRouter } from "./routes/me";
import { leaderboardsRouter } from "./routes/leaderboards";
import { groupsRouter } from "./routes/groups";
import { feedRouter } from "./routes/feed";
import { messagesRouter } from "./routes/messages";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
// CSV import endpoint accepts raw text bodies.
app.use(express.text({ type: ["text/csv", "text/plain"], limit: "5mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "vantage" }));

app.use("/api/auth", authRouter);
app.use("/api/athletes", athletesRouter);
app.use("/api/metrics", metricsRouter);
app.use("/api/import", importRouter);
app.use("/api/exercises", exercisesRouter);
app.use("/api/workouts", workoutsRouter);
app.use("/api/assignments", assignmentsRouter);
app.use("/api/benchmarks", benchmarksRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/integrations", integrationsRouter);
app.use("/api/me", meRouter);
app.use("/api/leaderboards", leaderboardsRouter);
app.use("/api/groups", groupsRouter);
app.use("/api/feed", feedRouter);
app.use("/api/messages", messagesRouter);

// In production, serve the built web client and let the SPA handle routing.
// WEB_DIST can override the location; default points at the monorepo web build.
const webDist = process.env.WEB_DIST || path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(path.join(webDist, "index.html"))) {
  app.use(express.static(webDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(webDist, "index.html"));
  });
  console.log(`Serving web client from ${webDist}`);
}

// Fallback error handler.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`Vantage API listening on http://localhost:${port}`));
