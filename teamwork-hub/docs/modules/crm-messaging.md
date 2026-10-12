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
| `/messages/preferences` | guardians, adult athletes | Own email/SMS consent (per channel) and personal quiet hours (or facility default), undeliverable-address notice, full change history. Minor athletes see a read-only notice (their guardians receive messages). |
| `/people/[id]` → Communication card | `crm.manage` | Current consent, quiet hours, undeliverable flags (clear), full consent history (source + timestamp + actor), "record a change the family told you about" (note required). |
| `/messages/segments`, `/messages/segments/[id\|new]` | `crm.manage` | Saved audiences with live counts. Builder: GET "Update count" shows matched athletes/leads, routed recipients and who was excluded; "Save" stores exactly the counted filters. |
| `/messages/campaigns`, `/messages/campaigns/[id\|new]` | `crm.manage` (approve: owner/admin) | Template + segment + channels + optional schedule. Live preview of the exact recipient list after routing, consent, undeliverable addresses and quiet hours (at the scheduled time). Draft → submit → approve/return → queued send; cancel; delivery report per channel/status with reasons; audit history. |
| `/messages/unmatched` | `crm.manage` | Staff-only queue of inbound email/SMS replies that couldn't be threaded; attach to a conversation or dismiss. "Handled" view lists auto-threaded and resolved items. |
| `POST /api/webhooks/messaging/[hook]` | provider (verified) | `postmark-events`, `postmark-inbound`, `sendgrid-events`, `sendgrid-inbound`, `twilio-sms`. See *Provider setup* below. |

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
- `messaging/preferences.ts` — `recordConsent` / `recordQuietHours` (the only writers of `comm_preferences` besides intake/convert, which log via `logConsentEvent`): upsert + append-only `comm_consent_events` row (source, detail, actor, timestamp) + audit. `canManageOwnPreferences` (guardians; athletes 18+ or with no active guardian), `myPreferences` / `updateMyPreferences` (own person only; SMS/email opt-in requires an address on file), `staffConsentView`, `staffRecordConsent` (note required), `clearUndeliverable`.
- `messaging/addresses.ts` — email/phone normalization (phones match on the last 10 digits) and the `undeliverable_addresses` lookup used by `planChannel`, `createDeliveries` and `deliverOne`.
- `messaging/segments.ts` — filter schema (audience athletes|leads; recipient role, group, sport, membership status incl. "no current membership", product, active/inactive, attended / not attended in last N days, missing form, lead stage, tag), `resolveSegment` (athletes → `routeForAthlete` → role filter → one entry per person, with athlete names for `{{athlete_first_name}}`; leads → lead contact), CRUD, `healthReason` / `assertFiltersAllowed`.
- `messaging/campaigns.ts` — create/update (edits return to draft), submit, approve/return (owner/admin), cancel (cancels the queued job), `previewCampaign`, `sendCampaign` (job body), `campaignReport`.
- `messaging/inbound.ts` — `webhookOrg`, `peopleByAddress`, `receiveInbound` (threading rules below), staff queue (`listInbound`, `attachInbound`, `dismissInbound`, `suggestedThreads`).
- `messaging/reply-token.ts` — `reply+<thread id + HMAC(SESSION_SECRET)>@EMAIL_INBOUND_DOMAIN` Reply-To on outbound email (only when the domain is set).
- `messaging/webhooks/{verify,adapters,ingest}.ts` — signature/credential checks, provider payload → normalized events, idempotent ingestion (`messaging_provider_events` unique on provider + event id).

### Consent rules (summary)

| Situation | In-app | Email | SMS |
|---|---|---|---|
| 1:1 staff message / automation | always | unless opted out | opted in only |
| Broadcast campaign | always | **opted in only** | opted in only |
| Address flagged undeliverable (hard bounce / complaint) | always | suppressed | suppressed |
| Quiet hours (personal window, else facility) | immediate | deferred to window end | deferred to window end |

Everything is re-checked when the delivery job runs (consent, campaign opt-in, undeliverable flag). A provider bounce for a message it had accepted turns that delivery from `sent` to `failed`.

### Campaign rules

- Only `crm.manage` staff create campaigns; only owner/admin approve. A SAMPLE template cannot be submitted or approved.
- Segments that filter on a **medical** form are health data: staff without health access (operations) can't preview, save, edit or campaign on them, and their list counts are hidden. "Any outstanding form" never includes medical forms.
- The send job re-resolves the segment at send time. Per-recipient dedupe: `campaign_recipients (campaign, person)` is unique and the message client id is `campaign:<id>:<person>`; a retried job never messages anyone twice. A guardian of several matching athletes gets one message ("Maya and Eli").
- Each recipient gets their own conversation (replies go to the shared inbox, never to other families).

### Inbound threading rules

