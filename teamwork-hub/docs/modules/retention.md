# Retention and session feedback

Staff-facing retention tools plus the athlete / parent feedback loop. Code lives in `src/lib/retention/*.ts`, schema in `src/db/schema/retention.ts`, tests in `tests/retention*.test.ts`.

Nothing in this module sends a message to a family. Every action is a staff task, a link, or a log entry.

No scheduled job: the radar, the winback list and milestones are worked out live from other tables on every view and store no score, so there is nothing for a nightly job to refresh (checked 2026-11; see `docs/modules/scheduled-jobs.md`).

| Screen | Path | Who |
|---|---|---|
| Retention radar | `/people/retention` (People → Retention) | owner, admin, operations; coaches see assigned athletes only |
| Winback list | `/people/retention/winback` | owner, admin, operations |
| One feedback response | `/people/retention/feedback/[id]` | owner, admin, operations; a coach only if "tell my coach" was ticked |
| Leave feedback | `/check-ins/[bookingId]/after` (old `/feedback/[bookingId]` links redirect there) and the "Session check-ins" card on Athlete Home and the family schedule | the athlete, or a guardian who may book for the athlete |
| Milestones this week | card on the staff dashboard (`/today`) | owner, admin, operations |
| Thresholds | Settings → "Retention radar thresholds" (`/settings#retention`) | owner, admin |
| Reports | `/reports/retention-saves`, `/reports/session-feedback` | see Reports below |

## Risk level

There is no score and no model. A member's level is decided by counting the signals below.

- **At risk**: any one **high-weight** signal, or `signalsForAtRisk` (default 2) signals of any weight together.
- **Watch**: exactly one watch-weight signal (fewer than `signalsForAtRisk`).
- **Low**: no signals.

"Active member" means an active athlete with a membership in status trialing, active, on hold or past due that has started. One row per athlete.

A member is **paused** when every live membership is on hold today. Attendance rules (no recent visit, attendance drop, nothing booked, onboarding) are not applied while paused, and time on hold never counts as absence.

## Signals

Every default is a **starting point** so the radar is useful on day one. None is an industry norm or a Teamwork policy. Tune them in Settings; they are stored in `organizations.settings.retention` and every save is audited.

| Signal (chip) | Weight | Rule | Setting (default) |
|---|---|---|---|
| No recent visit | high | Days since the last attended session (or since the last hold ended, or since joining if never attended) is at least the threshold. | `attendanceGapDays` in the **membership policy** (21) |
| Attendance drop | watch | Visits per week in the recent window are at least X% below the athlete's **own** rate in the baseline window immediately before it. Skipped if the baseline has too few visits or a hold touched either window. | `attendanceWindowDays` (28), `baselineWindowDays` (56), `attendanceDropPercent` (40), `minBaselineVisits` (4) |
| No-shows rising | watch | No-shows + late cancels are at least X% of resolved bookings in the window, there are at least N of them, and the rate is higher than in the same-length window before. | `noShowWindowDays` (28), `noShowRatePercent` (30), `noShowMinMisses` (2) |
| Nothing booked | watch | No booked or waitlisted session from today through the look-ahead. | `upcomingLookaheadDays` (14) |
| Payment failed / past due | high | A failed charge or payment attempt in the look-back with no successful payment after it, or an open membership invoice past its due date, or the membership is marked past due. | `failedPaymentLookbackDays` (60) |
| Card needs updating | watch | The payer's default card expires within X days or has expired. | `cardExpiryDays` (30) |
| Hold ending soon | watch | A family hold in effect today ends within X days. | `holdEndingDays` (14) |
| Restarted, not back yet | watch | A hold ended within X days and there is no attended session since. Replaces "No recent visit" for that period. | `holdRestartDays` (21) |
| Commitment ending | watch | `commitment_ends_on` is within X days. | `commitmentEndingDays` (45) |
| In Season term ending | watch | An In Season membership's end date, or the in-season pause on the regular plan, is within X days. | `inSeasonEndingDays` (21) |
| Open member request | watch | A confirmed member request (hold, pause, in-season, plan change, card, billing question, other) is still new or in progress. Unconfirmed keyword suggestions do not count. | none |
| Cancel requested | high | An open cancel request, or a cancellation date scheduled on a regular plan. (In Season plans are fixed-term and always carry an end date, so they do not count.) | none |
| Low session feedback | watch | A session rating at or below the low threshold, or a rating at or below the "negative comment" threshold that came with a comment, in the look-back. The comment text is never shown on the radar and is never analysed by a model. | `lowRatingThreshold` (2), `negativeCommentMaxRating` (3), `feedbackLookbackDays` (30) |
| Onboarding: few visits | watch | First membership started 14 to 90 days ago and visits so far are below the expected number at the latest checkpoint (day 30 / 60 / 90; before day 30 the day-30 number is prorated). The expectation is capped by the plan's weekly allowance. | `onboardingVisits30` (3), `onboardingVisits60` (6), `onboardingVisits90` (9) |
| Forms block booking | watch | A form that is required for booking is not completed (or has expired) for the athlete. | none |

