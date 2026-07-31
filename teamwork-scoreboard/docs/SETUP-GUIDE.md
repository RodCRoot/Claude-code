# Owner's Setup Guide — Teamwork Bloomington Scoreboard

This is the complete, in-order checklist of everything **you** need to do to
take the scoreboard from this repository to a live system your team uses
every day. Nothing here requires programming — where a command is needed,
it's written out exactly.

Rough time budget: **Phase 1 ≈ 15 min · Phase 2 ≈ 30–60 min · Phase 3 ≈ 30 min ·
Phase 4 ≈ 45 min · Phases 5–7 ≈ 30 min total.**

---

## Phase 1 — Try it on your own computer (15 minutes)

Goal: click around the app with sample data before committing to anything.

1. **Install Node.js 20 or newer** from <https://nodejs.org> (choose "LTS").
2. **Get the code.** Either download the repository as a ZIP from GitHub
   (green "Code" button → Download ZIP) or, if you have git:
   ```bash
   git clone https://github.com/RodCRoot/Claude-code.git
   cd Claude-code/teamwork-scoreboard
   ```
   *(If the branch hasn't been merged yet, switch to
   `claude/teamwork-bloomington-scoreboard-uyxr2c` or download the ZIP of
   that branch.)*
3. **Install and start:**
   ```bash
   npm install
   npm run db:seed
   npm run dev
   ```
4. Open <http://localhost:3000> and sign in as
   **rod@teamworkbloomington.com** / **teamwork1**.
5. Explore with the demo data: Today, Scoreboard, Team Scorecards, a 5-15,
   the Operations and Facility checklists, Onboarding, Marketing & 3R,
   Data & Sync, and Admin. Everything you see is editable in Admin later.

✅ Done when: you can log in and every page shows sample data.

---

## Phase 2 — Put it on a server (so it runs 24/7)

Goal: a permanent address like `https://scoreboard.teamworkbloomington.com`
that your staff can use from any phone, and that can run the nightly Zen
Planner pull. Sample data is fine to leave on during this phase.

You need any small host that gives you **Docker + a persistent disk**. Good
choices: a $6–12/month VPS (DigitalOcean, Hetzner, Linode), or
Railway/Render/Fly.io (each supports Docker deploys with a volume). If a
friend or contractor manages servers for you, this phase is a one-coffee
favor — send them this file.

**The Docker route (recommended — Chromium for the Zen Planner sync is
pre-installed in the image):**

