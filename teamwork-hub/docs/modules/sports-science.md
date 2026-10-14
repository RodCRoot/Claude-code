# Sports science, performance dashboards & parent progress reports

Owner paths: `src/app/(app)/science/**`, `src/app/(app)/performance/**`, `src/lib/science/**`,
`src/components/charts/**`, `src/components/body-map/**`, `scripts/seed/science.ts`, `tests/science*.test.ts`.

## 1. Research notes (public documentation, TeamBuildr AMS)

Sources: <https://www.teambuildr.com/platform-ams> and the AMS category of the TeamBuildr support site
(<https://support.teambuildr.com/category/z2dk9g59gc-ams-lite>), both fetched 2026-10-12. Most support
articles are short pages built around videos, so the public text contains **feature names, not specifications**.
The notes below record only what that public documentation states.

| AMS feature (public name) | What the public documentation says | Teamwork Hub equivalent |
|---|---|---|
| Body Heat Map (support URLs say "recovery radar") | Athletes "log pain location, rate its severity". It has an athlete view and a dashboard view. It is part of the AMS LITE add-on. | `/science/body-map` |
| Habit Tracker (support URLs say "consistency coach") | Has athlete and dashboard views. It is part of the AMS LITE add-on. | `/science/habits` |
| KPI Tracker | Keeps staff informed on progress, such as "hitting new maxes in the weight room". | `/science/kpis` |
| Load Monitoring Dashboard | It is a module of the AMS LITE add-on. A customer testimonial mentions monitoring workload. | `/science/load` |
| Volume Tracker | Shows "how much work your athletes are doing at different intensity levels". | `/science/volume` |
| Wearables Dashboard | It is the free module in AMS LITE and links to an "Exertion Score formula" article. | `/science/wearables` |
| Force Plate Dashboard | It is a paid add-on with weight-room and workout-entry views. | `/science/force-plate` |
| Wellness / readiness | The dashboards are used to "monitor readiness, wellness, injury status". | `/science/wellness` |

What we deliberately did **not** do:
- No proprietary formula is reproduced or claimed. That includes any TeamBuildr "Exertion Score" or readiness index. Every index here is a documented **Teamwork calculation** with a version key.
- The UI is an original design. No TeamBuildr assets, copy, or layouts are used.

## 2. Formulas (`src/lib/science/formulas.ts`)

All formulas are pure functions, and each one has a version key that is shown in the UI. Values that are missing or can't be calculated are `null`, never 0. Averages skip `null` values.

| Key | Definition | Unit |
|---|---|---|
| `srpe_load_v1` | duration_min × session RPE (CR-10). Null if either input is missing, or RPE is outside 0–10. | AU (arbitrary units) |
| `tw_readiness_v1` | Each **required** scale item with a direction is normalized to 0–100. For higher_better items: `(v−min)/(max−min)·100`. For lower_better items: `(max−v)/(max−min)·100`. The score is the mean over the answered items. It is null if fewer than half of the eligible items were answered, and null when there is no response. It is a Teamwork calculation. | 0–100 |
| `acwr_rolling_v1` | Mean daily load over the 7-day acute window ÷ mean daily load over the 28-day chronic window. The two windows are coupled and both end on the as-of date. A day is "known" only if it has logged sessions with computable load, or if it was explicitly recorded as a **rest** day (the only case that counts as 0). The ratio is null when either window's coverage is below `acwrMinCoverage` (default 75%, configurable) or the chronic mean is 0. | ratio |
| `monotony_v1` / `strain_v1` | Monotony is mean ÷ SD of the 7 daily loads; strain is weekly total × monotony. Both need all 7 days known. Monotony is null if the SD is 0. | ratio / AU |
| `tonnage_v1` | Σ load × reps over completed working sets. The rules are listed in §3. | display lb or kg |
| `intensity_zone_v1` | The set's load as a % of the **dated max**: the most recent max on or before the set's date, for the same exercise or its `max_source_exercise_id`, unit-converted. Zones are <60, 60–70, 70–80, 80–90 and ≥90, plus `no_max` and `no_load` buckets. | % |
| `trial_selection_v1` | best / mean / latest over included individual trials. **Vendor aggregate rows and excluded trials are never included**, and null values are skipped. "best" needs a metric direction. | metric unit |
| `swc_02sd_v1` | 0.2 × the SD of the athlete's session values, with at least 3 sessions. This "smallest worthwhile change" band is a Teamwork convention, not a vendor statistic. | metric unit |
| `change_pct_v1` | (current − baseline) ÷ \|baseline\| × 100. The baseline is the coach-set baseline if one exists, otherwise the first session. | % |
| `asymmetry_v1` | (L − R) ÷ ((L + R)/2) × 100, where positive means left is greater. It is Teamwork-derived, for example from peak forces in a raw trace. | % |
| `habit_adherence_v1` | (done + 0.5·partial) ÷ expected × 100. Explicit "missed" and "no check-in" are counted and shown **separately**. | % |
| `attendance_rate_v1` | attended ÷ (attended + no-show) bookings × 100. Cancellations are excluded, and the rate is null if there are no eligible bookings. | % |

**Unit conversion** (`convertUnit`) uses exact constants: 1 lb = 0.45359237 kg and 1 in = 2.54 cm. Units in different families, such as cm and s, return `null` and are never compared.

**Dates and time zones.** Daily buckets are local calendar dates in America/Indiana/Indianapolis. A workout's load is assigned to the local date of its `completed_at` (`workoutLoadDate`), so it is DST-correct: 23:30 EDT on 2026-03-08 is bucketed to 03-08. Date arithmetic uses UTC-noon, so a DST change never skips or duplicates a day. Derived load metrics are anchored to today only if today's load is known; otherwise they use yesterday, and the UI says so.

### Comparability (`src/lib/science/comparability.ts`)

A trend, baseline, personal best or change % is only built from sessions that were measured the same way as the athlete's latest usable session. `compareContexts(a, b)` returns `{ comparable, reasons }` and fails on any of: a different test type, a different protocol text (whitespace/case-insensitive), a different source (vendor vs Teamwork manual vs Teamwork-derived) or a different calculation version, units with no exact `convertUnit` factor, a different aggregation level (individual trial vs vendor mean/best vs derived), or, for metrics per kg of body mass, body mass known for one measurement and not the other. `athleteMetricSeries` keeps the incomparable sessions in `excludedPoints` with their reasons and summarizes them in `excluded: [{ reason, count }]`; the KPI, force-plate and family progress pages show that list in a notice, and progress-report snapshots carry it as `excludedNote`. Nothing is converted or merged to make values comparable.

## 3. Volume rules (`computeVolume`, `src/lib/science/volume.ts`)

Volume is read-only over `set_logs → workout_items → workouts → exercises`. If the item was substituted, the substituted exercise is used.

1. Warm-up sets are excluded by default. A toggle includes them.
2. Sets with `completed = false` are skipped.
3. Unilateral sets logged per side (`side = left/right`) are summed per side, shown as L/R, and both sides are included in the total.
4. For bodyweight movements (`bodyweight_reps`), load = `bodyweight_factor × athlete body mass (kg)`, plus any added external load. If body mass or the factor is unknown, the set is **excluded from tonnage but its reps are counted**.
5. A set with no load is excluded from tonnage and counted in reps (`excludedMissingLoad`).
6. lb and kg are converted explicitly to the chosen display unit.
7. `time`, `distance` and `time_distance` work is summed separately as seconds and meters, and never enters tonnage.
8. Intensity zones use the dated max (see `intensity_zone_v1`).

If the org has no set logs, the page shows an honest empty state. The demo seed adds a few `is_demo` workouts (source `teamwork`) only when no training seed has produced set logs.

## 4. Feature behaviour

- **Wellness.**
  - *Builder:* scale questions (min/max, anchors, polarity), number questions (unit), text and yes/no questions, each optionally required.
  - *Versioning:* changing the questions inserts a new `questionnaire_versions` row, and responses keep their `version_id`. Changing only the schedule or flag thresholds does not create a new version.
  - *Schedule:* daily, weekdays, or pre-session (any day with a booked or attended booking), with target groups.
  - *Athlete check-in:* mobile-first, one screen, with radio pills of at least 48px.
  - *Coach grid:* "No response" is a distinct, dashed state. It never gets a readiness score or flags, and is never counted as fine.
  - *Flags:* configured per questionnaire (`flagRules`), plus a readiness threshold.
  - *Trends:* per item and for readiness. Missing days appear as gaps.
- **Body map.**
  - *Entry:* an original front/back SVG with keyboard-focusable regions, plus an equivalent non-visual path (selects for region and side, type radios, a severity slider with a number field, and a note).
  - *Side mapping:* front view shows the athlete's right on the viewer's left; back view shows the athlete's left on the viewer's left.
  - *Heat overlay:* the maximum severity per region over the last 14 days.
  - *Review tasks:* a pain report, or soreness at or above `sorenessReviewThreshold` (default 7), creates one `tasks` row with dedupe key `body_review:<reportId>`, assigned to the athlete's coach.
  - *Review queue (`health.review`):* the outcome is reviewed, follow-up or referred out. Follow-up and referral require a note, and the task is closed or set to in progress to match.
  - *Disclaimer:* the UI copy states that it is self-reported, not a diagnosis, and not clearance to train.
- **Habits.**
  - Habits have a target value and unit, and a frequency of daily, weekdays or weekly (weekly folds into ISO weeks).
  - They are assigned to an athlete or a group (only groups entirely within the coach's scope) with a date range.
  - Check-ins are done, partial or missed, with an optional value, and can be backfilled for up to 7 days.
  - Views show adherence, the streak (today without a check-in doesn't break it), and a calendar.
- **KPIs.**
  - *Metric definitions:* unit, direction, category, `defined_by` (vendor vs Teamwork), precision and protocol.
  - *Test types:* each has a trial selection rule.
  - *Manual entry:* one session with up to 3 trials and 3 metrics. Units are kept as entered, and a blank unit means the metric's own unit.
  - *Targets:* baseline, target and goal date, for an athlete or a group. An athlete target overrides a group target.
  - *Athlete dashboard:* latest vs baseline vs target, a trend chart with a date range, SWC classification, and an explicit note when trials were unit-converted.
  - *Group dashboard:* covers only the coach's scope, with an opt-in leaderboard (staff only, and only for metrics with a direction).
  - *Attendance KPI:* comes from `bookings` joined to `schedule_sessions`.
- **Load.**
  - *Logging:* manual activity sessions (practice, game, conditioning, other, or an explicit **rest day**), plus completed workouts with duration and sRPE that aren't already linked.
  - *Views:* daily bars, a coverage strip (logged, rest, incomplete, no data), and weekly totals with known-day counts.
  - *Derived metrics:* ACWR, monotony and strain, with their windows and formula keys displayed.
  - *Wellness context:* shown as a separate chart, never on a second axis, and only with `health.read`.
- **Wearables.**
  - *Data model:* normalized observations with provider, metric, date, value, unit and quality (measured, missing or device_estimate).
  - *CSV import:* column mapping. Athletes are matched only by a **unique** email or a registered external id, never by name. Health scope is checked per row. Units are converted explicitly (for example, sleep in minutes to hours). A dry-run preview is available. The raw file is stored and an `import_batches` row is kept for provenance. Re-imports are idempotent.
  - *Manual entry* is also supported.
  - *Dashboard:* days with no data are explicit, never 0 and never carried forward.
- **Force plate.**
  - Shows force-plate metrics with "Hawkin (vendor)" badges.
  - The session value uses the trial rule over included trials. Vendor aggregate rows are shown separately and badged.
  - Trials can be excluded or re-included, with a reason.
  - Baseline and SWC are shown as a band.
  - The raw force-time CSV (`time_s, force_left_N, force_right_N`) is read server-side through `objectStore()` in `src/lib/storage.ts`, after an athlete-scope check. It is downsampled for plotting, and peak L/R and `asymmetry_v1` are labeled Teamwork-derived.
- **Progress reports.**
  - *Workflow:* draft (auto-assembled frozen snapshot) → the coach edits the summary and chooses sections (wellness is **off** by default and needs `health.read` to include) → approved (a summary is required) → shared, after which the report is frozen.
  - *Who sees what:* families and athletes see shared reports only. The wellness section is shown only if the report includes it **and** the viewer has `health.read`.
- **Performance** (`/performance`, `/performance/[athleteId]`): KPIs, strength PRs (best max per lift), habit adherence, attendance and shared reports. Wellness and body-map details are assembled only when the viewer has `health.read`.

## 5. Authorization

Every lib function re-checks scope through `src/lib/authz/policy.ts`:

| Data | Read | Write |
|---|---|---|
| Wellness, body map, wearables | `health.read` | `health.write`; review needs `health.review` |
| KPIs, load, volume, force plate, habits, reports | `training.read` | `training.write` / `training.log` |
| Questionnaires, habits, metrics, targets, thresholds, reports | — | `science.manage` (org-level) |

The practical effect:
- Operations (Erin) gets no health data.
- Jordan (a guardian without health access) never gets Maya's body map or wellness.
- Coaches see only athletes assigned to them.

Every mutation calls `audit()`. Wellness audit rows record that a submission happened, not the health answers.

## 6. Configuration

Thresholds live in `organizations.settings.science` and can be edited on the hub by `science.manage`. They are Teamwork starting points, not clinical norms:

| Setting | Default |
|---|---|
| `sorenessReviewThreshold` | 7 |
| `acwrMinCoverage` | 0.75 |
| `acwrAlertHigh` / `acwrAlertLow` | 1.5 / 0.8 |
| `readinessFlagBelow` | 40 |

## 7. Wearable provider boundary (`src/lib/science/wearables/provider.ts`)

There are no live connections. Every adapter returns `not_configured`, and `fetchObservations` throws. Teamwork Hub is a web app with no HealthKit, Health Connect or Bluetooth access.

A live sync would need the following:
- **WHOOP Developer API:** OAuth 2.0 and per-member consent.
- **Oura API v2:** OAuth 2.0.
- **Garmin Health API:** partner program approval and OAuth.
- **Polar AccessLink:** OAuth 2.0.
- **Fitbit Web API:** OAuth 2.0.
- **Apple Health:** no web API. It needs a native app or a manual CSV export.

## 8. Exported functions for dashboards

| Function | Returns |
|---|---|
| `wellnessCompletionSummary(tx, viewer, date?)` (`src/lib/science/wellness.ts`) | `{expected, answered, partial, noResponse, flagged}` over the viewer's health scope |
| `reviewQueueCount(tx, viewer)` / `reviewQueue(tx, viewer)` (`bodymap.ts`) | Open body-map review items |
| `loadAlerts(tx, viewer, asOf?)` (`load.ts`) | ACWR high/low and insufficient-data alerts |
| `performanceSummary(tx, viewer, athleteId)` (`performance.ts`) | Health is null without `health.read` |

## 9. Known gaps vs TeamBuildr AMS

- No native mobile app or push reminders for check-ins. A scheduled reminder job could use `src/lib/jobs.ts`.
- No live wearable sync, so there is no "Exertion Score" equivalent.
- No live Hawkin API sync in this module. It is expected from the imports/integrations module, and this module renders whatever lands in `test_sessions`/`trials`/`metric_values`.
- No configurable custom dashboards or saved views.
- No PDF export of progress reports, and no email or SMS delivery when a report is shared.
- Body-map history has no per-region drill-down chart.
- No inter-athlete comparison beyond the group table and leaderboard.
- Guardians can't submit check-ins on behalf of a minor, because policy grants guardians no `health.write`.
- `pre_session` scheduling counts any booked or attended booking that day; it doesn't filter by service type.
