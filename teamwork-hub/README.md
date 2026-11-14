# Teamwork Hub

One platform for **Teamwork Bloomington**: scheduling, memberships and billing, CRM and family communication, digital forms with signatures, strength programming and workout logging, a sports-science suite, performance dashboards, and historical imports from Zen Planner, TeamBuildr, and Hawkin.

> Status: first implementation pass. See [`FEATURE_MATRIX.md`](FEATURE_MATRIX.md) for exactly what works, what was verified, and what is missing, and [`BLOCKERS.md`](BLOCKERS.md) for what needs credentials or decisions.

## Quick start (local)

Requirements: Node 22, pnpm 10, PostgreSQL 16 (with the `btree_gist` extension available).

```bash
cd teamwork-hub
pnpm install
cp .env.example .env              # then set SESSION_SECRET (openssl rand -hex 32) and DATABASE_URL / TEST_DATABASE_URL
createdb teamwork_hub && createdb teamwork_hub_test
pnpm db:fresh                     # reset + migrate + seed synthetic demo data (APP_MODE=demo only)
pnpm dev                          # http://localhost:3000
```

Sign in at `/dev/switch` (demo mode only) or `/login` with any demo account and password `teamwork-demo-1`:

| Role | Login | What to look at |
|---|---|---|
| Owner | rod.demo@teamwork-hub.test | Today, Reports, Settings, Billing, Imports |
| Operations | erin.demo@teamwork-hub.test | Front desk: Today, People, Schedule, Billing, Documents |
| Coach | marcus.demo@teamwork-hub.test | Coach dashboard, Training, Weight room, Sports Science |
| Guardian | alex.parker@example.test | Parent portal for Maya & Eli (full access incl. health) |
| Guardian | jordan.parker@example.test | Same kids; no health-data access; can view but not pay invoices |
| Guardian | chris.parker@example.test | Unrelated "Parker" family — must never see Maya/Eli |
| Guardian | casey.nguyen@example.test | Separated co-parent of Leo — cannot book or pay |
| Athlete | maya.parker@example.test | Athlete portal: today's workout, check-in, body map |
| Adult athlete | dana.brooks@example.test | Self-paying adult |
| Kiosk | kiosk.demo@teamwork-hub.test | Restricted check-in screen |

All demo data is synthetic (`is_demo = true`, `.test` email domains, "Sample" products with placeholder prices).

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Run the app |
| `pnpm test` | Vitest suite against `TEST_DATABASE_URL` (schema rebuilt each run) |
| `pnpm test:e2e` | Playwright browser tests (needs a running app; see `e2e/`) |
| `pnpm typecheck` / `pnpm lint` | Static checks |
| `pnpm db:generate --name <x>` | Create a migration after editing `src/db/schema/*` |
| `pnpm db:migrate` | Apply migrations (safe for production) |
| `pnpm db:reset` / `pnpm db:seed` / `pnpm db:fresh` | **Development only** — refuse to run unless `APP_MODE=demo` |
| `pnpm jobs:work` | Background job worker (outbox: messaging, reminders, renewals, syncs) |
| `pnpm backup` | `pg_dump` backup (see `docs/BACKUP-RESTORE.md`) |
| `pnpm restore:check [dump]` | Restore rehearsal: restores a dump into a scratch DB and compares migrations, schema, and row counts |
| `pnpm monitoring:check` | Sends one synthetic, redacted error to Sentry (needs `SENTRY_DSN`) |

## Configuration (names only — never commit values)

`DATABASE_URL`, `TEST_DATABASE_URL`, `SESSION_SECRET`, `APP_URL`, `APP_MODE` (`demo` | `staging` | `production`),
`STORAGE_BACKEND` (`local` | `s3`), `STORAGE_DIR`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_PREFIX`, `S3_SSE`, `S3_KMS_KEY_ID` (+ standard `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` chain),
`STAGING_BASIC_AUTH_USER`, `STAGING_BASIC_AUTH_PASSWORD`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`, `LOG_LEVEL`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`,
`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENV`,
`HAWKIN_REFRESH_TOKEN`, `HAWKIN_API_BASE`, `HAWKIN_ORG_SCOPE`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`, `SMS_PROVIDER`, `SMS_ACCOUNT_SID`, `SMS_AUTH_TOKEN`, `SMS_FROM`, `DELIVERY_ENABLED`, `DELIVERY_TEST_RECIPIENTS`, `SENTRY_DSN`.

Missing provider variables leave that integration in an honest **not configured** state; the rest of the app keeps working. External email/SMS stays off unless `DELIVERY_ENABLED=true`.

## Architecture

