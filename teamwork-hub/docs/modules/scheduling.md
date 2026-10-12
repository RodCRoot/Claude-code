# Scheduling, booking, attendance, kiosk & calendar sync

Owner paths: `src/lib/scheduling/**`, `src/lib/calendar/**`, `src/app/(app)/schedule/**`, `src/app/kiosk/**`,
`scripts/seed/scheduling.ts`, `tests/scheduling*.ts`.

## Domain API (`@/lib/scheduling`)

Every mutation is a plain function `(tx, viewer, input)` and must run inside `db.transaction()`.

| Function | What it does |
|---|---|
| `bookSession` | Locks the session row `FOR UPDATE`; re-checks status, family booking window/cutoff (org settings `bookingWindowDays`, `familyBookingCutoffMinutes`; unset = no limit), duplicate, eligibility, capacity → `booked` or `waitlisted` (positions), entitlement, idempotency key. |
| `cancelBooking` | `mode: auto` (policy by time) / `late` (staff) / `waive` (staff, reason). Settles credits (release / forfeit), records fee penalties as a billing task, then promotes the waitlist in the same transaction. |
| `markAttendance` | `attended` → consume; `no_show` → policy (forfeit / release / release + fee task). Staff corrections between the two keep the ledger consistent. Kiosk may only check in. |
| `promoteWaitlist` | Fills open spots in order; re-checks eligibility and reserves credits; candidates that can't be charged are skipped (stay waitlisted) with an audit event `booking.waitlist_skipped`. Enqueues `notify.waitlist_promoted`. |
| `rescheduleBooking` | Atomic cancel + book (`rescheduled_from_booking_id`); both sessions locked in id order. Policy applies to the cancel unless staff waive. |
| `restoreBookingCredit` | Staff override (schedule.manage, reason) → `restoreCredit`. |
| `generateSeriesSessions` / `seriesOccurrences` | Weekly series → sessions in facility local time (each date converted independently, so 6:00 AM stays 6:00 AM across DST). Idempotent on `(series_id, starts_at)`. |
| `createSession`, `updateSession`, `substituteCoach`, `cancelSession` | One-off sessions; optimistic `version`; substitution keeps `original_coach_user_id`; session cancel releases all credits and enqueues `notify.session_cancelled` (dedupe `notify.session_cancelled:<sessionId>`). |
| `findAvailableSlots`, `bookPrivateSlot` | coach_availability − sessions (with both sides' buffers) − busy_blocks − exclusive-resource sessions. Families may book only offered slots of `public_bookable` services. |
| `checkEligibility`, `resolveEntitlement` | Reusable by other modules (e.g. POS / billing previews). |
| `attendanceHistory` + `AttendanceHistoryPanel` (`@/lib/scheduling/components/attendance-history`) | Per-athlete history, counts, attendance rate, milestones 10/25/50/100/250/500. Enforces `profile.read`. |
| `kioskRoster`, `kioskCheckIn` | Today's sessions; athletes as "First L." plus kiosk-flagged alert text only. |

### Authorization
- `schedule.manage` (owner/admin/operations): everything.
- Coaches: roster/attendance/add-athlete on **their own** sessions, athletes in their scope only; their own availability/time off.
- Guardians/athletes: need `booking.create` on that athlete (guardianship `can_book`). Casey (no `can_book`) sees Leo's schedule read-only.
- Kiosk: `schedule.checkin`, today only, check-in only. Exiting kiosk mode requires a staff login of the same org.

### Entitlement order
1. Service doesn't require one (`eligibility.requiresEntitlement === false` or `credit_cost = 0`) → free.
2. Staff comp (reason required) → `entitlement_source = comp`.
3. Active/trialing membership on an `unlimited` product version covering the service on that date, not on hold → `unlimited`.
4. Credits: `reserveCredits` (soonest-expiring eligible bucket, row-locked).
5. Otherwise: families get "needs an active membership or available session credits"; staff are told to comp or sell a package.

### Policies & fees
Cancellation policies are fully configurable (Settings → Cancellation policies). The seed policy is labeled **SAMPLE** and is not an approved Teamwork policy. Billing is a separate module, so a `fee` penalty creates an open task (`related_type = 'booking_fee'`, `dedupe_key = sched-fee:<bookingId>`) describing the amount; billing turns it into a charge or waives it.

### Concurrency guarantees
- Session row lock serializes capacity and waitlist decisions (test: 10 concurrent bookings into capacity 1 → 1 booked, 3 waitlisted, 6 rejected, ledger verified).
- Partial unique index `bookings_live_uq` prevents double booking; `bookings_idem_uq` backs idempotency keys.
- Exclusion constraints reject overlapping exclusive-coach / exclusive-room sessions (Postgres `23P01` → `ScheduleConflictError`). Private-slot booking also takes a per-coach advisory lock.

## Google Calendar (`@/lib/calendar`)
- **Source of truth: Teamwork.** Google receives copies of a coach's sessions; nothing is read back from event bodies.
- `queueCalendarSync(tx, sessionId)` runs in the business transaction (create/update/substitute/cancel/generate): upserts `calendar_event_links` as `pending` and enqueues `calendar.sync_session` (dedupe per connection/session/version/status).
- `calendarJobHandlers(tx, factory)` → push (POST), update (PUT with `If-Match` etag) or delete (DELETE; 404/410 = already gone). **Conflict handling:** a 412 (event edited in Google) is resolved by overwriting with Teamwork's version and noting it on the link.
- **Retries:** 429/5xx/network errors throw → job queue exponential backoff (`maxAttempts` 8) and the link records `attempts`/`last_error`; permanent 4xx errors stop and mark the link `error`.
- **Free/busy:** `syncFreeBusy` → `importFreeBusy` replaces `busy_blocks(source='google_freebusy')` inside the window; the slot finder subtracts them.
- **Not configured:** without `GOOGLE_CLIENT_ID/SECRET` (and a per-coach token store, not yet built) the default provider factory returns `null`; jobs complete with link status `error: not configured` and no retry storm. Settings → Calendar sync shows `<NotConfigured>`. Internal scheduling is unaffected.
- Follow-up needed for live sync: OAuth consent route + encrypted refresh-token storage per `calendar_connections` row (small additive schema change), and registering `calendarJobHandlers` in the worker (`scripts/worker.ts` does not exist yet).

## Jobs emitted (for other modules)
| Type | Payload | Dedupe key |
|---|---|---|
| `notify.session_cancelled` | `{ sessionId, reason, bookingIds, athleteIds }` | `notify.session_cancelled:<sessionId>` |
| `notify.waitlist_promoted` | `{ bookingId, sessionId, athleteId }` | `notify.waitlist_promoted:<bookingId>` |
| `calendar.sync_session` | `{ connectionId, sessionId }` | handled here |
| `calendar.import_freebusy` | `{ connectionId, from, to }` | handled here |

## Seed
Resources (Turf, Weight Room, Assessment Room — exclusive), a SAMPLE policy, four services, five weekly series (Marcus HS 6 AM M/W/F and Tu/Th 4:30 PM; Tess Youth Tu/Th 5:30 PM and Sat 9 AM; a sample Speed Camp), sessions from today−28 to today+21, an evening session today for the kiosk, a full class with a waitlist, a staff-cancelled session, private sessions and a comped assessment, ~290 bookings with attendance history (no-shows, late cancels) on a consistent credit ledger, coach availability and time off. Ethan, Sofia, Liam, Harper and Ava are left without credits/bookings (ledger tests rely on clean slates; Ava demonstrates the "needs credits" path).
