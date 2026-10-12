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
- **Not configured:** without `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and a valid `CALENDAR_TOKEN_KEY` (or before a coach connects) the default provider factory returns `null`; jobs complete with link status `error: not configured` and no retry storm. Settings shows `<NotConfigured>` naming the missing variables. Internal scheduling is unaffected.
- Idempotent delivery: a job for a link that is already `synced` at the session's current version (or already `deleted`) is a no-op.
- Handlers are registered in `src/lib/jobs-registry.ts` (worker: `pnpm jobs:work`).

### OAuth connect flow (per coach)
Files: `src/lib/calendar/oauth.ts` (protocol), `crypto.ts` (encryption), `tokens.ts` (storage, refresh, disconnect, provider factory), `connect.ts` (callback completion), routes `src/app/api/calendar/google/{start,callback}/route.ts`, action `src/app/(app)/schedule/settings/calendar-actions.ts`. UI: Schedule → Settings → Availability → “My Google Calendar” (every staff member); managers also see all connections under Settings → Calendar sync.

1. `GET /api/calendar/google/start` — staff only (owner/admin/operations/coach). Always for the **signed-in** user; no user id is accepted. Sets an httpOnly, `SameSite=Lax`, 10-minute cookie `tw_gcal_oauth` (path = callback) holding a random nonce, then redirects to Google with `access_type=offline`, `prompt=consent`, PKCE `S256`, and a `state` = base64url(JSON `{user, org, nonce, exp}`) + HMAC-SHA256 (key HKDF-derived from `SESSION_SECRET`).
2. `GET /api/calendar/google/callback` — verifies the state signature (constant-time), expiry, that it belongs to the **current** user + org, and that its nonce equals the cookie's (same browser). Only then is the code exchanged server-side (`client_secret` + PKCE verifier, derived from the nonce with the server key, never sent to the browser). The cookie is consumed on every callback. Redirects back with a short result code only (`?calendar=connected|denied|expired|invalid_state|…`).
3. On success: the coach's dedicated **“Teamwork Hub”** secondary calendar is created (or reused if it still exists; if it was deleted, a new one is created and old links reset), tokens are encrypted and stored, the connection becomes `connected`, upcoming sessions (60 days) are queued for push and a free/busy import (28 days) is queued.
4. **Scopes (minimal):** `calendar.app.created` (create the Teamwork calendar and manage events *only on calendars this app created*) and `calendar.freebusy` (busy/free only, no event details; queried on the coach's `primary` calendar). Granular consent is honored: only push → `sync_direction=push_events`; only free/busy → `freebusy_only`; neither → nothing stored.
5. **Disconnect** (`disconnectCalendar`): a coach may disconnect only their own connection; owner/admin (`integrations.manage`) may disconnect anyone's (operations cannot). The refresh token is revoked at Google (`POST https://oauth2.googleapis.com/revoke`), then the token row is deleted and the connection set `disabled` — local deletion happens even if Google can't be reached (audit + UI tell the coach to remove access under Google Account → Security → Third-party access). The “Teamwork Hub” calendar stays in the coach's Google account; they may delete it.

### Token storage
- Table `calendar_oauth_tokens` (migration `0004_cal_tokens`), one row per connection, separate from `calendar_connections` so status/UI queries can never select a token. Columns: `refresh_token_enc`, `access_token_enc`, `access_token_expires_at`, granted `scopes`, `refreshed_at`.
- AES-256-GCM, random 96-bit IV per value, format `v1.<iv>.<ciphertext>.<tag>`; key = HKDF-SHA256(`CALENDAR_TOKEN_KEY`). The connection id is the GCM additional authenticated data, so tampered bytes or a ciphertext copied to another row fail authentication.
- `CALENDAR_TOKEN_KEY` = 32 random bytes, base64 (`openssl rand -base64 32`). Changing it makes stored tokens unreadable → each connection is marked `error` (“reconnect”) on next use; no crash.
- `getAccessToken` returns the cached access token if it has > 60 s left, else refreshes (`grant_type=refresh_token`, token row locked `FOR UPDATE` when called inside a transaction). A `refresh_token` in the response replaces the stored one (rotation). `invalid_grant`/401 → connection `error` with “Google Calendar access was revoked or expired… reconnect”, grant deleted, audit `calendar.token_refresh_failed`, non-retryable. Network/5xx → retryable, connection untouched. A Calendar API 401 drops the cached access token so the retry refreshes.
- Tokens are never logged, returned to the client, put in audit summaries/before/after, job payloads or redirect URLs; token-endpoint errors surface only Google's error code. Audit events: `calendar.connected`, `calendar.disconnected`, `calendar.token_refresh_failed`.

### Google Cloud console setup (one-time)
1. Google Cloud console → create/select a project → **APIs & Services → Library** → enable **Google Calendar API**.
2. **Google Auth Platform → Branding / Audience (OAuth consent screen)**: app name “Teamwork Hub”, support email, authorized domain = the production domain. User type **Internal** if every coach uses a Teamwork Google Workspace account (no verification needed); otherwise **External** — while in *Testing*, add each coach as a test user (refresh tokens for Testing apps expire after 7 days), then publish; `calendar.app.created` / `calendar.freebusy` may require Google verification for External production apps.
3. **Data access (scopes)**: add `https://www.googleapis.com/auth/calendar.app.created` and `https://www.googleapis.com/auth/calendar.freebusy`.
4. **Clients → Create client → Web application**. Authorized redirect URI: `${APP_URL}/api/calendar/google/callback` (exact match, e.g. `https://hub.example.com/api/calendar/google/callback`; add `http://localhost:3000/api/calendar/google/callback` for local testing).
5. Set on the server: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CALENDAR_TOKEN_KEY` (`openssl rand -base64 32`), and make sure `APP_URL` is the public origin. Restart, then Settings → Integrations → Re-check.

### Reference docs (checked 2026-10-12)
- OAuth 2.0 for web server apps: https://developers.google.com/identity/protocols/oauth2/web-server
- PKCE (supported by Google's authorization server): https://developers.google.com/identity/protocols/oauth2/native-app
- Calendar API scopes: https://developers.google.com/workspace/calendar/api/auth
- `calendars.insert` (scope `calendar.app.created`): https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert
- `events.insert` (accepts `calendar.app.created`): https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- `freebusy.query` (accepts `calendar.freebusy`): https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query

## Jobs emitted (for other modules)
| Type | Payload | Dedupe key |
|---|---|---|
| `notify.session_cancelled` | `{ sessionId, reason, bookingIds, athleteIds }` | `notify.session_cancelled:<sessionId>` |
| `notify.waitlist_promoted` | `{ bookingId, sessionId, athleteId }` | `notify.waitlist_promoted:<bookingId>` |
| `calendar.sync_session` | `{ connectionId, sessionId }` | handled here |
| `calendar.import_freebusy` | `{ connectionId, from, to }` | handled here |

## Seed
Resources (Turf, Weight Room, Assessment Room — exclusive), a SAMPLE policy, four services, five weekly series (Marcus HS 6 AM M/W/F and Tu/Th 4:30 PM; Tess Youth Tu/Th 5:30 PM and Sat 9 AM; a sample Speed Camp), sessions from today−28 to today+21, an evening session today for the kiosk, a full class with a waitlist, a staff-cancelled session, private sessions and a comped assessment, ~290 bookings with attendance history (no-shows, late cancels) on a consistent credit ledger, coach availability and time off. Ethan, Sofia, Liam, Harper and Ava are left without credits/bookings (ledger tests rely on clean slates; Ava demonstrates the "needs credits" path).
