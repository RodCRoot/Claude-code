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
   assign to athletes (TeamBuildr-style).

### Data in / integrations

- **Manual entry** and **CSV import** (`POST /api/import/metrics-csv`) work today
  — drop in Hawkin / OVR / timing-gate exports.
- The data model is **integration-ready**: `MetricRecord.source` + `rawJson`
  fields are there for live **Hawkin Cloud / OVR** API syncs to populate later
  without schema changes.

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
- **Cohort percentiles** — where they rank among sport peers (same sport, sex,
  age ±1), among age+sex across sports, and gym-wide. "Lower is better" metrics
  (sprint times) are inverted so a fast time always scores high.
- **Elite comparison** — ratio to the elite mean and, when a standard deviation
  is known, a z-score → normal-CDF percentile.

The **composite Vantage Score** is the mean of per-metric scores. Elite norms
seeded in `prisma/seed.ts` are **placeholders** — swap in cited research values
(stored in the `Benchmark` table, filterable by sport/sex/age) to make ratings
authoritative.

---

## Going to production
- Switch Prisma `provider` to `postgresql` and point `DATABASE_URL` at Postgres
  (`prisma migrate deploy`). No model changes needed.
- Set a strong `JWT_SECRET`.
- Build: `npm run build` in each of `server/` and `web/`; serve the web `dist/`
  behind the API or a CDN.

## Roadmap (next)
- Live Hawkin Cloud / OVR API sync workers writing to `MetricRecord`.
- Athlete self-logging of completed workouts (set logs).
- Native mobile app on the existing API.
- Richer benchmark dataset + per-position norms.

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