Modular monolith: Next.js 16 App Router (server components + server actions + route handlers), TypeScript, Tailwind 4, Drizzle ORM on PostgreSQL 16, Postgres-backed job queue, object storage on local disk or an S3-compatible bucket (`STORAGE_BACKEND`). Conventions for contributors are in [`AGENTS.md`](AGENTS.md); design decisions in [`DECISIONS.md`](DECISIONS.md); per-module workflows, formulas, and provider research in `docs/modules/`.

## Documents

| Document | What it covers |
|---|---|
| [`FEATURE_MATRIX.md`](FEATURE_MATRIX.md) | What works, what was verified, what is missing, with evidence levels |
| [`DECISIONS.md`](DECISIONS.md) | The five decisions that change the architecture or migration, implementation decisions, open questions for Rod |
| [`BLOCKERS.md`](BLOCKERS.md) | Credentials and access still needed |
| [`NEXT_STEPS.md`](NEXT_STEPS.md) | Prioritized backlog and resume prompt |
| [`docs/REPLACEMENT-PLAN.md`](docs/REPLACEMENT-PLAN.md) | Four separate replacement decisions (Zen Planner operations, TeamBuildr training, Hawkin historical data, Hawkin capture) with cutover rules |
| [`docs/HAWKIN-CONNECTORS.md`](docs/HAWKIN-CONNECTORS.md) | Evaluation of every Hawkin data route (REST API, Python and R packages, Power Query, Excel, Sheets, Cloud exports) and the recommended import approach |
| [`docs/VALIDATION.md`](docs/VALIDATION.md) | Risk scenarios mapped to the tests that cover them, with the gaps listed |
| [`docs/DEPLOY.md`](docs/DEPLOY.md), [`docs/BACKUP-RESTORE.md`](docs/BACKUP-RESTORE.md), [`docs/SECURITY-REVIEW.md`](docs/SECURITY-REVIEW.md), [`docs/ACCESSIBILITY.md`](docs/ACCESSIBILITY.md) | Operations, backups, security findings, accessibility |
| `docs/modules/*.md` | Per-module workflows, formulas, and provider research |

Key guarantees:
- **Authorization is server-side** in one policy module (`src/lib/authz/policy.ts`). Guardian permissions are per relationship; payment access never implies health-data access; coaches see only assigned athletes; kiosks see first name + last initial.
- **Integrity in the database**: exclusion constraints prevent double-booking a coach or exclusive room; partial unique indexes allow one live booking per athlete per session; credit balances are row-locked and CHECK-constrained; audit events and signatures are append-only (triggers); published form versions are immutable.
- **Money**: integer minor units + currency; settled, pending, invoiced, and scheduled recurring revenue are always separate; only verified webhooks settle payments.

## Deployment

No hosting was configured or changed during the build. [`docs/DEPLOY.md`](docs/DEPLOY.md) has the exact steps for a private staging on Render using [`render.yaml`](render.yaml) (web + worker + Postgres 16, `APP_MODE=staging`, sandbox payments, `DELIVERY_ENABLED=false`, basic-auth gate) and the production [`Dockerfile`](Dockerfile), plus the health check (`GET /api/health`) and the pre-launch checklist. Do not point the existing Teamwork domain at staging.

Production hardening in place: nonce-based CSP and security headers (`src/proxy.ts`), structured redacted JSON logs + optional server-side Sentry (`src/lib/observability.ts`, `src/instrumentation.ts`), private SSE-encrypted S3-compatible object storage (`src/lib/storage-s3.ts`), and a scripted restore rehearsal (`scripts/restore-check.sh`).

## Walkthrough (screenshots in `docs/screenshots/`, synthetic data)

- **Staff (Rod/Erin):** `01-staff-today` — sessions with check-in counts, follow-ups, missing forms, payment exceptions (pending vs settled), integration health. `02-schedule-week` → open a session for the roster. `03-billing-overview`, `04-report-collections` (settled vs pending vs attested), `05-import-center`, `06-integrations-status` (honest "not configured").
- **Coach (Marcus):** `07-coach-today` — assigned sessions, wellness completion (no response ≠ fine), results to review, body-map queue. `08-weight-room` tablet logging, `09-science-hub`, `10-force-plate` (vendor vs Teamwork-derived metrics).
- **Parent (Alex):** `11-parent-today-mobile` — child switcher, upcoming sessions, credits, forms to sign, invoices. `12-parent-forms-mobile` sign & download PDFs, `13-parent-booking-mobile`, `14-parent-messages-mobile`.
- **Athlete (Maya):** `15-athlete-today-mobile`, `16-athlete-logging-mobile` (prescribed vs actual, offline queue), `17-body-map-mobile`.
- **Permission example:** `18-guardian-no-health-performance-mobile` — Jordan sees progress but no wellness/body-map data.
- **Kiosk:** `19-kiosk-tablet` — first name + last initial only. **Public:** `20-public-home`.
