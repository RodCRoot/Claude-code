# Progress log

## Checkpoint 1 — Foundation (2026-10-12)
- Scaffolded `teamwork-hub/` (Next 16.2, React 19.2, Tailwind 4, Drizzle 0.45, Postgres 16, pnpm).
- Full relational schema (~80 tables) across core identity, scheduling, billing/credits, CRM/messaging/jobs, documents/signatures, training, sports science, imports/integrations. Migrations `0000_init` + `0001_integrity_constraints` (exclusion constraints, CHECKs, append-only triggers).
- Auth: hashed opaque sessions, lockout, TOTP MFA path, logout, demo-only role switcher (`/dev/switch`).
- Authorization policy with per-role and per-guardian-link capabilities; 9 tests passing.
- UI kit + responsive shell (sidebar desktop / menu mobile), login, denied, error/loading states.
- Synthetic seed: staff, 3 family structures (2 guardians/2 kids; unrelated same-surname; separated co-parents), adult self-payer, inactive athlete, 10 roster athletes, groups, coach scopes, notes, alerts, tasks, integration rows.

Verified: `pnpm test` (9/9), `pnpm lint` clean, browser login → /today.
