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
4. **Email/SMS provider (needs keys):** enables family self-signing (email codes), automations, invites by email; then register the inbound/bounce/STOP webhooks (`docs/modules/crm-messaging.md` → Provider setup) and verify one round trip per provider.
5. **Staging deploy (needs Rod's Render + bucket):** follow `docs/DEPLOY.md`; rehearse managed-Postgres and S3 restores.
6. **Open decisions:** see both "Open decisions for Rod" sections in DECISIONS.md (security review + 13 membership/payroll policy questions). Answers are mostly Settings changes, not code.
7. **VBT surfaces (unblocked):** `src/lib/training/vbt.ts` + `vbt-maxes.ts` (ported from the Vantage platform, tested) are ready to surface: (a) an "Estimated max from bar speed" suggest/confirm card on the athlete training page (`suggestVbtMaxes`/`confirmVbtMax`); (b) live est-%1RM next to velocity entry (`pctFromVelocity`); (c) relative-strength (×BW) using Hawkin body-mass trials (`relativeStrength`/`relStrengthTier`); (d) GymAware CSVs: extend `importVbtCsv`'s `transformHeader` to strip "(m/s)"-style parens + infer unit from "weight (kg)" headers, and route name-only athlete matching through the identity-review pattern like the Hawkin sync (never auto-merge by name). An FMS movement screen (7 tests, 0–3, total /21, <14 flag) also fits the existing KPI/protocol machinery.
8. **Product depth (unblocked):** Playwright coverage for payroll, member requests and membership audit pages; Settings screen for member-request SLAs; verify the Zen Planner payroll paste format against a real export; kiosk QR; series weekday moves; offline beyond today's workout.

## Resume prompt
"Continue Teamwork Hub from `teamwork-hub/NEXT_STEPS.md`, `PROGRESS.md`, `FEATURE_MATRIX.md`, and `BLOCKERS.md` on branch `claude/teamwork-hub`. Run `pnpm install && pnpm db:fresh && pnpm test` first, then take the top unblocked item."