Each chip is shown with its evidence in plain language, for example: "2 visits in the last 28 days (0.5/week) vs 16 in the 56 days before (2.0/week): down 75% (threshold 40%)."

### Other columns

- **Est. monthly value at risk**: the monthly-equivalent price of the athlete's highest-priced live plan after its discount, in integer minor units. It is an **estimate** of recurring revenue tied to the member, not a forecast and not collected revenue. The header "Monthly revenue at risk" sums it for at-risk members only. Prices come from the product version; nothing is invented.
- **Last contact**: the most recent of a staff-written message in a thread about the athlete (not internal notes, automations or campaigns), a task linked to the athlete, or a logged outcome. Phone calls and GoHighLevel conversations are not visible to the Hub.
- **Recommended next action**: chosen from the signals in a fixed order (cancel request → card → open request → feedback → attendance → hold restart → term ending → onboarding → forms → booking). It says "parent" when the athlete has an active guardian and "athlete" otherwise.
- **Buttons**: "Create follow-up task" (existing tasks table, assigned to you, one per athlete per day, with the evidence in the description), "Open conversation" (opens New message with the athlete selected; you write and send it yourself), "Log outcome".

## Save log

`retention_actions`: athlete, what staff did, outcome (`saved`, `still_at_risk`, `lost`), reason code (required for a loss, enforced by a database CHECK), notes, a snapshot of the level and signals at that moment, the value-at-risk estimate, staff member and timestamps. Every entry writes an audit event (`retention.outcome_log`).

## Session feedback

**Since the session check-ins module (`docs/modules/checkins.md`) the rating is asked inside the after check**, so an athlete is never asked twice. `/feedback/[bookingId]` redirects to `/check-ins/[bookingId]/after`, and the family card is now "Session check-ins". The rating is still stored in `session_feedback` through `submitFeedback`, so everything below (one response per booking, the 24 hour edit window, the entry window, coach anonymity, the low-rating task, the radar signal, the averages report) is unchanged. The old comment box maps to the after check's "Any other notes?".

After an attended session has ended, the athlete or a guardian can leave a 1 to 5 rating, an optional comment and an optional "tell my coach" tick.

- **Who**: an athlete for their own bookings; a guardian only for athletes they may book for (`booking.create` in `src/lib/authz/policy.ts`). Staff cannot leave feedback.
- **One response per booking** (unique index). The person who left it can change it for 24 hours. After that, and for anyone else on the account, it is locked.
- **Window**: families can rate a session for `feedbackEntryDays` (default 14) after it ends.
- **No messages**: there is no prompt, reminder or notification. The entry points are the card on the family schedule page and `/feedback/[bookingId]`.
- **Low ratings**: a rating at or below `lowRatingThreshold` (default 2) creates one staff task titled "Follow up on session feedback". The task never contains the comment, the rating or the athlete's name. If "tell my coach" was ticked it is assigned to the session's coach and linked to the athlete; otherwise it goes to the first owner login and is **not** linked to the athlete, so it cannot reveal who said what on a profile a coach can open. The response itself opens at `/people/retention/feedback/[id]` for roles allowed.

