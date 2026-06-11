# Deploying Vantage

Two ways to get a live, clickable instance. Both serve the API **and** the web
app from one URL, with a Postgres database, and seed demo logins on first boot:

- **Coach:** `coach@vantage.dev` / `password123`
- **Athlete:** `athlete@vantage.dev` / `password123`

> Demo data only seeds when the database is empty, so redeploys never wipe real
> data. (To force a reseed, set `FORCE_SEED=1`.)

---

## Option A — Render (easiest, hosted, free tier)

This repo includes a Render blueprint (`render.yaml`) that provisions a Postgres
database and a web service automatically.

1. Push this branch to GitHub (already done).
2. Go to **https://render.com** and sign up (free).
3. **New → Blueprint**, connect your GitHub, pick the `RodCRoot/claude-code` repo.
4. Render reads `render.yaml`, shows a database + a web service → click **Apply**.
5. Wait for the build (~3–5 min). When it's live, open the service URL.

That's it — a public URL you can open on your phone or share with a coach.
The `JWT_SECRET` is generated for you; `DATABASE_URL` is wired to the database.

To update later: push to the branch and Render redeploys automatically.

---

## Option B — Docker (run it on your own machine or a VPS)

Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```bash
docker compose up --build
```

Open **http://localhost:4000**. This starts Postgres + the app together and
seeds the demo logins. Stop with `Ctrl+C`; data persists in a Docker volume.

For a real server, set a strong `JWT_SECRET` in `docker-compose.yml` (or your
host's env) before exposing it to the internet.

---

## Option C — Local dev (no Docker, SQLite)

Fastest for editing code. Two terminals:

```bash
cd server && cp .env.example .env && npm install && npm run setup && npm run dev
cd web && npm install && npm run dev   # open http://localhost:5173
```

---

## Notes & next steps for production hardening
- **Custom domain / HTTPS:** Render gives you HTTPS automatically; add a custom
  domain in its dashboard.
- **Secrets:** never commit a real `JWT_SECRET`; use the host's env settings.
- **Backups:** enable automatic Postgres backups on your host before real use.
- **Migrations:** this build uses `prisma db push` for simplicity. For a team,
  switch to `prisma migrate` so schema changes are versioned.
