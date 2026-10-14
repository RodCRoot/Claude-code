# Replacement plan: four separate decisions

This document answers one question per vendor system: can Teamwork Hub replace it, and what has to be true before anyone cancels a subscription. It is written against the code and tests in this repository as of 2026-10-14. Every "Hub today" claim points at `FEATURE_MATRIX.md`; anything not backed by code or tests is marked **proposed** or **unknown**.

The four decisions are independent. Retiring one system does not imply retiring another, and the verdicts differ.

| Decision | Source system today | Current verdict |
|---|---|---|
| 1. Membership, scheduling, billing, CRM, parent communication | Zen Planner Studio (PushPress named as a reference only) | Replaceable in stages, after sandbox verification and the cutover criteria below |
| 2. Training program creation, delivery, logging, coaching workflows | TeamBuildr | Partially replaceable; retirement gated on the essentials list |
| 3. Historical performance storage, analysis, reporting | Hawkin Cloud data | Replaceable for storage and reporting only, after a validated import |
| 4. Live force-plate acquisition and device operation | Hawkin capture app and hardware | **Not replaceable by this project** |

**Which subscriptions are actually in use is UNKNOWN until Rod confirms.** The build was done without account access to Zen Planner, TeamBuildr or Hawkin (see `BLOCKERS.md`). Zen Planner Studio is confirmed as the current operations system because the existing `teamwork-scoreboard` integration reads from it. PushPress appears in the brief and in `FEATURE_MATRIX.md` as the reference for the CRM module ("PushPress Grow-style; evidence: public docs"). Nothing in this repository shows that PushPress is installed or paid for, so this plan does not assume it. The TeamBuildr plan tier and any Hawkin software tier are also unknown.

Status labels used below match the `FEATURE_MATRIX.md` legend (verified locally, implemented configuration required, blocked, not implemented) and its evidence levels (publicly documented, account-verified, proposed Teamwork functionality, unresolved dependency).

## Decision 1: Membership, scheduling, billing, CRM, parent communication

Source today: Zen Planner Studio. PushPress is a feature reference only. Everything in the "source does today" column comes from public documentation plus the field names the scoreboard already parses (`../teamwork-scoreboard/docs/DATA-MAPPING.md`), never from account observation.

| Area | What the source system does today (evidence) | What the Hub does today (FEATURE_MATRIX status) | Still missing | Cutover criteria | Recovery route |
|---|---|---|---|---|---|
| Memberships and recurring billing | Zen Planner bills memberships on its schedule and holds payer card data (publicly documented; scoreboard never imported membership data) | Membership versions, trials, family discount, holds, upgrades, cancellation rules: **verified locally** (`billing.test.ts`). Teamwork membership policy (stub on the 1st, commitments, holds, in-season, weekly caps): **verified locally** (`billing-membership-policy.test.ts`). Stripe Billing and PayPal Subscriptions: **implemented, configuration required** (`billing-subscriptions.test.ts`, signed fixtures only). Zen Planner cutover safety (imported memberships never invoiced; cutover requires confirming the Zen Planner charge stopped): **verified locally** (`billing.test.ts`) | No sandbox round trip for Stripe or PayPal. Payer card data cannot be exported from Zen Planner by us (re-entry on hosted checkout or a Stripe Data Migrations request). 13 open policy questions in `DECISIONS.md`. Families cannot self-request holds or cancellations | Stripe test mode verified end to end (checkout, subscription anchor and first charge, refunds, disputes, payouts), real prices entered in Settings, policy questions answered, every member cut over through the "Cut over" step in `docs/modules/billing.md` with the Zen Planner charge stopped first | Keep Zen Planner billing active for any member not yet cut over. `external_zenplanner` memberships are never invoiced here, so running both in parallel cannot double bill. Reverting a member means re-enabling the Zen Planner recurring charge and ending the Hub membership (staff action, audited) |
| Scheduling, attendance, kiosk | Classes, private sessions, attendance, kiosk check-in (publicly documented; attendance report fields known from the scoreboard) | Recurring classes (DST-correct), series edits, family multi-booking, capacity and waitlist with concurrency tests, kiosk PIN check-in, attendance corrections, coach and room overlap prevention: all **verified locally** (`scheduling*.test.ts`) | No QR or barcode check-in; no date or weekday moves for a whole series; Google Calendar sync needs an OAuth client (**implemented, configuration required**) | Schedule rebuilt in the Hub from the confirmed Zen Planner class list; two weeks of parallel check-ins reconciled against the Zen Planner attendance report; kiosk device tested on site | Zen Planner schedule stays visible read-only during the comparison period; attendance can be re-imported from a Zen Planner CSV through the Import Center (`zenplanner.attendance`, idempotent) |
| People, families, CRM | Member and lead records, family links (publicly documented; People report CSV columns from third-party migration guides) | Person, login, athlete, guardian, household and payer kept separate with no auto-merge: **verified locally** (`people.test.ts`, `imports.test.ts`, `crm.test.ts`). Lead pipeline, inquiry form, conversion: **verified locally** | Zen Planner column mappings unverified until checked against a real export (`imports-exports.md`). No embeddable lead widget | Members, family links and documents index imported through the Import Center with every identity question resolved by staff; reconciliation report shows balanced counts | Any import batch can be reverted (`revertBatch`, idempotent, tested). The Zen Planner export files are kept as `import_source` objects with checksums |
| Parent communication | Email and SMS to families, consent (publicly documented) | Shared inbox, templates, automations, consent and quiet hours, campaigns, bounce and STOP webhooks: **verified locally** with mocked providers (`messaging*.test.ts`). Email and SMS adapters: **implemented, configuration required** | No provider keys; `DELIVERY_ENABLED` is off by design; no attachments; no drip sequences | One real round trip per provider (send, bounce, STOP) verified; consent records imported or re-collected; test-recipient redirect used first | In-app messaging works without providers. Zen Planner communication stays available until the Hub provider is verified |
| Reports | Zen Planner reports read from page grids by the scoreboard (existing Teamwork integration) | Memberships, attendance, utilization, receivables, collections, refunds, payouts, credits, renewals, retention and staff activity reports with CSV: **verified locally** (`reports-settings.test.ts`, `report-charts.test.ts`) | No saved or scheduled reports; Zen Planner billing history is not imported (membership audit amounts are estimates) | Collections and attendance reports match Zen Planner totals for the comparison period | The scoreboard's Zen Planner readers keep working as long as the Zen Planner account exists |

