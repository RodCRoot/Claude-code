# CRM, shared inbox, templates, automations & job worker

Owner module for leads, family messaging, message delivery, automations and the background job worker.

## Routes

| Route | Who | What |
|---|---|---|
| `/inquire` (+ `/inquire/thanks`) | public | Assessment inquiry form. Honeypot (`website`), per-IP rate limit (5/hour, hashed IP stored on the lead), server validation (zod), consent checkboxes. `?org=<slug>` selects the org; otherwise the first org (single-tenant deploy). |
| `/people/leads` | `crm.manage` | Board / List / Pipeline stages (CRUD, reorder). Filters: search, stage, owner, source, tag, age range. |
| `/people/leads/new` | `crm.manage` | Staff-entered lead (walk-in, phone…), same intake path as the public form. |
| `/people/leads/[id]` | `crm.manage` | Inquiry + consent, notes, tasks, stage/lost reason, owner, log contact, schedule assessment, tags, conversations with the lead contact, audit history, duplicate review. |
| `/people/leads/[id]/convert` | `crm.manage` + `people.manage` | Review screen: athlete + guardian (link existing vs create new when duplicates exist — required), household, payer. |
| `/messages` | staff with `messages.inbox` / families | Staff: shared inbox (all / mine / unassigned, open/closed, kind, athlete, subject search, unread). Families: their own threads only. |
| `/messages/[threadId]` | per thread access | History, delivery status per recipient/channel (staff), internal notes (staff), assignment, close/reopen, reply. |
| `/messages/new` | staff / families | Staff: choose athlete → see routed recipients and exclusions → compose (separate per recipient by default, or group). Families: message staff about an athlete they hold `messages.send` for. |
| `/messages/templates`, `/messages/templates/[id\|new]` | `crm.manage` | Template CRUD with `{{variables}}`, SAMPLE flag, example render. |
| `/messages/automations`, `/messages/automations/[id\|new]` | `crm.manage` | Rule CRUD (created disabled), enable/disable, preview against sample records (who receives what on which channel — no writes), audit history, "Run scan now". |
| `/messages/outbox` | `settings.manage` | All jobs; dead/failed with Retry, pending with Cancel. |

## Domain code (`src/lib`)

