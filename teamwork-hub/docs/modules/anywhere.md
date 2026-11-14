# Anywhere: On Your Own sessions, My Season, Daily 3

Proposed Teamwork functionality (built). It makes the Hub useful on days the athlete is not in the gym.

- Code: `src/lib/anywhere/*.ts`, schema `src/db/schema/anywhere.ts`, migration `drizzle/0020_anywhere.sql` (renumbered by the lead at merge).
- Athlete and guardian pages: `/anywhere` (Sessions tab), `/anywhere/sessions/[id]` (the session in progress), `/anywhere/season` (My Season tab). Nav item "On Your Own".
- Coach pages: `/training/anywhere` (library, assign, completion board, review queue, settings), `/training/anywhere/new`, `/training/anywhere/[id]` (builder). Training tab "On Your Own".
- Cards mounted elsewhere: Athlete Home (`src/components/anywhere/home-cards.tsx`), training overview and athlete training page and load page (`src/components/anywhere/coach-cards.tsx`).
- Seed: `scripts/seed/anywhere.ts`. Tests: `tests/anywhere.test.ts`, `tests/anywhere-pure.test.ts`.

All demo content is synthetic. Sessions are labelled **Sample** and are meant for coaches to edit. No vendor content is included.

## 1. On Your Own sessions

A session has a name, a short description, a type (mobility, recovery, core, speed and agility, bodyweight strength, travel and hotel, pre-game warm-up), minutes, equipment tags (none, band, ball, field), an "under 13" flag and a status (draft, published, archived). Steps are rows that point at the **existing exercise library**: the exercise name, its coaching notes and its demo link (`exercises.video_url`, authorized media only) are reused, and each step adds a plain-text "what to do" and an optional extra cue. Nothing new is copied into the session.

- Coaches, admins and owners (`training.manage`) build sessions. A session needs at least one step before it can be published. Steps are reordered with Up and Down buttons, so the builder works from the keyboard.
- Athletes browse published sessions at `/anywhere` and filter by the time they have (10, 15, 20 minutes) and what they have with them.
- The line "Stop if anything hurts and tell your coach or a parent." is on every session card, on the session page and in the builder (`SAFETY_COPY` in `common.ts`).
- **Under 13**: an athlete younger than 13, or with no birthday on file, only ever sees sessions with "Suitable for athletes under 13" ticked. This applies to the library, direct links, assignments, the game-day warm-up and to a coach finishing a session on the athlete's behalf.
- **No health-based recommendations.** Nothing in this module reads wellness answers, soreness or pain reports, or injury notes. The library order is by length and name. A test adds a severe pain report and checks that the output does not change.

### Finishing a session

The athlete ticks steps and taps Finish, with optional minutes and effort (RPE 0 to 10). The result is its own row in `anywhere_completions` (never a workout or a booking), with a snapshot of the session title and type.

- **Idempotent**: the device makes a `clientKey` when Finish is tapped. `(org_id, client_key)` is unique, so a retry returns `duplicate` and writes nothing. Four racing retries produce one row (tested).
- **Streak and XP**: `src/lib/engagement/sync.ts` reads completions as a new activity source. A completion makes its facility-local ISO week active, and earns the new XP kind `on_your_own_completed` (default 10, lower than a gym session at 20 or a logged workout at 15, configurable under Settings, Engagement). The `xp_events_kind_ck` CHECK is replaced in this migration to allow the new kind.
- **Load**: only when BOTH minutes and effort are given, one `activity_sessions` row is written with `source = 'on_your_own'` (`kind = 'training'`). With one or neither, no load row exists. Missing is never zero.

### Assignments

A coach assigns one session, or "any session of a type", a number of times inside a date window (up to 60 days), to an athlete or a group. Example: any mobility session, 2 times, Monday to Sunday. The same rule as habits applies: a coach can only assign to athletes and groups in their own scope.

- Athlete Home shows "On your own this week" with progress and a Start button. `/anywhere` shows the same list under "From your coach".
- `/training/anywhere` shows each assignment with completion per athlete, and a review queue of finished sessions ("Mark reviewed"). Coaches only see their own athletes.

### Poor connectivity: what is and is not offline

The training logger's service worker (`public/training-sw.js`, scope `/training/today`) was **not** extended. Widening its scope and caches to a second area would put the existing offline suite at risk, so this module uses save-and-retry instead.

| Works without a connection | Needs a connection |
|---|---|
| A session page that is already open: ticking steps, entering minutes and effort, tapping Finish | Opening the library or a session for the first time (no pages are cached offline) |
| Ticks survive a reload on the same device (step ids only, in `localStorage`) | Seeing new assignments |
| Finish is saved on the device first, then sent with its `clientKey`. Retries with backoff, when the browser comes back online, and on the next visit to On Your Own | My Season forms and the "How was practice?" form (plain server actions) |

