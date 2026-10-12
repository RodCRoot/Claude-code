# Import Center, Hawkin API sync, exports

Owner: imports module. Routes: `/imports` (history + upload), `/imports/[id]` (wizard), `/imports/[id]/rejected` (CSV), `/imports/hawkin`, `/imports/exports`, `/api/exports/[id]`.
Code: `src/lib/imports/**`, `src/lib/integrations/hawkin/**`, `src/lib/exports/**`. Fixtures: `fixtures/**`. Tests: `tests/imports.test.ts`, `tests/hawkin.test.ts`, `tests/exports.test.ts`.

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

## Known gaps / needs real data

- Every mapping marked "unverified — configurable" must be checked against a real export (Zen Planner People/Membership/Attendance reports, TeamBuildr Max/Raw Data/Questionnaire reports, Hawkin Cloud export); save the confirmed mapping as a preset.
- Hawkin API never called live (no credentials here). First real sync should be a short historical window with auto-commit off; check warnings for field-shape differences (athlete object, metrics shape, force-time shape).
- Hawkin CSV without a Test ID column cannot be de-duplicated against API-synced tests.
- `test_sessions (source, source_record_id)` and `maxes (source, source_record_id)` uniqueness is global, not per org: a vendor test id in two orgs is rejected at validation. Recommend making those indexes org-scoped (schema owner).
- Revert leaves stored files on disk (the storage adapter has no delete); rows are removed.
- XLSX is not read directly (save as CSV).
- Very large files commit in one transaction (fine to tens of thousands of rows); split bigger exports by date.
