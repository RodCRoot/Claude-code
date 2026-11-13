# Session check-ins (ready check and after check)

A short questionnaire before and after every in-gym session, tracked over time for the athlete, the parent and the coach. Code in `src/lib/checkins/*.ts`, schema in `src/db/schema/checkins.ts`, pages under `src/app/(app)/check-ins/**`, components in `src/components/checkins/**`, tests in `tests/checkins.test.ts`, browser test `e2e/checkins.spec.ts`, seed `scripts/seed/checkins.ts`.

**Nothing in this module sends a message to anyone.** Alerts are rows in the staff `tasks` table. The answers are self-reported; the app never diagnoses and never clears anyone to train.

Ideas were taken from the feature list of TeamBuildr's sports science suite as recorded in `docs/modules/sports-science.md` §1 (readiness and wellness questionnaire, body heat map, load monitoring). No TeamBuildr wording, layout, formula or asset is used; every calculation here is a named Teamwork calculation.

| Screen | Path | Who |
|---|---|---|
| Ready check | `/check-ins/[bookingId]/ready` | the athlete; a parent with health access, for an athlete under 13 |
| After check | `/check-ins/[bookingId]/after` (the old `/feedback/[bookingId]` redirects here) | the athlete; a parent, for the parts they may answer (below) |
| My check-ins: what is open, and trends | `/check-ins` (athlete / parent) | athlete, guardian |
| Session check-ins: alerts, class view | `/check-ins` (staff) | owner, admin, operations; coaches see their own classes |
| One athlete's trends | `/check-ins/athletes?id=…` | staff with the athlete in scope |
| One response | `/check-ins/responses/[id]` | staff, cut down to what they may see |
| Readiness strip, planned intensity | card "Readiness" on `/schedule/sessions/[id]` | staff |
| Alerts | card on `/follow-ups` and on `/check-ins` | staff, per alert |
| Kiosk ready check | `/kiosk`, right after a PIN check-in | the athlete whose PIN matched |
| Settings | Settings → Session check-ins (`/settings/check-ins`) | owner, admin |
| Report with CSV | `/reports/session-checkins` | owner, admin; a coach for their own sessions |
| Cards "Session check-ins" | Athlete Home (`/today`), family schedule, My Reservations | athlete, guardian |

## The questions (question set 1.1)

Wording lives in one file, `src/lib/checkins/questions.ts`, and is shown word for word at the bottom of the settings page. It is written for a 10 year old and an adult alike.

**Ready check** (opens 4 hours before the session by default, closes 15 minutes after it starts):

1. **How ready do you feel today?** Five faces: Not ready / A bit off / OK / Good / Ready to go. Required.
2. **How did you sleep last night?** 1 Very poor / 2 Poor / 3 OK / 4 Good / 5 Excellent. Required unless already answered in today's wellness.
3. **About how many hours did you sleep?** Optional number. Can be turned off.
4. **How sore are your muscles right now?** Slider 0 Not sore … 5 Sore … 10 Worst ever. Required. An untouched slider is an unanswered question, never a 0.
5. **Does anything hurt today?** No, all good / Something hurts. If yes: **Where? Tap the spot.** (the existing body figure, or two selects) · **What does it feel like?** Achy or tight (dull, like sore muscles) / Sharp pain (sudden, stabbing or pinching) · **How much does it bother you?** A little / Quite a bit / A lot. Soreness at or above 6 (configurable) adds a nudge to show where.
6. **How tired do you feel?** 1 Fresh / Pretty good / A bit tired / Tired / 5 Exhausted. Can be turned off.
7. **How is your mood?** 1 Low / Meh / OK / Good / 5 Great. Can be turned off.
8. **How stressed do you feel?** 1 Relaxed … 5 Very stressed. Off by default.
9. **How sore were you the day after your last session?** 0 to 10, optional, asked once per earlier session. Can be turned off.
10. **Anything your coach should know today?** Optional, 300 characters.

**After check** (opens when the session ends and the athlete was checked in):

1. **How hard was the session?** Session RPE 0 Rest / 1 Very easy / 2 Easy / 3 Moderate / 4 Somewhat hard / 5 to 6 Hard / 7 to 8 Very hard / 9 Almost max / 10 Max effort. Required for whoever may answer it.
2. **What did you like?** Chips (defaults: Lifting, Speed work, Jumps, Competing, My coach, My group, Learned something new, It was fun) plus optional text.
3. **Anything you did not like or want changed?** One tap "Nothing, it was good", or chips (defaults: Too hard, Too easy, Too crowded, Too much waiting, Did not understand something, Ran out of time) plus optional text. Hint: "Honest answers help us get better, and nobody gets in trouble."
4. **Did anything hurt or not feel great?** No / Yes, then the same where / feel / how much, plus **Did it start during this session?**
5. **How sore are you right now?** Slider 0 to 10, optional.
6. **Overall, how was the session?** The existing rating: 1 Poor / 2 Not great / 3 OK / 4 Good / 5 Great. Optional.
7. **Any other notes?** Optional.
8. Tick box: **Show my coach my name with my likes, dislikes and rating** (off unless ticked).