## Milestones this week

Computed for active members in the current facility-local week (Monday to Sunday, `America/Indiana/Indianapolis` by default):

- membership anniversaries (whole years since the athlete's first membership start; Feb 29 is observed on Feb 28 outside leap years);
- 25 / 50 / 100 / 250 sessions attended (reached this week, or 2 or fewer sessions away), using the local date of each session;
- birthday this week (no age is shown);
- first 30 days complete.

The only action is "Create shoutout task" (one per athlete and milestone). No automatic messages.

The member journey (`docs/modules/journey.md`) creates its "Recognise N visits" step with the same task key, so a milestone never has two tasks, and it extends the visit counts to 10, 500, 750 and 1000 on its own screens.

## Winback list

Athletes with no membership now whose most recent membership ended in the last 365 days, with the end reason (from the save log, else the cancellation reason, else the athlete record, else "Not recorded"), last plan and tenure. The only action is "Create follow-up task".

## Reports

Both use the existing reports page and CSV route.

- **Retention: saves, losses and churn** (`retention-saves`; owner, admin, operations).
  - Outcomes logged: save-log entries created in the range, by outcome, with the sum of their value-at-risk estimates.
  - Losses by reason: entries with outcome Lost, by reason code. "No outcome logged" = athletes who churned in the range with no Lost entry in the range.
  - Churn counts **athletes**: members at start = athletes with a membership on the From date that started before it; ended = of those, athletes with no membership at the end of the To date; churn = ended ÷ members at start. Shown overall, by tenure cohort (0–2, 3–5, 6–11, 12+ whole months from first membership start to the From date) and by the athlete's highest-priced plan on the From date.
  - Average tenure in whole months from first membership start: to the To date for current members, to the last membership end for athletes who churned in the range.
  - A membership ends on its end date, else its cancel date, else the day it was marked cancelled or expired. Pending memberships are ignored.
- **Session feedback averages** (`session-feedback`; owner, admin, and coaches for their own sessions): responses, average rating, low ratings, attended bookings and response rate by coach and by class for sessions that started in the range. No names and no comments.

## Privacy rules

1. **Health and wellness values never feed the risk level and never appear here.** The module reads memberships, holds, bookings, invoices / payments, payment-method expiry, member requests, session feedback, form completion status, messages (timestamps and sender only), and tasks. It does not read questionnaires, body-map reports, habits, wearables, test results, or the contents of any form. A test fails if the module's source references those tables.
2. **Coaches** see only assigned athletes (`accessibleAthleteIds`), never see payment signals, card details or dollar values, and their save-log entries store none.
3. **Who said what**: a coach sees feedback averages only, and only once an average has `anonymityMinResponses` (default 3) responses. A coach sees an individual rating and comment only when the family ticked "tell my coach" and it is their session or their assigned athlete. Feedback that was not shared is not a radar signal for a coach either. Owner, admin and operations can read individual responses so they can follow up.
4. **Birthdays** are shown to staff only, without age or year.
5. **Comments** are stored as written, shown only on the response page and the session page to roles allowed, never copied into tasks, audit summaries, radar evidence or reports.
6. Every query filters on the viewer's organization; ids from the client are re-checked in every action.

## Assumptions to confirm

- Operations can read individual feedback responses (so the front desk can follow up) but cannot open the averages report, which is limited to owner / admin and each coach's own sessions.
- Unshared low-rating follow-ups are assigned to the first owner login.
- Coaches can create follow-up tasks and log outcomes for their assigned athletes.
- "Negative comment" is a rule (a comment left with a rating of 3 or lower by default), not sentiment analysis.

## Demo data

`scripts/seed/retention.ts` adds synthetic members with invented names (one per signal, a healthy control, two ended members), an "Evening Performance Group" class history, feedback from the existing demo families (one low rating with its follow-up task), and two save-log entries. All rows are flagged `is_demo`.
