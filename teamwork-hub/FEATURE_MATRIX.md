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
| Staff MFA enforcement (org policy) | verified locally | `security.test.ts` (`shouldRequireMfa` policy per role/path, org settings switch), `e2e/staff-mfa.spec.ts` (coach redirected to enrol, guardian not; run with `--workers=1`) | — |
| Audit log (append-only trigger), audit UI | verified locally | trigger in `0001`, used across modules | — |
| Security headers, nonce-based CSP, no-store caching for private pages, dev role switcher disabled outside demo, optional staging password gate | verified locally | `e2e/csp.spec.ts` (0 violations across all roles on the production build), e2e redirect test | — |
| Migrations, constraints (exclusion, partial unique, CHECK, immutability triggers) | verified locally | all DB tests | — |
| Object storage (local disk or S3-compatible bucket, private + SSE), deletes, auth-checked downloads | verified locally (S3 via mocked client) | `storage*.test.ts`, `forms-files.test.ts`, `exports.test.ts` | Real bucket not configured |
| Job queue/outbox + worker (`pnpm jobs:work`) | verified locally | `messaging.test.ts`, `scheduling-calendar.test.ts` | No process supervisor/deploy config |
| Scheduled jobs on the outbox: nightly (after 2:00 AM facility time) referral progress, team challenge completions and goals/XP/badges per organization, plus the existing daily recap job; deduped per org, type and local date; one athlete or referral per transaction; Settings → Scheduled jobs shows last run and result with Run now | verified locally | `scheduled-jobs.test.ts` (11 tests: schedule and dedupe, idempotency, races against the page functions, failure isolation, queue path, status view, no messages), e2e `jobs.spec.ts`, a11y on `/settings/jobs` | No worker deployed, so the schedule has not run unattended; fixed 2:00 AM; see `docs/modules/scheduled-jobs.md` and `docs/DEPLOY.md` |
| Go-live readiness page (`/settings/go-live`, owner and admin): about forty items in eight sections, each status computed from the environment and the data on every load (hosting and safety, payments, messages, legal text, catalog and policy, data migration, people, open decisions); fixed blocking subset; manual ticks only for what the hub cannot see, shown as attested by a named person on a date and audited; storage round-trip check; typed open-decision list with "confirm as is"; Today card "Go-live: N blocking items"; one machine-readable sample-wording flag (`src/lib/sample-text.ts`) | verified locally | `golive.test.ts` (20 tests), e2e `golive.spec.ts` (desktop + 390 px), a11y and CSP on `/settings/go-live` | Synthetic data and fixtures only: no real Stripe account, email provider or bucket was contacted. Built-in wording is replaced in code. See `docs/modules/go-live.md` |
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
| Saved payment methods (card, US bank account) via Stripe-hosted setup; references + last four only; active only by verified webhook; default/remove rules; staff summaries + QR | implemented, configuration required | `billing-payment-methods.test.ts` (signed fixtures, mocked API), `e2e/signup.spec.ts` (not-configured state) | Never run against a Stripe sandbox; several event/parameter shapes unverified (`docs/modules/payments-autopay.md`) |
| Autopay: off-session charge per membership bill, idempotent under lock, ACH pending/failed/late return, decline sorting + retry schedule, staff tasks, no messages | implemented, configuration required | `billing-autopay.test.ts` | Needs test keys to prove a real charge, ACH timing and failure codes; no staff retry button |
| Processor fees per payment and by method type per month (report + CSV); optional bank pay discount (off by default) | implemented, configuration required | `billing-autopay.test.ts`; axe on `/reports/processing-fees` | Fee lookup path unverified; no fee rate is built in |
| Membership agreement: merge fields from the membership, frozen signed snapshot, linked to membership + product version, configurable re-sign triggers, awaiting-agreement gating | verified locally | `signup-agreements.test.ts`, `e2e/signup.spec.ts` | Template text is SAMPLE for a lawyer to replace; self-signing needs email delivery (step-up) |
| Guided sign-up flow (plan → sign → pay → confirm), resumable, staff hand-over QR; Zen Planner conversion; Cut over requires agreement + saved method (or audited reason) | verified locally (not-configured mode in browser at desktop + 390px) | `signup-agreements.test.ts`, `e2e/signup.spec.ts` | Saving a method inside the flow needs Stripe keys; card data cannot be migrated from Zen Planner by this app |

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
| VBT data: CSV import, incl. GymAware-style headers (`Mean Velocity (m/s)`, load unit from `Weight (kg)`); name-only rows go to identity review, never matched by name | verified locally | `training.test.ts`, `training-vbt-surfaces.test.ts`, fixtures `fixtures/vbt/` | No device connectivity (by design). Header style not checked against a real GymAware export. A coach without imports access is told to hand name-only files to an owner or admin |
| "Estimated max from bar speed" card on the athlete training page: coach confirms or dismisses; stored as estimated, source `vbt_bar_speed`, audited; never on boards, Showcase, recaps, PRs or the family strength table | verified locally | `training-vbt-surfaces.test.ts`, e2e `vbt.spec.ts`, screenshots `docs/screenshots/vbt/` | Stored in the athlete's working unit for the lift. A confirmed estimate drives % loads like any max |
| Bar speed field in the logger and weight room with live estimated %1RM (`mpv_*_v1`), shown only when the athlete has a load-velocity profile for that lift | verified locally | `training-vbt-surfaces.test.ts`, e2e `vbt.spec.ts` | Uses published curves, not the athlete's own line. Not shown in the offline copy. Adds one field per set on phones |
| Relative strength (`rel_strength_v1`) for staff with health access, body mass from Hawkin trials or the athlete profile | verified locally | `training-vbt-surfaces.test.ts`, e2e `vbt.spec.ts` | Hawkin body-weight keys are inferred from the fixture header (`Body Weight(kg)`), not a live account. No UI to edit body weight |
| FMS movement screen | not built | n/a | Does not fit the KPI entry form (3 metrics per session, no derived total or flag) and involves pain scoring, which belongs under health access |
| VBT math: load–velocity profile → estimated 1RM (`lv_profile_v1`), published velocity→%1RM curves (`mpv_squat_v1`/`mpv_bench_v1`/`mpv_generic_v1`), velocity zones, relative strength (`rel_strength_v1`) | verified locally | `training-vbt.test.ts` (pure), `training-vbt-maxes.test.ts` (suggest/confirm from `vbt_readings`, authz, kg conversion) | Ported from the proven Vantage engine (`claude/athlete-training-platform` branch). Surfaced in the rows above |

