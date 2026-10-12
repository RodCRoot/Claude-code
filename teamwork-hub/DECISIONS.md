# Decisions

Reversible implementation choices made autonomously during the build. Newest last.

| # | Decision | Why | Reversal cost |
|---|---|---|---|
| D1 | New sibling app `teamwork-hub/` instead of extending `teamwork-scoreboard/` | Scoreboard is a KPI/accountability tool on SQLite; Hub needs a much larger relational model, Postgres concurrency guarantees, and family/athlete portals. Scoreboard untouched. | Low — patterns (Next 16, Drizzle, Tailwind) are shared. |
| D2 | Next.js 16 App Router + TypeScript + server actions; modular monolith | One deployable, server-side authorization everywhere, matches existing repo stack. | Medium |
| D3 | PostgreSQL 16 + Drizzle ORM; migrations in `drizzle/` | Required integrity: exclusion constraints (no coach/room double-booking), partial unique indexes (one live booking per athlete/session), row locks for credits, CHECK constraints, append-only triggers. | Medium |
| D4 | Opaque random session token in httpOnly cookie, SHA-256 hash stored in `auth_sessions` (revocable), bcrypt passwords, lockout after 5 failures, TOTP MFA (otplib) for staff | Revocation + MFA state per session; no JWT secret rotation complexity. | Low |
| D5 | Authorization in one module (`src/lib/authz/policy.ts`) with capability sets per role and per guardian link | Guardian permissions are per-relationship (health, training, booking, forms, messaging) and independent of payer permissions. | Low |
| D6 | Person ≠ user ≠ athlete ≠ guardianship ≠ household ≠ payer account | Required by brief; separated parents, unrelated same-surname families, adult self-payers. Nothing auto-merges. | High (core model) |
| D7 | Postgres-backed job queue/outbox (`jobs`, `FOR UPDATE SKIP LOCKED`) rather than Redis | One less service; transactional enqueue with business changes. | Low |
| D8 | Local-disk object store behind an S3-shaped interface; files served only by auth-checked route handlers | Works in this environment; bucket backend can be swapped. | Low |
| D9 | pnpm instead of npm | npm 10.9 arborist crashes (`edgesOut` null) resolving vitest 4 peers. | Low |
| D10 | All seed data synthetic, `is_demo=true`, `.test`/`example.test` emails, products named "Sample …" with placeholder prices | Brief forbids inventing real prices/policies or seeding real athletes. | Low |
| D11 | Interval arithmetic in exclusion constraints via an IMMUTABLE helper `tw_buffered_range()` | Postgres rejects STABLE timestamptz±interval in index expressions; minute offsets are timezone-independent so IMMUTABLE is correct. | Low |
| D12 | Separate worktree per parallel module agent; lead merges and renumbers Drizzle migrations | Parallel delivery without shared-file churn; migrations regenerated against merged schema (no drift) | Low |
| D13 | Job runners claim only job types they have handlers for | Specialised runners (and parallel tests) never steal and fail others' jobs | Low |
| D14 | Body-map review tasks carry no symptom details | Operations staff can see tasks but have no health access | Low |
| D15 | Signer identity step-up on by default for waivers/agreements; staff-witnessed in-person fallback when email isn't configured | Typed name alone is not adequate identity evidence | Low (org setting) |
| D16 | Google Calendar scope `calendar.app.created` + `calendar.freebusy` (Teamwork-owned calendar per coach) | Narrower than full calendar access | Low |

## Open decisions for Rod (from the security review)
- Which proxy hop to trust for client IP (rate limit + signature evidence) — set at deployment.
- Coaches currently see facility-wide attendance/no-show reports (not health data). Restrict to assigned athletes?
- Guardians see co-guardians' email/phone on their child's page (separated parents). Hide?
- Login resolves by email across orgs; fine single-tenant, revisit if multi-tenant.
- Exporting an approved payroll run marks it "exported" on download (GET, audited, idempotent; approved runs are immutable). Move to an explicit "Mark exported" button?

## Open decisions for Rod (Teamwork membership policy, wave 4)
Defaults come from Rod's documented procedures; every value is editable in Settings → Membership policy, and unconfirmed ones show "Needs confirmation".
1. Family discount: 10% or 15%? (Sources disagree; 10% is in use and flagged.) Reference plan prices also differ between sources; the seeded "Sample —" plans are labelled to confirm.
2. Does the partial first month (stub) count toward a 6- or 12-month commitment? Currently no: the term starts on the 1st after the stub.
3. Should a hold extend the commitment end date? Currently no.
4. In Season "commitment carries over": read as In Season months counting toward the commitment, end date unchanged.
5. Are In Season terms capped for members not on a 12-month plan? Currently uncapped.
6. "2 months" of hold / In Season is counted as 62 days. Calendar months instead?
7. Unused sessions when a paid month goes on hold: weekly limit × days left ÷ 7, minus attended/no-show sessions; unlimited plans need staff to enter the number.
8. Do past-due memberships count as "active" for punch-card use? Currently no.
9. Generic decline / "do not honor" treated as retryable; family card-update wording is sample text.
10. A plan version's own cancellation notice overrides the 30-day policy. Intended?
11. College weekly plan bills every 7 days from start. Align to Mondays instead?
12. Membership audit: In Season plans are recognised by name ("In Season"); siblings are grouped by payer account; Zen Planner-era amounts are estimates (no ZP billing history imported).
13. Payroll: flag thresholds (over 12 h, 2.5× usual shift, under 0.5 h, 90 min off usual start) and the flat 17% deduction are placeholders; confirm with the accountant.
