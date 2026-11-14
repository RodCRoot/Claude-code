# Import Center, Hawkin API sync, exports

Owner: imports module. Routes: `/imports` (history + upload), `/imports/[id]` (wizard), `/imports/[id]/rejected` (CSV), `/imports/zenplanner` (guide, lists, plan catalog), `/imports/zenplanner/discounts` (+ `/export` CSV), `/imports/zenplanner/reconcile`, `/imports/hawkin`, `/imports/exports`, `/api/exports/[id]`, `/api/webhooks/zenplanner/[feed]`.
Code: `src/lib/imports/**`, `src/lib/zenplanner/**`, `src/lib/integrations/hawkin/**`, `src/lib/exports/**`. Fixtures: `fixtures/**`. Tests: `tests/imports.test.ts`, `tests/zpimport.test.ts`, `tests/hawkin.test.ts`, `tests/exports.test.ts`, `e2e/zpimport.spec.ts`.

## Access

| Action | Who |
| --- | --- |
| Upload, map, validate, review, commit, revert, Hawkin sync | `imports.manage` (owner, admin) — checked in every lib function, server action and route handler |
| Hawkin options (auto-commit, force-time) | `integrations.manage` |
| Org-wide export (create/download) | `imports.manage` |
| Per-athlete export | `imports.manage`, or staff with `profile.read` on that athlete. Health files only with `health.read`, billing files only with `billing.read`. Downloads require at least the rights the export was built with. |

Every mutation and download is written to `audit_events` (`import.*`, `hawkin.*`, `export.*`).

## Pipeline

1. **Upload** (`POST /imports/upload`, a route handler so files > 1 MB work): original bytes saved with `saveObject(kind: import_source, owner_only)` and SHA-256; `import_batches` row. An identical checksum is flagged ("uploaded before") — re-import is allowed and idempotent.
2. **Schema** from the registry (`src/lib/imports/schemas/*`): target fields, required fields, types, header aliases, batch options (e.g. default load unit), limitations text, evidence level.
3. **Mapping**: auto-suggested from headers, editable, stored on `import_batches.mapping` (options as `$option.<key>`). Presets: org `settings.importMappingPresets[schemaId][name]`.
4. **Validate** → `import_rows`: `raw` = untouched cells; `normalized` = typed values. Dates: offsets kept verbatim (`source_timestamp` / raw), times without offset read as facility local time with DST gap/overlap warnings. Numbers keep source text (`raw_value`). Empty / `N/A` / `-` → `null`, never 0. Units canonicalized (lb/lbs→lb, inches→in, …) but never converted. Duplicates within the file (same source record) → `duplicate`.
5. **Identity** (`identity.ts`), one decision per source person (identity key), never auto-merging:
   - (a) `external_ids` exact source id → linked;
   - (b) exact first+last AND exact DOB (or exact email for adults), exactly one candidate, and that person not already tied to a *different* id of the same source → **strong**, still needs staff confirmation ("Confirm all strong matches");
   - (c) any other candidate (name-only, same surname + DOB, shared email) → `needs_review` with candidate list;
   - (d) no candidate → create (if the schema allows) else review (link manually or skip).
   Staff decide per person: link to a candidate / any person, create new, or skip.
6. **Preview**: counts by action, sample rows, rejected rows with reasons, warnings, limitations text. Coverage range is pre-filled from row dates and **must be confirmed** before commit.
7. **Commit**: one transaction; blocked while any row needs review. Writes entities, `external_ids` (with `first_import_batch_id`), `created_entities` per row, and before-values of anything it changed on pre-existing records.
8. **Reconciliation**: file rows vs staged rows (balanced?), committed/linked/updated/skipped/rejected, records created by type, per person × item counts, sampled values source text vs stored text/value/unit, null/precision/unit checks (incl. "null coerced to 0" = must be 0), duplicates, coverage; rejected-rows CSV.
9. **Revert**: deletes created entities children-first, each type in a savepoint; anything later data still references is **kept and listed**; restores fields it filled on existing records; removes the `external_ids` it introduced (except for kept records); idempotent (second call is a no-op); audited.