## Sports science / AMS (evidence: public docs; all indices are documented Teamwork calculations)

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Wellness questionnaires (versions, schedules, missing ≠ favorable, `tw_readiness_v1`) | verified locally | `science.test.ts`, `science-formulas.test.ts` | No reminders/push |
| Body heat map (front/back SVG + accessible entry, history, coach review queue + generic task) | verified locally | `science.test.ts`, `connected-flows.test.ts` | — |
| Habits (assignments, check-ins, adherence, streaks; missed ≠ missing) | verified locally | `science.test.ts` | — |
| KPI tracker (definitions, protocols, trial selection, baselines, targets, group dashboard) | verified locally | `science.test.ts` | — |
| Comparability disclosure: trends, baselines and change % only use sessions measured the same way as the latest result (test type, protocol, source/calculation version, exact unit conversion, aggregation level, body mass for relative metrics); mismatches are listed, never merged or converted | verified locally | `science-comparability.test.ts` (pure rules + two-protocol trend through series, progress view and report snapshot) | — |
| Load monitoring (`srpe_load_v1` AU, `acwr_rolling_v1` with coverage threshold, monotony/strain) | verified locally | `science-formulas.test.ts` | — |
| Volume tracker (tonnage rules, unit conversion, intensity zones vs dated max) | verified locally | `science.test.ts` | — |
| Wearables (normalized schema, CSV/manual import, missingness) | implemented (file/manual only) | `science.test.ts` | No live vendor APIs (OAuth per vendor needed) |
| Force-plate dashboard (trials, aggregates separate, baselines, SWC band, asymmetry, raw force-time plot, comparability notice) | verified locally | `science.test.ts`, `science-comparability.test.ts` | — |
| Coach-reviewed parent progress reports (health sections opt-in + permission-gated) | verified locally | `science.test.ts` | No PDF/email delivery of reports |

## Imports, Hawkin, exports

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Import Center wizard (upload → map → validate → identity review → preview → commit → reconcile → revert), idempotent re-import | verified locally | `imports.test.ts` | XLSX not read directly (save as CSV) |
| Zen Planner schemas (members, family links, memberships, attendance, documents index) | implemented, configuration required | fixtures in `fixtures/` | All column mappings unverified until checked against a real export |
| Zen Planner exact presets for the Person, Membership, Bill and Attendance report grids (case and punctuation-insensitive headers with aliases; unmatched headers listed; Family ID households; Parent columns → guardians with no health access and staff review; health columns behind `health.read`; prospects → leads with UTM; weekly limit and punch card; bills as history only; visit only when Att. = Yes) | verified locally with fictional fixtures (desktop + 390px); **not yet tested against a real export file** | `zpimport.test.ts`, `e2e/zpimport.spec.ts`, fixtures `fixtures/zenplanner/grid/` | Built from the 2026-11-13 account map. Real CSV header spellings, Person Status values and ID columns unconfirmed. No Task preset |
| Zen Planner vocabularies as default lists (Prospect Status → lead stage mapping; unknown values imported as written and flagged; owner can add values) | verified locally | `zpimport.test.ts` | Drop Reason, Income Category and Membership Category are partial (4/12, 4/12, 3/14 known from the map) |
| "Load Teamwork plan catalog": 20 unpublished draft plans from the real price ladder (owner only, idempotent, audited; Sample plans untouched) | verified locally | `zpimport.test.ts` | Plan names, some billing intervals and weekly limits are assumptions shown on each draft; short-run programs left for Events |
| Discount review after a Membership import (family percent, In Season rate, other; siblings on one Family ID without the family discount; CSV) | verified locally (desktop + 390px) | `zpimport.test.ts`, `e2e/zpimport.spec.ts` | Read-only. List price is worked out (ladder match or highest in import), not exported |
| Zen Planner webhook receiver (People, Class Sessions, Attendance / RSVP): shared secret in constant time, idempotent, rate limited, off by default, stages into the Import Center; Settings → Integrations card | implemented, configuration required | `zpimport.test.ts` (synthetic payloads) | Real payload and secret/signature format unverified; no body signature check; Class Sessions stored only; per-process rate limit; never writes to Zen Planner |
| Reconciliation of hub counts against typed-in Zen Planner dashboard figures, with likely reasons | verified locally | `zpimport.test.ts`, `e2e/zpimport.spec.ts` | Hub figures are org-wide; past-due needs the Bill grid imported |
| TeamBuildr schemas (maxes, workout log, questionnaire) | implemented, configuration required | fixtures | Mappings unverified; no public API (by research) |
| Hawkin CSV import (tests vs averages kept separate) | verified locally (fixtures) | `imports.test.ts` | Cloud CSV headers unverified |
| Hawkin Cloud API sync (token exchange, historical windows, incremental `syncFrom`, backend filtering, pagination, backoff, checkpoints, schema-change warnings, raw curves) | implemented, configuration required | `hawkin.test.ts` (mocked HTTP; also: test date = the test's own timestamp, explicit backfill window required, `includeInactive` on athletes and tests, edited tests update in place with the prior value in the row's audit trail) | Needs `HAWKIN_REFRESH_TOKEN`; response shapes partially unverified; rate limits undocumented |
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

## Retention & athlete experience (proposed Teamwork functionality; no vendor equivalent claimed)

