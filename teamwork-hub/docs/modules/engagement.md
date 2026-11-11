# Engagement module (Athlete Home, streaks, XP and levels, badges, goals)

Owner paths: `src/lib/engagement/**`, `src/db/schema/engagement.ts`, `drizzle/0018_engagement.sql`,
`src/components/engagement/**`, `src/app/(app)/today/_components/athlete-home.tsx`,
`src/app/(app)/goals/**`, `src/app/(app)/settings/engagement/**`,
`src/app/(app)/performance/[athleteId]/engagement-panels.tsx`, `scripts/seed/engagement.ts`,
`tests/engagement*.test.ts`. Screenshots: `docs/screenshots/engagement/`.

Purpose: make the athlete's own view the part of the Hub they want to open, in and out of the gym.
Everything here is derived from rows other modules already write. No other module's write path
was changed.

## What's built

| Area | Where | Notes |
| --- | --- | --- |
| Athlete Home | `/today` for `athlete` and `guardian` roles (`athlete-home.tsx`, `lib/engagement/home.ts`) | Staff and coach views of `/today` are unchanged. Mobile-first (390px). |
| Weekly streak | `lib/engagement/streaks.ts` (pure) | Current and best streak, last six weeks. |
| XP ledger and levels | `xp_events`, `lib/engagement/sync.ts`, `levels.ts` | Append-only, idempotent, derived. |
| Badges | `athlete_badges`, `lib/engagement/badges.ts`, `components/engagement/medallion.tsx` | Catalog in code, SVG medallions drawn in code. |
| Goals | `athlete_goals`, `lib/engagement/goals.ts`, `/goals`, Goals panel on `/performance/[athleteId]` | Free text, or linked to a test metric or a lift max. |
| Coach strip | `components/engagement/strip.tsx` on `/performance/[athleteId]` | Level, streak, badge count, last activity. |
| Settings | `/settings/engagement` (owner/admin), `lib/engagement/settings.ts` | XP per action, levels on/off, badges on/off. Audited. |

### Athlete Home sections

For an athlete: greeting, level ring and streak (hero), today's workout with a large **Start
workout** button (`/training/today`), today's wellness check-in prompt when one is due and not
answered, next booked session with a countdown and **Book another**, this week's progress
(sessions attended against the plan's weekly cap when the plan has one, workouts logged against
workouts planned), active goals with progress, newest badges, latest PRs, and a "What's next"
checklist (profile complete, forms signed, first session booked, baseline test recorded, first
goal set) that disappears when everything is done.

For a guardian: the same summary for one child at a time, with a chip per linked child, plus a
Family card covering every linked child (forms to sign, upcoming sessions, and open invoices when
the guardian may see billing). Guardians never get the Start workout button or the check-in prompt.

## Rules and formulas

### Weekly streak (`streaks.ts`)

- A week is the **facility-local ISO week**, Monday to Sunday. Instants are converted to a local
  date in the organization's timezone first (`src/lib/time.ts`), so a Sunday 11:30 PM session
  belongs to the week that is ending even though it is already Monday in UTC, and the two DST
  changes do not move anything.
- A week is **active** when the athlete has at least one booking with status `attended` (by the
  session's start time) or at least one workout with status `completed` (by `completed_at`, or the
  scheduled date when that is missing).
- The **current streak** is the number of consecutive active weeks ending now. The week in
  progress never breaks it: an athlete who has not trained yet this week keeps last week's number.
- **Hold weeks are skipped.** A week in which any day falls inside a `membership_holds` row of
  kind `hold` neither adds to nor breaks the streak. If the athlete trains during a hold week
  anyway, it counts. In-season pauses (kind `in_season`) are not holds: the athlete is still
  training.
- **Best streak** is the longest run found by the same rule over the athlete's whole history.
- Copy never scolds a missed week. A week without training is labelled a rest week.

### XP (`sync.ts`)

`xp_events` is an append-only ledger: athlete, kind, points, source type and id, a unique
`(org_id, idempotency_key)`, and when the activity happened. A database trigger blocks UPDATE and
DELETE, the same way `audit_events` is protected. CHECK constraints limit `kind` and `points`.

`syncXp(tx, orgId, athleteId)` derives the events an athlete's history justifies and inserts the
ones that are missing (`ON CONFLICT DO NOTHING` on the unique key). It is safe to run on every
page load, repeatedly, and concurrently.