1. Every webhook is scoped to one org: `?org=<slug>` on the URL, else the first org (single-tenant). Matching never crosses orgs.
2. Email with a valid reply token → that conversation, if the sender's address belongs to a non-staff participant who is still routed for the athlete. A valid token from anyone else → unmatched (never falls back).
3. Otherwise (SMS, or email without a token) → the most recent conversation in which we had a provider-accepted delivery (`sent`/`test_redirected`/`delivered`) to that person on that channel, with the same eligibility check.
4. Anything else → `inbound_messages` with status `unmatched` and a reason; staff attach (credited to the sender only if they are an eligible participant; otherwise prefixed with the raw address) or dismiss.
5. SMS keywords (STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT, START/YES/UNSTOP, HELP/INFO, or Twilio's `OptOutType`) update SMS consent for every person in the org with that number (`source = sms_keyword`) and are never threaded. HELP changes nothing.
6. Threaded replies create in-app copies for staff participants only. Nothing in the inbound path sends anything externally.

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
| `campaign.send` | `{ orgId, campaignId }` | campaign approval (dedupeKey `campaign.send:<id>`, runAt = schedule or now; cancelled with the campaign) |

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

Email: `EMAIL_PROVIDER=postmark|sendgrid`, `EMAIL_API_KEY`, `EMAIL_FROM`. SMS: `SMS_PROVIDER=twilio`, `SMS_ACCOUNT_SID`, `SMS_AUTH_TOKEN`, `SMS_FROM`. Plus `DELIVERY_ENABLED=true`. Use `DELIVERY_TEST_RECIPIENTS=qa@example.com,+15555550123` for staging. `EMAIL_PROVIDER=smtp` is accepted by env validation but has no transport, so it reports not configured. `sent` means the provider accepted the message (a later hard bounce turns it into `failed`). Delivery receipts (`delivered`) are not consumed yet.

### Provider setup (webhooks)

All endpoints are `POST {APP_URL}/api/webhooks/messaging/<hook>`; append `?org=<org slug>` if more than one organization exists. They are exempt from `STAGING_BASIC_AUTH_*` (they carry their own verification). Without the listed secret an endpoint answers 503 and records a `rejected` row in `messaging_provider_events` — nothing is applied. Bad signatures/credentials → 401, also recorded.

| Provider | Hook | What to configure at the provider | Verification env |
|---|---|---|---|
| Postmark | `postmark-events` | Server → Webhooks → add `https://hub:<EMAIL_WEBHOOK_SECRET>@<host>/api/webhooks/messaging/postmark-events`, events **Bounce** and **Spam Complaint** (others are acknowledged and ignored). | `EMAIL_WEBHOOK_SECRET` (HTTP Basic password, ≥16 chars; any username) |
| Postmark | `postmark-inbound` | Inbound stream → Webhook URL `https://hub:<secret>@<host>/api/webhooks/messaging/postmark-inbound`; point your inbound domain's MX at Postmark (or use the `…@inbound.postmarkapp.com` address with `+` hashes) and set `EMAIL_INBOUND_DOMAIN` to that domain so outbound mail carries `Reply-To: reply+<token>@domain`. | `EMAIL_WEBHOOK_SECRET` |
| SendGrid | `sendgrid-events` | Mail Settings → Event Webhook → URL `…/sendgrid-events`, events **Bounced** and **Spam Reports**; enable **Signed Event Webhook** and copy the verification key. (`bounce` type `blocked` is treated as temporary.) | `SENDGRID_WEBHOOK_PUBLIC_KEY` (base64 DER or PEM) |
| SendGrid | `sendgrid-inbound` | Settings → Inbound Parse → host = `EMAIL_INBOUND_DOMAIN` (MX → `mx.sendgrid.net`), URL `https://hub:<secret>@<host>/api/webhooks/messaging/sendgrid-inbound`, *not* "POST the raw, full MIME message". | `EMAIL_WEBHOOK_SECRET` |
| Twilio | `twilio-sms` | Phone number (or Messaging Service) → "A message comes in" → Webhook, HTTP POST, `{APP_URL}/api/webhooks/messaging/twilio-sms[?org=slug]`. Keep **Advanced Opt-Out** on so Twilio itself answers STOP/START/HELP (we return empty TwiML and only record consent). | `SMS_AUTH_TOKEN` (X-Twilio-Signature). `APP_URL` must be the exact public origin Twilio calls — the signature covers the full URL incl. query string. |

Hard bounces / complaints flag the address in `undeliverable_addresses` (one active flag per org + channel + address); a complaint also opts that person out of email (`source = email_complaint`). Soft bounces are recorded and ignored. Staff clear a flag from the person's Communication card once the family fixes the address.

## Known gaps vs PushPress Grow / Zen Planner

- No delivery-receipt webhooks (`delivered` for email/SMS) and no Twilio failure callbacks (e.g. error 21610 for numbers that blocked us outside a STOP reply).
- Inbound attachments/HTML are dropped (plain text only); quoted-history stripping is heuristic.
- No drip sequences with multiple steps per rule; no A/B tests or link tracking for campaigns; campaign recipients are re-resolved at send time (the preview is a snapshot, not a frozen list).
- Phone matching uses the last 10 digits (North American numbers); international numbers sharing those digits would collide.
- No lead-capture embeds/landing-page builder beyond `/inquire`; no lead scoring, no attachments in messages.
- Assessment scheduling links a lead to a session but does not create a booking (leads are not athletes until conversion).
