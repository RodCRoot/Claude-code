# Feature matrix

Status values: **verified locally** (automated tests and/or browser check against local Postgres) · **verified with provider sandbox** · **implemented, configuration required** · **blocked** · **not implemented**.

Evidence levels for reference workflows: **public docs** (vendor marketing/help pages), **existing Teamwork integration** (field knowledge from `teamwork-scoreboard`), **account observation** (none yet: account access is blocked, see BLOCKERS.md).

Rod's planning brief uses four evidence labels. They map onto the levels above as follows; rows below keep the original wording.

| Brief label | Meaning | Maps to |
|---|---|---|
| **publicly documented** | Stated on a vendor's public page, with the URL and the date it was checked | = **public docs** (and **existing Teamwork integration** where the scoreboard's field knowledge is the source) |
| **account-verified** | Observed in Teamwork's own vendor account (Zen Planner, TeamBuildr, Hawkin Cloud) or in a provider sandbox | = **account observation**; currently none. No row carries this label yet |
| **proposed Teamwork functionality** | Something the Hub could do but does not do today; not implemented, or implemented without any test or browser check | corresponds to status **not implemented**, and to items listed under Gaps or in `NEXT_STEPS.md` |
| **unresolved dependency** | Needs something outside this repository before it can be verified: credentials, an account export, a real device, a policy answer, or a vendor fact that no public page states | corresponds to status **blocked** or **implemented, configuration required**, and to every item in `BLOCKERS.md` |

The replacement decisions that use these labels are in `docs/REPLACEMENT-PLAN.md`; the Hawkin route evaluation is in `docs/HAWKIN-CONNECTORS.md`; scenario-to-test mapping is in `docs/VALIDATION.md`.

Test evidence refers to files in `tests/` (Vitest, real Postgres) and `e2e/` (Playwright). Module docs with formulas, policies, and research are in `docs/modules/`.

**No provider integration is verified with a sandbox yet** (no credentials were available).

## Platform & security

Security review: see `docs/SECURITY-REVIEW.md` (10 findings fixed with regression tests; open decisions listed in DECISIONS.md).

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Person ≠ login ≠ athlete ≠ guardian ≠ household ≠ payer; no auto-merge | verified locally | `people.test.ts`, `imports.test.ts`, `crm.test.ts`, e2e duplicate flow | — |
| Server-side authorization (owner/admin/operations/coach/guardian/athlete/kiosk), per-guardian flags, org boundary | verified locally | `authz.test.ts`, every module test file, e2e `auth-and-access` | Row-level security in Postgres not added (app-layer enforcement only) |
| Sessions (hashed, revocable), lockout, TOTP MFA, invites/reset links, role changes revoke sessions | verified locally | `reports-settings.test.ts`, e2e | Email delivery of invites needs an email provider (links are shown once to staff) |
| Staff MFA enforcement (org policy) | implemented (manual check) | — | Not covered by an automated test |
| Audit log (append-only trigger), audit UI | verified locally | trigger in `0001`, used across modules | — |
| Security headers, nonce-based CSP, no-store caching for private pages, dev role switcher disabled outside demo, optional staging password gate | verified locally | `e2e/csp.spec.ts` (0 violations across all roles on the production build), e2e redirect test | — |
| Migrations, constraints (exclusion, partial unique, CHECK, immutability triggers) | verified locally | all DB tests | — |
| Object storage (local disk or S3-compatible bucket, private + SSE), deletes, auth-checked downloads | verified locally (S3 via mocked client) | `storage*.test.ts`, `forms-files.test.ts`, `exports.test.ts` | Real bucket not configured |
| Job queue/outbox + worker (`pnpm jobs:work`) | verified locally | `messaging.test.ts`, `scheduling-calendar.test.ts` | No process supervisor/deploy config |
| Backups (`pnpm backup`) and restore rehearsal (`pnpm restore:check`) | verified locally | full restore into a scratch DB: schema, 103 tables' row counts, stored-file checksums identical; corrupted/truncated dumps rejected | Managed-Postgres (Render) and S3 restores not rehearsed |
| Error monitoring (redacted structured logs; Sentry when `SENTRY_DSN` set) and `/api/health` | verified locally (fake Sentry endpoint) | `observability.test.ts` | Real Sentry project not configured |
| Responsive UI (desktop / 390px), loading/empty/error/denied states | verified locally | Playwright sweep of all nav routes for 9 roles (no page errors, no horizontal overflow) | Formal accessibility audit (axe) not run |
| Public site (overview, programs, public schedule, assessment inquiry) | verified locally | browser checks | Copy is draft (editable in Settings) |

