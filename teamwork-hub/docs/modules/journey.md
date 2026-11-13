# Member journey

Replaces the spreadsheets of checkboxes: an onboarding checklist per new member, scheduled check-in touchpoints, visit milestones, review and referral asks, a hold checklist, an offboarding checklist, a daily / weekly operations checklist and a per-coach weekly scorecard. Steps are created from real events and tick themselves off where the system already knows the answer.

Code in `src/lib/journey/*.ts`, schema in `src/db/schema/journey.ts`, tests in `tests/journey*.test.ts`, browser test `e2e/journey.spec.ts`, seed `scripts/seed/journey.ts`.

**Nothing in this module sends a message to anyone.** Steps that involve a message link to the normal compose page (`/messages/new?athlete=…`), which stays test-only without a provider. A step is finished by a staff member logging it or by a detectable event.

| Screen | Path | Who |
|---|---|---|
| Today's follow-ups (queue, no-shows, absent members) | `/follow-ups`, and a card on the staff and coach dashboards (`/today`) | owner, admin, operations; coaches for assigned athletes only, never billing steps |
| Journey panel | card "Member journey" on the staff person page (`/people/[personId]`) | same as above |
| Operations checklist | `/follow-ups/checklist` | all staff (tick); owner, admin edit the list |
| Coach weekly scorecard | `/follow-ups/scorecard` | coaches and operations see their own; owner, admin see every coach |
| Journey report | `/follow-ups/report` | owner, admin |
| Templates, timing, targets, checklist items | Settings → Member journey (`/settings/journey`) | owner, admin |
| Nightly job | Settings → Scheduled jobs, "Member journey" (`journey.sync.nightly`) | owner, admin |

Capabilities (in `src/lib/authz/policy.ts`): `journey.view` (all staff), `journey.billing_steps` (owner, admin, operations), `journey.report` (owner, admin), `ops_checklist.use` (all staff). Editing templates and the checklist list uses `settings.manage`.

## How it reuses what exists

- **Session check-in alerts.** The follow-ups page also mounts the card "Session check-ins to look at" (`CheckinAlertsCard`, `docs/modules/checkins.md`): open check-in alert tasks the viewer may act on. They are plain tasks (source `session_checkin`), not journey steps, so the journey report and scorecard do not count them.

- **Tasks.** A journey step IS a row in the existing `tasks` table (`source = 'journey'`): status, assignee, due time and completion live there. `journey_steps` (1:1, keyed by the task id) only adds what a plain task cannot hold: the checklist it belongs to, the auto-complete rule, the facility-local due date, snooze date, skip reason, outcome. Skip = the task is `cancelled` with a reason on the step. Journey tasks show on People → Tasks once they have an assignee; the generic "open tasks" list on the person page leaves them out because the journey panel shows them (and a coach must not see the billing ones there).
- **Milestones.** The "recognise this" step for N visits uses the same task dedupe key as "Create shoutout task" on Milestones this week (`milestone:<athleteId>:sessions:<N>`). Whichever comes first, there is one task: the journey adopts an existing shoutout task, and the card's button becomes a no-op. The step ticks itself when a coach shoutout is posted on or after the day the count was reached, so recognition goes through the existing shoutout → TV board → XP path. The journey adds 10, 500, 750 and 1000 to the counts the dashboard card lists; the card itself is unchanged.
- **Retention radar.** "Absent members" is the radar's own "No recent visit" signal (so members on hold are skipped and both screens agree). Review asks are held back using the radar's level and its payment signal.
- **Win-back list.** Completing "Win-back date set" creates a normal task for that date ("Winback outreach: …"), which the existing win-back list shows as the member's last task.
- **Notes.** Steps that record a conversation, and "Log a reach-out", write a staff note on the person (category `reach_out` or `check_in`, visibility "assigned coaches").
- **Settings.** Templates, timing numbers and scorecard targets are stored in `organizations.settings.journey`; every save is audited.

## Templates

