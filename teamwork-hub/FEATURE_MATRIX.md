# Feature matrix

Status values: **verified locally** (automated tests and/or browser check against local Postgres) · **verified with provider sandbox** · **implemented, configuration required** · **blocked** · **not implemented**.

Evidence levels for reference workflows: **public docs** (vendor marketing/help pages), **existing Teamwork integration** (field knowledge from `teamwork-scoreboard`), **account observation** (none yet: account access is blocked, see BLOCKERS.md).

Test evidence refers to files in `tests/` (Vitest, real Postgres) and `e2e/` (Playwright). Module docs with formulas, policies, and research are in `docs/modules/`.

**No provider integration is verified with a sandbox yet** (no credentials were available).

## Platform & security

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Person ≠ login ≠ athlete ≠ guardian ≠ household ≠ payer; no auto-merge | verified locally | `people.test.ts`, `imports.test.ts`, `crm.test.ts`, e2e duplicate flow | — |
| Server-side authorization (owner/admin/operations/coach/guardian/athlete/kiosk), per-guardian flags, org boundary | verified locally | `authz.test.ts`, every module test file, e2e `auth-and-access` | Row-level security in Postgres not added (app-layer enforcement only) |
| Sessions (hashed, revocable), lockout, TOTP MFA, invites/reset links, role changes revoke sessions | verified locally | `reports-settings.test.ts`, e2e | Email delivery of invites needs an email provider (links are shown once to staff) |
| Staff MFA enforcement (org policy) | implemented (manual check) | — | Not covered by an automated test |
| Audit log (append-only trigger), audit UI | verified locally | trigger in `0001`, used across modules | — |
| Security headers, no-store caching for private pages, dev role switcher disabled outside demo | verified locally | e2e redirect test | CSP not configured |
| Migrations, constraints (exclusion, partial unique, CHECK, immutability triggers) | verified locally | all DB tests | — |
| Object storage (local disk, S3-shaped interface), auth-checked downloads | verified locally | `forms-files.test.ts`, `exports.test.ts` | S3/bucket backend not implemented; no delete (orphans possible on rollback) |
| Job queue/outbox + worker (`pnpm jobs:work`) | verified locally | `messaging.test.ts`, `scheduling-calendar.test.ts` | No process supervisor/deploy config |
| Backups (`pnpm backup`), restore docs | partially verified | dump readable by `pg_restore --list` | Full restore into a fresh DB not rehearsed |
| Error monitoring | not implemented | — | `SENTRY_DSN` reserved; no SDK wired |
| Responsive UI (desktop / 390px), loading/empty/error/denied states | verified locally | Playwright sweep of all nav routes for 9 roles (no page errors, no horizontal overflow) | Formal accessibility audit (axe) not run |
| Public site (overview, programs, public schedule, assessment inquiry) | verified locally | browser checks | Copy is draft (editable in Settings) |

## Zen Planner Studio-style operations (evidence: public docs + existing Teamwork integration; account exploration blocked)

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Recurring classes (DST-correct), private sessions, assessments, camps | verified locally | `scheduling.test.ts` | "Edit all future sessions" of a series not implemented |
| Day/week/month calendars, roster, check-in, attendance, no-show, late cancel | verified locally | `scheduling.test.ts`, browser | — |
| Capacity + waitlist + auto-promotion (with credit reservation) | verified locally | concurrency test (10 parallel → 1 booked) | — |
| Coach/room overlap prevention incl. buffers | verified locally | DB exclusion constraint tests | — |
| Configurable cancellation / no-show policies (release, forfeit, fee) | verified locally | `scheduling.test.ts` | Fees become staff tasks, not automatic invoices |
| Coach availability, time off, slot finder, substitution | verified locally | `scheduling.test.ts` | — |
| Family self-service booking, eligibility (forms, age, entitlement) | verified locally | `scheduling.test.ts`, `connected-flows.test.ts` | Multi-athlete family checkout not implemented |
| Restricted kiosk check-in (first name + last initial) | verified locally | `scheduling.test.ts`, browser | No QR/PIN/barcode check-in |
| Google Calendar push + free/busy | implemented, configuration required | adapter tests with mocked fetch | OAuth consent flow and encrypted token storage not built |
| Memberships: versions, trials, family discount, holds, upgrades, cancellation rules | verified locally | `billing.test.ts` | Families can't self-request holds/cancellations |
| Session-credit ledger (reserve/consume/release/forfeit/restore/expire/adjust) | verified locally | `credits.test.ts` (concurrency), `scheduling.test.ts` | — |
| Lead/member status, custom fields, skills/levels, notes (visibility), tags, tasks, alerts | verified locally | `people.test.ts` | Custom-field definitions UI not built (schema exists) |
| Unified athlete timeline across modules (permission-gated) | verified locally | `people.test.ts`, `connected-flows.test.ts` | — |
| Retail/POS + inventory | verified locally | `billing.test.ts` | No barcode scanning |
| Reports (memberships, attendance, utilization, no-shows, receivables/aging, collections, invoiced, refunds/disputes, payouts, credits, renewals, retention, staff activity) with definitions + CSV | verified locally | `reports-settings.test.ts` | No saved/scheduled reports or charts on report pages |

