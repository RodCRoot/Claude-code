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