1. On the server, install Docker (<https://docs.docker.com/engine/install/>).
2. Copy the `teamwork-scoreboard` folder to the server (git clone or upload).
3. Create your environment file:
   ```bash
   cd teamwork-scoreboard
   cp .env.example .env
   ```
4. Edit `.env` and set two secrets (make up long random strings, or run
   `openssl rand -hex 32` to generate them):
   - `AUTH_SECRET=` ← required; the app refuses logins in production without it
   - `CRON_SECRET=` ← protects the scheduled-sync endpoint
   Leave the Zen Planner lines empty for now (Phase 4).
5. Start it:
   ```bash
   docker compose up -d --build
   ```
6. First run only — create the database, config, and demo data:
   ```bash
   docker compose exec scoreboard npm run db:seed
   ```
7. Visit `http://YOUR-SERVER-IP:3000` and log in.
8. **Put HTTPS in front of it** (required before real client data goes in).
   Easiest options: point Cloudflare at it (free), or install Caddy on the
   server (`caddy reverse-proxy --from scoreboard.yourdomain.com --to localhost:3000`).
   Railway/Render/Fly give you HTTPS automatically.
9. **Back up the database.** Everything lives in the `data/` folder next to
   `docker-compose.yml`. Copy it anywhere (Google Drive, another disk) on a
   schedule — even a weekly manual copy is fine to start.

✅ Done when: the app loads over HTTPS from your phone.

---

## Phase 3 — Make it yours (30 minutes, in the app)

1. **Change every password.** Admin → Users & Roles → open each user →
   set a real password. Do yours first.
2. **Fix the team list.** Rename/deactivate the placeholder staff (Marcus
   Webb, Jordan Ellis, Guest Viewer) or replace them with your real people
   and roles. Erin is already set up as Manager.
3. **Set your numbers.** Admin →:
   - *Monthly revenue target* — used for "Progress to monthly revenue target".
   - *Lead response goal (minutes)* — drives the red "leads waiting" alert.
   - *At-risk threshold (days without attendance)*.
4. **Review KPI goals.** Admin → Metric Dictionary → skim each group and
   adjust goals/thresholds to your reality. The defaults are reasonable
   starting points, not your numbers.
5. **Check terminology.** Admin → Settings: appointment types (Success
   Session, Strong Start…), lead sources, and program names.
6. **Review the checklists.** Admin → Task Templates: the daily/weekly/
   monthly operations and cleaning lists match the spec defaults — add,
   edit, or reassign to fit how you actually run the facility.
   Same for Admin → Onboarding Steps and Admin → Scorecard Templates.
7. **Remove the sample data** when you're ready for real numbers:
   ```bash
   docker compose exec scoreboard npm run db:clear-demo
   ```
   (Local install: `npm run db:clear-demo`.) Users, metrics, templates, and
   settings survive; only demo records vanish. Then Admin → Demo mode →
   turn the label off.

✅ Done when: real staff can log in, goals are yours, demo label is off.

---

## Phase 4 — Connect Zen Planner (the scheduled browser sync)

Goal: attendance, members, and payments flow in automatically every night.
The app signs into Zen Planner with a browser, exactly like you do.

1. **Create a dedicated Zen Planner staff login** for the sync (recommended:
   report-only permissions, name it something like "Scoreboard Sync"). You
   can use your own login, but a dedicated one is safer and survives your
   own password changes.
2. On the server, put the credentials in `.env`:
   ```
   ZEN_PLANNER_EMAIL=scoreboard-sync@teamworkbloomington.com
   ZEN_PLANNER_PASSWORD=********
   ```
   then restart: `docker compose up -d`.
3. **For each report you want pulled** (start with attendance; add members
   and payments once that works):
   1. In Zen Planner, open the report and **copy its URL** from the address
      bar.
   2. Run its CSV export once by hand and upload the file in the app at
      **Data → Import**: pick the matching target (Attendance), map the
      columns, and **save the mapping** with the exact name the job expects —
      `ZP Attendance Export` (members: `ZP Member Export`, payments:
      `ZP Payment Export`). This teaches the app your report's columns once;
      the nightly sync reuses it forever.
   3. In **Admin → Settings → "Zen Planner scrape jobs"**, paste the report
      URL into the matching job, and change `"enabled": false` to
      `"enabled": true`. Save.
4. **Test it:** Data & Sync → Zen Planner card → **Sync now**. Check the
   sync-history table underneath:
   - `success … N new, M already known` → you're done. Re-running is always
     safe; nothing double-counts.
   - `error …` → read the message. It names the exact problem and saves a
     screenshot of what the browser saw in the server's `data/debug/`
     folder. The two common fixes, both in Admin → Settings, no code:
     - login form changed → adjust "Zen Planner login flow" selectors;
     - export link not found → change the job's `exportSelector` to match
       the report's actual export/CSV link text.
5. Repeat step 3 for the members and payments reports.

✅ Done when: Sync now shows green "success" rows for each report.

---

## Phase 5 — Turn on the schedule

The sync and the daily checklist generation run whenever something calls
`/api/cron`. Pick the easiest option:

- **Free web scheduler (simplest):** create an account at
  <https://cron-job.org> (or any uptime/cron service) and add a job that
  requests, **once per hour**:
  ```
  https://YOUR-DOMAIN/api/cron?secret=YOUR_CRON_SECRET
  ```
- **Or server cron:** `crontab -e` and add:
  ```
  0 * * * * curl -s -H "Authorization: Bearer YOUR_CRON_SECRET" https://YOUR-DOMAIN/api/cron
  ```

Hourly is fine — the Zen Planner pull only actually runs on its own interval
(daily by default), and everything deduplicates anyway. If a source stops
syncing, the Today page tells you.

✅ Done when: next morning, Data & Sync shows a `scheduled` run overnight.

---

## Phase 6 — Connect the CRM (leads), two options

**Real-time (best), if you use GoHighLevel / Automatic Members / ZP Engage:**
1. Add to `.env`: `CRM_WEBHOOK_SECRET=` (another random string), restart.
2. In the CRM, create a workflow: *trigger:* contact created → *action:*
   webhook / POST to:
   ```
   https://YOUR-DOMAIN/api/webhooks/crm
   ```
   with a custom header `x-webhook-secret` set to that same secret.
3. Create a test contact — it should appear under Leads within seconds, and
   in the sync history.

**Fallback, any CRM:** export leads to CSV weekly and upload via
Data → Import (save the mapping once, reuse it every week).

✅ Done when: a new CRM contact shows up as a lead by itself.

---

## Phase 7 — Set the weekly rhythm (people, not software)

The app only pays off if it's part of the routine:

- **Daily (staff):** work off the Today page — leads to contact, tasks,
  cleaning, at-risk outreach. Two minutes at open and close.
- **Friday (each staff member):** Team Scorecards → enter the week's numbers
  → **Save & submit** → it walks straight into the 5-15. Ten minutes.
- **Monday (you and Erin):** open **Weekly Summary**, respond to 5-15s,
  leave scorecard comments, and pick the week's priorities from the
  suggested list. Fifteen minutes.
- **Monthly (you):** Marketing & 3R — set up next month's plan and campaign;
  Admin → Metrics — adjust any goal that's proven wrong.
- Numbers with no integration yet (Google reviews, testimonials, outstanding
  balances…) — enter them right on the metric's page (Scoreboard → click the
  metric → "Record a value"), or import them via CSV.

---

## Quick reference

| Need | Where |
| --- | --- |
| Add a lead / athlete / outreach | Today page quick actions |
| Change a goal or threshold | Admin → Metric Dictionary |
| Add/remove staff, permissions | Admin → Users & Roles |
| Edit checklists | Admin → Task Templates |
| Import any CSV / Google Sheet | Data → Import |
| See why a sync failed | Data & Sync → sync history (+ `data/debug/` screenshots) |
| Remove sample data | `npm run db:clear-demo` (or via docker compose exec) |
| Back up everything | copy the `data/` folder |

**Never** commit or share the `.env` file — it holds your secrets.