## Payments (Stripe, PayPal, Venmo)

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Provider adapter interface, capability matrix (`/billing/providers`) | verified locally | `billing.test.ts` | — |
| Stripe Checkout creation (one-time) | implemented, configuration required | contract tests; refuses without keys | Never run against Stripe test mode |
| Stripe webhook verification (HMAC, tolerance), idempotent + out-of-order processing, amount/currency mismatch handling | verified locally (signed fixtures) | `billing-webhooks.test.ts` | Not verified with real Stripe events |
| Pending ACH vs settled; entitlement policy | verified locally | `billing-webhooks.test.ts` | — |
| Refunds/disputes ingestion, reconciliation, payouts | verified locally (fixtures) | `billing-webhooks.test.ts` | Stripe refund/dispute/payout field names unverified |
| Stripe Billing subscriptions (recurring mandates) | not implemented | — | Memberships are invoiced per period by the app and paid by one-time checkout or offline |
| PayPal Orders checkout + capture | implemented, configuration required | contract tests | Never run against PayPal sandbox |
| PayPal webhook verification (verify-webhook-signature API) | implemented, configuration required | rejects when unconfigured | `verification_status` value unverified |
| PayPal Subscriptions | not implemented | — | — |
| Venmo (via PayPal Checkout) | blocked | capability matrix documents eligibility (US, USD, Venmo app) | Button page not built; recurring Venmo unverified, so the UI offers Stripe/PayPal for recurring |
| Offline/manual payments (cash, check, personal Venmo/Zelle) with attribution, labeled staff-attested | verified locally | `billing.test.ts` (DB CHECKs) | — |
| Zen Planner cutover safety (imported memberships never invoiced; cutover requires confirming Zen Planner billing stopped) | verified locally | `billing.test.ts` | — |

## CRM & communication (PushPress Grow-style; evidence: public docs)

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Public inquiry → lead (consent capture, honeypot, rate limit, duplicate flag) | verified locally | `crm.test.ts`, `connected-flows.test.ts` | No embeddable lead widget |
| Pipeline (configurable stages, owner, tags, tasks, assessment scheduling, conversion with explicit link/create) | verified locally | `crm.test.ts` | Scheduling an assessment links a session but doesn't create a booking |
| Shared inbox, internal notes, assignment, athlete context, per-guardian threads | verified locally | `messaging.test.ts` | Attachments not supported |
| Delivery records; consent/opt-out, quiet hours (DST-safe), guardian routing, test-recipient redirect | verified locally | `messaging.test.ts` | — |
| Email (Postmark/SendGrid) & SMS (Twilio) adapters | implemented, configuration required | `not_configured` path tested | No inbound replies, bounce, or STOP handling (needs provider webhooks) |
| Templates, automations (8 triggers), preview, dedupe, retry, dead-letter outbox | verified locally | `messaging.test.ts` | No broadcast campaigns/drip sequences |

## Forms & signatures

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Versioned templates, immutable published versions, field builder, signer requirements | verified locally | `forms.test.ts` | Template text is SAMPLE and needs approved language |
| Requests (athlete/group/missing), reminders, renewals/expiry, superseding | verified locally | `forms.test.ts` | — |
| Guardian/adult signing with exact consent text, identity, relationship, evidence; multi-signer | verified locally | `forms.test.ts`, browser | Typed-name pilot only; stronger identity assurance needed |
| Completed PDF with integrity hash; verify view; auth-checked download | verified locally | `forms-files.test.ts` | Standard font (non-Latin characters print as "?") |
| Historical archive import (never recreates signatures) | verified locally | `forms.test.ts` | — |
| Established e-signature provider adapter | implemented, configuration required | interface only | No provider chosen/connected |