**Verdict:** replaceable in stages. The blocking items are provider sandbox verification, confirmed import mappings, the real price list, and the open policy questions. Nothing here is a code gap that blocks a careful cutover, but no Zen Planner cancellation should happen until every member has been cut over and a full comparison period has passed. PushPress is not in scope for cancellation because its use is unknown.

## Decision 2: Training program creation, delivery, logging, coaching workflows

Source today: TeamBuildr (plan tier unknown). Public documentation only (`docs/modules/training.md`, research notes). Research found no public data API; outbound webhooks and an FTP export exist on higher plan tiers.

| Area | What the source system does today (public docs) | What the Hub does today (FEATURE_MATRIX status) | Still missing | Cutover criteria | Recovery route |
|---|---|---|---|---|---|
| Program building | Calendar and free-form builders, exercise library, templates deployed to teams | Exercise library, phases, weeks and days, supersets and circuits, full prescriptions, progression, annual plan: **verified locally** (`training.test.ts`). Week-view builder with drag-and-drop and keyboard reorder: **verified locally** (`training-builder.test.ts`, builder Playwright test) | No calendar-wide drag across weeks; licensed TeamBuildr video library not copied (by design; exercises hold video links only) | Current programs rebuilt in the Hub and reviewed by the coaches who wrote them | Programs stay in TeamBuildr until the subscription ends; nothing in the Hub depends on TeamBuildr running |
| Delivery and logging | Mobile app and shared tablet, few-tap logging, live results | Mobile logging with offline queue and idempotent retry: **verified locally** (`training.test.ts`, offline Playwright test). Weight-room tablet view: **verified locally** | No native app or push notifications; offline covers only today's workout; no background sync | Athletes log a full training week in the Hub on real devices; coaches confirm the weight-room tablet works at each rack | Athletes could log in TeamBuildr during the comparison period; workout logs can be imported later through `teambuildr.workout_log` (mapping unverified) |
| Maxes and percentage loading | Custom 1RM tracking, percentage loads per athlete | Tested and estimated maxes, dated-max percentage loading with rounding: **verified locally**. VBT math ported and tested, no UI yet (`training-vbt*.test.ts`) | VBT suggest and confirm have no surface on the athlete page | Max history imported (`teambuildr.maxes`, mapping unverified) and spot-checked against TeamBuildr | TeamBuildr Max Report export kept as the archive |
| Coaching review and reports | Leaderboards, 16+ exportable reports, raw-data CSV on higher tiers | Coach review, PR alerts, adherence, progress charts, opt-in leaderboard, CSV export: **verified locally** | Fewer report types than TeamBuildr; leaderboards are per-lift e1RM only | Coaches list the TeamBuildr reports they actually use and each one has a Hub equivalent or an accepted gap | TeamBuildr reports remain available until cancellation |
| Questionnaires and AMS add-ons | Wellness, body heat map, habits, KPI tracker, load and volume dashboards (paid add-ons; public feature names only) | Equivalent Teamwork-defined modules: **verified locally** (`science*.test.ts`), with documented Teamwork formulas, not TeamBuildr's | No push reminders; no live wearable sync; no PDF or email delivery of progress reports | Only relevant if Teamwork currently pays for AMS add-ons (unknown) | Questionnaire history can be imported (`teambuildr.questionnaire`, mapping unverified) |

