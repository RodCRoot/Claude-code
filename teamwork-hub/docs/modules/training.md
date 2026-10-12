# Training module (strength programming, logging, weight room, maxes, progress)

Owner paths: `src/app/(app)/training/**`, `src/app/api/training/**`, `src/lib/training/**`,
`scripts/seed/training.ts`, `tests/training*.{test,e2e}.ts`, `tests/training.playwright.config.ts`.

## Research notes — public documentation only

No TeamBuildr account was used. Sources: teambuildr.com/platform-strength,
teambuildr.com/weight-room-view-feature, support.teambuildr.com (category index only).
What their public pages describe, which shaped *which workflows* we cover (the UI, copy and
media here are original; no licensed videos are copied):

- Workout builder: calendar/date-based and free-form building, exercise library, reusable
  templates deployed to several teams/groups.
- Delivery: athletes see workouts in a mobile app or on a shared tablet.
- Logging: athletes log results in a few taps; coaches see results live.
- Maxes: custom 1RM tracking; percentage-based loads adjust to each athlete's max; Max & PR tracking.
- Weight Room View: one shared tablet per rack/station serving roughly 4–8 athletes, each seeing
  their own prescribed loads; works on any web-connected device.
- Leaderboards (no detail published) and 16+ exportable reports (progress, workout results,
  completion), filterable by team/athlete/date/lift; raw-data CSV export on higher tiers.
- Help-center categories: Maxes, Reporting, Weight Room View, Manage Calendars, Free Form
  Programming, Build, Exercise Database, Whiteboard (TV timer).

## What's built

| Area | Where | Notes |
| --- | --- | --- |
| Exercise library | `/training/exercises`, `lib/training/exercises.ts` | category, pattern, equipment, tracking type, unit, unilateral, bodyweight factor, authorized video **link**, notes, substitutions, `max_source_exercise_id`. Staff read; `training.manage` edits. 42 seeded. |
| Programs | `/training/programs/[id]`, `lib/training/programs.ts` | phases (goal, weeks) → weeks × days → items with block labels (A1/A2 superset, C1–C3 circuit) and set groups (sets, reps/rep text, load absolute/%/RPE/RIR/bodyweight/none, time, distance, tempo, rest, warm-up), linear progression per week. Copy week, duplicate program. Every structural edit bumps `current_version`. |
| Annual plan | `/training/plan` | `training_plan_blocks` per group/athlete on a 12-month timeline. |
| Assignment | `lib/training/assignments.ts` | assign program version to athlete or group with start date + weekdays → frozen `workouts` + `workout_items` with resolved loads. Unique (assignment, athlete, program_day) ⇒ idempotent re-runs. "Add new members" (sync), "Apply to unstarted workouts" (rebuild scheduled, no-log, today-or-later workouts from the current version), cancel. |
| Maxes & loading | `lib/training/formulas.ts`, `loads.ts`, `maxes.ts` | see below |
| Athlete logging | `/training/today` | mobile-first; prescribed vs actual per set, "Done as prescribed", edit reps/load/RPE, substitutions/modifications, skip/reopen, complete with session RPE + duration. |
| Offline tolerance | `_components/set-queue.ts`, `POST /api/training/sets` | see below |
| Weight room | `/training/weight-room` | group/date → athlete grid (names + workout progress only) → per-exercise quick entry. Coaches: their groups/athletes; owner/admin: all; operations: view only. "Exit weight room" flushes, then wipes client state. |
| Coach review | `/training/review`, `/training/workouts/[id]` | feed with group/status/date filters, mark reviewed, feedback, PR alerts. |
| Progress & reports | `/training/athletes/[id]`, `/training/reports` | adherence, workout history, max/PR history, e1RM chart per lift (unit + date range labelled, data table), group report, opt-in leaderboard, CSV exports, VBT CSV import. |
| Settings | `/training/settings` | plate increments (org settings JSON `settings.training`). |

### Loading rules
- Methods: `epley_v1` 1RM = w × (1 + reps/30) (reps = 1 → w); `brzycki_v1` 1RM = w × 36/(37 − reps),
  valid for 1 ≤ reps < 37. Invalid input (reps < 1, non-integer, load ≤ 0, Brzycki ≥ 37) → `null`.
- % loads use the latest lb/kg max recorded **on or before the workout date** for the max exercise
  (`load.maxExerciseId` → exercise `max_source_exercise_id` → the exercise itself).
