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
   - (b2) Zen Planner Membership, Bill and Attendance grids only: exactly one person has this exact first+last name, no conflicting DOB, nothing else to confirm it → **name only**, a suggestion with its own bulk confirmation ("Confirm all name-only matches");
   - (c) any other candidate (a shared name, same surname + DOB, shared email) → `needs_review` with candidate list;
   - (d) no candidate → create (if the schema allows) else review (link manually or skip).
   Staff decide per person: link to a candidate / any person, create new, or skip. The step is paged (25 people), searchable and filterable by match type.
6. **Preview**: counts by action, sample rows, rejected rows with reasons, warnings, limitations text. Coverage range is pre-filled from row dates and **must be confirmed** before commit.
7. **Commit**: one transaction; blocked while any row needs review. For the Zen Planner grid presets each row runs in its own savepoint: a row the database refuses is rejected with its reason and the rest commit (see "Commit: one bad row no longer stops the file"). Writes entities, `external_ids` (with `first_import_batch_id`), `created_entities` per row, and before-values of anything it changed on pre-existing records.
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

### First real export (2026-11-14)

Person and Membership grids were exported from the owner's account (students and alumni only; prospects and the ~200 parent-only records with no status left out) and stored in Rod's private Drive folder, not in the repo. What the real files showed, now handled:
- Dates are written with month names (`Nov 14, 2026`); `parseDate` accepts them.
- The Membership grid's plan column is `Membership Label`; added as an alias of Membership.
- `Mbr. Status` values are `CURRENT`, `NOT STARTED`, `HOLD`, `CANCELED`, `CANCEL PENDING`, `COMPLETED`. `NOT STARTED` → pending and `CANCEL PENDING` → active (the Cancel Date records the end) were added; before, those rows were rejected.
- Person `Status` values are `Student`, `Alumni`, `Prospect` and blank (parent-only records). Already mapped.
- The Membership grid has no Family ID column, and the Person grid did not return a Group column with `_c=tagId`.
- The Membership grid filters to `status is CURRENT` unless criteria are passed: use `&_f1=status&_o1=is not empty&_v1=` for the full history.
- A few Person rows have an unquoted comma inside Address, which shifts later columns; the export step re-joins them into Address.

#### Dry run of the real export (2026-11-15, private local database, nothing committed to the repo)

The two files were run through the importer end to end on a throwaway local database. Totals only:
- **Person grid:** 2,184 rows, of which 809 are exact repeats of another row (the export step wrote some people several times). 1,374 people created, 1 left for review, 0 rejected. 1,206 rows have no birth date. 214 rows name a Primary Instructor that matches no coach login.
- **Membership grid:** 15,797 rows, one per Zen Planner membership Number. 15,498 imported, 299 rows (41 people) left for staff review because the name is shared or nothing but the name matches. 0 rejected.
- **Imported current picture:** 225 active, 116 not started, 8 on hold. The file has 223 CURRENT plus 5 CANCEL PENDING, 119 NOT STARTED and 8 HOLD; the gap is inside the 299 rows left for review.
- **Autopay ERROR:** 1,187 rows, 15 of them on memberships that are current, not started or on hold.
- **Discount review:** 349 current memberships reviewed: 205 at list price, 3 family, 41 other, 100 with no list price (items sold without a label). 95 siblings have no family discount.

What the real file needed, now handled (tests use fictional people):
- **No Membership Label on 10,893 rows** (drop-ins, class tuition, one-off items; 59 of them current). They were rejected. They now import under a plan named `No label: <Income Category>`, flagged `no_membership_label`, and get no list price in the discount review.
- **Autopay? is ON / OFF / ERROR**, not Yes/No. ERROR is recorded as unknown and flagged `autopay_error`. Hub autopay stays off for every imported membership regardless.
- **Number** is the membership id. Without it, two memberships with the same person, plan and start date collapsed into one (153 rows).
- **In Season memberships** failed the hub's fixed-term rule and aborted the whole commit. They now carry their end date as the end marker; one with no end date imports as a regular membership with a warning.
- **Identity matching:** most children carry a parent's email and half the rows have no birth date, so nearly every row was "ambiguous" (11,462 rows skipped in the first run). The rule is now: exactly one person in the organization has this exact first and last name, and the birth date or the email matches, and the birth dates do not conflict. Two people with one name stay ambiguous. Matches are still confirmed by staff in bulk.
- **List values** seen in the file were added to the Income Category, Membership Category and Cancel Reason lists.