Re-import of the same or an overlapping file: rows whose source record id is already in `external_ids` are `skip` (unchanged) or `update` (Hawkin metric values changed / empty person fields can be filled) — never duplicated.

### What each schema writes

| Schema | Writes | Notes |
| --- | --- | --- |
| `zenplanner.members` | people (+ athlete unless type parent/guardian), external id `zenplanner/member` | fills empty DOB/email/phone on existing people only |
| `zenplanner.family_links` | households, household_members, guardianships | both people must already exist (exact id or strong); new guardianships: no health access, not emergency contact |
| `zenplanner.memberships` | memberships `billing_provider=external_zenplanner`, `source=zenplanner`; one inactive unlisted product + version per plan | no invoices, subscriptions, messages or jobs (tested). Missing price → version price 0 labelled "price not imported" |
| `zenplanner.attendance` | private `completed` schedule sessions (inactive service "Imported (Zen Planner)", notes "Imported from Zen Planner"), bookings `source=zenplanner` attended/no_show | RSVP'd / cancelled rows skipped (not check-ins); athletes sharing class+time share one session |
| `zenplanner.documents_index` | stored object (`imported_archive`) + `archived_documents` | upload a .zip: one index CSV + the files; missing file → rejected row |
| `teambuildr.maxes` | maxes `kind tested/estimated/imported`, exercises if new | unit lb/kg required (column, header "(kg)" or batch default); >2 decimals warned (numeric(8,2)) |
| `teambuildr.workout_log` | completed workouts, workout items, set logs (`logged_via=import`) | performed sets only |
| `teambuildr.questionnaire` | questionnaire (inactive) + version, responses (one per athlete/day/questionnaire) | long format; unanswered items null |
| `hawkin.tests_csv` / `hawkin.api_tests` | test types (vendor hawkin), test_sessions (`source=hawkin`, `source_record_id` = Hawkin test id), one trial each (raw payload kept), metric_definitions (`defined_by=hawkin`, key = label+unit), metric_values (`aggregation trial`) | vendor average rows → separate session with an `is_aggregate` trial (`vendor_mean`) and `vendor_mean` values; inactive athletes/tests kept, `trials.source_active=false`, newly created athletes inactive |
| `generic.people` | people / athletes | |
| `generic.metric_values` | metric_values (`other_vendor`, `aggregation single`) | |
| `wearable.daily_csv` | wearable_observations; empty value → `quality=missing` | |

## Zen Planner exact presets (2026-11-13)

**Status: built from the 2026-11-13 account map (`docs/ZENPLANNER-MAP.md`); not yet tested against a real export file.** The column names are the report-grid labels seen in the owner's account. Nobody has run a real CSV through them. Fixtures are fictional people only.

The older `zenplanner.members / family_links / memberships / attendance` schemas stay (existing data and saved mappings keep working); the presets below are separate schemas offered first in the upload list.

### Header matching

Headers are compared without case or punctuation (`normHeader` in `mapping.ts`: "Att." = "att", "Shared?" = "shared", "Mbr. Begin Date" = "mbr begin date"), and every field has a short alias list. A header the preset does not recognize is listed on the mapping step ("Not recognized (will not be imported): ...") and left out; it never fails the import. Preset columns missing from the file are listed too and left empty. Staff can still remap any field by hand.

### Export steps (the same text is shown in the wizard and on Imports → Zen Planner)

For every grid: open the report grid in Zen Planner Studio, choose columns, add the listed columns, export as CSV. The address has the form `~/<object>/index.cfm?export=CSV&_c=<chosen column names>`; the column list goes in `_c`. The exact `_c` token for each column is not in the map, so use the grid's own column picker and export link. Import order: Person, then Membership, then Bill and Attendance.

