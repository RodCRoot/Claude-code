# Data mapping guide

The import wizard (Data → Import) accepts CSV uploads and shared Google
Sheets, shows a preview, and lets you map source columns to canonical fields.
Mappings can be saved by name and reused for recurring reports. Every import
is recorded in sync history with processed/rejected counts and reasons.

## Canonical fields by import target

### Leads
| Field | Required | Notes |
| --- | --- | --- |
| `name` | ✓ | Lead/athlete name |
| `contact_name` | | Parent or guardian |
| `phone`, `email` | | |
| `source` | | `referral`, `reactivation`, `community`, `website`, `paid_ads`, `organic_social`, `other` |
| `stage` | | `new`, `contacted`, `appointment_scheduled`, `appointment_completed`, `trial`, `member`, `lost` |
| `created_at` | | Any common date format (see below); defaults to import time |
| `first_contacted_at` | | Drives response-time and %-contacted KPIs |
| `notes` | | |

### Athletes
`name`✓, `guardian_name`, `birth_year` (year only — deliberately no full DOB),
`program`, `start_date`✓, `status` (`active`/`hold`/`canceled`),
`lead_source`, `expected_sessions_per_week`.

### Attendance
`athlete_name`✓ (matched case-insensitively against existing athletes — rows
with unknown names are rejected and reported), `date`✓, `status`
(`attended`/`no_show`).

### Payments
`athlete_name` (optional match), `date`✓, `amount`✓ (`$`/commas tolerated),
`category` (`membership`, `private_training`, `specialty_program`, `rental`,
`other`), `status` (`paid`, `failed`, `recovered`, `refunded`), `note`.

### KPI values
`metric_key`✓ (the key shown in Admin → Metric Dictionary, e.g.
`google_reviews`), `period_start`✓, `period_end`, `value`✓, `source_note`.
Use this to backfill history or feed metrics that have no direct integration.

## Date formats

`2026-07-04`, `7/4/2026`, `07/04/26`, `7-4-2026`, and ISO timestamps all
normalize to `YYYY-MM-DD`. Unparseable dates reject the row with a reason.

## Getting exports from your systems

- **Zen Planner:** most reports (attendance, payments, members) export to
  CSV, and many can be scheduled as recurring emailed reports — save the
  attachment and upload it here. Map once, name the mapping (e.g. "ZP
  attendance export"), reuse forever.
- **GoHighLevel / Automatic Members / ZP Engage:** export contacts/
  opportunities as CSV for backfill. For live data, use the webhook —
  `POST /api/webhooks/crm` with the `x-webhook-secret` header — from a
  workflow triggered on contact creation.
- **Google Sheets:** share the sheet as "anyone with the link can view" and
  paste its URL. The specific tab is selected by the `gid` in the URL.

## Sync cadence (when connectors are credentialed)

| Data | Cadence |
| --- | --- |
| Leads / pipeline | Real-time via webhook; hourly API pull |
| Attendance & schedule | Daily |
| Financial & payments | Daily |
| Team scorecards | On staff submission |
| Checklists | Immediate |
| Marketing results | Daily or manual |

The cron endpoint (`/api/cron`) drives scheduled pulls; a connector whose
last sync is older than twice its interval is flagged on Today and in
Data & Sync.