## Zen Planner Studio-style operations (evidence: public docs + existing Teamwork integration; account exploration blocked)

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Recurring classes (DST-correct), private sessions, assessments, camps | verified locally | `scheduling.test.ts` | — |
| Series edits (this / following / all: time, coach, room, capacity; cancel from a date) with explicit over-capacity choices | verified locally | `scheduling-series-edit.test.ts` (incl. concurrency, DST), browser 390px | No date/weekday moves for a whole series |
| Family multi-booking (several children, or next N weeks; all-or-nothing or partial; idempotent) | verified locally | `scheduling-family-batch.test.ts` (incl. concurrency), browser 390px | — |
| Kiosk PIN check-in (hashed, per-session rate limit, optional PIN-only kiosk) | verified locally | `scheduling-kiosk-pin.test.ts`, browser 390px | PIN uniqueness per org can reveal that a PIN is taken when choosing one |
| Attendance corrections re-settle credits and no-show fees | verified locally | `scheduling-attendance-correction.test.ts` | — |
| Day/week/month calendars, roster, check-in, attendance, no-show, late cancel | verified locally | `scheduling.test.ts`, browser | — |
| Capacity + waitlist + auto-promotion (with credit reservation) | verified locally | concurrency test (10 parallel → 1 booked) | — |
| Coach/room overlap prevention incl. buffers | verified locally | DB exclusion constraint tests | — |
| Configurable cancellation / no-show policies (release, forfeit, fee) | verified locally | `scheduling.test.ts` | Fees become staff tasks, not automatic invoices |
| Coach availability, time off, slot finder, substitution | verified locally | `scheduling.test.ts` | — |
| Family self-service booking, eligibility (forms, age, entitlement) | verified locally | `scheduling.test.ts`, `connected-flows.test.ts` | Multi-athlete family checkout not implemented |
| Restricted kiosk check-in (first name + last initial) | verified locally | `scheduling.test.ts`, browser | No QR/PIN/barcode check-in |
| Google Calendar: per-coach OAuth (PKCE, signed state), AES-256-GCM token storage, push to a Teamwork-owned calendar, free/busy import | implemented, configuration required | `calendar-oauth.test.ts`, `scheduling-calendar.test.ts` (mocked Google) | Needs Google Cloud OAuth client + `CALENDAR_TOKEN_KEY`; not run against a real account |
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
| Stripe Billing subscriptions (subscription-mode Checkout, webhook sync, cancel at period end, never double-billed) | implemented, configuration required | `billing-subscriptions.test.ts` (signed fixtures) | Anchor/first-charge behaviour and period alignment need sandbox verification; no plan changes/trials on provider subscriptions |
| PayPal Orders checkout + capture | implemented, configuration required | contract tests | Never run against PayPal sandbox |
| PayPal webhook verification (verify-webhook-signature API) | implemented, configuration required | rejects when unconfigured | `verification_status` value unverified |
| PayPal Subscriptions (plans, approval link, webhooks) | implemented, configuration required | `billing-subscriptions.test.ts` (mocked API) | Approval link, sale payload fields need sandbox verification |
| Venmo (via PayPal Checkout, one-time) | implemented, configuration required | `billing-subscriptions.test.ts` (server-side order + capture, amount checks) | Needs PayPal credentials and a real device test with the Venmo app; recurring Venmo not offered (not documented by PayPal) |
| Offline/manual payments (cash, check, personal Venmo/Zelle) with attribution, labeled staff-attested | verified locally | `billing.test.ts` (DB CHECKs) | — |
| Zen Planner cutover safety (imported memberships never invoiced; cutover requires confirming Zen Planner billing stopped) | verified locally | `billing.test.ts` | — |

## CRM & communication (PushPress Grow-style; evidence: public docs)

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Public inquiry → lead (consent capture, honeypot, rate limit, duplicate flag) | verified locally | `crm.test.ts`, `connected-flows.test.ts` | No embeddable lead widget |
| Pipeline (configurable stages, owner, tags, tasks, assessment scheduling, conversion with explicit link/create) | verified locally | `crm.test.ts` | Scheduling an assessment links a session but doesn't create a booking |
| Shared inbox, internal notes, assignment, athlete context, per-guardian threads | verified locally | `messaging.test.ts` | Attachments not supported |
| Delivery records; consent/opt-out, quiet hours (DST-safe), guardian routing, test-recipient redirect | verified locally | `messaging.test.ts` | — |
| Email (Postmark/SendGrid) & SMS (Twilio) adapters | implemented, configuration required | `not_configured` path tested | No delivery-receipt webhooks |
| Templates, automations (8 triggers), preview, dedupe, retry, dead-letter outbox | verified locally | `messaging.test.ts` | No drip sequences |
| Family communication preferences (per-channel consent, quiet hours) + append-only consent history; staff history view | verified locally | `messaging-preferences.test.ts` | — |
| Segments (live counts) + broadcast campaigns (preview after routing/consent/quiet hours, owner/admin approval, outbox send, per-recipient dedupe, report); health-filter restriction | verified locally | `messaging-campaigns.test.ts` | No A/B, link tracking |
| Provider webhooks: bounces/complaints → undeliverable, Twilio STOP/START/HELP → consent, inbound email/SMS threading + unmatched queue | verified locally (mocked providers, signatures verified) | `messaging-webhooks.test.ts` | Needs provider setup (docs/modules/crm-messaging.md); not sandbox-verified |