| Preset | Grid | Columns to include |
| --- | --- | --- |
| `zenplanner.person_grid` | `person/index.cfm` | First Name, Last Name, Birth Date, Email, Phone, Status, Family ID, Family, Parent First, Parent Last, Parent Email, Special Needs, Medications, Allergies, Prospect Status, Source, Interest, Referred By, Prospect Priority, Sales Rep, Inquiry Date, Trial End Date, Tracking Source / Name / Medium / Keywords, Primary Instructor, Primary Location, Signup Date, Has Password?, Signed Documents, Groups |
| `zenplanner.membership_grid` | `membership/index.cfm` | First Name, Last Name, Membership, Status, Mbr. Begin Date, Mbr. End Date, Months, Auto Renew, Renewal Type, Trial Member?, Cancel Date, Cancel By, Cancel Reason, Cancel Comments, Payment Amount, First Bill Due, Income Category, Att. Limit, Att. Limit Type, Class Card Att. Remaining, Shared?, Autopay?, Family ID, Birth Date, Email |
| `zenplanner.bill_grid` | `bill/index.cfm` | First Name, Last Name, Description, Due Date, Amount Due, Amount Paid, Amount Unpaid, Discount Total, Paid On Time, Status (do not add the Autopay Account columns) |
| `zenplanner.attendance_grid` | `attendance/index.cfm` | First Name, Last Name, Date, Time, Att., Rsvp, Canceled, Session Type, Program, Location, Staff Member |

No Task preset: the Task grid (10 fields) is short-lived staff work and is better re-created than imported.

### What each preset writes

**Person** (`commitPersonGrid`)
- Person, plus an athlete record unless the row is a prospect. Status: Member → active, Prospect → prospect, Alumni → inactive (athlete inactive). The exact Zen Planner status values are unverified: an unknown value imports as inactive and is flagged.
- **Family ID is the household key** (`external_ids` `household` = `family:<id>`): everyone sharing it joins one household.
- **Parent First / Last / Email → guardian.** Never merged by name. In order: (1) a parent who is another row of the same file with the same Family ID and name is linked; (2) a parent this importer created before is reused; (3) exactly one existing person with the same name **and** email is *proposed*: the row waits in identity review and links only when staff confirm it; (4) any other candidate (name only, shared email) links nobody, the row waits in review and says so; (5) no candidate: a new person is created. Every new guardianship has **no health access** and is not an emergency contact, as with `zenplanner.family_links`.
- **Special Needs / Medications / Allergies are health data.** They go to their own table (`zp_person_health`), read only through `importedHealthForPerson`, which requires `health.read` on the athlete (`policy.ts`): owner, admin, an assigned coach, the athlete, a guardian whose link grants health access. Operations never sees them. Staff get an alert that says only "health information is on file". The values also sit in the import's staged rows and the stored source file, both limited to `imports.manage` (owner/admin, who hold health access).
- **Prospects → CRM leads** (one open lead per person): stage from the mapping below, Source, Interest, Sales Rep → lead owner only on an exact match to one staff login, guardian → lead contact. Prospect Status, sub-status, Referred By, Priority, Sales Rep, Inquiry Date and Trial End Date are kept in `leads.inquiry.zenplanner`; Tracking Source / Name / Medium / Keywords in `leads.inquiry.utm` (`source`, `campaign`, `medium`, `term`). Inquiry Date becomes the lead's created date.
- Primary Instructor → coach assignment only on an exact match to one coach login (otherwise the name is kept and the row warns). Primary Location, Signup Date, Has Password?, Signed Documents, Family ID: kept as information in `zp_person_details`.
- Groups → tags. A tag named after a known sport (`KNOWN_SPORTS`) also fills the athlete's sport when it is empty. Whether the Person grid exports a Groups column is unverified.
- Not imported: Address, Gender Identity, Bar Code, attendance rollups.

**Membership** (`commitMembershipGrid`). Always `billing_provider = external_zenplanner`, `source = zenplanner`, hub autopay off, no next bill date: never invoiced, renewed or charged here (tested: no invoices, no jobs).
- One inactive, unlisted product + version per plan name and weekly limit. Its price is the **highest Payment Amount seen for that plan in the file**; each member's own Payment Amount is kept in `zp_membership_details`.
- Att. Limit with Att. Limit Type "Weekly" → the version's `classes_per_week`. Other limit types are recorded, not enforced.
- Class Card Att. Remaining → a credit bucket (`source_kind = imported`) tied to the membership. No expiry (not in the grid).
- Months 6 or 12 with an end date → commitment start/end. Cancel Date / By / Reason / Comments, Auto Renew, Renewal Type, Trial Member?, First Bill Due, Income Category, Shared?, Autopay? kept in `zp_membership_details`. Hold Reason + hold dates (aliases unverified) → a hold row.
- Status missing → worked out from the dates, with a warning. Plan names containing "In Season" → `kind = in_season`.
- Not imported: Installment Plan, # of Installments, Signup Fee, Acct Name.

