# Teamwork Bloomington — Business Scoreboard

A self-updating business scoreboard and accountability command center for
**Teamwork Bloomington**, a youth sports-performance training facility in
Bloomington, Indiana. It replaces scattered spreadsheets with one system:
executive KPIs, team scorecards, 5-15 reports, operations & cleaning
checklists, new-athlete onboarding, marketing/3R tracking, and a data
integration layer with honest sync status.

---

## Quick start

```bash
cd teamwork-scoreboard
npm install
npm run db:seed        # creates the SQLite db, config, and demo data
npm run dev            # http://localhost:3000
```

**Demo logins** (password for all: `teamwork1` — change them in Admin → Users):

| Role              | Email                            |
| ----------------- | -------------------------------- |
| Owner/Admin       | rod@teamworkbloomington.com      |
| Manager           | erin@teamworkbloomington.com     |
| Coach             | coach@teamworkbloomington.com    |
| Client Experience | frontdesk@teamworkbloomington.com|
| Read-Only         | viewer@teamworkbloomington.com   |

The **DEMO DATA** label shows until you turn it off (Admin → Demo mode).
Remove all sample records cleanly with `npm run db:clear-demo` — users,
roles, metric dictionary, templates, and settings are kept.

Run the calculation test suite: `npm test` (41 tests over the KPI math,
period logic, recurrence engine, and CSV import parsing).

---

## Stack (and one deliberate deviation)

- **Next.js 16 + TypeScript** (App Router, server components, server actions)
- **Tailwind CSS v4** with a hand-rolled shadcn-style component system
- **Recharts** for trends
- **Drizzle ORM + SQLite** (better-sqlite3), migrations committed in `drizzle/`
- Cookie-session auth (jose-signed JWT, bcrypt password hashes)
- **Vitest** for calculation coverage

**Why SQLite instead of Supabase/Postgres:** this build environment has no
managed Postgres, and for a single-location business SQLite is operationally
simpler — one file to back up, zero configuration, no connection limits, and
plenty of headroom for this data volume. The schema is written in Drizzle,
which speaks Postgres natively: if you later want Supabase, change the
Drizzle dialect/driver in `src/db/`, re-generate migrations, and the
application code is unchanged. Role-based access is enforced in the
application layer (every page and server action checks permissions); with a
move to Supabase you could add row-level security on top.

---

## Application areas

| Area | What it does |
| --- | --- |
| **Today** (`/`) | Default landing page: attention engine ("What Needs Attention"), stat tiles, today's sessions, tasks due, leads to contact, appointments to confirm, onboarding, at-risk outreach, failed payments, marketing due, sync status, quick actions. |
| **Scoreboard** (`/scoreboard`) | Executive KPIs in four groups (Demand, Conversion, Delivery, Financial) with weekly/monthly/quarterly/YTD/custom views. Every card shows actual, goal, diff, % of goal, previous period, trend, R/Y/G status, source, and last-updated, and links to the records behind the number plus a manual-entry form with audit fields. CSV export included. |
| **Team Scorecards** (`/team`) | Role scorecards (Coach and Client Experience/Admin seeded, more addable) with a rolling 6-week grid, 6-week average, MTD totals, goal status, staff notes, owner comments, and auto-filled values where source data exists. Submitting the week routes straight into the 5-15. |
| **5-15 Reports** (`/reports`) | Weekly staff report (wins, KPI wins, commitments, challenges, concerns, help needed, next-week priorities), manager review + follow-up actions, comment thread, submission-tracking grid, print/export view. |
| **Operations** (`/operations`) | Recurring daily/weekly/monthly checklists generated automatically from templates, overdue view, completion %, proof notes, late flags, ad-hoc tasks. |
| **Facility** (`/facility`) | Opening/daily/closing cleaning plus weekly deep-clean and monthly equipment checks, with a facility-readiness percentage. |
| **Onboarding** (`/onboarding`) | Pipeline of new athletes through a configurable checklist (Zen Planner profile → agreement → autopay → waiver → Strong Start → TeamBuildr → welcome → day-one photo → first-workout follow-up), with completion %, overdue steps, and responsible staff. |
| **Marketing & 3R** (`/marketing`) | Deadline-driven offer tracker (checklist + leads/appointments/enrollments/revenue/conversion), digital marketing, 3-2-1 email strategy, Referrals / Reactivations / Relationships, internal engagement, social proof, and editable weekly content themes. |
| **Leads & Athletes** (`/leads`, `/athletes`) | The operational records behind the numbers, with quick actions: add lead, log outreach, book/confirm appointments, stage changes, risk flags, status changes. |
| **Weekly Summary** (`/summary`) | Owner report: wins, KPIs behind, staff accountability, at-risk clients, revenue/membership movement, marketing performance, and five rule-based priorities — every line computed from records, facts labeled as facts. Print-friendly. |
| **Data & Sync** (`/data`) | Connector status, sync history with errors and retry, saved field mappings, CSV/Google Sheets import wizard, webhook + cron endpoints. |
| **Admin** (`/admin`) | Metric dictionary (definitions, formulas, goals, R/Y/G thresholds), users & role permissions, task templates, onboarding steps, scorecard templates, business settings (revenue target, response-time goal, at-risk window, appointment types, lead sources, programs), demo mode. |

Everything that may change later — goals, staff, roles, metrics, thresholds,
schedules, checklist items, appointment types — is editable in Admin, not
hard-coded. Financial goals are settings; no historical revenue figures are
baked in.

## KPI engine