Not handled: `classes every month` and `class card (expire when full)` limits are recorded but not enforced (926 rows, all warned). The Person export should be re-run without the repeats and, if Zen Planner offers it, with the person id column, which would remove the name matching altogether.

#### Second dry run: the unfiltered full-history files (2026-11-15, private local database)

A second set, exported straight from the Zen Planner grids with every status and all history, replaced the first one: `zp-01-people.csv`, `zp-02-memberships.csv`, `zp-03-bills.csv` in the same private Drive folder. Use these; ignore the two dated 2026-11-14 files. Attendance (about 57 MB) is not exported yet. Totals only:
- **People:** 1,698 rows, no repeats. 1,696 created, 1 left for review, 1 rejected (an email that is not an email). 543 rows have a birth date.
- **Memberships:** 15,812 rows. 15,797 imported, every one matched by key; 15 belong to the person left for review; 0 rejected. Imported current picture: 229 active, 119 not started, 7 on hold.
- **Bills:** 18,709 rows, 2018 to 2027. 15,422 imported as history (nothing payable is created). 151 left for staff review. 3,135 rejected because the row names nobody: all are paid, almost all from 2018 to 2022, and look like bills of people since deleted in Zen Planner. Of the imported bills, 746 are unpaid for a total of $132,781, but 719 of those are future-dated instalments. The amount already past due is $4,022.