| Feature | Status | Evidence | Gaps |
|---|---|---|---|
| Retention radar (`/people/retention`): transparent low / watch / at-risk level per active member from 15 documented rule-based signals, each with evidence; estimated monthly value at risk; last contact; recommended next action; filters and sort | verified locally | `retention.test.ts` (one fixture per signal + healthy control, read-only transaction, thresholds from settings, coach scope, org isolation) | Thresholds are starting points to tune, not norms. "Last contact" only knows Hub messages, tasks and logged outcomes (not calls or GoHighLevel). No health/wellness data by design |
| Retention thresholds in `organizations.settings.retention` (Settings → Retention radar thresholds), validated and audited | verified locally | `retention.test.ts` | "Days since last visit" reuses `attendanceGapDays` from the membership policy |
| Save log (`retention_actions`): action, outcome saved / still at risk / lost + reason code, signal snapshot, audited; "Create follow-up task" (existing tasks, one per athlete per day); "Open conversation" link | verified locally | `retention.test.ts` | A coach's entry stores no billing signals or dollar value |
| Report "Retention: saves, losses and churn" (saves, losses by reason, athlete churn overall / by tenure cohort / by plan, average tenure) with CSV via the existing reports route; every row states how it is computed | verified locally | `retention-milestones-reports.test.ts` | Dollar figures are value-at-risk estimates, not collected or lost revenue |
| Session feedback: 1–5 rating + optional comment + "tell my coach", one response per booking, editable 24h by the person who left it; family schedule card and `/feedback/[bookingId]`; no messages sent | verified locally | `retention-feedback.test.ts` (authorization per role, uniqueness, edit window, DB CHECKs) | No reminder or prompt is sent: families must open the schedule page. Not yet mounted on the family dashboard (being rebuilt separately) |
| Feedback privacy: coaches see averages only (anonymity floor, default 3 responses) unless "tell my coach" was ticked; per-session line on the session page; "Session feedback averages" report by coach and class (owner/admin; coach = own sessions) | verified locally | `retention-feedback.test.ts` | Operations can read individual responses (they do the follow-up) but cannot open the averages report |
| Low rating → staff task "Follow up on session feedback" (no comment, rating or name in the task; not linked to the athlete unless shared with the coach) | verified locally | `retention-feedback.test.ts` | Unshared follow-ups go to the first owner login |
| Milestones this week on the staff dashboard (anniversaries, 25/50/100/250 sessions, birthdays staff-only, first 30 days) with "Create shoutout task"; facility-timezone math | verified locally | `retention-milestones-reports.test.ts` | Shown on the owner/admin/operations dashboard only; no automatic messages by design |
| Winback list (`/people/retention/winback`): ended in the last 12 months with end reason, last plan, tenure; follow-up task only | verified locally | `retention-milestones-reports.test.ts` | End reason is only as good as the cancellation reason or logged loss |
## Session check-ins (ready check and after check; see `docs/modules/checkins.md`)

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Ready check before a booked session (readiness, sleep, soreness 0 to 10, does anything hurt with the existing body map, tiredness, mood, optional note); window in hours before the start; prefill from today's wellness for identical items | verified locally | `checkins.test.ts`, `e2e/checkins.spec.ts` | Wording in `src/lib/checkins/questions.ts`; defaults labelled in Settings |
| After check (session RPE, liked / did not like chips and text, anything hurt, soreness, the existing 1 to 5 rating, notes); replaces the ten-second feedback form, old link redirects, rating still stored in `session_feedback` | verified locally | `checkins.test.ts`, `retention-feedback.test.ts` (unchanged), `e2e/checkins.spec.ts` | Sections can be answered by different people; each locks to who answered it |
| Who may answer: athlete; parent of an under-13 (`training.log_at_home`), health questions only with health access; other parents experience only; staff and kiosk login never | verified locally | `checkins.test.ts` (every demo role) | Recorded as logged by a parent |
| Session RPE feeds the existing sRPE load exactly once (one `activity_sessions` row per check-in; workout logger wins on a day it has a computable load) | verified locally | `checkins.test.ts` | Two separate gym sessions in one day, logged differently, count once |
| Coach readiness strip on the session page with own-baseline context; health details only inside the viewer's health scope, others see "has a note for the coach"; optional planned intensity per session | verified locally | `checkins.test.ts`, `e2e/checkins.spec.ts` | Not shown on the shared weight-room board |
| Alerts as staff tasks (sharp pain via the body-map queue, pain two sessions running, soreness / readiness far from own baseline, "did not like" comment, low rating), listed on the follow-ups queue | verified locally | `checkins.test.ts`, `e2e/checkins.spec.ts` | Nothing is sent to families |
| Trends per athlete (staff view and simpler family view) with rolling own baseline and "not enough data yet"; class view (completion, reported vs planned RPE, chip counts, shared comments); owner report with CSV | verified locally | `checkins.test.ts`; a11y on `/check-ins`, `/check-ins/athletes`, `/reports/session-checkins` | Every number names its method and version |
| Kiosk ready check after PIN check-in: single-use pass, four taps, skip, idle timeout, reads nothing back | verified locally | `checkins.test.ts`, `e2e/checkins.spec.ts` (kiosk test) | No free text and no body picture at the kiosk |
| Settings → Session check-ins: on / off, kiosk offer, optional questions, chips, windows, alert thresholds; question-set version on every answer | verified locally | `checkins.test.ts`; a11y on `/settings/check-ins` | |
| XP for each check-in, once per booking and phase, through the existing ledger | verified locally | `checkins.test.ts` | Reuses kind `wellness_checkin` |
| Check-in completion line in the monthly recap | not implemented | | Recap snapshots are frozen under `tw_recap_v1` |

## Member journey (replaces the coaching program's checkbox spreadsheets; see `docs/modules/journey.md`)

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Journey templates (Settings → Member journey): onboarding, touchpoints, visit milestones, review and referral asks, hold, offboarding; each step has a name, owner role, due offset, optional auto-complete rule from a fixed list; editable, defaults labelled "Default"; stored in `organizations.settings.journey`, audited | verified locally | `journey-pure.test.ts`, `journey.test.ts` (edit, custom step, reset, coach refused), e2e `journey.spec.ts`, a11y on `/settings/journey` | Edits apply to journeys that start afterwards. Defaults are starting points, not policy |
| Generator `syncJourneys`: steps created from memberships, holds, cancellations, visit counts and 5-star feedback; idempotent (unique anchor, step and task keys plus an advisory lock); nightly job `journey.sync.nightly` with Run now; also run by the follow-ups page and the profile panel | verified locally | `journey.test.ts` (twice and three at once create nothing; job registered; long-standing member gets no backlog; nothing sent), `scheduled-jobs.test.ts` | No worker deployed. Nothing older than 30 days (editable) is generated, so a gap longer than that loses steps |
| Auto-completion for 14 detectable events (staff message, documents signed, payment method, first session booked / attended, coach assigned, program assigned, shoutout posted, hold reason / return date / restart reminder, cancel reason, final bill settled, removed from program and groups), audited as system | verified locally | `journey-pure.test.ts` (every rule), `journey.test.ts` (each against real rows) | Exit survey is staff-logged (session feedback is per booking and does not fit). The hold reminder ticks only if the restart automation rule is enabled |
| Journey steps are rows in the existing `tasks` table with a 1:1 `journey_steps` extension; visit-milestone steps share the dedupe key of the Milestones "Create shoutout task" (adopted, never duplicated); win-back step creates the task the win-back list shows | verified locally | `journey.test.ts` | Journey tasks appear on People → Tasks only once assigned |
| Due dates in facility-local dates (calendar months clamped, DST-safe); a touchpoint that falls inside a hold moves to 7 days after the hold ends and back if the hold is removed; tenure is not stretched by a hold | verified locally | `journey-pure.test.ts`, `journey.test.ts` (UTC vs facility day, hold added later, member already on hold) | Decision documented in `docs/modules/journey.md`; grace days editable |
| Review and referral asks: suggested once after a visit milestone or 5-star rating; never while at risk or past due; an open ask is hidden while the member is at risk or past due; asked / reviewed / referred / declined recorded | verified locally | `journey.test.ts` (healthy, past due, at risk, becomes past due later, outcomes) | No review-site integration (by design) |
| Per-member journey panel on the staff person page: onboarding progress, upcoming touchpoints, milestones and whether each was recognised; one-tap complete, skip with reason, snooze, assign; all audited | verified locally | `journey.test.ts`, e2e `journey.spec.ts` (desktop + 390px), a11y person detail page | Opening the page runs the generator for that athlete (a write on a page view, as engagement does) |
| Today's follow-ups (`/follow-ups` and a dashboard card): due and overdue steps grouped by type, filter by owner, location and type, assignable; yesterday's no-shows and absent members with "Log a reach-out" | verified locally | `journey.test.ts` (scope per role, billing steps hidden from coaches, other org, assignment rules, snooze, no-show and absent lists), e2e, a11y, CSP sweep (owner 150 pages, coach 125, desktop) | Absent window = radar "No recent visit" up to 60 days (assumption). Queue capped at 500 rows |
| Operations checklist (`/follow-ups/checklist`): opening / closing / cleaning / weekly items per location, ticked per facility-local day by any staff, month grid | verified locally | `journey-ops.test.ts`, e2e, a11y | Deliberately small. Month grid uses the currently active items. Sample list is invented wording |
| Coach weekly scorecard (`/follow-ups/scorecard`): utilisation, reach-outs logged, assessments held, touchpoints on time against editable targets, plus a weekly reflection; coaches see their own, owner / admin see all | verified locally | `journey-ops.test.ts`, e2e, a11y | Targets are organization-wide. "Meetings" counts sessions of kind Assessment only |
| Journey report (`/follow-ups/report`, owner / admin): onboarding completion rate and time, touchpoints on time vs late, milestones recognised vs missed, by month; query functions `onboardingCompletionByMonth`, `touchpointTimelinessByMonth`, `milestoneRecognitionByMonth` usable by another page | verified locally | `journey.test.ts` | No CSV. Not wired into `/scoreboard` (built separately) |