## TeamBuildr Strength-style training (evidence: public docs)

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Exercise library (categories, equipment, units, video links, substitutions) | verified locally | `training.test.ts` | Licensed video library not copied (by design) |
| Programs: phases, weeks/days, supersets/circuits, full prescriptions, progression; annual plan blocks | verified locally | `training.test.ts` | Form-based builder (no drag-and-drop calendar) |
| Versioned assignment snapshots (template edits never rewrite completed workouts) | verified locally | `training.test.ts` | — |
| Maxes (tested/estimated; Epley/Brzycki v1), dated-max % loading with rounding | verified locally | `training.test.ts` | — |
| Mobile logging with offline queue + idempotent retry | verified locally | `training.test.ts` + offline Playwright test | No service worker (reload without network fails; queue survives) |
| Weight-room tablet view (coach-scoped) | verified locally | `training.test.ts`, browser | — |
| Coach review, PR alerts, adherence, progress charts, scoped opt-in leaderboard, CSV export | verified locally | `training.test.ts` | Fewer report types than TeamBuildr |
| VBT data | implemented (CSV import only) | `training.test.ts` | No device connectivity (by design) |

## Sports science / AMS (evidence: public docs; all indices are documented Teamwork calculations)

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Wellness questionnaires (versions, schedules, missing ≠ favorable, `tw_readiness_v1`) | verified locally | `science.test.ts`, `science-formulas.test.ts` | No reminders/push |
| Body heat map (front/back SVG + accessible entry, history, coach review queue + generic task) | verified locally | `science.test.ts`, `connected-flows.test.ts` | — |
| Habits (assignments, check-ins, adherence, streaks; missed ≠ missing) | verified locally | `science.test.ts` | — |
| KPI tracker (definitions, protocols, trial selection, baselines, targets, group dashboard) | verified locally | `science.test.ts` | — |
| Load monitoring (`srpe_load_v1` AU, `acwr_rolling_v1` with coverage threshold, monotony/strain) | verified locally | `science-formulas.test.ts` | — |
| Volume tracker (tonnage rules, unit conversion, intensity zones vs dated max) | verified locally | `science.test.ts` | — |
| Wearables (normalized schema, CSV/manual import, missingness) | implemented (file/manual only) | `science.test.ts` | No live vendor APIs (OAuth per vendor needed) |
| Force-plate dashboard (trials, aggregates separate, baselines, SWC band, asymmetry, raw force-time plot) | verified locally | `science.test.ts` | — |
| Coach-reviewed parent progress reports (health sections opt-in + permission-gated) | verified locally | `science.test.ts` | No PDF/email delivery of reports |

## Imports, Hawkin, exports

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Import Center wizard (upload → map → validate → identity review → preview → commit → reconcile → revert), idempotent re-import | verified locally | `imports.test.ts` | XLSX not read directly (save as CSV) |
| Zen Planner schemas (members, family links, memberships, attendance, documents index) | implemented, configuration required | fixtures in `fixtures/` | All column mappings unverified until checked against a real export |
| TeamBuildr schemas (maxes, workout log, questionnaire) | implemented, configuration required | fixtures | Mappings unverified; no public API (by research) |
| Hawkin CSV import (tests vs averages kept separate) | verified locally (fixtures) | `imports.test.ts` | Cloud CSV headers unverified |
| Hawkin Cloud API sync (token exchange, historical windows, incremental `syncFrom`, backend filtering, pagination, backoff, checkpoints, schema-change warnings, raw curves) | implemented, configuration required | `hawkin.test.ts` (mocked HTTP) | Needs `HAWKIN_REFRESH_TOKEN`; response shapes partially unverified; rate limits undocumented |
| Exports (org/athlete zip: CSV + JSON + PDFs + raw signals + checksummed manifest) | verified locally | `exports.test.ts` | — |

## Cross-module acceptance paths (brief §13)

| Path | Status | Evidence |
|---|---|---|
| 1. Registration → form → invoice → verified payment → entitlement → booking → attendance/credit | verified locally | `connected-flows.test.ts` |
| 2. Program → assignment → athlete log → coach review → history/volume/load | verified locally | `training.test.ts`, `science.test.ts`, `connected-flows.test.ts` (load link) |
| 3. Wellness/body map/habits → scoped coach dashboard + review task | verified locally | `science.test.ts`, `connected-flows.test.ts` |
| 4. Historical import → identity review → commit → performance chart → export/reconciliation | verified locally (fixtures) | `imports.test.ts`, `hawkin.test.ts`, `exports.test.ts` |
| 5. Lead inquiry → assessment → task/inbox → conversion | verified locally | `crm.test.ts`, `connected-flows.test.ts` |