What these files needed, now handled:
- **Bar Code is the person key.** Neither grid has a Person ID column, but both carry Bar Code (the person's number in Zen Planner): unique per person and present on every membership row. The Person and Membership presets now map it as the person key, so memberships attach to people exactly, with no name matching. This took the Membership rows left for review from 331 to 15.
- **Malformed addresses.** Zen Planner writes some addresses with unescaped quotes, which splits the Address cell and pushes later columns to the right (9 People rows, 85 Membership rows: emails landed in the Status column and the rows were rejected). The CSV reader now folds the surplus cells back into Address. The address itself is not imported.
- **Paid On Time** is `On-Time`, `Early` or `Late`, not Yes/No.

Still open:
- **The Bill grid has no person key**, only names, and Zen Planner cannot add one (its Bill grid has no Bar Code or person id field; checked 2026-11-15). Bills attach by exact name plus email. When two people share a name, the one whose email or birth date fits is proposed, unless it fits both. 151 bill rows still need a person chosen by staff: 129 where only the name matches (neither side has an email; these can be confirmed in bulk) and 22 where two people share both name and email.
- **3,135 old paid bills name nobody** and are not imported. Revenue history before 2023 is therefore incomplete in the hub; Zen Planner remains the record for it.
- The membership grid has no discount column. The 32 discounts are a separate list (`ref-discounts.txt` in "2 - Reference lists").

### Bill and Attendance grids: made ready before the real files arrive (2026-11-15)

Neither grid has been exported yet. Using what the Person and Membership files showed, both presets were gone through field by field. Tests use fictional people only (`tests/zpimport-hardening.test.ts`, `tests/zpimport-volume.test.ts`); nobody has seen a real Bill or Attendance file, so every item below is a guess at the format that is now tolerated, not a confirmed format.

The rule for both: **nothing in a row can reject the file or stop a commit.** A value is accepted, or left empty with a warning, or the one row is rejected with a reason staff can read (and download in the rejected-rows CSV).

| What the file may send | Bill grid | Attendance grid |
| --- | --- | --- |
| Month-name dates (`Nov 14, 2026`), with a weekday (`Sat, Nov 14, 2026`), day first (`14 Nov 2026`) | Due Date, Bill Date, Payment Date, Birth Date | Date, Birth Date |
| Date and time in one cell (`Nov 14, 2026 4:30 PM`, `Sat, Nov 14, 2026 at 4:30 PM`, `11/14/2026 16:30`) | the date part is used | the time is used when there is no Time column or it is blank |
| Time written `4:30PM`, `4pm`, `4:30 p.m.`, `16:30`, `4:30 PM EST`, or a range `4:30 PM - 5:15 PM` | n/a | the start is used; a range sets the session length (5 to 480 minutes, otherwise 60) |
| A time that is not a time (`All day`, `TBD`) | n/a | visit kept at the start of the day, warned |
| ON / OFF, TRUE / FALSE, Y / N, 1 / 0, in any letter case | Paid On Time | Att., Rsvp, Canceled |
| Another word in a yes/no column (`ERROR`) | Paid On Time left empty, warned | Rsvp / Canceled left empty, warned. **Att.: that row is rejected** (it cannot be counted or skipped safely) |
| Blank cell in a column the preset used to require | Due Date blank: Bill Date, then Payment Date is used and the row says so. No date at all: that row is rejected | **Att. blank: not a visit, skipped** with the reason (before, the row was rejected). Date blank: that row is rejected |
| Money as `$1,234.56`, `(45.00)`, `-45.00`, `-$45.00`, `$-45.00`, `45.00-`, `USD 45.00` | all four amounts; negative amounts are kept and flagged as a credit or refund | n/a |
| Money that cannot be read (`ERROR`, `45.00 CR`) | left empty (never 0), warned | n/a |
| Amounts that do not add up (Due minus Paid is not Unpaid) | all three kept as written, warned | n/a |
| Status words in capitals (`PAID`, `NO SHOW`) | kept as written in `zp_status` | read without regard to case |
| A `Status` column instead of `Att.` | n/a | Attended / Present / Checked In / Completed / Late count as a visit; Reserved, No Show, Canceled, Late Cancel, Waitlisted and the like are skipped; an unknown word rejects that row. When both columns are present, Att. decides |
| A `Number` column | mapped to Bill ID (one per bill). If more than 5% of rows turn out to share a number, the validate step warns that the column may be the person's number and says how to unmap it | mapped to Attendance ID and folded into the row's identity together with person, date, time, class and location, so it is safe whichever it really is |
| An account name instead of first and last name (`Acct Name`, `Bill To`) | used as the person's name | n/a |
| A date that cannot be real (year before 1990, or far in the future) | that row is rejected | that row is rejected; Att. = Yes on a future date imports with a warning |
| NUL bytes in a cell | removed at upload (they used to fail validation of the whole file) | same |
| People with no birth date, families sharing one email | see Identity below | same |

Mapping: the Bill preset needs one of Due Date / Bill Date / Payment Date mapped, and the Attendance preset needs Att. or Status mapped (`requireOneOf` on the schema); a file with neither is stopped at the mapping step with that reason.

**Bills stay history only.** `commitBillGrid` writes `zp_bills` and nothing else: no invoice, no membership, no job, no athlete record for a payer (tested). Re-importing a bill that is already there refreshes it in place (see "Re-importing the Bill grid" below); it still writes nothing but `zp_bills` and the audit trail.

**Database rules a row can hit.** Checked for `zp_bills`, `bookings`, `schedule_sessions`, `external_ids`, `athletes`, `memberships`, `credit_buckets`: required due date and person (now caught at validation), amounts beyond a `bigint` (an amount with more than 10 digits before the point is unreadable), unique bill and booking keys (already skip, never fail), session end after start, NUL bytes. Whatever is not foreseen is caught by the row savepoint below.

**Volume.** A 20,000-row Attendance file and a 20,000-row Bill file (400 fictional people, generated inside the test) on the shared 4-core build machine, two measurements each, the slower one while the full test suite and a browser suite were running beside it:

| Step | Attendance | Bills |
| --- | --- | --- |
| Upload + validate | 10 to 17 s | 7 to 8 s |
| Review page (one of 16 pages of 25 people) | 0.1 s | n/a |
| Confirm 400 strong matches | 0.2 to 0.3 s | 0.2 s |
| Commit (18,800 visits / 19,905 bills, every row in its own savepoint) | 28 to 42 s | 24 to 35 s |

The commit still runs inside one web request. If the real host has a request limit under about a minute, split the export by date range.

### Attendance grid: the confirmed real format (2026-11-16)

The format is now confirmed, though no real file has been run yet (nine yearly files of 400 to 16,600 rows are expected): 51 columns, CRLF, every field quoted, month-name dates, addresses that may contain unescaped quotes. The columns that matter: `Barcode` (numeric, the person's number: the same value as `Bar Code` on the Person and Membership grids, which the Person import stores as the person's external id), `Person` (a display name such as "First Last", not an id), `Membership`, `Membership Label` (sometimes empty), `Email`, `Phone`. Tests: `tests/zpimport-attendance-barcode.test.ts` (fictional people; the file is built CRLF and fully quoted).

- **Barcode is the person key.** It auto-maps to the person key (`Barcode` and `Bar Code` are the same alias). A visit whose Barcode was imported with the Person grid is matched with confidence `exact_source_id`: no name comparison, no review step. Tested with a Person file that says "Tessa Madeup" and an attendance file that says "Tess Maddup" for the same Barcode, and with two people who share one name and differ only by Barcode.
- **Person is the fallback.** It maps to the full name ("First Last": everything before the last space is the first name; "Last, First" is also read). It is only used when a row has no Barcode, and then the usual rules apply (exact name plus email or birth date is a suggestion staff confirm).
- **A Barcode that matches nobody** (a person deleted in Zen Planner, or missing from the Person export) leaves only those rows in review with "No matching person in Teamwork". Staff link them to a person or skip them; every other row commits. If the name on such a row belongs to a person already tied to a different Barcode, that person is listed as a candidate but never proposed. Once the person is imported with that Bar Code, uploading the same file again imports just those visits (tested).
- **Overlapping or repeated yearly files create nothing twice.** A visit's identity is Barcode + date + time + class (or Program, or Session Type) + location, so the spelling of the Person name and the order of rows do not matter. A visit already imported is skipped, and the session it belongs to is found again rather than created (tested: an overlapping file adds only its new visits; the same file a second time creates no visit, session or athlete record). The identity depends on which columns are mapped: keep the same mapping for all nine files.
- **A bad Email or Birth Date cell no longer rejects the visit.** Both are read as text on this grid; a value that is not an email or a date is ignored with a warning. Before, a person whose record carried a mistyped email would have had every visit rejected.
- **A Status column that is not about the visit.** When the file has an Att. column, a blank Att. with a Status word the import does not know (for example the person's `Student`) is "not a visit" and skipped; it used to reject the row. Without an Att. column an unknown Status word still rejects the row, because nothing else says whether a visit happened.
- **Not imported:** Membership, Membership Label and Phone (they stay in the stored raw row). Of the 51 columns only the ones listed on the mapping step are read; check that step on the first real file, since the other column names have not been seen.
- **Open:** whether Date and Time are one column or two, and how Att. is written, are still the guesses listed in the table above. A Barcode written differently in the two grids (leading zeros, a trailing `.0` from a spreadsheet) would not match; nothing suggests that happens, but it would show as every row waiting in review.

### Re-importing the Bill grid refreshes bills already in the history (2026-11-16)

Before, a bill whose `Bill #` was already imported was skipped, so Amount Paid, Amount Unpaid, Status and the payment date went stale. Now (`billRefreshPatch` / `refreshBill` in `commit-zenplanner.ts`, tests in `tests/zpimport-bill-refresh.test.ts`):

- **What is refreshed:** Due Date, Payment Date (new column `zp_bills.paid_date`, migration `0035_attend`; before, the Payment Date was only a stand-in for a missing Due Date), Amount Due, Amount Paid, Amount Unpaid, Discount Total, Paid On Time, Status. **Not touched:** the person, the description, the membership link, the batch that first imported the bill.
- **Preview:** at validation the row's action is `update` when at least one of those fields differs, `skip` when nothing differs. The preview counts (`action_update`), the commit counts (`update`, `committed_update`) and the row's result all say update. A bill already in the history is not sent back to identity review: it stays with the person it was given the first time, so the 151 name decisions are not asked again.
- **Blank and missing columns:** a column the new file does not have changes nothing. A blank cell in a column the file does have clears the stored value (a payment taken back in Zen Planner: Payment Date blank, Amount Paid $0.00). A cell that cannot be read (`ERROR`) never replaces a stored value.
- **Audit:** every refreshed bill writes one `import.zp_bill.update` audit event with the before and after values of the fields that changed, beside the batch's own `import.commit` event.
- **Revert:** reverting the batch that refreshed a bill puts back the earlier values (the row records before and after per field) and deletes only the bills that batch created. If a still later import changed a field again, that field keeps the later value; the fields that still hold what the reverted batch wrote go back. Reverting the batch that first created a bill deletes the bill, whatever later batches did to it. Revert cannot bring back a bill deleted that way: re-import the file.
- **History only, unchanged:** no invoice, membership, job or charge is created on create or on update (tested on both paths).
- Without a `Bill #` column the bill's identity is person + due date + description + amount due, so a re-import still finds the same bill and refreshes its payment fields, but a changed due date or amount makes a new bill.

### Commit: one bad row no longer stops the file

`commitBatch` runs each row of a Zen Planner grid preset (Person, Membership, Bill, Attendance) inside its own savepoint. When the database refuses a row (a CHECK, a missing value, a foreign key, an exclusion, a value it cannot store) the savepoint is rolled back, the row becomes `invalid` with `Rejected at commit: <reason>` in its errors, and the commit goes on. The reason is plain words for the constraints an imported row can hit (`row-errors.ts`) and a generic sentence naming the rule for any other. The row shows in the Rejected count, in reconciliation and in the rejected-rows CSV; because everything it wrote is gone, uploading the file again imports just that row once the cause is fixed.

- The commit keeps an id cache (the imported service, sessions, plans, households, parents). Ids cached by a row that is rolled back are forgotten (`RowCache`), so the next row creates them again instead of pointing at something that no longer exists (tested: the first visit of a file is refused after it created the service and the session).
- Failures that are not about the row still abort the whole commit so it can be retried: lost connection, serialization failure or deadlock, out of resources, cancelled query, a query that is wrong (classes 08, 25, 40, 42, 53 to 58, XX).
- A Person row that names another row of the file as its parent, when that parent row was rejected, imports without the guardian link and says so (existing behaviour).
- **Not applied to the other schemas** (Hawkin, TeamBuildr, wearables, generic, GoHighLevel, the older Zen Planner schemas): they keep all-or-nothing commits. A Hawkin sync advances its checkpoint when the batch commits, so a silently rejected test would never be fetched again, and a TeamBuildr questionnaire is assembled from several rows, so dropping one would store a partial answer set.

### Identity review with many people

- Review was already one decision per source person; that is unchanged. What was missing was a way to get through a long list.
- **Name-only tier.** For the Membership, Bill and Attendance grids (files that follow a Person import from the same account and cannot create people), a row whose exact first and last name belongs to exactly one person in Teamwork, with no conflicting birth date and nothing else to confirm it, is now a suggestion (`name_only`) instead of "ambiguous". It still waits for staff. **Confirm all name-only matches (N)** links them in one deliberate step with its own confirmation; strong matches keep their own button. A name two people share stays "several candidates" and is decided person by person. The Person grid and every other schema are unchanged (a name alone never suggests anyone there). The Bill and Attendance export steps now ask for Birth Date and Email columns when the grid offers them, which turns name-only matches into strong ones.
- The step is **paged** (25 people), **searchable** by name or email, and **filterable** by how the person matched (strong / name only / several candidates / no match), counted in SQL (`reviewGroupPage`), so 400 people from a 20,000-row file load in about 0.1 s. A decision keeps the current search, filter and page.
- "Link to someone else" is one type-ahead list shared by the whole page (up to 5,000 people) instead of a 2,000-option menu per person; the server accepts only a pick from that list, inside the organization.
- The committed import page no longer scrolls sideways at 390px (the reconciliation tables widened their grid column).
- For the 299 membership rows (41 people) left after the real dry run: the ones where "nothing but the name matches" and the name is unique become name-only suggestions; the ones where the name is shared still need a decision each. How the 41 split is not known here (the real file was not available to this session).

### Header matching

Headers are compared without case or punctuation (`normHeader` in `mapping.ts`: "Att." = "att", "Shared?" = "shared", "Mbr. Begin Date" = "mbr begin date"), and every field has a short alias list. A header the preset does not recognize is listed on the mapping step ("Not recognized (will not be imported): ...") and left out; it never fails the import. Preset columns missing from the file are listed too and left empty. Staff can still remap any field by hand.

### Export steps (the same text is shown in the wizard and on Imports → Zen Planner)

For every grid: open the report grid in Zen Planner Studio, choose columns, add the listed columns, export as CSV. The address has the form `~/<object>/index.cfm?export=CSV&_c=<chosen column names>`; the column list goes in `_c`. The exact `_c` token for each column is not in the map, so use the grid's own column picker and export link. Import order: Person, then Membership, then Bill and Attendance.

| Preset | Grid | Columns to include |
| --- | --- | --- |
| `zenplanner.person_grid` | `person/index.cfm` | First Name, Last Name, Birth Date, Email, Phone, Status, Family ID, Family, Parent First, Parent Last, Parent Email, Special Needs, Medications, Allergies, Prospect Status, Source, Interest, Referred By, Prospect Priority, Sales Rep, Inquiry Date, Trial End Date, Tracking Source / Name / Medium / Keywords, Primary Instructor, Primary Location, Signup Date, Has Password?, Signed Documents, Groups |
| `zenplanner.membership_grid` | `membership/index.cfm` | First Name, Last Name, Membership, Status, Mbr. Begin Date, Mbr. End Date, Months, Auto Renew, Renewal Type, Trial Member?, Cancel Date, Cancel By, Cancel Reason, Cancel Comments, Payment Amount, First Bill Due, Income Category, Att. Limit, Att. Limit Type, Class Card Att. Remaining, Shared?, Autopay?, Family ID, Birth Date, Email |
| `zenplanner.bill_grid` | `bill/index.cfm` | First Name, Last Name, Description, Due Date, Amount Due, Amount Paid, Amount Unpaid, Discount Total, Paid On Time, Status (do not add the Autopay Account columns). If offered: Number, Birth Date, Email |
| `zenplanner.attendance_grid` | `attendance/index.cfm` | First Name, Last Name, Date, Time, Att., Rsvp, Canceled, Session Type, Program, Location, Staff Member. If offered: Birth Date, Email |

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

**Bill** (`commitBillGrid`): one row in `zp_bills` (due date, payment date, amounts, discount total, paid on time, status); a bill already there is refreshed, not duplicated. **Never an invoice**: nothing payable, nothing shown to families. Autopay Account columns are never mapped. Two screens read `zp_bills`, both read-only. The **membership audit** uses the imported bills of a Zen Planner-billed membership (matched by `membership_id`) instead of its estimate: the exception shows the billed and paid amounts labelled "from imported bill history", and falls back to the labelled estimate when the membership has no imported bills or for bill dates after its last imported bill. The **scoreboard money view** shows them as a separate table, "Billed in Zen Planner, imported" (definition `mv_zp_imported`), never added to Collected, Billed or Outstanding. A bill that could not be matched to one membership (plan name not unique for the athlete) is in the scoreboard table but not in the audit.

**Attendance**: a row is a visit **only when `Att.` = Yes** (or ON, TRUE, Y, 1). Rsvp and Canceled are separate columns and never make a visit; those rows are skipped with the reason, and so is a row whose Att. is blank. When the file has a Status column and no Att. value, the Status word decides. Session Type, Program and Staff Member are kept as text on the imported session; Location links to a hub location on an exact name match.

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

`zp_person_details`, `zp_person_health` (health), `zp_membership_details`, `zp_bills`, `zp_webhook_events`, `zp_reconciliations`. No hand-written SQL. Migration `0035_attend` adds `zp_bills.paid_date` (nullable date, no hand-written SQL).

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
- Very large files commit in one transaction (20,000-row Bill and Attendance files measured at 24 to 42 s on the build machine); split bigger exports by date, or any export if the host limits a request to under a minute.
- The Bill and Attendance grids have still not been exported: every format in "Bill and Attendance grids: made ready before the real files arrive" is a tolerated guess. Check the first real file's mapping step (which columns were recognized), the rejected rows and the warnings before committing.
- A bill is never removed because a later Bill export no longer contains it (deleted or voided in Zen Planner): compare counts on the reconciliation page.
- A re-imported bill keeps its person, description and membership link; only its dates, amounts, Paid On Time and Status are refreshed.
- Row savepoints cover the Zen Planner grid presets only; other schemas still commit all or nothing.