The queue (`_components/anywhere-queue.ts`) stores ids, counts and numbers only: no names, titles or notes. The server (`POST /api/anywhere/complete`) re-checks scope per item and answers `applied`, `duplicate`, `rejected` or `error` so the device knows what to drop and what to retry.

## 2. My Season

Families add the athlete's outside season: team name, sport, first and last day (up to 400 days), then events: game, practice, tournament, travel day, rest day. An event is one day, or weekly on chosen weekdays for the rest of the season. Single days of a weekly event can be skipped.

- **Time zone and DST**: events store a local date, a local "HH:MM" and the facility time zone. Occurrences are expanded with the scheduling module's `seriesOccurrences`, which converts each occurrence on its own, so a 4:00 PM practice stays 4:00 PM on both sides of a DST change (tested for spring and fall).
- **Opponent and location** are free text the family typed. They are shown as typed and are never geocoded or looked up.

### Calendar file upload (.ics)

Pasting a calendar URL is not supported (the Hub makes no outbound calls). A family can upload an `.ics` file instead. `src/lib/anywhere/ics.ts` is a bounded text scan:

- Limits: 256 KB, 20,000 lines, 200 events, 2,000 characters per line, 120 characters per text field. Must be UTF-8 and end in `.ics`.
- Only `UID`, `SUMMARY`, `LOCATION`, `DTSTART`, `DTEND`, `DURATION`, `RRULE` (weekly only), `STATUS` and `RECURRENCE-ID` of `VEVENT` blocks are read. Alarms, attachments, URLs, descriptions, organizers and attendees are ignored. Nothing in the file is fetched, followed, included or executed.
- UTC and `TZID` times are converted to facility time. An unknown `TZID` is read as facility time with a warning.
- Events outside the season, cancelled events, and changes to single days of a repeating event are skipped and counted. Unsupported repeats import their first day with a warning.
- The parsed result is **staged** in `anywhere_ics_imports` and shown as a preview. Nothing reaches the season until "Import these". Import is idempotent by UID: the same file again updates the events and never duplicates them. Events with no UID get a stable synthetic one.
- The event type is a guess from the title (practice, tournament, travel, rest, otherwise game) and can be changed by removing and re-adding.

### Logging practice and games into load

After a practice, game or tournament the athlete logs minutes and effort: from Athlete Home ("How was practice?", minutes pre-filled from the event), from the Game Day card, or from My Season (also for something not on the calendar).

- Each log owns one `activity_sessions` row with `source = 'sport'` and `kind` practice or game. That is the same table the load page already reads, so `srpe_load_v1`, `acwr_rolling_v1`, `monotony_v1` and `strain_v1` include outside load **without any change to the formulas**.
- Logging the same event day again updates that row (unique on event and date). Without an event, a one-time key stops a double submit.
- **Missing logs stay missing.** A practice nobody logged adds no row, so that day stays "no data" and lowers coverage, exactly as before. Nothing here writes a zero.
- Logs can be entered up to 30 days back and never for the future (same as existing activity logging).

### Load by origin (`load_origin_v1`)

`loadEntries` now tags every row with an origin. This is a display split only.

| Origin | Rows |
|---|---|
| Gym | Completed Hub workouts, manual "training" entries |
| Sport | `source = 'sport'`, and manual practice or game entries |
| On your own | `source = 'on_your_own'` |
| Other | Manual conditioning or other |

The load page has a new card, "Weekly load by origin": a stacked column chart per ISO week with a numbered legend (legend order is bottom to top), the week total printed above each stack, a text summary with shares, and the usual data table. Series are not told apart by color alone. Tests check that the split adds up to the known session loads, that existing series and ACWR are unchanged when no outside session exists, and that they equal the existing formulas over the new series when one does.

### What coaches see