## Forms & signatures

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Versioned templates, immutable published versions, field builder, signer requirements | verified locally | `forms.test.ts` | Template text is SAMPLE and needs approved language |
| Requests (athlete/group/missing), reminders, renewals/expiry, superseding | verified locally | `forms.test.ts` | — |
| Guardian/adult signing with exact consent text, identity, relationship, evidence; multi-signer | verified locally | `forms.test.ts`, browser | Typed-name pilot; no legal-enforceability claim |
| Signer identity step-up (emailed one-time code, MFA session, or staff-attested in person), org setting | verified locally (email via test transport) | `forms-step-up.test.ts` | Real email needs EMAIL_PROVIDER + DELIVERY_ENABLED; without it, step-up forms need staff in-person verification |
| Completed PDF with integrity hash; verify view; auth-checked download; Unicode fonts (Noto Sans + CJK/Hangul fallbacks) | verified locally | `forms-files.test.ts`, `forms-step-up.test.ts` | Scripts outside Latin/Greek/Cyrillic/CJK/Hangul (e.g. Arabic, Devanagari, emoji) still print "?" |
| Historical archive import (never recreates signatures) | verified locally | `forms.test.ts` | — |
| Established e-signature provider adapter | implemented, configuration required | interface only | No provider chosen/connected |

## TeamBuildr Strength-style training (evidence: public docs)

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Exercise library (categories, equipment, units, video links, substitutions) | verified locally | `training.test.ts` | Licensed video library not copied (by design) |
| Programs: phases, weeks/days, supersets/circuits, full prescriptions, progression; annual plan blocks | verified locally | `training.test.ts` | Week-view builder with drag-and-drop + keyboard reorder, copy day, bulk set scheme (`training-builder.test.ts`, builder Playwright test); no calendar-wide drag |
| Versioned assignment snapshots (template edits never rewrite completed workouts) | verified locally | `training.test.ts` | — |
| Maxes (tested/estimated; Epley/Brzycki v1), dated-max % loading with rounding | verified locally | `training.test.ts` | — |
| Mobile logging with offline queue + idempotent retry | verified locally | `training.test.ts` + offline Playwright test | Scoped service worker for today's workout (athletes only; offline Playwright test); no background sync |
| Weight-room tablet view (coach-scoped) | verified locally | `training.test.ts`, browser | — |
| Coach review, PR alerts, adherence, progress charts, scoped opt-in leaderboard, CSV export | verified locally | `training.test.ts` | Fewer report types than TeamBuildr |
| VBT data | implemented (CSV import only) | `training.test.ts` | No device connectivity (by design) |
| VBT math: load–velocity profile → estimated 1RM (`lv_profile_v1`), published velocity→%1RM curves (`mpv_squat_v1`/`mpv_bench_v1`/`mpv_generic_v1`), velocity zones, relative strength (`rel_strength_v1`) | verified locally | `training-vbt.test.ts` (pure), `training-vbt-maxes.test.ts` (suggest/confirm from `vbt_readings`, authz, kg conversion) | Ported from the proven Vantage engine (`claude/athlete-training-platform` branch). No UI yet — suggest/confirm are lib functions awaiting a surface on the athlete training page |

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

## Staff time clock & payroll

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Clock in/out (Today card, kiosk staff PIN, kiosk staff session); one open entry per person (partial unique index) | verified locally | `payroll.test.ts` (incl. 5 concurrent clock-ins) | — |
| Corrections/void/manual add/flag acknowledgement with required reason, originals preserved (DB trigger), audited | verified locally | `payroll.test.ts` | — |
| Pay-rate history by effective date; deduction % (default 17%, "confirm with your accountant") and rounding (truncate 2 dp like Zen Planner, or exact) as settings; integer-cent math | verified locally | `payroll-engine.test.ts` | Deduction is a single flat estimate, not tax withholding |
| Abnormality flags (runaway / missed clock-out, tiny, missing usual weekday, off-pattern start, stray clock-out orphan, no rate), DST-safe; weekday estimates marked separately | verified locally | `payroll-engine.test.ts` | Thresholds are heuristics; tune in Payroll → Settings |
| Payroll runs (draft → approved → exported, frozen by DB trigger), CSV export | verified locally | `payroll.test.ts` | No direct payroll-provider integration |
| Zen Planner payroll paste/CSV import (dedupe, preview) | implemented, configuration required | `payroll-engine.test.ts`, `payroll.test.ts` | Column mapping unverified against a real export; one staff member per paste |

## Cross-module acceptance paths (brief §13)

| Path | Status | Evidence |
|---|---|---|
| 1. Registration → form → invoice → verified payment → entitlement → booking → attendance/credit | verified locally | `connected-flows.test.ts` |
| 2. Program → assignment → athlete log → coach review → history/volume/load | verified locally | `training.test.ts`, `science.test.ts`, `connected-flows.test.ts` (load link) |
| 3. Wellness/body map/habits → scoped coach dashboard + review task | verified locally | `science.test.ts`, `connected-flows.test.ts` |
| 4. Historical import → identity review → commit → performance chart → export/reconciliation | verified locally (fixtures) | `imports.test.ts`, `hawkin.test.ts`, `exports.test.ts` |
| 5. Lead inquiry → assessment → task/inbox → conversion | verified locally | `crm.test.ts`, `connected-flows.test.ts` |