| Kind | Source row | Idempotency key | Default points |
| --- | --- | --- | --- |
| `session_attended` | booking with status `attended` | `session:<bookingId>` | 20 |
| `workout_completed` | workout with status `completed` | `workout:<workoutId>` | 15 |
| `wellness_checkin` | any questionnaire response for a date | `checkin:<athleteId>:<date>` | 5 |
| `pr_set` | a max that beats every earlier max of the same kind for that lift | `pr:<maxId>` | 25 |
| `goal_achieved` | goal with status `achieved` | `goal:<goalId>` | 50 |
| `form_signed` | completed form request (not imported archives) | `form:<requestId>` | 10 |

- Point values are **organization settings with defaults** (`organizations.settings.engagement.xp`).
  They are labelled as defaults in Settings. Points are copied onto the ledger row at award time,
  so changing a value affects future awards only.
- **Health values never affect XP.** The check-in award reads only the date of a response, never
  an answer, and is limited to one per day. The ledger row stores the date and nothing else.
- PRs: the first max for a lift is the starting point, not a PR. Tested, manual and imported maxes
  ("measured") are compared only with each other, estimated maxes only with each other. lb and kg
  are compared through the exact conversion in `science/formulas.ts`; other units are ignored.
- XP is not taken back. If staff later correct an attendance from attended to no-show, the earlier
  award stays (see Known limits).

### Levels (`levels.ts`, curve `tw_levels_v1`)

Total XP needed to reach level n: `50 * n * (n - 1)`.

| Level | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Total XP | 0 | 100 | 300 | 600 | 1000 | 1500 | 2100 | 2800 | 3600 | 4500 |
| Title | Rookie | Starter | Grinder | Competitor | Varsity | Captain | All-Conference | All-State | All-American | Legend |

Each level takes 100 XP more than the one before. Levels continue past 10 with the title Legend.
With the default points, an athlete who attends three sessions and logs three workouts a week
earns about 105 XP a week.

### Badges (`badges.ts`)

The catalog lives in code with **versioned keys**. A key never changes meaning: a changed rule
gets a new key with the next version suffix, and the old key stays so earned badges still render.
Badges are never taken away. `syncBadges` is idempotent (unique `(athlete_id, badge_key)`).

| Key | Earned by |
| --- | --- |
| `first_session_v1` | first attended session |
| `sessions_10_v1`, `sessions_25_v1`, `sessions_50_v1`, `sessions_100_v1` | that many attended sessions |
| `streak_4_v1`, `streak_12_v1`, `streak_26_v1`, `streak_52_v1` | weekly streak reaching that many weeks (hold weeks skipped) |
| `first_pr_v1`, `pr_5_v1` | one PR, five PRs |
| `goal_first_v1` | first goal achieved |
| `early_bird_v1` | five attended sessions that start before 7:00 AM facility time |
| `all_forms_signed_v1` | every active form template marked required for booking has a completed, unexpired request (and at least one such template exists) |
| `one_year_member_v1` | first membership started at least a year ago and a membership is live now |

`earned_at` is the moment the rule was first met where that can be known (for example the start
time of the tenth attended session), not the time the row was written. `source` records the rule
and count, never a health value.

Art: `BadgeMedallion` draws each badge as inline SVG (rim, face, glyph per family, optional
number) in a fixed bronze, silver, gold or platinum palette. Each has `role="img"`, an
`aria-label` and a `<title>`, and the badge name is always printed as text next to it. Badges not
yet earned are drawn grey with the way to earn them written underneath.

### Goals (`goals.ts`)

`athlete_goals`: title, optional link to **one** of a test metric (`metric_definition_id`) or a
lift max (`exercise_id`), target value and unit, direction (increase or decrease), optional target
date, status (`active`, `achieved`, `archived`), who created it.

- **Who can create and change goals**: the athlete if 13 or older (birthday must be on file),
  a guardian with an active guardianship, and staff with `training.write` on the athlete (owner,
  admin, assigned coach). Linking a goal to a measured value also needs `training.read`.
  An athlete may have at most 8 active goals.
- **Free-text goals** are checked off by hand.
- **Linked goals** fill in from results and check themselves off. When the latest comparable value
  meets the target the goal becomes `achieved`, an audit event `engagement.goal.achieved` is
  written with actor role `system`, and the XP follows on the same refresh. A target that is
  already met when the goal is created is rejected.
- **Comparability.** Test-metric goals read `athleteMetricSeries` (sports science), which applies
  `src/lib/science/comparability.ts`: same test type, protocol, source, calculation version,
  aggregation level and an exactly convertible unit. The goal stores the measurement context of
  its starting value. A newer result measured another way is **not counted** toward the goal and
  never checks it off; the goal says so in plain words. Target units must convert exactly to the
  metric's unit or the goal is rejected. Nothing is estimated or merged.
- **Lift-max goals** use maxes of one basis only, chosen when the goal is created from the
  athlete's latest max for that lift: measured (tested, manual, imported) or estimated. The other
  kind is ignored and the goal says so.