Six checklists. Every step has a name, an owner role (Owner, Front desk, Coach), a due offset (days, weeks or calendar months; hold steps may count from the hold's start, midpoint or end), an optional auto-complete rule from the fixed list below, an "in use" switch and a "billing step" flag. Steps can be added. **Every default is a starting point and is labelled "Default" on the settings page until edited**; none is a Teamwork policy. Journeys already under way keep the steps they began with.

| Checklist | Starts when | Default steps (auto = ticks itself) |
|---|---|---|
| Onboarding | a membership or trial begins (within the last `backfillDays`) | welcome message sent (auto: staff wrote in Messages), documents signed (auto), payment method on file / autopay on (auto, billing), first session booked (auto), first session attended (auto), assigned coach set (auto), added to training program (auto), day-one call or message logged, next-day check-in logged, thank-you card sent, "bring a friend" ask made (links to the referral page) |
| Touchpoints | the start of the member's current stint | personal check-ins at 6 weeks, 6, 12, 18 and 24 months; a goal review at 12 weeks (links to the athlete's performance page, where staff manage goals). Each needs a short note |
| Visit milestones | a visit count is reached | "Recognise N visits" for 10, 25, 50, 100, 250, 500, 750, 1000 (auto: a shoutout is posted) |
| Review and referral asks | a positive moment (see below) | ask for a review (asked / reviewed / declined), ask for a referral (asked / referred / declined). No review site is contacted |
| Hold | a hold is recorded (running, or starting within the look-ahead) | reason recorded (auto), return date set (auto), "we miss you" check-in at the midpoint, return reminder 7 days before the end (auto: the existing `membership_restart_upcoming` automation ran for this hold) |
| Offboarding | a cancellation is processed (cancelled, or a cancel date is set, on a regular plan, and nothing else continues) | reason recorded (auto), save conversation logged, final bill settled (auto, billing), removed from training program and groups (auto), thank-you sent, exit survey answered, win-back date set |

### Auto-complete rules

| Rule | True when |
|---|---|
| A staff member wrote to the family in Messages | a staff-written message (not an internal note, automation or campaign) in a thread about the athlete since the journey began |
| Every requested form is signed | at least one form request is completed and none is pending |
| Payment method on file or autopay linked | the payer has an **active** saved payment method (see `payments-autopay.md`), or the membership has a provider subscription |
| A session is booked / was attended | a live booking / an attended booking for a session from two weeks before the journey start (a trial session before the start date counts) |
| An assigned coach is set | a current coach assignment, direct or through a group |
| Added to a training program | an active program assignment, direct or through a group |
| A coach shoutout was posted | a shoutout that is still posted, dated on or after the day the count was reached |
| The hold has a reason / a return date | the hold row has them |
| The restart reminder automation ran | a finished `automation.dispatch` job for this hold |
| A cancellation reason is recorded | the membership's cancel reason, or a "lost" entry with a reason in the save log |
| No open invoice is left on the membership | no invoice with status open for that membership |
| No active program and no group membership | both are gone |