Picking "Sharp pain" shows, on the form and again after saving: "Sharp pain is worth speaking up about. Please tell your coach and a parent now. This app cannot tell you what is wrong or whether it is safe to train."

The chip lists are **defaults** an owner can edit; each default is labelled "Default" in Settings until changed.

## Where each answer is stored (nothing twice)

- `session_checkins`: one row per booking and phase (`pre` / `post`), unique on `(booking_id, phase)`, with `question_set_version` = wording version + the organization's revision (for example `1.3`). Chips are stored as `{key, label}` as they read when tapped, so editing the list never rewrites history. Unanswered is NULL, never 0 (a CHECK constraint holds every scale in range).
- **Rating**: stays in `session_feedback` (retention module), written through the existing `submitFeedback`. No rows were migrated because the table did not change: the rating history is continuous by construction, and the retention radar signal, the "Session feedback averages" report, the 24 hour edit rule and the low-rating task all keep working untouched.
- **Session RPE**: also writes ONE `activity_sessions` row (`source = 'session_checkin'`, minutes = the session's scheduled length), updated in place on a correction. That row is what Sports Science → Load already sums, so there is no second load number.
- **A marked body spot**: a `body_region_reports` row (existing body map storage) with `source_checkin_id`. "Achy or tight" is stored as the body map's `soreness`, "Sharp pain" as its `pain`; A little / Quite a bit / A lot are stored as severity 3 / 6 / 9 (`checkin_pain_level_v1`). A pain report creates the existing "Review a body-map self-report" task for the athlete's coach.
- **Planned intensity**: `schedule_sessions.intended_rpe` (optional, 0 to 10).
- **Kiosk passes**: `checkin_kiosk_passes` (SHA-256 of a single-use token, 3 minutes).

### One gym session, one load number

A workout finished in the workout logger carries its own RPE and minutes. Rule in `loadEntries` (`src/lib/science/load.ts`), applied when load is read: on a local day where a completed workout has a computable load, **the workout logger wins** and the check-in's load row is left out; where the workout has no computable load (no RPE or no minutes), **the check-in's load stands** and that workout is left out, so the day is neither doubled nor marked incomplete. The limit of this rule: two separate gym sessions on one day, one logged each way, count once.

## Who may answer

Decided in `writableSections` (`core.ts`) and re-checked on every submit:

| Who | Ready check | Effort (RPE) | Body (hurt, soreness) | Experience (likes, dislikes, rating, notes) |
|---|---|---|---|---|
| The athlete | yes | yes | yes | yes |
| Parent, athlete under 13, with health access | yes | yes | yes | yes, if they may book |
| Parent, athlete under 13, no health access (demo: Jordan for Eli) | no | yes | no | yes, if they may book |
| Parent, athlete 13 or older | no | no | no | yes, if they may book (the old feedback rule) |
| Parent who may not book (demo: Casey) | no | no | no | no |
| Staff | no | no | no | no |
| Kiosk | only with a pass for that athlete | no | no | no |

"Under 13 with training and booking access" is the existing `training.log_at_home` capability (the rule for finishing an at-home session). **Decision:** that capability is reused for the effort answer; the health answers additionally need `health.read`, because a parent who may not see health data should not be shown or asked health questions. A parent's answers are saved as logged by a parent (`logged_by_parent`, and `answered_by` records who answered each part and when).

Different people can answer different parts (the athlete at the gym, a parent at home). A part answered by one person is locked for everyone else; the person who answered can correct it while its window is open (the rating and experience part: 24 hours, as before).

**Windows.** Ready check: `preOpensHoursBefore` (default 4) before the start until 15 minutes after it. After check: effort and body for `postClosesHoursAfter` (default 48) after the end, because recall of effort fades; the experience part and rating for the retention setting `feedbackEntryDays` (default 14), as before. Windows are measured from the session's own start and end instants; "today's wellness" uses the facility-local date.

**Prefill.** If the athlete already did today's daily wellness, items that are the same item (same key; scales also the same 1 to 5 range: `sleep_quality`, `sleep_hours`, `fatigue`, `mood`, `stress`) are not asked again; the stored answer is used and listed in `prefilled`. Nothing is converted between scales: the wellness soreness (1 to 5) and readiness (1 to 10) never fill the check-in's 0 to 10 and 1 to 5 questions.

## Who sees what

| Data | Rule |
|---|---|
| Health answers: readiness, sleep, soreness, tiredness, mood, stress, pain, the ready-check note | `health.read` on the athlete. Operations and a guardian without health access never receive them (left out of the returned objects, not just hidden). |
| Effort: RPE, load | `training.read` |
| Experience: likes, dislikes, rating, notes | The family always sees its own. Owner, admin and operations see every response (`feedback.review`). A coach sees a named response only when the family ticked "show my coach" and it is their session or their athlete; otherwise class totals, and those only from the anonymity minimum (`anonymityMinResponses`, default 3). |

On the roster strip, a viewer without health access for an athlete sees "Ready check done" and, when there is a note, a pain answer or an alert, "Has a note for the coach". A coach running a class sees health details only for athletes assigned to them.

The readiness strip is on the session page only. It was deliberately **not** added to the weight-room board, which is a shared tablet that shows names and workouts only.

## Alerts

Created in the same transaction as the answer, deduplicated by task key, never containing an answer:

| Trigger | Task | Goes to |
|---|---|---|
| Sharp pain with a spot marked | the existing "Review a body-map self-report" (body map queue) | the athlete's coach |
| Something hurts, no spot marked (always the case at the kiosk) | "Review a session check-in" (`checkin_review:<id>`) | the athlete's coach, else the session's coach |
| Something hurt in this session and in the one before | same task | same |
| Soreness at least `sorenessAboveBaseline` (default 3) above the athlete's own baseline | same task | same |
| Readiness at least `readinessBelowBaseline` (default 1.5) below the athlete's own baseline | same task | same |
| A "did not like" comment | "Follow up on session feedback" (`checkin_dislike:<id>`) | the session's coach if shared with the coach, otherwise the first owner login and not linked to the athlete (same routing as a low rating) |
| Rating at or below the retention threshold | the existing low-rating task | as before |

They appear in the card "Session check-ins to look at" on the follow-ups queue (`/follow-ups`) and on `/check-ins`; "Mark as reviewed" (needs `health.review`) or "Mark follow-up done" closes the task.

## Calculations (`src/lib/checkins/baseline.ts`)

| Key | Definition |
|---|---|
| `checkin_baseline_v1` | Mean of the athlete's earlier answers to the same question inside `baselineWindowDays` (default 42), not counting the answer being judged. Null until `baselineMinAnswers` (default 5) earlier answers exist; the UI then says "Not enough data yet". No fixed good or bad cutoff. |
| `checkin_deviation_v1` | An answer is flagged when it is at least the configured number of points on the unfavourable side of the baseline. No flag without a baseline. |
| `srpe_load_v1` | Reused from sports science: session minutes × session RPE. |
| `intensity_gap_v1` | Mean reported RPE minus the planned RPE, per session, averaged over sessions that have both. |
| `checkin_completion_v1` | Check-ins answered ÷ attended bookings. Null (not 0) when nothing was attended. |
| `soreness_response_v1` | Next-day soreness (asked in the following ready check) beside the load of the session it is about. A pairing, not a prediction. |
| `checkin_pain_level_v1` | A little / Quite a bit / A lot = 3 / 6 / 9 on the body map's 0 to 10 scale. |

## Recognition

Each ready check and each after check earns the existing check-in XP (kind `wellness_checkin`, default 5), once per booking and phase, through the existing derive-and-upsert ledger (`session_checkin:<bookingId>:<phase>`). Corrections, a second person completing a part and re-submissions earn nothing more. No new XP kind, so the kind CHECK constraint is unchanged.

## Kiosk

After a PIN matches, `issueKioskReadyPass` mints a single-use pass if that athlete has a session whose ready-check window is open and unanswered. The kiosk then shows four questions as big buttons (readiness, sleep, soreness 0 to 10, does anything hurt), a Skip button, and a countdown that returns to the PIN pad after 25 seconds without a tap. It never prefills and never receives earlier answers; the panel's state is discarded when it closes. No free text and no body picture at the kiosk: "Something hurts" there becomes a coach alert without a location.

## Exported functions for dashboards

| Function | Returns |
|---|---|
| `checkinCompletionSummary(tx, orgId, {from, to, tz})` (`views.ts`) | attended, ready, after, and both rates. No names. |
| `checkinInsights(tx, orgId, scope, opts)` | per class slot or per coach: completion, mean RPE, planned RPE, gap, rating, chip counts |
| `openCheckinAlerts(tx, viewer)` | open alerts the viewer may act on |
| `sessionReadiness(tx, viewer, sessionId)` | the roster strip |
| `athleteCheckinTrends(tx, viewer, athleteId)` | history shaped by the viewer's access |
| `pendingCheckins(tx, viewer)` | what a family member can answer now |

## Assumptions to confirm

- "Show my coach my name…" is **off** unless ticked, the same default the old feedback form had. Coaches therefore read few named comments; flipping the default is a one-line change but changes a privacy promise families were given.
- Staff cannot enter a check-in for an athlete (for example a coach asking a 10 year old out loud).
- Next-day soreness is asked about the most recent attended session within 10 days, and not when it was earlier the same day.
- The ready check closes 15 minutes after the session starts (fixed), not at the end of the session.

## Not done

- No line in the monthly recap: recap snapshots are frozen under `tw_recap_v1` with an allow-list, so adding a field needs a new snapshot version.
- No reminders or push prompts: the after check is offered on Athlete Home, the schedule and My Reservations once attendance is recorded and the session has ended.
- The demo seed is opt-in history (`HISTORY_SEEDS`), so the default test seed has no check-ins.

## Demo data

`pnpm db:fresh` adds about eight weeks of synthetic ready checks and after checks for the demo athletes with attended bookings (Maya, Eli, Leo, Dana), a planned intensity on those sessions, one baseline alert (Maya) and one "did not like" follow-up (Dana). Eli's latest session is left without an after check so a parent login has one to answer. All rows are invented and flagged `is_demo`; sample notes end in "(sample)".