`src/lib/metric-catalog.ts` seeds ~50 metrics into the `metrics` table; after
seeding, **the database is the source of truth** and admins edit everything in
Admin → Metric Dictionary. Metrics marked auto-compute are calculated live
from operational tables by the registry in `src/lib/kpi.ts` (leads,
appointments, memberships, attendance, payments, outreach, onboarding).
Metrics without a data source read from manual entries/imports
(`kpi_values`), which carry who/when/why audit fields. A manual entry for a
period **overrides** the computed value for that period and is labeled as an
override in the UI.

All ratios go through `safeDiv`/`safePct` (`src/lib/calc.ts`) — division by
zero yields "no data", never `NaN`. Status is % of goal attainment against
per-metric red/yellow thresholds; lower-is-better metrics invert attainment.
Weekly goals scale to longer periods; point-in-time ("stock") metrics don't.

## Integrations — honest by design

The connector framework (`src/lib/connectors.ts`) **never fakes a live
connection**. Each adapter declares required env vars; until they exist the
connector shows *not configured* and "Sync Now" writes an honest error to
sync history explaining exactly what's missing and what fallback to use.

Working today, no credentials needed:

- **CSV import wizard** (Data → Import): upload any Zen Planner/CRM/Gmail
  report export, map columns once (mappings are saved for reuse), preview,
  commit. Rejected rows are counted with reasons; every import is logged to
  sync history.
- **Google Sheets import**: paste a sheet URL shared as "anyone with the link
  can view" — same mapping flow.
- **CRM webhook** (`POST /api/webhooks/crm`): point a GoHighLevel/Automatic
  Members/ZP Engage workflow at it with the `CRM_WEBHOOK_SECRET` header and
  new contacts arrive as leads in real time. Disabled until the secret is set.

Ready for credentials (adapter stubs with clear TODOs in
`src/lib/connectors.ts`): **Zen Planner** (partner API key from ZP support),
**CRM API pull**, **TeamBuildr** (no public API today — tracked via the
onboarding checklist). When you get credentials, implement `sync()` in the
adapter; everything else (status, history, retry, scheduling) already works.

**Scheduling:** hit `GET /api/cron` (Bearer `CRON_SECRET`) hourly or daily
from any scheduler — it generates recurring task instances and runs
configured connector syncs. Task generation also self-heals lazily on page
loads, so the app works without a scheduler too.

## Roles & permissions

Four seeded roles (Owner/Admin, Manager, Coach, Read-Only) plus Client
Experience. Every permission is a checkbox per role in Admin → Users & Roles.
Financial KPIs require `view_financials`; coaches see their own scorecard but
not others'; every server action re-checks permissions server-side.

## Data care for minors

Athlete records store name, guardian name, program, and **birth year only**
(no full birth dates), no addresses, no medical data. Demo data is entirely
fictional.

---

## Deployment

Any Node 20+ host with a persistent disk works:

```bash
npm install
npm run build
npm run db:seed          # first run only (or skip and add users via a seeded admin)
AUTH_SECRET=$(openssl rand -hex 32) CRON_SECRET=$(openssl rand -hex 24) npm start
```

1. Copy `.env.example` to `.env` and fill in `AUTH_SECRET` (required in
   production — the app refuses sessions without it) and `CRON_SECRET`.
2. Persist the `data/` directory (that's the whole database — back it up by
   copying the file; `sqlite3 data/teamwork.db ".backup backup.db"` for hot
   backups).
3. Schedule `curl -H "Authorization: Bearer $CRON_SECRET" https://your-app/api/cron`
   hourly (system cron, GitHub Action, uptime pinger — anything).
4. Put it behind HTTPS (Caddy/nginx/Cloudflare Tunnel).

Good fits: a small VPS, **Fly.io**, **Railway**, or **Render** with a
persistent volume. **Vercel note:** Vercel's filesystem is ephemeral, so
SQLite won't persist there — for Vercel, switch the Drizzle driver to
Postgres (Supabase/Neon) first; the schema and app code carry over.

Change the demo passwords (Admin → Users) before real use. Secrets live only
in environment variables — never in the repo or client code.

## Project structure

```
teamwork-scoreboard/
├─ drizzle/                  # committed SQL migrations (auto-applied on boot)
├─ scripts/seed.ts           # demo dataset (deterministic, all rows demo=1)
├─ scripts/clear-demo.ts     # removes demo rows, keeps configuration
├─ src/db/schema.ts          # full schema (~30 tables)
├─ src/lib/
│  ├─ calc.ts                # canonical math (safe division, status, trends)
│  ├─ periods.ts             # week/month/quarter/YTD/custom + goal scaling
│  ├─ metric-catalog.ts      # default metric dictionary (seeded, then DB-owned)
│  ├─ kpi.ts                 # auto-compute registry + scoreboard + drill-downs
│  ├─ attention.ts           # the accountability/attention engine
│  ├─ tasks.ts               # recurrence engine + facility readiness
│  ├─ connectors.ts          # integration adapter framework (honest states)
│  ├─ importer.ts            # CSV/Sheets parsing, mapping, commit
│  ├─ auth.ts                # sessions, permissions enforcement
│  └─ __tests__/             # vitest coverage of critical calculations
└─ src/app/                  # routes: today, scoreboard, team, reports,
                             # operations, facility, onboarding, marketing,
                             # leads, athletes, data, admin, summary, api/*
```

See `docs/DATA-MAPPING.md` for import field references and CRM/Zen Planner
export tips.