## Athlete engagement (proposed Teamwork functionality, built; see `docs/modules/engagement.md`)

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Athlete Home on `/today` for athletes and guardians (workout, next session, week progress, goals, badges, PRs, checklist, family items) | verified locally | `engagement.test.ts` (read model + access), e2e `a11y` + `csp` for guardian and athlete, screenshots in `docs/screenshots/engagement/` | Refreshes on page load only (no background job, no notifications) |
| Weekly streak in facility-local ISO weeks; hold weeks skipped; DST safe | verified locally | `engagement-pure.test.ts`, `engagement.test.ts` | In-season pauses are not treated as holds (by design) |
| XP ledger (`xp_events`, append-only trigger, idempotent derive-and-upsert) and levels | verified locally | `engagement.test.ts` (repeat + concurrent sync, constraints), `engagement-pure.test.ts` | XP is never reversed after a correction |
| Badges: catalog in code, idempotent awarding, SVG medallions | verified locally | `engagement.test.ts`, `engagement-pure.test.ts`, e2e `a11y` | No notification when a badge is earned |
| Goals: free text or linked to a test metric or lift max; comparability enforced; auto-achieve with audit and XP | verified locally | `engagement.test.ts` | Staff manage goals from the performance page only |
| Coach Engagement strip and Goals panel on `/performance/[athleteId]` | verified locally | `engagement.test.ts` (assigned vs unassigned coach), e2e `a11y` detail pages | Not shown on the People profile |
| Engagement settings (XP points, levels on/off, badges on/off), owner/admin, audited | verified locally | `engagement.test.ts`, e2e `a11y` + `csp` for owner | Point values are defaults to confirm with the owner |
## Events: camps and clinics sold online (see `docs/modules/events.md`)