- `crm/intake.ts` — `createLeadFromInquiry(tx, orgId, input, meta)`: people (status `lead`), lead (stage `new`), consent rows (source + timestamp; unchecked = `unknown`), follow-up task for the owner (`settings.crm.defaultLeadOwnerUserId` → first operations user → owner), possible-duplicate flag (email or phone match — never merged), `automation.evaluate` (lead_created).
- `crm/leads.ts`, `crm/stages.ts` — pipeline, filters, stage changes (Lost requires reason; Won only via conversion), notes, tasks, contact log, assessment scheduling (reads `schedule_sessions` whose service type kind is `assessment`), tags, duplicate review.
- `crm/convert.ts` — `conversionPreview` / `convertLead`. Duplicate candidates (email/phone/name) require `link:<personId>` or `new`. Linking archives the intake-created record with `linkedToPersonId` (kept, not merged) and copies consent only where the existing person has none. Creates/reuses athlete, active guardianship, household, payer account + authorization + beneficiary; sets `converted_at`; enqueues `crm.lead_converted`.
- `messaging/threads.ts` — access rules, lists with unread counts (`thread_participants.last_read_at`), start/post/assign/close, internal notes, client mutation ids (namespaced by user), `systemSend` for automations.
- `messaging/routing.ts` — minors → each active guardian with `canMessageStaff` (independently); the minor only if `settings.messaging.minorAthletesMayMessage`; adults → themselves. Missing DOB + guardians = treated as minor.
- `messaging/delivery.ts` — one `message_deliveries` row per recipient per channel. In-app always `delivered`. Email: suppressed if opted out / no address. SMS: requires `opted_in`. Quiet hours (per-person on the channel's `comm_preferences` row, else org `settings.quietHours`) defer the `messaging.deliver` job to the end of the window in facility time (DST-safe). Consent is re-checked at send time.
- `messaging/channels/{email,sms}.ts` — adapters. `not_configured` unless provider vars are set **and** `DELIVERY_ENABLED=true`. Email: Postmark or SendGrid HTTP APIs; SMS: Twilio. With `DELIVERY_TEST_RECIPIENTS` every send goes to the first email / phone in that list and the row is `test_redirected` (original address kept on the row).
- `messaging/outbox.ts` — Outbox listing, retry (resets attempts, re-queues failed delivery), cancel.
- `automation/templates.ts`, `automation/rules.ts`, `automation/engine.ts` — render, CRUD, trigger evaluation, dispatch, preview, session notices.

## Jobs (`src/lib/jobs-registry.ts`)

Run the worker: `pnpm jobs:work` (loop) or `pnpm jobs:work --once` (cron; exit 2 if any job died). Each pass re-queues jobs stuck in `running` > 15 min and enqueues an hourly `automation.evaluate` scan per org.

| Type | Payload | Enqueued by |
|---|---|---|
| `notify.session_cancelled` | `{ sessionId, version? }` | Schedule, when a session is cancelled. dedupeKey suggestion: `notify.session_cancelled:${sessionId}` |
| `notify.session_changed` | `{ sessionId, version }` | Schedule, when time/coach/location changes. dedupeKey: `notify.session_changed:${sessionId}:${version}` |
| `automation.evaluate` | `{ orgId, trigger?, sessionId?, leadId?, athleteId?, formRequestId?, paymentAttemptId?, membershipId? }` | Anyone (Forms after a request is created, Billing after a failed attempt, …), the worker's hourly scan, "Run scan now". |
| `automation.dispatch` | internal | `automation.evaluate` (dedupeKey `auto:<rule>:<entityType>:<entityId>:<recipient>:<period>`) |
| `messaging.deliver` | `{ deliveryId }` | messaging (one per external delivery) |
| `crm.lead_converted` | `{ orgId, leadId, athleteId, guardianPersonId, payerAccountId, convertedBy }` | lead conversion → creates an onboarding task |

Example from another module (inside the business transaction):

```ts
import { enqueue } from "@/lib/jobs";
await enqueue(tx, { type: "notify.session_cancelled", orgId, payload: { sessionId }, dedupeKey: `notify.session_cancelled:${sessionId}` });
```

When no `session_cancelled`/`session_changed` rule is enabled, the notify handlers still send a plain **in-app** notice (never email/SMS) to each routed recipient of each booked athlete, deduped per session/version/recipient.

### Triggers

`session_changed`, `session_cancelled`, `assessment_completed` (event: session id), `lead_created` (event: lead id), and scans: `form_missing` (form_requests pending ≥ N days), `payment_failed` (payment_attempts failed in last N days, invoice not paid/void → people authorized on the payer account), `renewal_upcoming` (active membership end/next bill within N days → payer-authorized people), `attendance_lapsed` (last attended ≥ N days ago, within 120 days, no upcoming booking). Conditions: days, sport, service kind. Optional task creation (deduped per rule/entity/period). Delayed rules re-check that the situation still applies at dispatch time.

## Settings (organizations.settings)

- `quietHours: { start: "21:00", end: "07:30" }` — facility quiet hours (local time).
- `messaging.minorAthletesMayMessage: boolean` — default false.
- `crm.defaultLeadOwnerUserId: uuid` — default lead owner (seeded to Erin).

## Provider configuration

Email: `EMAIL_PROVIDER=postmark|sendgrid`, `EMAIL_API_KEY`, `EMAIL_FROM`. SMS: `SMS_PROVIDER=twilio`, `SMS_ACCOUNT_SID`, `SMS_AUTH_TOKEN`, `SMS_FROM`. Plus `DELIVERY_ENABLED=true`. Use `DELIVERY_TEST_RECIPIENTS=qa@example.com,+15555550123` for staging. `EMAIL_PROVIDER=smtp` is accepted by env validation but has no transport, so it reports not configured. Provider webhooks (bounces, STOP replies, delivery receipts) are not wired yet: `sent` means the provider accepted the message.

## Known gaps vs PushPress Grow / Zen Planner

- No inbound email/SMS (replies by email/text don't thread back); no provider webhooks for bounces / STOP keywords — opt-outs are recorded by staff or via preferences.
- No bulk/broadcast campaigns or segment builder (automations + per-athlete messages only); no drip sequences with multiple steps per rule.
- No lead-capture embeds/landing-page builder beyond `/inquire`; no lead scoring, no SMS two-way chat UI, no attachments in messages.
- Families can't edit their own communication preferences / quiet hours yet (rows exist; UI belongs in the family profile).
- Assessment scheduling links a lead to a session but does not create a booking (leads are not athletes until conversion).