**Bill** (`commitBillGrid`): one row in `zp_bills` (due date, amounts, discount total, paid on time, status). **Never an invoice**: nothing payable, nothing shown to families. Autopay Account columns are never mapped. Two screens read `zp_bills`, both read-only. The **membership audit** uses the imported bills of a Zen Planner-billed membership (matched by `membership_id`) instead of its estimate: the exception shows the billed and paid amounts labelled "from imported bill history", and falls back to the labelled estimate when the membership has no imported bills or for bill dates after its last imported bill. The **scoreboard money view** shows them as a separate table, "Billed in Zen Planner, imported" (definition `mv_zp_imported`), never added to Collected, Billed or Outstanding. A bill that could not be matched to one membership (plan name not unique for the athlete) is in the scoreboard table but not in the audit.

**Attendance**: a row is a visit **only when `Att.` = Yes**. Rsvp and Canceled are separate columns and never make a visit; those rows are skipped with the reason. Session Type, Program and Staff Member are kept as text on the imported session; Location links to a hub location on an exact name match.

Revert removes all of the above (leads, tags, health rows, alerts, bills, punch cards, holds); anything later data depends on is kept and listed. Imported plan versions always stay: a database trigger refuses deleting product versions (same as the older membership import).

### Controlled vocabularies (`src/lib/zenplanner/vocab.ts`)

Copied from the map. A value not on a list imports as written, is flagged on the row and stored in `flags`. Owners add missing values on Imports → Zen Planner (stored in `settings.zenplannerVocab`).

| List | Values | Complete? |
| --- | --- | --- |
| Prospect Status | New Prospect, Call 1, Call 2, Ready to Sign, Not Interested | yes |
| Source | Flyer, Newspaper Advertisement, Facebook, Referral, Walk-in, Drive By, Website, Other | yes |
| Interest | General Fitness, Performance Training, Weight Loss, Police/Fire/Military, Endurance, Other | yes |
| Priority | Low, Medium, High | yes |
| Hold Reason | Vacation, Illness, Injury, Financial, maternity, busy, sports | yes |
| Drop / Cancel Reason | Price is too expensive, Doesn't fit my schedule, Membership Upgrade, Administrative Drop | **4 of 12 known** |
| Income Category | Sports Performance, Youth, Adult Performance Training, Six Week Challenges | **4 of 12 known** |
| Membership Category | Sport Performance and Youth Memberships, In-Season, Add-On | **3 of 14 known** |

The other values of the last three lists are not in the map and were not invented.

