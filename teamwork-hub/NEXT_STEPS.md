# Next steps (resume here)

Current state: all modules merged on branch `claude/teamwork-hub` (draft PR #12). Everything in FEATURE_MATRIX.md marked "verified locally" passes. No provider is sandbox-verified.

## Resume commands
```bash
cd teamwork-hub && pnpm install
cp .env.example .env   # set SESSION_SECRET, DATABASE_URL, TEST_DATABASE_URL
pnpm db:fresh && pnpm test && pnpm typecheck && pnpm lint
pnpm dev               # then: PW_CHROMIUM=<chromium path> npx playwright test
```

## Prioritized backlog
1. **Account research (blocked on access):** Zen Planner Studio, Hawkin Cloud, TeamBuildr read-only exploration → verify import mappings, save presets. See BLOCKERS.md.
2. **Sandbox verification (needs keys):** Stripe test mode (checkout, subscriptions anchor/first charge, refunds/disputes/payouts fields), PayPal sandbox (orders, subscriptions approval link, webhook verification), Venmo on a real phone. Mark `verified_sandbox` only after a real round trip.
3. **Google Calendar (needs console setup):** create OAuth client per `docs/modules/scheduling.md`, set env, connect one coach, verify push + free/busy.
4. **Email/SMS provider (needs keys):** enables family self-signing (email codes), automations, invites by email; then inbound/bounce/STOP webhooks.
5. **Staging deploy (needs Rod's Render + bucket):** follow `docs/DEPLOY.md`; rehearse managed-Postgres and S3 restores.
6. **Open decisions:** see "Open decisions for Rod" in DECISIONS.md.
7. **Product depth (unblocked):** series "edit all future", multi-athlete family booking, kiosk PIN/QR, training service worker + drag-and-drop builder, broadcast campaigns/segments, custom-field definitions UI, report charts, accessibility (axe) audit.

## Resume prompt
"Continue Teamwork Hub from `teamwork-hub/NEXT_STEPS.md`, `PROGRESS.md`, `FEATURE_MATRIX.md`, and `BLOCKERS.md` on branch `claude/teamwork-hub`. Run `pnpm install && pnpm db:fresh && pnpm test` first, then take the top unblocked item."
