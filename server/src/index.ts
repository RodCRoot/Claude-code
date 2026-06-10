import "dotenv/config";
import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth";
import { athletesRouter } from "./routes/athletes";
import { metricsRouter } from "./routes/metrics";
import { importRouter } from "./routes/import";
import { exercisesRouter } from "./routes/exercises";
import { workoutsRouter } from "./routes/workouts";

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

// Fallback error handler.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`Vantage API listening on http://localhost:${port}`));