### What must exist before the TeamBuildr subscription can be retired

Historical import alone does not satisfy replacement. Importing the Max, Raw Data and Questionnaire reports preserves history; it does not give coaches a place to build and deliver next week's program.

Essential (the subscription cannot be retired without them):
1. Program building and assignment for every active group, built and reviewed by the coaches (exists, verified locally).
2. Athlete logging on the athletes' own phones and the weight-room tablets, including offline tolerance for today's workout (exists, verified locally; needs an on-site device check, **not yet done**).
3. Maxes with percentage loading (exists, verified locally).
4. Coach review and PR alerts (exists, verified locally).
5. Historical import of maxes and workout logs with mappings confirmed against a real TeamBuildr export (**blocked**, no account access or CSV).
6. A comparison period of at least a few training weeks where both systems hold the same programs, and coaches sign off.

Nice to have (do not gate retirement):
- Calendar-wide drag-and-drop across weeks.
- Native app, push notifications, background sync.
- Full TeamBuildr report catalogue, custom leaderboards, whiteboard or TV timer.
- VBT suggest and confirm UI (lib functions exist).
- Athlete video upload.

**Verdict:** partially replaceable today. The code covers the essentials, but items 5 and 6 are not done, and item 2 has not been checked on real devices. Do not cancel TeamBuildr before those three are complete. The plan tier, renewal date and any AMS add-ons in use are **unknown**.

## Decision 3: Historical performance storage, analysis, reporting (Hawkin Cloud data)

Source today: Hawkin Cloud holds every force-plate test Teamwork has recorded. Public documentation only; the account has never been signed in to from this project (`BLOCKERS.md`).

| Area | What the source system does today (public docs) | What the Hub does today (FEATURE_MATRIX status) | Still missing | Cutover criteria | Recovery route |
|---|---|---|---|---|---|
| Storage of tests, trials, metrics | Cloud stores tests per athlete and test type; each API test is one trial; Cloud export offers trial rows and average rows | `test_sessions`, `trials` (aggregate rows flagged `is_aggregate`), `metric_values` with `raw_value` and unit, `raw_signals` for force-time files (`src/db/schema/science.ts`). Hawkin CSV import keeps trials and vendor averages separate, nulls, precision, units and DST offsets: **verified locally** with synthetic fixtures (`imports.test.ts`). API sync: **implemented, configuration required** (`hawkin.test.ts`, mocked HTTP) | Real Cloud export column headers unverified; API response shapes partially unverified; a CSV without a Test ID column cannot be de-duplicated against API-synced tests; the `test_sessions (source, source_record_id)` uniqueness is global rather than per org | A full-history import (export files or API backfill with explicit date ranges) whose reconciliation report shows balanced counts, zero null-to-zero coercions, zero precision or unit mismatches, and spot checks against the Hawkin Cloud UI | Import batches are revertible. Keep the original export files and the Hawkin account until the comparison is signed off |
| Analysis | Cloud dashboards and metric trends | Force-plate dashboard with trial rule, vendor aggregates shown separately, baseline and SWC band, asymmetry from raw traces, labelled Teamwork-derived: **verified locally** (`science.test.ts`, `science-formulas.test.ts`) | Vendor-proprietary analyses are not reproduced; only documented Teamwork formulas | Coaches confirm the dashboards answer the questions they currently answer in Hawkin Cloud | Hawkin Cloud remains the reference while the account exists |
| Reporting and export | Cloud CSV export, Power Query, spreadsheet connectors | Org and athlete export zips with CSV, JSON, raw signals and a checksummed manifest: **verified locally** (`exports.test.ts`) | No PDF or email delivery of progress reports | An org-wide export is produced, restored into a scratch database and reconciled (see `docs/BACKUP-RESTORE.md`) | The export zip is the long-term archive even if the Hub were shut down |