- Rounded to the plate increment of the max's own unit (default 5 lb / 2.5 kg). Units are never
  silently converted; lb↔kg conversion only happens explicitly (progression in a different unit)
  with factor 0.45359237 and is written into the load note.
- Each resolved set group stores `loadMethod` (e.g. "80% of Back Squat max 225 lb (tested, 2026-02-01),
  rounded to 5 lb") and `maxUsed`; the logger shows them under each exercise.
- Progression: `weekOffset = day.week − phase start week`; `percent` adds percentage points, `lb/kg`
  adds load. Warm-up groups never progress.
- Recording a max (or confirming an estimate) recomputes %-loads only on that athlete's *unstarted*
  workouts dated on/after the max date (`refreshUnstartedLoads`). Started/completed workouts stay frozen.
- Estimated maxes are *suggested* from completed working sets of 1–10 reps in the last 42 days
  that beat the current max in the same unit; a coach confirms (Epley or Brzycki) → `maxes.kind = estimated`
  with `source_set_log_id`.

### Offline protocol
- Client queue in `localStorage["tw.training.queue.v1"]` stores only ids, numbers, unit and side
  (no names, notes or other PII). Each entry has a random `clientMutationId` and a client timestamp.
- Sync: `POST /api/training/sets {mutations[], via}`; retries with exponential backoff (1 s → 30 s),
  immediately on the `online` event, and on "Retry now". UI shows "N unsynced entries".
- Server (`applySetMutation`): same `clientMutationId` → `duplicate` (no change); otherwise upsert on
  (workout_item, set_index, side) and only overwrite if the incoming client time is ≥ the stored
  one (late retries of older edits return `stale`). Authorization (`training.log` on the athlete) is
  checked for every mutation; out-of-scope entries are `rejected` and shown to the user.
- Reloading while offline-but-served (or with the API unreachable) keeps pending entries; a reload with
  no network at all needs the page itself, which is not service-worker cached (see gaps).

### Permissions
All checks go through `policy.ts`: reads need `training.read` on the athlete (guardians only when
`can_view_training`), logging needs `training.log` (athlete self, coach for assigned athletes,
owner/admin), coach review / maxes / substitutions to any exercise need `training.write`.
Programs, plan, exercises edits, VBT import need org `training.manage`. Operations is read-only.
Exports: staff get their scope; athletes/guardians only their own athletes.

### Load monitoring hand-off
Completing a workout upserts exactly one `activity_sessions` row (kind `training`, unique `workout_id`)
with session RPE and duration, for the Sports Science module's sRPE load calculations.

## Exports for other modules
`src/lib/training/dashboard.ts`
- `workoutsForDate(tx, viewer, date?)` — scoped workouts with items + progress.
- `todaysWorkoutSummary(tx, viewer, date?, limit?)` → `{ workoutId, athleteName, title, status, setsDone, setsTotal, href }[]`.
- `recentLogsForCoach(tx, viewer, limit?)` → recent logged sets in the viewer's scope.
- `athleteTrainingSnapshot(tx, viewer, athleteId, today?)` → `{ adherence28d, next, href }` or null when out of scope.

`src/app/(app)/training/_components/dashboard-cards.tsx` (server components)
- `<TodayTrainingCard viewer date? />`, `<CoachTrainingFeedCard viewer limit? />`, `<PrAlertsCard viewer since? />`.

## Tests
- `pnpm test` — `tests/training.test.ts` (formulas, dated % loads + rounding, kg handling, max-source,
  template edit isolation + apply-to-unstarted, idempotent set retries incl. stale/concurrent, coach
  scope in weight room and logging, guardian `can_view_training`, substitutions, single activity
  session on completion, adherence, leaderboard opt-in, PR scope, CSV scope, VBT import provenance).
- `pnpm exec playwright test -c tests/training.playwright.config.ts` — offline → log → reload →
  lost response → synced with no duplicate rows (requires `pnpm db:fresh`; starts dev on :3105).

## Known gaps vs. TeamBuildr Strength (public feature list)
- No native mobile app or push notifications; no service worker, so a cold reload with zero network
  fails (queued entries remain and sync once the page loads again).
- No drag-and-drop calendar builder or day-stacking; editing is form-based per week.
- No athlete video upload, questionnaires/readiness surveys, whiteboard/TV timer, or payments marketplace.
- Leaderboards are per-lift e1RM only (no custom metrics/tests); reports are a focused subset.
- VBT data comes from CSV file import only; no live device integration.
- Program templates are versioned by counter only (assignments reference the version number; the
  template content of older versions isn't stored separately — workouts themselves are the frozen record).
