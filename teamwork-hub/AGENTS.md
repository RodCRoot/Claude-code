<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

(Next.js 16: middleware is now `proxy.ts`; `params`, `searchParams`, `cookies()`, `headers()` are async.)

# Teamwork Hub conventions (read before changing code)

Package manager: **pnpm** (npm 10 crashes on vitest's peer graph). Run `pnpm install`.

## Commands
- `pnpm db:fresh` — reset + migrate + seed the dev DB (APP_MODE=demo only)
- `pnpm dev` — http://localhost:3000 ; demo logins at `/dev/switch` (password `teamwork-demo-1`)
- `pnpm test` — vitest against `TEST_DATABASE_URL` (schema recreated each run; each test file seeds its own isolated org via `seedOrg()`)
- `pnpm typecheck`, `pnpm lint`, `pnpm build`
- `pnpm db:generate --name <x>` after editing `src/db/schema/*`

## Architecture
- `src/db/schema/*` — Drizzle schema (PostgreSQL). Money = integer minor units + currency. Every tenant row has `org_id`; every query filters on `viewer.orgId`.
- `src/lib/authz/policy.ts` — **the** authorization source of truth. Use `athleteCapabilities` / `requireOnAthlete` / `accessibleAthleteIds` + `athleteScopeFilter` for any athlete-scoped read/write, and `can` / `assertCan` for org-level capabilities. Never trust ids from the client; re-check scope in every server action and route handler.
- `src/lib/auth/viewer.ts` — `requireViewer()`, `requireStaff()`, `requireCap(cap)` for pages.
- `src/lib/actions.ts` — wrap server actions in `safeAction(...)` and return `ActionState`; throw `UserError` for business-rule messages. Client forms use `<ActionForm action={...}>` + `<SubmitButton>` from `src/components/forms.tsx`.
- `src/components/ui.tsx` — Card, Button, Badge, StatusBadge, Field/Input/Select/Textarea, Table/Th/Td, PageHeader, Stat, EmptyState, Callout, NotConfigured, Tabs.
- `src/lib/audit.ts` — `audit(tx, actor, action, entityType, entityId, {summary, before, after})` for every meaningful mutation (append-only table).
- `src/lib/jobs.ts` — transactional outbox (`enqueue` inside the business transaction, dedupe keys).
- `src/lib/storage.ts` — object storage (`saveObject`), always served via an auth-checked route handler.
- `src/lib/time.ts` — facility timezone helpers (America/Indiana/Indianapolis). Store instants as timestamptz; local calendar dates as `date` strings.
- Domain logic goes in `src/lib/<module>/*.ts` as plain functions taking `(tx, viewer, input)` so it is testable without Next. Pages/actions stay thin.
- Use DB transactions + row locks (`SELECT … FOR UPDATE`) or unique constraints for anything involving capacity, credits, or money.
- Missing values are `null`, never `0`. Never invent prices/policies: make them configurable and label sample text.
- Provider integrations never fake success. Without credentials, show an honest "not configured" state (`<NotConfigured>`) and keep internal workflows usable.

## Seeds & tests
- `scripts/seed/core.ts` builds the synthetic identity graph (keys in `ctx.users/people/athletes/payers/groups`). Module seeds live in `scripts/seed/<module>.ts` and are registered in `scripts/seed/modules.ts`.
- Tests live in `tests/<module>*.test.ts`; use `seedOrg()` / `viewerFor(ctx, "alex")` from `tests/helpers/db.ts`.
- Demo users: rod (owner), erin (operations), marcus & tess (coaches), alex & jordan (guardians of maya+eli; jordan has no health access and can view but not pay invoices), chris (unrelated Parker, guardian of ava), sam & casey (separated co-parents of leo; casey cannot book or pay), dana (adult athlete, self-pay), maya (athlete login), kiosk.