Reports alone do not satisfy capture replacement. Even a complete, reconciled history in the Hub says nothing about how the next test gets recorded. That is decision 4.

**Verdict:** replaceable for storage, analysis and reporting of historical data, after a validated import. See `docs/HAWKIN-CONNECTORS.md` for the recommended import route. This verdict does not support cancelling anything by itself, because future tests still come from Hawkin capture.

## Decision 4: Live force-plate acquisition and device operation (Hawkin capture app)

**Verdict: NOT replaceable by this project.** Teamwork Hub is a web application. It has no device drivers, no Bluetooth or USB access, no calibration routines and no signal-processing pipeline for raw plate output. Nothing in `src/` talks to a force plate. Importing Hawkin data or using the Hawkin Cloud API does not establish that capture can be replaced; both depend on Hawkin having already recorded the test.

Dependencies that would have to be resolved before anyone could recommend cancelling the Hawkin software subscription. Each is **unknown** today.

| Dependency | What has to be answered | Status |
|---|---|---|
| Hardware ownership and support | Who owns the plates, whether firmware updates and warranty support require an active software subscription, and whether the plates operate at all without the vendor app | unknown |
| SDK or protocol availability and licensing | Whether Hawkin publishes any device SDK or wire protocol, and under what licence. The public connector pages (`connect.hawkindynamics.com`) document a data API and data clients only, not device access | unknown; no public device SDK was found during the 2026-10-12 research |
| Calibration | How plates are zeroed and calibrated, and whether that is possible outside the vendor app | unknown |
| Device and firmware support | Which plate models and firmware versions Teamwork owns, and their update path | unknown |
| Future data access after cancellation | Whether Cloud data, exports and the API remain readable after the subscription ends, and for how long | unknown; must be confirmed with Hawkin before any cancellation |
| Test-type definitions and metric calculations | Metric values in the Hub carry `defined_by = hawkin`; the Hub does not compute them from raw force. Without Hawkin, no new vendor metrics exist | known gap by design |
| Hub features that depend on Hawkin continuing to run | Incremental API sync (`runHawkinSync`), force-time archiving (`archiveForceTime`), the Hawkin-vendor badges on the force-plate dashboard, KPI baselines built from Hawkin metrics, relative-strength plans that use Hawkin body-mass trials | all depend on new tests arriving from Hawkin |

Cutover criterion for this decision: there is none. The recommended state is "keep Hawkin capture, sync read-only into the Hub" (see `DECISIONS.md`, five decisions section).

## Cutover rules (apply to every decision)

1. **No service is cancelled** until all four gates pass with written evidence:
   - Data retention: the full history is in the Hub, reconciled, backed up (`pnpm backup`) and restore-rehearsed (`pnpm restore:check`), and the original source exports are archived with checksums.
   - New-data capture: the workflow that creates new records (bookings, payments, workout logs, force-plate tests) runs in its new home for a full comparison period. For force plates the new home is still Hawkin.
   - Recurring billing: every recurring charge has exactly one owner. Follow the Zen Planner cutover plan in `docs/modules/billing.md` (imported memberships are `external_zenplanner` and never invoiced; "Cut over" requires ticking "Zen Planner charge stopped" and a first bill date of today or later; the renewal job skips provider-billed memberships). Do not rewrite that plan here.
   - Feature replacement: the essentials list for the system in question is complete and signed off by the people who use it daily.
2. **Read-only comparison period.** Keep the old system available read-only (or with recurring billing stopped, for billing) for a defined period after cutover. Reconcile counts and totals at the end of the period before any cancellation. Length is a Rod decision; **proposed** default is one full billing cycle for decision 1 and a few training weeks for decision 2.
3. **Recovery route stays open** until the comparison period ends: import batches are revertible, Hub memberships can be ended and Zen Planner charges re-enabled, programs still exist in TeamBuildr, and Hawkin data remains in Hawkin Cloud.
4. **No duplicate subscriptions or double billing.** Each member is cut over individually, never in bulk, and never before the Zen Planner charge for that member has been stopped. The Hub's own guards (`billing.test.ts` "cutover from Zen Planner requires confirmation and a future first bill date"; `billing-subscriptions.test.ts` "a provider charge for a period Teamwork already settled is applied to that invoice and flagged as double collection") are the backstop, not the plan.
5. **Force-plate capture is never part of a cutover.** Any step that would interrupt Hawkin capture is out of scope.
6. **Account facts first.** Before any of the above, Rod confirms which subscriptions exist, their tiers and renewal dates. Those facts are unknown to this repository.