- Training overview: "Who has a game in the next 48 hours" (games and tournaments from My Season, coach's own athletes only).
- Athlete training page (`/training/athletes/[id]`): "Sport season" with last week through the next two weeks and log status.
- Load page: the stacked chart above.

### Game Day card and In Season link

- On a day with a game or tournament, Athlete Home shows a Game Day card: time, opponent and location as typed, a warm-up suggestion (the shortest published session of type "pre-game warm-up" the athlete may see) and, once the start time has passed, a "log it" form.
- **In Season**: when the organization turns on "Mention the In Season membership" (`organizations.settings.anywhere.showInSeasonOption`, default **off**, owner and admin, audited), an active season shows an informational link that opens a new message to the front desk. Staff handle it through the existing member request flow. Nothing in this module creates a request or changes a membership (tested).

## 3. Daily 3

A compact card on Athlete Home with up to three coach-assigned habits due today, from the **existing** habit tables (`habits`, `habit_assignments`, `habit_checkins`) through `habitSummaries` and `checkinHabit`. No new habit tables. One tap marks a habit done for today. Changing a check-in is done on the Habits page.

## 4. Authorization

Everything goes through `src/lib/authz/policy.ts` (`anywhereAccess` in `common.ts` maps capabilities, it grants nothing itself). Every row has `org_id` and every query filters on the viewer's organization.

| Action | Needs | Who that is |
|---|---|---|
| Browse the library, see assignments, completions, RPE and minutes of sport logs, Daily 3 | `training.read` on the athlete | The athlete, guardians with training access, assigned coaches, owner, admin, operations |
| Finish a session, log practice or a game, tick a habit | `training.log` | The athlete, assigned coaches, owner, admin |
| See the season calendar | `profile.read` | The athlete, linked guardians, assigned coaches, staff |
| Add or change the season, upload a calendar file | `profile.read` and `booking.create` | The athlete, guardians who can book, assigned coaches, staff |
| Build sessions, assign | `training.manage` (+ `training.write` on each target athlete) | Coach (own athletes), admin, owner |
| Settings | `settings.manage` | Owner, admin |

Notes:

- **RPE mirrors existing load data.** The load module shows sRPE under `training.read`, not `health.read`, so a guardian without health access but with training access (Jordan in the demo) sees logged minutes and effort. A guardian without training access sees the calendar only: logs are withheld, not shown as empty.
- **Guardians and logging (owner decision, 2026-11).** A guardian may finish an On Your Own session and enter its effort rating for an athlete **under 13**, when their link to that child has **both training access and booking access** (`training.log_at_home` in `policy.ts`, computed by `guardianMayLogAtHome`). Booking access is the existing flag for acting on the child's activity (it already gates editing the season); training access is what lets them see the library and logged effort. Health access is not needed. An athlete with **no birthday on file does not qualify**: unknown age always takes the more restrictive reading, and here that means nobody else logs in the athlete's name (the library restriction for unknown age is unchanged). The permission ends on the 13th birthday.
  - The completion row stores `logged_by` and `logged_as` (`athlete`, `guardian` or `staff`, CHECK constraint). The audit entry reads "Parent logged On Your Own session ... on behalf of an athlete under 13". Coaches see a "Logged by parent: name" badge in the review queue; the family history says "logged by a parent".
  - It is the same completion row and, with minutes and effort, the same `activity_sessions` row as the athlete's own log, so streaks, XP (`own:<completionId>`) and load are identical.
  - Everything else under `training.log` (workouts, habits, practice and game logs) still cannot be done by a guardian.
- Habit values use the existing habit access rules unchanged.

## 5. Data model

| Table | Purpose |
|---|---|
| `anywhere_sessions`, `anywhere_session_steps` | Library. Steps reference `exercises` |
| `anywhere_assignments` | Session or type, athlete or group, window, target count |
| `anywhere_completions` | One finished session. Unique `(org_id, client_key)`. Optional link to its load row |
| `anywhere_seasons`, `anywhere_season_events` | Season and one-off or weekly events. Unique `(season_id, ics_uid)` |
| `anywhere_ics_imports` | Staged calendar upload for preview |
| `anywhere_sport_logs` | Link from an event day (or a one-time key) to its `activity_sessions` row |

Hand-written SQL at the end of the migration: CHECK constraints for types, statuses, ranges and "exactly one target", plus the wider `xp_events_kind_ck`.

Changes to other modules (all additive): `XpKind` and XP defaults, `loadActivity`/`streakFromActivity`/`xpCandidates` in engagement; `LoadRow.origin` and `loadOrigin` in `science/load.ts`; `load_origin_v1` in the formula registry; nav item and icon; one training tab; mounts on Athlete Home, the training overview, the athlete training page and the load page.

## 6. Gaps and assumptions

- No offline first load of the library or a session (no service worker in this module). See the table above.
- Guardians can finish at-home sessions for athletes under 13 only (see Authorization). They cannot log practice, games or habits for a child.
- An athlete with no birthday on file is treated as under 13 for the library, and as not eligible for parent logging.
- Ticks kept on the device are per session, not per child: a parent of two children under 13 doing the same session should finish one before starting the other.
- Events cannot be edited in place: remove and add again. Only weekly repeats are supported.
- XP is not removed if a completion is later deleted (same as the rest of the XP ledger).
- No reminders or notifications are sent for assignments, games or logs.
- The warm-up suggestion is the shortest published pre-game warm-up. There is no per-sport choice.
- Point value (10) and the sample sessions are starting points for the owner and coaches to confirm.