An automatic tick is stamped with the time of the event when the system knows it (for example the session's start), has no "completed by", is marked "Ticked automatically", and writes an audit event (`journey.step_auto_complete`, actor system). Staff can still tick any step by hand.

Not automatic, and why: the **exit survey** is logged by staff with a note. The session-feedback machinery is one response per attended booking, so it does not fit a survey for someone who has left; no survey form is sent.

## Generation

`syncJourneys(tx, orgId, { today, now, athleteIds? })` in `src/lib/journey/sync.ts` is the only generator. It runs:

- nightly as `journey.sync.nightly` (registered in `src/lib/scheduled/jobs.ts`, one job per organization and local date, Run now on Settings → Scheduled jobs);
- when `/follow-ups` is opened and from its "Refresh now" button (whole organization);
- when a person page is opened (that athlete only).

So nothing waits for a worker (none is deployed yet).

**Idempotent.** Journeys are unique per `(org, anchor key)` (`onboarding:<membershipId>`, `hold:<holdId>`, `offboarding:<membershipId>`, `touchpoints:<membershipId>`, `visit_milestones:<athleteId>`, `review_referral:<athleteId>`), steps per `(journey, step key)`, tasks per `(org, dedupe key)`, and a pass holds a per-organization advisory lock. Running it twice, or three at once, creates nothing new (tested).

**No backlog.** Nothing whose date is more than `backfillDays` (default 30) in the past is generated, so a three-year member does not get an onboarding checklist or five overdue touchpoints on the first run. The cost: if nothing runs the generator for longer than that, steps that fell in the gap are never created and are not in the report.

**Stints.** Touchpoints count from the membership that began the member's current stint. A plan change is the same stint; coming back more than 30 days after the last membership ended starts a new one (onboarding again, touchpoints restart).

**Touchpoints are created `lookaheadDays` (default 14) before they are due.** Later ones are shown under "Upcoming touchpoints" on the profile panel, computed from the template and not stored.

**Closing.** If a hold is removed, or a cancellation is withdrawn, the checklist is closed and its open steps are cancelled with that reason. If a hold's dates change, its open steps follow. A one-off checklist is marked completed when no step is open; its completion time is when the last step was finished or skipped.

Coach-owned steps are assigned to the athlete's directly assigned coach when there is one; everything else starts unassigned.

## Dates, and what a hold does to touchpoints

All due dates are facility-local calendar dates (`journey_steps.due_on`); the task's `due_at` is the end of that local day. "Today" is the facility's date, not UTC. Months are calendar months clamped to the end of the month (Aug 31 + 6 months = Feb 28 or 29); weeks and days are plain day counts.

**Decision: touchpoints do not pause for a hold, but they are not asked for during one.** Tenure keeps counting through a hold, as membership anniversaries already do, so a 30-day hold does not push every later check-in out by 30 days. A check-in whose date falls inside a hold moves to `holdGraceDays` (default 7) after that hold ends, and moves back if the hold is removed; the original date is kept and shown ("Moved from … for a hold"). The hold checklist has its own mid-hold check-in. Onboarding dates do not move.

## Review and referral asks

Suggested **once per member**, when both are true: a positive moment in the last `positiveMomentDays` (default 14), meaning a visit milestone was reached or a 5-star session rating was left; and the member is not at risk on the retention radar and not past due (membership status, a failed payment, or an overdue invoice). If the member is at risk or past due at that moment nothing is created; if they recover while the moment is still recent the ask appears then. An ask that is already open is hidden from the queue for as long as the member is at risk or past due, and returns afterwards.

## Queue, panel and actions

- **Queue**: every open step due today or earlier that is not snoozed or held back, grouped by checklist, filterable by owner (me, unassigned, a role, a staff member), location (a membership or its product covers the location) and type. Beside it: yesterday's no-shows and absent members, each with "Log a reach-out".
- **Absent window**: at least `attendanceGapDays` from the membership policy (21) and at most `absentMaxDays` (default 60) without a visit, not counting time on hold.
- **Actions**: one-tap Done (a short form instead when the step records a conversation, an outcome or a date), skip with a reason (required), snooze 1 to 60 days (hides the step; the due date does not change, so it still counts as late), assign. Each action re-checks organization, coach scope and billing visibility on the server and writes an audit event (`journey.step_complete`, `journey.step_skip`, `journey.step_snooze`, `journey.step_assign`, `journey.reach_out_log`).
- **Coaches** see only steps for athletes assigned to them (directly or through a group) and never steps flagged billing. A billing step cannot be assigned to a coach; a step cannot be assigned to a coach who is not assigned to the athlete; a coach can only assign a step to themselves.

## Operations checklist

`ops_checklist_items` (section opening / closing / cleaning / weekly, label, order, optional location; no location = every location) and `ops_checklist_ticks` (item, local date, who). One tick per item per day; weekly items are stored on the Monday and ticked once per week. Staff can tick today or yesterday (a closing list is often finished after midnight). Only the person who ticked, or an owner or admin, can untick. The month grid shows daily items done out of the total per day, and weekly items per week. Kept small on purpose: no per-shift assignment, no photos, no history of list edits beyond the audit log. The month grid uses the items that are active now, so past days are not re-based when the list changes. An item for "every location" is ticked once for all locations. The sample starter list is invented wording and is only added when an owner or admin asks for it.

## Coach weekly scorecard

Week = Monday to Sunday, facility time. Computed, never stored:

| Number | How |
|---|---|
| Session utilisation | live bookings (booked, attended, no-show) ÷ capacity over the coach's non-cancelled sessions that started in the week |
| Client reach-outs logged | staff notes of category `reach_out` or `check_in` the coach wrote in the week |
| Client meetings / assessments held | the coach's sessions of service kind Assessment in the week with at least one attended booking |
| Touchpoints on time | touchpoint steps due in the week that are assigned to the coach or were completed by them: done on or before the due date ÷ all that were due (skipped ones excluded) |

A rate with nothing to divide by is shown as "—", not 0. Targets are organization-wide and editable (defaults 70%, 10, 3, 90%: starting points, not standards). The reflection (what went well, what is stuck, what help is needed) is stored in `coach_reflections`, one per coach per week; a coach writes only their own; owner and admin can read it; the text is not copied into the audit log.

## Reporting

`src/lib/journey/reports.ts`, by facility-local month, last six months:

- `onboardingCompletionByMonth(tx, orgId, { today, tz, months })`: started, completed, closed, in progress, completion rate, average days to complete, by the month onboarding started.
- `touchpointTimelinessByMonth(...)`: due, on time, done late, still overdue, skipped, on-time percent, by the month due.
- `milestoneRecognitionByMonth(...)`: reached, recognised, missed (skipped, or open after the due date), waiting, recognised percent, by the month due.
- `journeyCompletionReport(tx, viewer)`: the three together, limited to `journey.report`.

The three `...ByMonth` functions take an organization id and no viewer, so another page (for example the owner scoreboard being built separately at `/scoreboard`, which this module does not touch) can call them after its own permission check. `coachScorecards(tx, viewer, { weekStart })` is available the same way for owner and admin viewers.

## Assumptions to confirm

- "Absent in the retention module's actionable window" was read as the radar's "No recent visit" signal with an upper bound of 60 days (editable). There is no window by that name in the retention module.
- "The existing hold reminder" was read as the `membership_restart_upcoming` automation. If that rule is not enabled the return-reminder step simply stays open for staff.
- "Client meetings / assessments" counts sessions of kind Assessment only. Private sessions are not counted as meetings.
- Operations (front desk) can see and act on billing steps, cannot open the journey report, and sees only their own scorecard.
- The owner role label "Front desk" maps to the operations role. Owner role on a step is a label and a filter; it does not restrict who may tick the step beyond the scope rules above.
- A scheduled cancellation starts offboarding on the day it was scheduled (the first cancel event), not on the last day.
- "Final bill settled" is true as soon as no open invoice is attached to that membership, which can be immediately.
- Scorecard targets are the same for every coach.

## Not done

- No per-coach targets, no scorecard history export, no CSV for the journey report.
- No exit survey form sent to families; it is a staff-logged step.
- Template edits do not change journeys already under way, and there is no "add this new step to everyone" action.
- Location filter on the queue is by membership / product location scope; an athlete with no location scope matches every location.
- The dashboard card reads the queue without running the generator; the queue page and the person page run it.
- No worker is deployed, so the nightly job has only run in tests and through Run now.

## Demo data

`scripts/seed/journey.ts` adds eight synthetic members with invented names (brand new; nearly through onboarding with a no-show yesterday; a six-week check-in due in three days; one five days overdue; a tenth visit waiting to be recognised plus a 5-star rating; a 25th visit already recognised; on hold; cancellation scheduled), runs the real generator for those members only, ticks a few steps as staff, and adds a sample operations checklist with ticks and one coach reflection. Opening `/follow-ups` then generates for the rest of the demo organization.
