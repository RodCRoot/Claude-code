# Progress log

## Checkpoint 1 — Foundation (2026-10-12)
- Scaffolded `teamwork-hub/` (Next 16.2, React 19.2, Tailwind 4, Drizzle 0.45, Postgres 16, pnpm).
- Full relational schema (~80 tables) across core identity, scheduling, billing/credits, CRM/messaging/jobs, documents/signatures, training, sports science, imports/integrations. Migrations `0000_init` + `0001_integrity_constraints` (exclusion constraints, CHECKs, append-only triggers).
- Auth: hashed opaque sessions, lockout, TOTP MFA path, logout, demo-only role switcher (`/dev/switch`).
- Authorization policy with per-role and per-guardian-link capabilities; 9 tests passing.
- UI kit + responsive shell (sidebar desktop / menu mobile), login, denied, error/loading states.
- Synthetic seed: staff, 3 family structures (2 guardians/2 kids; unrelated same-surname; separated co-parents), adult self-payer, inactive athlete, 10 roster athletes, groups, coach scopes, notes, alerts, tasks, integration rows.

Verified: `pnpm test` (9/9), `pnpm lint` clean, browser login → /today.

## Checkpoint 2 — Lead modules (2026-10-12)
- People: directory/search with coach scoping and contact redaction, person page (contact, athlete profile, guardians with independent permission flags, households, payer accounts, notes by visibility, tasks, tags, kiosk alerts, attendance), unified permission-gated timeline, registration that flags duplicates instead of merging.
- Role dashboards (staff, coach, parent with child switcher, athlete), 13 reports with written definitions + CSV export, Settings (org/branding/policies, users/invites/reset links/roles, TOTP MFA enrollment + staff enforcement, integrations status, audit log), public site, security headers via `proxy.ts`.
- Fix: React 19 form reset wiped user input on validation errors → `ActionForm` submits through a transition.

## Checkpoint 3 — Seven modules merged (2026-10-12)
Built in parallel worktrees and merged: scheduling/booking/kiosk/calendar adapter; billing/payments/ledger/POS; CRM/inbox/messaging/automations/worker; forms/signatures/PDFs; training/logging/weight room; sports science/performance/progress reports; Import Center/Hawkin sync/exports.
Integration fixes during merge: seed ordering + per-test seed scoping, job runner claims only types it handles, per-org source-record uniqueness (`0003`), billing/calendar/export jobs registered with the worker, attendance panel on athlete profiles, body-map review tasks linked to the athlete and stripped of health details (operations can see tasks), table captions contained on mobile, inquiry layout de-duplicated.

Verified (2026-10-12): `pnpm test` 273/273 (19 files, incl. cross-module acceptance paths), `pnpm typecheck` clean, `pnpm lint` clean, `pnpm build` succeeds, Playwright `e2e/` 10/10 (desktop + mobile), training offline-recovery e2e 1/1, browser sweep of every nav route for owner/operations/coach/3 guardians/2 athletes/kiosk with no page errors or horizontal overflow at 390px. Screenshots in `docs/screenshots/`.

## Checkpoint 4 — Hardening wave (2026-10-12)
Merged: security review (10 fixes + tests: coach export scope, export download route, CSV formula injection, cross-org ids, inquiry rate limit, login/MFA enumeration and brute force, admin MFA reset), Stripe Billing + PayPal subscriptions and server-side Venmo checkout (never double-billed: 4 guards), Google Calendar OAuth with encrypted tokens, signer identity step-up (email code / MFA / staff-witnessed) + Unicode PDFs + version-status trigger, observability (redacted logs, optional Sentry), nonce CSP, S3 storage + deletes, restore rehearsal, Dockerfile + private Render staging blueprint (not deployed), `pnpm bootstrap:owner`.
Migrations renumbered after parallel work: 0004 cal tokens, 0005 provider plans, 0006 provider billing guard, 0007 signer step-up, 0008 form version status guard; `drizzle-kit generate` reports no drift.

Verified: `pnpm test` 364/364 (23 files), typecheck/lint clean, production build OK, Playwright against the production build 24/24 (auth/access + CSP sweep for every role, desktop + mobile), training offline e2e 1/1, `/api/health` ok.