Prospect Status → lead stage (the hub's own stages were kept; the Zen Planner status stays on the lead):

| Zen Planner | Hub stage | Why |
| --- | --- | --- |
| New Prospect | `new` | Not contacted yet |
| Call 1 | `contacted` | First call made |
| Call 2 | `contacted` | The hub has one Contacted stage |
| Ready to Sign | `assessment_done` | Last open stage before Won |
| Not Interested | `lost` | Lost reason "Not Interested" |

Where the hub already had free text (lead source, interest, hold and cancel reasons), nothing existing was changed; the hold form now suggests Zen Planner's hold reasons.

### Plan catalog (`src/lib/zenplanner/catalog.ts`)

"Load Teamwork plan catalog" on Imports → Zen Planner: **owner only, idempotent (keyed in `external_ids`, never by name), audited** (`zenplanner.catalog_loaded`). Creates 20 products, each **inactive and unlisted**, category and description "From Zen Planner configuration, confirm before use". It never changes or deletes existing products, including the demo "Sample" plans. Prices are the owner's Zen Planner configuration.

| | 12-month | 6-month | Month-to-month |
| --- | --- | --- | --- |
| 1x/wk | not offered | not offered | $129.00 |
| 2x/wk | $178.99 | $197.99 | $232.99 |
| 3x/wk | $221.99 | $261.99 | $348.00 |
| 4x/wk | $295.99 | $375.99 | $465.00 |
| Unlimited | $309.99 | $419.99 | $569.00 |

Plus In Season $99, College Plan $50 weekly (unlimited, 7-day billing per the existing college logic), Fitness Together Drop-in $10 and Unlimited $60, Bootcamp $75, Linton $60 and $75.

Assumptions shown on each draft, because the map gives prices only: plan names are ours (Zen Planner's option names are not in the map); In Season is 1x per week (from the hub's reference plan); Fitness Together options between $10 and $60 are not listed and not created; Bootcamp and Fitness Together Unlimited are assumed monthly; the two Linton prices are not explained (weekly limit left unset). Zen Planner has 33 options; these are the 20 whose price is in the map.

**Not memberships, not created, candidates for the events module:** 6-week challenges ($229 to $299), Summer 8-week ($249), Vertical Jump ($349.99, add-ons $149.99 and $229.99), All-Girl Speed & Strength ($229 and $279.99).

### Discount review (`/imports/zenplanner/discounts`, `discounts.ts`)

Read-only, `imports.manage`. Lists every current imported membership whose Payment Amount differs from its list price or that carries a discount, grouped: **family discount** (equals list less the configured `familyDiscountPercent`, currently 10% and still "needs confirmation"), **In Season rate** (paying the In Season price on another plan), **other**, **cannot tell**. Shows the difference per billing period. A separate table lists **siblings on one Family ID who are not on the family discount**, with what the percent would take off. Can be filtered to one import; CSV by a plain link with `download` (the download is audited).

List price is not a grid column, so it is worked out and the basis is shown: `catalog` when the plan matches the ladder by name, Att. Limit and Months (`matchCatalogPlan`, a heuristic); otherwise the highest Payment Amount on that plan in the import. With the second basis, a plan on which everyone is discounted looks like list price. The optional `Discount` column is mapped if the export has it (not in the map's field list).

### Webhook receiver (`/api/webhooks/zenplanner/{people|class-sessions|attendance}`, `webhooks.ts`)

For the transition only. **Off by default** (404, nothing stored) until an owner or admin turns it on in Settings → Integrations, which also requires the `ZENPLANNER_WEBHOOK_SECRET` server variable. The card shows the three URLs to paste into Zen Planner, last received time and counts per feed, and recent stored payloads.

- **Unverified:** how Zen Planner presents the Shared Secret and the payload shape are not in the map and have never been observed. The receiver accepts the secret as a header or a query value (name configurable) and compares it in constant time. It does **not** verify a body signature. An optional Account ID check refuses deliveries that state a different account.
- Idempotent: a delivery is keyed by a hash of feed + body; a redelivery is acknowledged and changes nothing.
- Rate limited per feed (default 120/min, in memory per server process).
- Payloads are stored with passwords, tokens, payment fields and health fields removed. Health data therefore never arrives by webhook; import it from the Person grid.
- It feeds the same pipeline: staff press "Stage N for review", which builds an ordinary import batch with the Person or Attendance preset. Identity review, coverage confirmation, commit and revert apply. Nothing is auto-committed. Class Sessions has no import and is kept for inspection only.
- Receive only. No code path calls Zen Planner.

### Reconciliation (`/imports/zenplanner/reconcile`, `reconcile.ts`)

Type in Zen Planner's dashboard figures (active members, memberships, on hold, past due total), optionally tied to one committed import. The page stores them with the hub's figures at that moment and shows the differences with likely reasons drawn from hub breakdowns: prospects, alumni, active athletes with no membership, members with several memberships, on-hold and pending memberships, and the split by Zen Planner Primary Location (location filter). A reason that equals the gap exactly is marked. The hub's past-due figure is the unpaid amount on imported bills past their due date, so it is empty until the Bill grid is imported. Hub figures are org-wide, not per batch.

### Tables (migration `0033_zpimport`)

`zp_person_details`, `zp_person_health` (health), `zp_membership_details`, `zp_bills`, `zp_webhook_events`, `zp_reconciliations`. No hand-written SQL.

### GoHighLevel contacts

`gohighlevel.contacts`: one GHL contact line → one row per athlete named on it (siblings sharing a surname are split on `,` `&` `+` `/` `;` `and`); the contact's phone/email are the parent's and become the guardian contact (proposed match in review, or a placeholder guardian per contact). See `docs/modules/crm-messaging.md` → GoHighLevel.

## Hawkin Dynamics API

`src/lib/integrations/hawkin/client.ts` (server-only): refresh token from `HAWKIN_REFRESH_TOKEN` exchanged at `GET {base}/token` (`Authorization: Bearer <refresh>`) for a 1-hour access token, refreshed 5 min early and on 401. Never logged, stored, or put in errors (tests assert this). Base from `HAWKIN_API_BASE` (default Americas).
Requests: `GET /v1/athletes?includeInactive=true`, `/v1/metrics`, `/v1/test_types`, `/v1?paginate=true&cursor=…` (cursor pagination), `/v1/forcetime/{id}`. 429/5xx/network errors: exponential backoff with jitter (base 500 ms, cap 30 s, 5 retries), `Retry-After` honored. `assertValidTestQuery` refuses syncFrom/syncTo combined with athleteId/teamId/groupId/testTypeId (documented API rule) and >10 team/group ids.

`sync.ts`:
- **Historical**: creation-date windows (`from`/`to`) chunked (default 30 days).
- **Incremental**: `syncFrom` = checkpoint (`integrations.checkpoint.lastSyncTime`, else `historicalThrough`), `syncTo` = now. Refused before any historical import.
- Filters (`integrations.config.filters`: testTypeIds, athleteIds, teamIds, groupIds) are applied **in our backend** after fetching, in both modes.
- Tests are flattened into the Cloud-CSV column shape and fed through the same pipeline (batch `source=hawkin_api`, schema `hawkin.api_tests`), so identity review applies. Hawkin athlete id → `external_ids hawkin/athlete`.
- Coverage is confirmed from the window. With `autoCommit` and no review needed the batch commits immediately; otherwise it waits for staff.
- **Checkpoint advances only when that batch is committed** (`checkpoint.ts`, called inside the commit transaction). Failed fetches mark the run `failed`, integration `error`, checkpoint untouched.
- Schema-change detection: metric fields new for a test type (vs `config.knownMetricFields`), expected fields missing, labels absent from `/metrics`, and unrecognized non-metric top-level fields → warnings on `sync_runs.cursor_after.warnings` (count in `counts.warnings`). Raw payload always preserved in `trials.raw_payload`.
- Force-time: when enabled, each newly committed test's `/forcetime/{id}` JSON is archived (`stored_objects kind raw_signal` + `raw_signals` with `sample_rate_hz=1000`, channels from array keys, sample count) and attached to the batch so revert removes it. Also `scripts/hawkin-sync.ts … forcetime <batch-id>`.
- Without a token: `not_configured` with env var names; the UI shows `<NotConfigured>` and disables sync. Nothing claims the connection works until a call succeeds (`status=connected`).

CLI / scheduler: `pnpm exec tsx --conditions=react-server scripts/hawkin-sync.ts --org <slug> incremental` (or `historical <from> <to> [--chunk 30]`). Runs as the org's first owner/admin (`--as <email>` to choose).

## Exports

`src/lib/exports/bundle.ts` → zip with `data/<dataset>.csv` + `.json` for people, athletes, guardianships, households, household_members, memberships, invoices, invoice_lines, transactions, attendance, workouts, workout_items, set_logs, maxes, test_sessions, trials, metric_values (with `metricDefinedBy`, `formulaKey`, `formulaVersion`, `unit`, `rawValue`), questionnaire_responses, body_reports, wearable_observations, completed_forms, archived_documents, raw_signals; original files under `files/forms|archived_documents|raw_signals/`; `manifest.json` (`schemaVersion teamwork-export/1`, scope, includes, every file with sha256 + bytes + record count, record→file links, missing files). Built synchronously from the Exports page and stored as `stored_objects kind export` (owner_only), downloaded through `/api/exports/[id]` (re-authorized + audited). For large orgs: `enqueueExport()` + `exportJobHandlers["exports.build"]` in `src/lib/exports/jobs.ts` (needs registering in the worker).

Backups: `docs/BACKUP-RESTORE.md`, `scripts/backup.sh` (`pnpm backup`).

## Research findings (fetched 2026-10-12)

Evidence levels: **verified in docs** = stated on the vendor's official page; **existing Teamwork integration** = used by `teamwork-scoreboard` against Teamwork's real Zen Planner account; **third-party** = competitor migration guides; **unverified** = assumption, configurable.

### Hawkin Dynamics

| Finding | Evidence | Source |
| --- | --- | --- |
| Regions: `cloud.` (Americas), `eu.cloud.`, `apac.cloud.hawkindynamics.com`; paths `/api/token`, `/api/v1/...` | verified in docs | https://connect.hawkindynamics.com/api |
| Org admin creates refresh token in Settings → Integrations; `GET /api/token` with `Bearer <refresh>` → `access_token`; access tokens expire after 1 hour | verified in docs | /api, https://connect.hawkindynamics.com/faq |
| Tests `GET /api/v1`: `from`/`to` filter by original creation timestamp; `syncFrom`/`syncTo` return tests created **or modified**; store `lastSyncTime` as next `syncFrom` | verified in docs | /faq, /api |
| "syncFrom/syncTo parameters cannot be combined with athleteId, teamId, groupId, or testTypeId filters" — pull and filter client-side | verified in docs (FAQ) | /faq |
| teamId/groupId: comma-separated, ≤ 10 ids each, work with from/to only | verified in docs | /faq |
| Cursor pagination opt-in: `paginate`, `cursor`, 1,000 tests/page, `hasMore`, `nextCursor` | verified in docs | /api |
| No-parameter request returns the whole database; responses over the memory limit fail | verified in docs | /faq, /api |
| `includeInactive` (tests; athletes default false); `useNulls` (default true; false → "N/A"); `rounding` (default false); `nestMetrics` → `{metricId, metricLabel, metricUnits, metricValue}` | verified in docs | /api, https://connect.hawkindynamics.com/python |
| Test fields `id`, `timestamp` (Unix seconds), `testType` object, `active`, metrics flat keyed like `Jump Height(m)` | verified in docs (partial) | /api |
| Nested `athlete` object `{id,name,active}` and `segment` on tests | **unverified** (inferred from packages; client accepts object or id) | — |
| Endpoints `/v1/athletes`, `/v1/test_types` (bare array), `/v1/metrics`, `/v1/teams`, `/v1/groups`, `/v1/tags`, `/v1/forcetime/{id}` (1000 Hz), `/v1/cop/{id}` | verified in docs | /api, /faq |
| Force-time response shape (array keys) | **unverified** — channels derived from whatever arrays are returned | — |
| Rate limits | **not documented** — backoff implemented defensively | /api, /faq |
| Trial vs average in API: each API test is one trial; no vendor averages in API | verified (packages: "each row is a single test trial") | /python |
| Timezone: Unix seconds (UTC) | verified in docs | /api |
| Python `hdforce` (PyPI), R `hawkinR` (GitHub/r-universe), Power Query templates (30-day chunks), Excel add-in & Google Sheets add-on ("pending review") | verified in docs | https://connect.hawkindynamics.com/ |
| Python package says athleteId/typeId/teamId/groupId cannot be combined with each other | verified in docs (python page) | /python |
| Cloud export (Tests / Averages / Averages and Tests; average row follows test rows; de-identify option; date format preference; default last 100 tests unless custom range; active metrics only unless "Include Inactive Metrics"; force/velocity/power-time export for a single test: time, left, right, combined at 1000 rows/s) | verified in docs | https://learning.hawkindynamics.com/knowledge/exporting-data-from-cloud |
| Exact Cloud export column headers (athlete/test type/date/trial columns), CSV vs Sheets format, timezone of dates | **unverified — configurable** (fixture headers are synthetic) | — |

### TeamBuildr

| Finding | Evidence | Source |
| --- | --- | --- |
| Reports: Max Report, Raw Data Report, Questionnaire Report, Workout Results, Rep & Load, Completion, Progress, Comparison, Assessment, Activity, Opt Out | verified (article titles) | https://support.teambuildr.com/category/GjDWk7OsWB-reporting |
| Article bodies (columns, export format) not readable from the help center | unverified | same |
| FTP/SFTP export integration (Platinum Pro plan): Raw Data, Max, Sport Science, Active User reports, daily ~11:45 pm (hourly on request); file format not stated | verified in docs | https://support.teambuildr.com/article/l882ccxtmd-ftp-export |
| Outbound webhooks deliver workout result objects; no public data API documented | verified in docs | https://support.teambuildr.com/category/f9x82p5l42-integrations |
| Licensed videos / templates export | not offered / not assumed — not imported | — |
| All TeamBuildr column mappings | **unverified — configurable** | — |

### Zen Planner

| Finding | Evidence | Source |
| --- | --- | --- |
| No usable API; reports read from page grids (iframe, ColdFusion layout tables, pager/"Add" rows, reprinted headers); columns chosen via `_c=` URL param (e.g. `firstName,dueDate,billAmount,status`); person column headed "Name"; attendance report includes RSVP'd/cancelled rows that are not check-ins | existing Teamwork integration | `../teamwork-scoreboard/docs/ZENPLANNER-SYNC.md`, `src/lib/zp-table.ts` |
| Membership data was never imported by the scoreboard | existing Teamwork integration | same |
| People report → CSV with First Name, Last Name, Birth Date, Email, Phone, Status, Signup Date columns | third-party | https://help.pushpress.com/articles/508445-export-users-from-zen-planner, https://help.arboxapp.com/en/articles/5320233-export-data-from-zen-planner |
| Family/guardian link export, membership report columns, signed document export | **unverified — configurable** (no account access) | — |
| Report-grid column names for Person, Membership, Bill, Attendance, Task; controlled vocabularies; price ladder; three webhook feeds taking URL + Account ID + Shared Secret; `?export=CSV&_c=` pattern | account observation (read-only session, 2026-11-13) | `docs/ZENPLANNER-MAP.md` |
| CSV header spellings, webhook payload and signing, `_c` column tokens | **unverified** | — |

## Known gaps / needs real data

- The Zen Planner exact presets have never seen a real export file: header spellings, Person Status values, whether Groups / Discount / hold columns exist, and whether the grids export a Person or Membership ID are all unconfirmed. Without an ID column people are matched by exact name + birth date and confirmed by staff, and a renamed person re-imports as new.
- A Person export with no date column (no Signup Date / Inquiry Date) has no detected coverage range; staff type the range before committing.
- Zen Planner webhook payload and secret format unverified; no body signature check; the rate limit is per server process.
- Discount review list prices are worked out (ladder match or highest in import), not exported.
- Every mapping marked "unverified — configurable" must be checked against a real export (Zen Planner People/Membership/Attendance reports, TeamBuildr Max/Raw Data/Questionnaire reports, Hawkin Cloud export); save the confirmed mapping as a preset.
- Hawkin API never called live (no credentials here). First real sync should be a short historical window with auto-commit off; check warnings for field-shape differences (athlete object, metrics shape, force-time shape).
- Hawkin CSV without a Test ID column cannot be de-duplicated against API-synced tests.
- `test_sessions (source, source_record_id)` and `maxes (source, source_record_id)` uniqueness is global, not per org: a vendor test id in two orgs is rejected at validation. Recommend making those indexes org-scoped (schema owner).
- Revert leaves stored files on disk (the storage adapter has no delete); rows are removed.
- XLSX is not read directly (save as CSV).
- Very large files commit in one transaction (fine to tens of thousands of rows); split bigger exports by date.