- **Progress** = share of the way from the starting value to the target, shown as a number and as
  text, with a bar. No percentage is shown when it cannot be stated honestly (nothing measured
  yet, or no starting value); the text then gives the current value and the target. It reads 100
  only when the target is actually met.
- A goal set before anything was measured takes its starting value from the first result.

The older `goals` table in the science schema is unused by this module and left as it is.

## Settings

`/settings/engagement`, owner and admin only (`settings.manage`), stored at
`organizations.settings.engagement`, every save audited as `org.engagement_settings_update`.

| Setting | Default | Effect |
| --- | --- | --- |
| XP and levels | on | Off: no XP is awarded, the level ring is hidden everywhere. |
| Badges | on | Off: no badges are awarded or shown. |
| XP per action (six values) | see table above | Whole numbers 0 to 1000. Apply to future awards. |

The streak, goals and this week's progress stay on in every case. Turning XP or badges back on
fills them in from each athlete's history at the current point values.

## Privacy and authorization

Every read and write goes through `engagementAccess` (`lib/engagement/access.ts`), which only
restates what `athleteCapabilities` in `src/lib/authz/policy.ts` already grants. Every table has
`org_id` and every query filters on it. Ids from the client (athlete, goal, metric, exercise) are
re-checked on the server.

| Viewer | Sees | Can change |
| --- | --- | --- |
| Athlete | own home, goals, badges | own goals (13+) |
| Guardian with training access | child's streak, level, badges, PRs, goal progress | child's goals |
| Guardian without training access | goal titles and targets, sessions, forms. No streak, XP, badges, PRs, workouts or measured values | free-text goals only |
| Guardian without health access | everything above for their flags, and nothing about wellness (not even whether a check-in was done) | |
| Payer-only adult (no guardianship) | nothing about the athlete; only their invoices | nothing |
| Assigned coach, owner, admin | strip and goals | goals |
| Operations | strip and goals (no health) | nothing |
| Unassigned coach, other families, kiosk, other organizations | nothing | nothing |

- Wellness: the only thing Athlete Home ever shows is whether today's check-in is due and done,
  and only to a viewer with `health.read`. No answer, score or flag is read by this module.
- Sections a viewer may not see are returned as `null` from `athleteHome`, never as zero.
- Billing items on the guardian's Family card come from `familyBilling`, unchanged.

## Seed

`scripts/seed/engagement.ts` (registered last in `scripts/seed/modules.ts`) adds a few synthetic
goals for demo athletes and then runs the refresh for every athlete, so XP and badges come from
the same rules as production. Two goals get an earlier starting value so the demo shows a partly
filled bar; that edit exists only in the seed.

## Tests

- `tests/engagement-pure.test.ts`: week boundaries in facility time including both DST changes
  and a year boundary, streak math (gaps, hold weeks, training during a hold, week in progress,
  milestones), level curve, PR detection, badge rules and catalog, goal progress.
- `tests/engagement.test.ts` (real Postgres): XP idempotency under repeated and concurrent sync,
  append-only trigger and constraints, check-in XP independent of answers, point changes, org-wide
  off switch, badge awarding and dating, hold weeks from membership rows, goal auto-achievement
  with one audit row and one XP award under concurrency, protocol comparability, and
  authorization for athlete, under-13 athlete, guardian without health access, guardian without
  training access, payer-only adult, unassigned coach, operations, kiosk and another organization.
- `e2e/a11y.spec.ts` and `e2e/csp.spec.ts` include `/goals` (guardian, athlete) and
  `/settings/engagement` (owner); `/today` was already covered for both family roles.

## Known limits

- XP is never reversed. A corrected attendance, a deleted max or a reopened goal leaves the
  earlier award in the ledger. A reversal entry would need a new event kind.
- XP, badges and auto-achieved goals are brought up to date when Athlete Home, `/goals` or the
  athlete's performance page is opened (and by the seed), and every night by the scheduled job
  `engagement.refresh.nightly` for every active athlete (same functions; see
  `docs/modules/scheduled-jobs.md`). Streaks are computed from attendance when shown and store nothing.
- "Profile complete" in the checklist means a birthday and a sport are on file. Families cannot
  edit those themselves yet, so the item points them to Messages.
- No notifications are sent for new badges or levels.
- The weekly cap shown under This week is the plan's `classes_per_week`; plans without one show
  the count only.

## On Your Own sessions (anywhere module)

A finished On Your Own session (`anywhere_completions`) is a streak source and earns the XP kind `on_your_own_completed` (default 10, configurable on the same settings page). See `docs/modules/anywhere.md`.
