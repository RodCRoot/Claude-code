# ▲ Vantage — Athlete Performance Platform

A TeamBuildr-style strength & conditioning platform with a performance-rating
engine at its core. Track athlete testing data (sprint times, Hawkin CMJ,
OVR vertical/drop jumps, strength), see each athlete **rated against peers in
their sport + age group, gym-wide, and research "elite" norms**, build an
exercise library, and program workouts.

This is the foundation build: a real API + database with auth and roles, a
responsive web client, and a working rating engine seeded with demo data.

> The repo also contains a separate, unrelated browser app, **Line Coach**
> (`index.html`, `app.js`, `styles.css`, `LineCoach.html`) — see
> [`docs/line-coach.md`](docs/line-coach.md). Vantage lives in `server/` and `web/`.

---

## Architecture

```
server/   Node + TypeScript + Express + Prisma (SQLite dev → Postgres prod)
          JWT auth · coach/athlete roles · rating engine · CSV import
web/      React + Vite + TypeScript · Recharts · responsive UI
```

API-first by design so a future native mobile app reuses the same endpoints.

### The four pillars (all wired up in this build)

1. **Athlete dashboard** — per-athlete metric trends, a composite **Vantage
   Score**, and per-metric rating cards.
2. **Rating / comparison engine** (`server/src/rating.ts`) — percentile rank
   within configurable cohorts (sport peers · age+sex · gym-wide) plus z-score
   vs. research **elite** benchmarks, rolled into a 0–100 composite + tier
   (Elite / Advanced / Proficient / Developing / Foundational).
3. **Exercise database** — searchable library with video links, categories,
   equipment, and muscle groups.
4. **Workout builder** — blocks → exercises with sets/reps/load/rest, save and
   assign to athletes (TeamBuildr-style). Athletes **log sets/reps/load/RPE**
   from their Training view.

### Coach analytics & reports

- **Team analytics** (`/analytics`, coach-only) — roster overview, a metric
  explorer with team-average **trends**, a **leaderboard** (direction- and
  bodyweight-aware), **biggest movers** (improving/declining), and a
  **workout-compliance** table that flags who's falling behind.
- **Printable athlete report** (`/athletes/:id/report`) — profile, Vantage Score,
  per-metric ratings with sparklines, elite comparison, and training compliance.
  One click to **Print / Save PDF** for parent meetings or recruiting.

### Data in / integrations

- **Manual entry** and **CSV import** (`POST /api/import/metrics-csv`) — drop in
  Hawkin / OVR / timing-gate exports.
- **Device sync** (`server/src/integrations/`) — pluggable **Hawkin Cloud** and
  **OVRtrain** adapters. Set `HAWKIN_API_TOKEN` / `OVR_API_KEY` for live sync, or
  run a **sample import** from the analytics page to try the flow with no
  credentials. Syncs are **idempotent** (deduped by the provider's external id).

---

## Run it locally

Two terminals.

**1) API**
```bash
cd server
cp .env.example .env
npm install
npm run setup     # prisma generate + db push + seed demo data
npm run dev       # http://localhost:4000
```

**2) Web**
```bash
cd web
npm install
npm run dev       # http://localhost:5173 (proxies /api to :4000)
```

### Demo logins
| Role | Email | Password |
| --- | --- | --- |
| Coach | `coach@vantage.dev` | `password123` |
| Athlete | `athlete@vantage.dev` | `password123` |

Coaches see the full roster, can log/import metrics, and build workouts.
Athletes land on their own dashboard.

---

## Rating engine, briefly

For each metric we take an athlete's best value and compute:
- **Cohort percentiles** — where they rank among **sport + position peers**
  (same sport, position, sex, age ±1), sport peers, age+sex across sports, and
  gym-wide. "Lower is better" metrics (sprint times) are inverted so a fast time
  always scores high.
- **Relative strength** — metrics flagged `relativeToBw` (e.g. back squat) are
  divided by bodyweight before comparison, so a 60 kg and a 90 kg athlete are
  judged fairly. Benchmarks for these are in ×bodyweight units.
- **Elite comparison** — the engine picks the **most specific** elite benchmark
  available (sport + position + sex > sport + sex > sex > generic), then reports
  ratio to the elite mean and a z-score → normal-CDF percentile, along with the
  source and a **confidence flag** (HIGH/MEDIUM/LOW; LOW shows as "estimate").

The **composite Vantage Score** is the mean of per-metric scores.

### Tuning the benchmarks
Elite norms live in **`server/prisma/benchmarks.json`** — an editable, cited
dataset keyed by metric/sport/position/sex with `mean`, `sd`, `source`, and
`confidence`. Edit it and re-run `npm run seed`, or manage rows live via the
`/api/benchmarks` admin API. The seeded values are **research-backed drafts
pending review** — adjust before relying on ratings.

---

## Deploy it live
See **[DEPLOY.md](DEPLOY.md)**. Quick paths:
- **Render** — one-click blueprint (`render.yaml`): provisions Postgres + a web
  service, generates `JWT_SECRET`, gives you a public HTTPS URL.
- **Docker** — `docker compose up --build`, then open http://localhost:4000.

In production the server serves the built web client, and the Prisma provider
auto-switches to Postgres based on `DATABASE_URL` (no schema edits needed).

## Roadmap
- [x] Athlete self-logging of completed workouts (set logs).
- [x] Position-aware benchmarks + bodyweight-relative strength rating.
- [ ] Finalize benchmark values with Rod (review the drafts in `benchmarks.json`).
- [ ] Live Hawkin Cloud / OVR API sync workers writing to `MetricRecord`.
- [ ] Match TeamBuildr UI/flows from screenshots.
- [ ] Native mobile app on the existing API.

## API reference (quick)
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/auth/register` · `/login` · GET `/me` | JWT auth |
| GET/POST | `/api/athletes` · GET `/:id` · `/:id/rating` | roster + rating card |
| GET | `/api/metrics/types` · `/series` | catalog + chart series |
| POST | `/api/metrics` | log one result (coach) |
| POST | `/api/import/metrics-csv` | bulk CSV import (coach) |
| GET/POST | `/api/exercises` · GET `/:id` | library |
| GET/POST | `/api/workouts` · GET `/:id` · POST `/:id/assign` | builder + assign |
| GET | `/api/assignments` · GET `/:id` · POST `/:id/logs` · `/:id/complete` | athlete logging |
| GET/POST/DELETE | `/api/benchmarks` | view/edit elite norms |