| Feature | Status | Evidence | Gaps |
|---|---|---|---|
| Staff create an event (camp, clinic, event) with one or more sessions on the existing session tables, capacity, price, early bird price with last day, sibling discount percent, registration open/close dates, age limits, required forms, unpaid-hold hours; draft / published / closed | verified locally | `events.test.ts` (validation, permissions, capacity floor, publish rules); screenshots | Sessions cannot be removed from the event page (cancel the day on the calendar) |
| Family list and detail (`/shop/camps`, cards on `/shop` and Athlete Home): dates, ages, price in effect, spots left; choose athletes with a running total; eligibility and permission reasons in plain words | verified locally | `events.test.ts`, `e2e/events.spec.ts` at desktop and 390px (6 passed) | — |
| Only people who can pay AND book register (Alex yes; Jordan, Casey, unrelated families, minors' own logins, coaches no); staff can register at the front desk | verified locally | `events.test.ts` permissions case, e2e Jordan case | — |
| Registration holds the seat and creates one open invoice per billing account through the existing invoice flow; idempotent per form | verified locally | `events.test.ts` | — |
| Capacity correct under concurrency (event row lock; one live registration per athlete by partial unique index) | verified locally | `events.test.ts`: 10 concurrent for 3 seats gives 3 and 7 "full"; same athlete x3 gives 1 | — |
| Unpaid hold: per event, default 48 hours, never past the first session; released lazily (next registration, page loads), which voids the unpaid invoice; never released while money is recorded or in flight | verified locally | `events.test.ts` unpaid holds | No scheduled job; release is lazy |
| Confirmed only when the invoice is paid by the existing settlement path (verified provider payment or staff-recorded payment); pending, partial, redirect and "grant on pending" never confirm | verified locally | `events.test.ts` confirmation cases | Real provider checkout not exercised (no credentials) |
| On confirmation the athlete is booked into every session without membership credits; a session added later books confirmed athletes | verified locally | `events.test.ts` (credit ledger unchanged) | — |
| Staff cancellation releases the spot and upcoming bookings; unpaid invoice voided (reissued for remaining siblings); paid invoices untouched, refund through the existing refund flow | verified locally | `events.test.ts` staff cancellation | Families cannot cancel online |
| Staff events list: registrations, paid/unpaid, revenue per event (less settled refunds), roster CSV | verified locally | `events.test.ts`, e2e staff case | — |
| Waitlist when full | not done | — | Shows "Full". The session waitlist reserves credits; an event seat needs an invoice and a hold |
| Notifications (registered, reminder to pay, hold expiring) | not done | — | Nothing is sent |

## Growth: referrals, Family Shop, helpful offers, trial passes (proposed Teamwork functionality, now implemented; see `docs/modules/growth.md`)

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Referral code + link per payer account (`/r/<code>` → public inquiry form; 10-char random code, one active per payer, staff can revoke and reissue); family "Refer a friend" page with copy button, QR code, reward text from settings, and referral status as first name + last initial + stage only | verified locally | `growth-referrals.test.ts`; a11y/CSP sweeps for `/refer` and `/r/parkerdemo26` | The public page never looks the code up (identical page for any code), so a mistyped link is not flagged to the visitor. Families cannot rotate their own code |
| Attribution rules: first valid code wins (per lead and per family), self-referral blocked, same household blocked (configurable), referred family must be new (configurable); rules re-checked at conversion; blocked attempts kept for staff with the reason | verified locally | `growth-referrals.test.ts` | Matching is by person record, email and phone. A family that inquires with a brand-new email and phone is treated as new until conversion links them |
| Reward settings (Settings → Growth, owner/admin): none / account credit / session credits, earned on first paid invoice above $0 or after N days active, optional reward for the referred family. Defaults OFF and empty; demo values labelled sample | verified locally | `growth-referrals.test.ts` | — |
| Earned reward → PENDING → staff approve (one click, row-locked, idempotent, audited) → account credit ledger entry or session credits via the existing credit ledger; decline needs a reason | verified locally | `growth-referrals.test.ts` (8 concurrent approvals → 1 ledger entry) | Referral progress is evaluated when staff open People → Referrals or a family opens Refer a friend, not by a background job |
| New family discount (owner decision 2026-11-11): configurable amount in Settings → Growth (off by default, $50 in the demo); reserved at conversion, applied automatically to the referred family's first open invoice as a discount (also at invoice creation); one per new payer account, never for existing/returning families or self-referrals, never stacked; released if the invoice is voided; becomes a staff-approved account credit if the first invoice was already paid | verified locally | `growth-new-family.test.ts` (15 tests), e2e `jobs.spec.ts` (wording on `/r/<code>`, `/refer`, settings, staff page) | Remainder above a small first invoice is not carried over; shown inside the invoice discount total, not as a named line |
| Refund handling for referral rewards: a fully refunded first payment does not earn; pending rewards (both sides) are withheld automatically; approval refused meanwhile | verified locally | `growth-new-family.test.ts` | An already approved credit is flagged for staff, not reversed |
| Account credit ledger + staff "apply to open invoice" (lowers the invoice total as a discount; never a payment, never auto-applied) | verified locally | `growth-referrals.test.ts` | Not shown on the invoice PDF/receipt as a separate line; no family self-service redemption; refused for provider-subscription invoices |
| Staff referrals page (`/people/referrals`): funnel, top referrers, rewards to approve, recent referrals incl. not-counted reasons; lead detail shows who referred the lead and lets staff add a code | verified locally | `growth-referrals.test.ts`; a11y/CSP sweeps | — |
| Family Shop (`/shop`): products staff mark "sellable online" in Billing → Products (default off); session packs, drop-ins, assessments, one-time add-ons; choose athlete; price from the catalog version | verified locally | `growth-shop-offers.test.ts` | Camps and clinics are sold as events (see the Events section), not as shop products. Memberships and retail are excluded. Quantity is always 1 |
| Shop checkout = OPEN invoice through the existing invoice flow, idempotent per form key; entitlements only via the existing settle-on-verified-payment path; honest "pay at the front desk" state when no provider is configured | verified locally | `growth-shop-offers.test.ts` (5 concurrent clicks → 1 invoice; no credits before settlement; `startCheckout` not-configured) | Hosted checkout with real provider credentials is the billing module's sandbox item, unchanged here |
| Shop respects per-guardian flags: only payers with can-pay buy, only for athletes on their account (Jordan view only, Casey none, minors' own logins none) | verified locally | `growth-shop-offers.test.ts` | — |
| Helpful offers (rule-based, evidence shown): weekly cap reached 3 of last 4 weeks → next plan up; purchased credits low/expiring → renewal; month to month N months → commitment savings; sibling on file not enrolled → family discount; no baseline test in N months → assessment; In Season ending → returning plan | verified locally | `growth-shop-offers.test.ts` (fixture + control athlete per rule) | Rules only fire when the suggested plan/item exists in the catalog. "Same plan" matching uses interval, classes per week and commitment, and treats products whose name or category says "In Season" as in-season plans |
| Staff Opportunities: card on the member profile and `/billing/opportunities` list with estimates labelled as estimates, "Create task" (deduped) and links into the membership page | verified locally | `growth-shop-offers.test.ts`; a11y/CSP sweeps | Estimates are catalog list-price differences, not forecasts |
| Family suggestion: at most one, inline on `/shop` and the family billing page, "Not now" stored and respected for a configurable period, hidden from anyone without billing access, org-wide off switch | verified locally | `growth-shop-offers.test.ts` | Sibling discount suggestion stays staff-only until an owner confirms the family discount percent |
| Free trial pass from the lead page (N session credits with expiry, reason required, audited, idempotent) via the existing credit ledger | verified locally | `growth-referrals.test.ts` | Issuing a pass gives the lead's person an athlete record so credits can be held and staff can book them; the lead stays open. No pass for a person who is not a lead from the UI (domain function supports it) |
| Growth reports (referrals funnel, shop sales by item, suggestions shown/followed/dismissed, trial pass conversion) with written definitions and CSV | verified locally | `growth-referrals.test.ts`, `growth-shop-offers.test.ts` | "Followed" means the button was used, not that a purchase happened |

## Anywhere: On Your Own, My Season, Daily 3 (proposed Teamwork functionality, built; see `docs/modules/anywhere.md`)

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| On Your Own library (`/anywhere`): coach-curated short sessions built from the existing exercise library, filter by time and equipment, safety line on every session, under-13 athletes see only sessions marked suitable | verified locally | `anywhere.test.ts` (published only, age rule, scope per role, org isolation), `anywhere-pure.test.ts`, e2e `a11y` + `csp` for guardian and athlete, screenshots in `docs/screenshots/anywhere/` | Sample sessions are starting points for coaches to edit. No birthday on file is treated as under 13 |
| Coach builder and library (`/training/anywhere`), keyboard operable (Up/Down/Remove buttons) | verified locally | `anywhere.test.ts` (builder roles, publish needs a step, other-org exercise refused, reorder), e2e `a11y` for owner and coach | Steps are removed and re-added rather than edited in place |
| Finish a session: own record (`anywhere_completions`), idempotent client key, optional RPE and minutes | verified locally | `anywhere.test.ts` (repeat + 4 racing retries = 1 row, late retry keeps finish time, who may finish) | Save-and-retry only: an open session works without a connection, a first load does not (no service worker) |
| Parent logs an at-home session and effort rating for an athlete under 13 (owner decision): guardian link needs training and booking access (`training.log_at_home` in `policy.ts`); no birthday on file = not allowed; recorded as `logged_as = guardian`, audited, "Logged by parent" badge for coaches; same streak, XP and load rows as the athlete's own log | verified locally | `anywhere-guardian.test.ts` (13 tests, every permission case), e2e `anywhere.spec.ts` (guardian flow, desktop + mobile) | At-home sessions only; practice, game and habit logging stay with the athlete and coaches |
| Completions count toward the weekly streak and a new XP kind `on_your_own_completed` (default 10, configurable) | verified locally | `anywhere.test.ts`, `anywhere-pure.test.ts`, existing `engagement*.test.ts` unchanged | Point value is a default to confirm with the owner |
| Assign a session or a type for specific days to an athlete or group; status on Athlete Home and on the coach board; review queue | verified locally | `anywhere.test.ts` (coach scope, group scope, progress, under-13 hidden) | No reminders are sent |
| My Season (`/anywhere/season`): team, sport, dates, one-off and weekly events in facility time, DST safe | verified locally | `anywhere.test.ts` (who can edit/view), `anywhere-pure.test.ts` (both DST changes) | Weekly repeats only. Events are removed and re-added rather than edited |
| `.ics` upload: bounded parser, staged preview, import idempotent by UID; no remote fetches | verified locally | `anywhere-pure.test.ts` (limits, malformed, alarms/URLs ignored, time zones), `anywhere.test.ts` (stage, import twice, roles) | Calendar URLs are out of scope. Changes to single days of a repeating event are skipped with a warning |
| Log outside practice and games (duration + RPE) into `activity_sessions` with source `sport`; missing logs stay missing | verified locally | `anywhere.test.ts` (ACWR equals existing formulas over the new series, unchanged without outside sessions, relog updates one row, access mirrors load) | Guardians cannot log for a child (existing `training.log` rule) |
| Weekly load stacked by origin (gym / sport / on your own) on the load page, `load_origin_v1`, text summary and table | verified locally | `anywhere-pure.test.ts`, `anywhere.test.ts` (split adds up), e2e `a11y` on `/science/load` | Unlogged sport sessions make the sport share look smaller than it is (stated on the chart) |
| Coach views: "Who has a game in the next 48 hours" on the training overview; season on the athlete training page | verified locally | `anywhere.test.ts` (own athletes only, 48h window) | Not shown on the People profile |
| Game Day card on Athlete Home with a pre-game warm-up suggestion and a post-game log prompt; never based on wellness or injury data | verified locally | `anywhere.test.ts` (pain report changes nothing), screenshots | Suggestion is the shortest published warm-up, not sport specific |
| Daily 3 on Athlete Home from the existing habit tables, one-tap done | verified locally | `anywhere.test.ts` (max three, existing check-in rules) | Changing a check-in is done on the Habits page |
| In Season informational link, org setting, default off; never changes a membership | verified locally | `anywhere.test.ts` (off by default, owner/admin only, no membership or request rows written) | Opens a new message to the front desk; staff log the request as today |

## Athlete Showcase and monthly recap (proposed Teamwork functionality, built; see `docs/modules/showcase.md`)

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Showcase builder at `/showcase` (athlete or guardian picks test results, lift maxes, consistency, profile, bio, video link, contact email; live preview) | verified locally | `showcase.test.ts`, e2e `a11y` + `csp` for guardian and athlete, screenshots in `docs/screenshots/showcase/` | Height is not on file anywhere in the Hub, so it cannot be shown. Families cannot edit sport, school or body weight themselves |
| Allowlist: config, catalog and public payload hold only named keys; wellness, body map, health, notes, billing, attendance detail, date of birth, address and account contacts can never appear | verified locally | `showcase.test.ts` (extra posted keys dropped, non-allowlisted metric refused, rendered HTML and JSON checked for a seeded athlete with wellness, body map, notes and invoices) | |
| "Verified by Teamwork on <date>" only for staff-entered or device-imported values; measured vs estimated maxes labelled; trend sparkline only with three or more comparable results | verified locally | `showcase.test.ts` | No athlete-entered test path exists today, so the unverified branch is exercised by test data only |
| Consent and control: minors need a guardian to publish, adults publish themselves, staff never; append-only consent table (who, when, fields, policy version); a change by anyone returns it to draft until republished | verified locally | `showcase.test.ts` | Consent wording is SAMPLE text and needs review. A guardian's own edit also pauses the link until they publish again (stricter than asked) |
| Share link `/s/[token]`: 256-bit token stored as SHA-256 only, instant revoke, optional expiry (default 90 days), rotate, same generic page for unknown, revoked and expired, `noindex` meta and `X-Robots-Tag`, `private, no-store`, rate limit, daily view counts with no visitor data | verified locally | `showcase.test.ts`, e2e `a11y` + `csp` (seeded demo token and a dead link) | The rate limit is in memory per server process. The link is shown once and cannot be recovered, only replaced |
| Public one-pager: branding from org settings, metric tiles, methods footnote, "Train at Teamwork" link to `/inquire?ref=showcase`, prints to one page | verified locally | e2e `a11y` + `csp`, screenshots (1440, 390, print) | The inquiry form does not store the `ref` value yet. An external logo URL is ignored (same-origin path only) |
| Showcase PDF (`/api/showcase/[athleteId]/pdf`, family only, pdf-lib, content hash in footer and header) | verified locally | `showcase.test.ts` (text, hash, one page, access) | Generated on request, not stored |
| Staff list at `/people/showcases` (coach scope applies) with owner/admin revoke, audited; org switch and minimum age in `/settings/showcase` | verified locally | `showcase.test.ts`, e2e `a11y` + `csp` | |
| Monthly Progress Recap at `/recap` and `/recap/[yyyy-mm]`: sessions vs plan, streak, PRs, badges, goals, tests with comparable change, coach note, next month; printable | verified locally | `showcase-recap.test.ts`, e2e `a11y` + `csp` | Goal progress is as of finalization, not the month's last day |
| Recap snapshot: finalized once under `tw_recap_v1`, immutable by database trigger; guardian flags and coach scope respected; no health values | verified locally | `showcase-recap.test.ts` | |
| Coach queue `/training/recaps` for notes before the month closes; monthly job `recap.monthly` creates the record and an in-app notice only | verified locally | `showcase-recap.test.ts` (job, idempotency, no deliveries or jobs created) | No email is sent for a recap (by design; delivery stays off). The notice is a card on Athlete Home, not a push |

## Community: gym TV board, leaderboards, shoutouts, challenges (proposed Teamwork functionality, built; see `docs/modules/community.md`)

| Feature | Status | Evidence | Gaps |
|---|---|---|---|
| Display consent per athlete (first name + last initial, first name only, hidden); one resolver (`publicName`) for every board, leaderboard, shoutout and challenge; org default | verified locally | `community-pure.test.ts`, `community.test.ts` (hidden athlete absent from every payload while a PR, shoutout, badge and streak exist) | |
| Who may change it: guardian with profile access for a minor, adult athlete for themselves, staff with a required "who asked" note; audited | verified locally | `community.test.ts` (unrelated guardian, revoked guardianship, minor, coach, other org all refused) | Staff request is a typed note, not a signed consent form |
| Gym TV board `/display`: nine panels, cut rotation, in-place refresh, last data kept offline, facility clock, no sound | verified locally | `community.test.ts` (payload: no ids, last names, birthdays, body mass, rosters; writes nothing), e2e `community.spec.ts` (cuts, offline note), axe on every panel, CSP sweep, screenshots in `docs/screenshots/community/` | One board per organization (not per location). No animation by design |
| Board access: revocable display token (hash stored), httpOnly cookie read by the board page and `GET /api/display/board` only; owner/admin preview | verified locally | `community.test.ts` (create, resolve, revoke, malformed, cross-org), e2e `community.spec.ts` (19 app routes bounce to login, other APIs refuse, non-GET 405, revoke kills it) | Token has no expiry: it lives until revoked |
| Leaderboards `/leaderboards` by age band and training group: sessions this month, weekly streaks, most improved (90 days), measured maxes, pound for pound (order only) | verified locally | `community.test.ts` (age bands never mixed, no birthday = not ranked, estimated maxes excluded, no weight or ratio output), `community-pure.test.ts` (ranking, ties, improvement math) | Mixed lb/kg boards rank by exact conversion but print each athlete's own unit |
| Own rank always shown, also when hidden; small boards (<5 visible) rank visible athletes only and withhold totals | verified locally | `community-pure.test.ts`, `community.test.ts`, e2e `community.spec.ts` | |
| Coach shoutouts: four chips + optional 140-character note, staff only, coach scope, family-style lint, per-author daily limit, XP kind `coach_shoutout`, audited removal | verified locally | `community.test.ts` | XP stays after a removal (append-only ledger). No notification is sent |
| Team challenges: individual or team total; sessions, workouts or weeks trained; facility-timezone window; completion badge + audit | verified locally | `community.test.ts` (11:30 PM edge cases, idempotent completion, group scope, who may create/archive), `community-pure.test.ts` | Completion is recorded on the next Athlete Home or leaderboards load, not by a scheduled job. No prizes by design |
| Settings → Community: feature switch, default display mode, panels, rotation seconds, shoutout limit, gym message, screens | verified locally | `community.test.ts`, e2e `a11y` + `csp` | |

## Wins and Competitions (owner request, built; see `docs/modules/wins.md`)

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Competition calendar from My Season games and tournaments plus staff team schedules (entered once, attached to several athletes); staff week and month views with sport, team, training group and location filters | verified locally | `wins.test.ts` (merge, one entry per athlete per day, coach scope, filters), e2e `wins.spec.ts` at desktop and 390px, screenshots `docs/screenshots/wins/` | "Location" is derived from bookings in the last 90 days: athletes have no home location on file. Team dates are single days, no repeat rule, no in-place edit |
| "Competing this week" on staff and coach Today with "compete tomorrow" called out and a link to the existing load page | verified locally | `wins.test.ts`, e2e `wins.spec.ts` | No new load logic by design |
| Family card "athletes competing this week": display name, sport, kind and day only | verified locally | `wins.test.ts` (no hidden athlete, ids, last names, team, opponent, place or time for five roles), e2e `wins.spec.ts` | Cannot be switched off on its own; follows the community master switch |
| Wins: submit by athlete, guardian with the can-book flag, or staff in scope; pending until staff approve; headline edit at approval; removal by staff with a reason or withdrawal by the family; all audited | verified locally | `wins.test.ts` (every demo role incl. kiosk and another organization), e2e `wins.spec.ts` | Families cannot edit after sending. Staff-entered wins need no family confirmation (only leads do) |
| No health, injury, body-weight or school-grades wording; no last names; `https` source link shown to staff and the family only | verified locally | `wins.test.ts` | Keyword screen only; staff approval is the real check |
| Optional photo: JPEG or PNG, metadata stripped before storing, staff-approved before anyone outside the family sees it | verified locally (logic); upload control **not browser-tested** | `wins.test.ts` (EXIF and PNG text stripping, who may load the photo) | The upload form and route handler were not exercised in e2e. Photos never go on the TV and are not shown inside the marketing queue |
| Three consent levels per win: in the app, gym TV (both follow the display-name setting; hidden athletes never appear), public marketing (default no; guardian with the sign-forms flag for a minor, the adult athlete for themselves; revocable; who and when stored in an append-only ledger) | verified locally | `wins.test.ts` (roles, guardian without the flag, guardian of an adult, minor athlete, ledger trigger, CHECKs), e2e `wins.spec.ts` | Consent wording is SAMPLE text and needs review |
| Wins on the TV board (switchable panel), the family feed, Athlete Home, staff profile, monthly recap, and a "reason to congratulate" card on the retention radar | verified locally | `wins.test.ts` (payloads with no ids, last names, links, unapproved or hidden wins), e2e `community.spec.ts` (board payload), `wins.spec.ts`, axe on the new routes and the extra panel | Recap section and staff profile card are covered by unit tests and axe only, not by a browser flow |
| XP for an approved win (`win_approved`, default 15, once per win) | verified locally | `wins.test.ts` | Default is a starting point. XP stays if the win is removed |
| Marketing queue: only approved wins with consent; three caption drafts from fixed templates; mark as posted (channel, date); "Ask the family" in-app request; take-down list after a withdrawal | verified locally | `wins.test.ts` (revocation removes a win; nothing can be marked without consent; no job written), e2e `wins.spec.ts` | The app posts nothing and sends nothing. Caption templates are sample wording |
| Leads to check: staff note or pasted link becomes a draft win the family confirms, then staff approve | verified locally | `wins.test.ts`, e2e `wins.spec.ts` (list only) | Converting a lead was not clicked through in the browser |
| Scraping social media or news site pages for athletes | **not implemented, on purpose** | none | Ruled out. News watch (below) reads feeds only, for opted-in names |

## News watch (owner request, built; see `docs/modules/newswatch.md`)

| Feature | Status | Test evidence | Gaps |
|---|---|---|---|
| Every news clip needs a person's approval before it appears anywhere (feed, alumni section, TV). Owner and admin approve; the owner can also allow operations and coaches. No automatic approval exists | verified locally | `newswatch.test.ts` (every demo role, both settings, database CHECK), e2e `newswatch.spec.ts` | None known |
| Sources: publisher RSS/Atom feeds and news search feeds restricted to named publications; on/off, audience, minimum interval, last result; https public hosts only | verified locally (fixtures) | `newswatch.test.ts` (parsing, validation, permissions), e2e settings page | **Not run end to end against live feeds.** One manual live check of each default address is recorded in the module doc. A news search feed is a third-party service whose terms need review |
| Sample default sources for the Herald-Times, the Bedford Times-Mail and the Greene County Daily World | implemented, configuration required | default list test; live check notes in the doc | Both paywalled papers answer 402 directly and are covered only through a news search feed; the Bedford search results looked stale in the live check |
| Watch list: guardian opt-in for minors (sign-forms flag), adult self opt-in, default off, revocable, "Ask the family" in-app request, append-only ledger | verified locally | `newswatch.test.ts`, e2e `newswatch.spec.ts` | Opt-in wording is SAMPLE text. The request is shown on the Wins page only, not on Home |
| Alumni records with a recorded basis for watching, one-step removal, "Mark as alumni" on a profile, minors never watched on staff's say-so | verified locally | `newswatch.test.ts` | "Mark as alumni" card covered by unit tests and axe only, not a browser flow |
| Matching: exact full-name phrase, school/sport/town words, same-name and common-name penalties, "not our athlete" negatives, dedupe across sources and days | verified locally | `newswatch.test.ts` | A word-and-phrase matcher: it can miss stories and mis-match names |
| Sensitive topics: health, weight or grades headlines cannot be approved; arrest, court, death, discipline or crash terms show a warning label | verified locally | `newswatch.test.ts` | Word lists only |
| Approval queue with bulk approve and one-step take down; pending count on staff Today for approvers | verified locally | `newswatch.test.ts`, e2e `newswatch.spec.ts` (approve, Today count, take down) | Bulk approve covered by unit tests, not clicked in e2e |
| Display: "In the news" wins in the feed with a filter, "Teamwork alumni in college" section, TV panel lines; headline, publication, date, link out; never article text or images | verified locally | `newswatch.test.ts` (payloads), e2e `newswatch.spec.ts`, axe and CSP route lists | TV lines covered by unit tests only |
| Never public marketing: the app posts nothing; marketing queue still needs the family's separate consent | verified locally | `newswatch.test.ts` | None known |
| Nightly job with Run now, daily request cap, per-source interval and backoff, failure isolation, idempotent | verified locally (fixtures) | `newswatch.test.ts` | **No worker is deployed**, so nothing runs on its own until the app is hosted. News watch is off by default |
| Paid or licensed news API | **not implemented** | none | An adapter interface exists; nothing is integrated |

## Cross-module acceptance paths (brief §13)

| Path | Status | Evidence |
|---|---|---|
| 1. Registration → form → invoice → verified payment → entitlement → booking → attendance/credit | verified locally | `connected-flows.test.ts` |
| 2. Program → assignment → athlete log → coach review → history/volume/load | verified locally | `training.test.ts`, `science.test.ts`, `connected-flows.test.ts` (load link) |
| 3. Wellness/body map/habits → scoped coach dashboard + review task | verified locally | `science.test.ts`, `connected-flows.test.ts` |
| 4. Historical import → identity review → commit → performance chart → export/reconciliation | verified locally (fixtures) | `imports.test.ts`, `hawkin.test.ts`, `exports.test.ts` |
| 5. Lead inquiry → assessment → task/inbox → conversion | verified locally | `crm.test.ts`, `connected-flows.test.ts` |

## Family scheduling and billing in the previous member site's shape (`docs/modules/zp-parity.md`)

Reference evidence: **from memory of the public member experience** only (the vendor help centre was unreachable from the build machine; no account access). Parity itself is therefore unverified until checked against the owner's screenshots.

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Family calendar: day list with week strip, date jump, program / location / instructor filters, Reserve / Join waitlist / Cancel reservation per class | verified locally | `e2e/family-reserve-bills.spec.ts` (desktop + 390 px), axe guardian + athlete groups | Booking rules unchanged |
| Family-member checklist at the moment of reserving | verified locally | same spec (reserves Eli from the checklist, then cancels) | Uses the existing batch booking (partial mode) |
| Class detail for families (`/schedule/classes/<id>`) | verified locally | same spec, axe dynamic route | Shows only the viewer's own family |
| My Reservations, My Attendance by month | verified locally | same spec (reservations), axe (both) | Attendance is a list, not a calendar grid |
| Appointments entry (private sessions, assessments) | verified locally | axe; labels only | Slot logic unchanged |
| My Profile tabs: Family, Memberships, Bills, Payment Methods, Payment History, Documents, Attendance | verified locally | same spec (tab order), `tests/billing-family-views.test.ts` | |
| Bills: unpaid with Pay Now, upcoming (Scheduled), history with receipts | verified locally | same spec (Pay Now for Alex, none for Jordan), `tests/billing-family-views.test.ts` | Online payment itself still needs provider configuration |
| Payment Methods: card on file, which memberships it pays for | verified locally (read model); update flow **not implemented** | `tests/billing-family-views.test.ts` | No self-service update; the tab says to contact the front desk |
| Parity with the previous member site's exact layout and words | not verified | none | Checklist in `zp-parity.md` |

## Owner scoreboard and business dashboard (see `docs/modules/scoreboard.md`)

| Feature | Status | Evidence | Gaps |
|---|---|---|---|
| Daily scoreboard (`/scoreboard`): 27 headline numbers, each with yesterday's change and a link to the list of rows it was counted from; location / program filter applied to every number (unattributable numbers are withheld, not shown unfiltered); Definitions drawer with a version per number | verified locally | `tests/scoreboard.test.ts`, `tests/scoreboard-history.test.ts`, `e2e/scoreboard.spec.ts` (desktop + 390px) | No stored history: change is "not tracked" for lead stages, the radar and billing method. Leads cannot be filtered by location or program |
| Past due with aging buckets that sum to the total; bills due in 14 days (matches the billing module's bill preview); failed payments; projected recurring revenue net of holds | verified locally | `tests/scoreboard.test.ts` (hand-built fixtures), `tests/scoreboard-history.test.ts` (parity with `scheduledBills`) | Projection assumes no new sales or cancellations |
| At-risk reuses the retention radar; over-limit and conflicts reuse the membership audit; unreconciled items reuse billing reconciliation | verified locally | `tests/scoreboard-history.test.ts` | |
| Monthly funnel (`/scoreboard/monthly`): 18 rows by month, editable ideals (audited), real losses separated from plan changes / rebuilds, net growth, rule-of-thumb bottleneck read-out showing the rule that fired | verified locally | `tests/scoreboard.test.ts`, e2e | At-risk has the current month only. A lead later marked Lost no longer counts as showed |
| Schedule efficiency: weekly slot utilisation with configurable consistently-full / consistently-under flags; coaching hours and payroll cost as % of collected from the payroll module ("not available" when payroll data is missing) | verified locally | `tests/scoreboard.test.ts`, e2e | Flags are prompts, thresholds are starting points |
| Marketing economics: manual monthly spend by channel, cost per lead / per new member, revenue per member, length of engagement, estimated lifetime revenue and ratio, labelled gross revenue not profit | verified locally | `tests/scoreboard.test.ts`, e2e | No ad-platform integration (by design) |
| Money view: collected / billed / outstanding / refunds / account credits / camp revenue by month, collected by membership option and by location, manual expenses and a management-estimate operating margin; CSV for every table | verified locally | `tests/scoreboard.test.ts`, `tests/scoreboard-history.test.ts`, e2e | Not accounting; no accounting integration (by design); single currency |
| Permissions: owner / admin / operations view, owner / admin edit, payroll cost and margin only with payroll access, coaches refused on pages and CSV | verified locally | `tests/scoreboard.test.ts`, e2e | |
| Synthetic history seed (about six months), opt-in so other tests' fixtures are unchanged | verified locally | `tests/scoreboard-history.test.ts` | Demo database only |
