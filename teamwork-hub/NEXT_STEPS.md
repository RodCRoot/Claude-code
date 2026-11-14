# Next steps (resume here)

Current state: all modules merged on branch `claude/teamwork-hub` (draft PR #12). Everything in FEATURE_MATRIX.md marked "verified locally" passes. No provider is sandbox-verified.

## Resume commands
```bash
cd teamwork-hub && bash scripts/setup-dev.sh   # Postgres role + databases, .env, install, seed
pnpm test && pnpm typecheck && pnpm lint
pnpm build && PORT=3000 pnpm start &            # then: PW_CHROMIUM=<chromium path> npx playwright test --workers=1 --trace off
```

## Planning documents (read before any cutover work)
- `docs/REPLACEMENT-PLAN.md`: four separate replacement decisions and the cutover rules; nothing is cancelled until the gates there pass.
- `docs/HAWKIN-CONNECTORS.md`: which Hawkin data route to use (archived exports first, then read-only API backfill) and the read-only account inspection checklist.
- `docs/VALIDATION.md`: scenario-to-test map; the "Gaps" section lists what still has no automated coverage.

## Prioritized backlog
1. **Account research (blocked on access):** Zen Planner Studio, Hawkin Cloud, TeamBuildr read-only exploration → verify import mappings, save presets. See BLOCKERS.md and the inspection checklist in `docs/HAWKIN-CONNECTORS.md`.
2. **Sandbox verification (needs keys):** Stripe test mode (checkout, subscriptions anchor/first charge, refunds/disputes/payouts fields), PayPal sandbox (orders, subscriptions approval link, webhook verification), Venmo on a real phone. Mark `verified_sandbox` only after a real round trip.
3. **Google Calendar (needs console setup):** create OAuth client per `docs/modules/scheduling.md`, set env, connect one coach, verify push + free/busy.
4. **Email/SMS provider (needs keys):** enables family self-signing (email codes), automations, invites by email; then register the inbound/bounce/STOP webhooks (`docs/modules/crm-messaging.md` → Provider setup) and verify one round trip per provider.
5. **Staging deploy (needs Rod's Render + bucket):** follow `docs/DEPLOY.md`; rehearse managed-Postgres and S3 restores.
6. **Open decisions:** see the three "Open decisions for Rod" sections in DECISIONS.md (security review, 13 membership/payroll policy questions, 11 from the athlete experience wave). Answers are mostly Settings changes, not code.
7. **VBT follow-ups (unblocked):** the four surfaces are built (`docs/modules/training.md` → "Bar speed"). Left: verify the GymAware header mapping against a real export; decide whether the live %1RM should use the athlete's own load-velocity line instead of the published curves; a body-weight entry field for staff (today it comes from Hawkin trials or the Showcase seed); an FMS movement screen (7 tests, 0 to 3, total out of 21, flag under 14) needs its own small form and health-access gating because the KPI entry form takes 3 metrics per session and has no derived totals.
8. **Product depth (unblocked):** Playwright coverage for payroll, member requests and membership audit pages; Settings screen for member-request SLAs; verify the Zen Planner payroll paste format against a real export; kiosk QR; series weekday moves; offline beyond today's workout.
9. **Athlete experience follow-ups (unblocked):** link products to a session series so camps and clinics can be sold online; browser tests for the display-name and shoutout forms (server-side tests only today); push or email nudges for streaks once a provider is connected.

## Resume prompt
"Continue Teamwork Hub from `teamwork-hub/NEXT_STEPS.md`, `PROGRESS.md`, `FEATURE_MATRIX.md`, and `BLOCKERS.md` on branch `claude/teamwork-hub`. Run `pnpm install && pnpm db:fresh && pnpm test` first, then take the top unblocked item."