## Checkpoint 5 — Product depth wave (2026-10-12)
Merged: scheduling depth (series edits this/following/all with capacity-conflict choices, family multi-athlete and N-week booking, kiosk PIN check-in + PIN-only mode, attendance corrections re-settle credits); training (scoped service worker so athletes can reload offline and keep logging, shared-tablet cache purging, web manifest, accessible drag-and-drop/keyboard program builder; fixed a stuck-queue bug and a post-sync display race); messaging (family communication preferences with immutable consent history, saved segments + approved broadcast campaigns, Postmark/SendGrid/Twilio webhooks for bounces, complaints, STOP/START, threaded replies); custom fields (Settings + person page + list filters + export), report charts with text/table fallbacks, axe accessibility audit (263 violations → 0 across 217 page audits) with app-wide fixes.
Migrations: 0009 crm preferences/campaigns/inbound, 0010 kiosk pins, 0011 custom fields (renumbered at merge; `drizzle-kit generate` reports no drift).
Test infrastructure: vitest hook timeout 180 s and max 4 workers (seeding grew); job-count assertion scoped per org.

Verified: `pnpm test` 455/455, typecheck/lint clean, production build OK; Playwright against the production build 234/234 (auth/access, CSP sweep, axe WCAG 2.1 AA sweep for every role at desktop + 390px) and training offline/builder suite 4/4.

## Checkpoint 6 — Teamwork policies wave (2026-10-12)
Merged:
- **Multi-location:** locations; membership, product and credit scope per location, with a family-facing explanation when a plan doesn't cover a session's location.
- **GoHighLevel adapter:** contacts import, not configured by default.
- **Family message style lint.**
- **Membership policy engine**, from Rod's documented procedures; policies only, no member data:
  - billing on the 1st with a half-month stub;
  - commitments roll to month to month;
  - holds: capped, backdated only to the request date, punch-card makeup;
  - fixed-term In Season memberships;
  - weekly class caps enforced under a row lock;
  - 30-day cancellation notice;
  - automatic family discount;
  - restart nudges;
  - decline classification;
  - Settings → Membership policy.
- **Member requests log** (with suggestions from inbound messages), a read-only membership status page, and a membership audit sweep with a dollar figure for each exception.
- **Staff time clock** (Today card plus kiosk PIN pad) and **payroll:** abnormality flags, estimates, approve/lock, CSV export, Zen Planner paste import.

Migrations: 0012 locations, 0013 GHL integration row, 0014 membership policy, 0015–0016 payroll (and run/time-entry guard triggers), 0017 member requests (renumbered at merge; no drift).
Policy questions for Rod are listed in DECISIONS.md.

Verified:
- `pnpm test` 568/568 (48 files); typecheck and lint clean; production build OK.
- Playwright against the production build: 234/234.
- The axe and CSP sweeps now also cover payroll, `/time`, member requests, the membership audit and the kiosk staff clock. Owner, coach and kiosk passed 180/180 at desktop and 390px.

## Checkpoint 7 — Studio-style redesign (2026-10-12)
Rod asked for the look and feel of Zen Planner (operations) and TeamBuildr (training). Layout and interaction patterns only: no logos, product names or brand colors were copied, and the accent stays configurable per org.
- **App frame:**
  - Dark navy sidebar with icons, grouped Front desk / Members / Coaching / Business.
  - Top bar: member search, a "+ New" menu filtered by capability, and an account menu.
  - Denser components: title-bar cards, striped tables, KPI tiles with an accent bar.
- **Calendar (Zen Planner style):**
  - Week view as an hour grid; day view with one column per coach; month grid.
  - Session roster as a check-in table.
  - Agenda list on phones.
- **Dashboard, People, Billing:**
  - Widget dashboard.
  - Dense member directory.
  - Member profile: header band, info column, tabs.
  - Leads kanban.
  - Ledger-style billing tables with totals.
  - Checkout-style point of sale.
- **Training, Sports Science, Performance (TeamBuildr / AMS style):**
  - Week calendar with group progress.
  - Phone-first workout cards.
  - Dark weight-room board.
  - Program builder with day columns.
  - Leaderboards.
  - Readiness heat table: values shown as text and symbols, not color alone.
- Before/after screenshots at 1440px and 390px are in `docs/screenshots/redesign/`.

Verified:
- `pnpm test` 594/594; typecheck and lint clean; build OK.
- Playwright 252/252: auth, CSP, and axe for every role at desktop and mobile.
- Training offline/builder suite 4/4.
