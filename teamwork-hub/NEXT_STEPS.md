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
1. **Account research (blocked on access):** Zen Planner Studio and Hawkin Cloud read-only exploration → verify import mappings, save presets, adjust workflows. See BLOCKERS.md.
2. **Sandbox verification:** Stripe test keys → run checkout + webhook round trip, verify refund/dispute/payout field names; PayPal sandbox → Orders + webhook verification; mark `verified_sandbox` only after a real round trip.
3. **Recurring billing via provider:** Stripe Billing subscriptions / PayPal Subscriptions adapters (currently app-invoiced per period).
4. **Google Calendar OAuth** consent + encrypted token storage (additive schema), then enable push/free-busy.
5. **E-signature hardening (remaining):** approved legal/consent text from counsel; configure an email provider so families can self-sign step-up forms (until then staff verify in person); optional SMS codes; rate limiting per IP on code requests. (Done: email-code identity step-up, Unicode PDF fonts, `published → draft/retired` trigger guard.)
6. **Messaging providers:** inbound email/SMS + bounce/STOP webhooks; family communication-preference screen.
7. **Training:** service worker for full offline reload; drag-and-drop calendar builder.
8. **Ops:** error monitoring SDK, CSP, S3 storage backend with deletes, restore rehearsal, staging deploy (private, payments in test mode, delivery off).
9. **UX polish:** series "edit all future", multi-athlete family checkout, kiosk QR/PIN, custom-field definitions UI, report charts.

## Resume prompt
"Continue Teamwork Hub from `teamwork-hub/NEXT_STEPS.md`, `PROGRESS.md`, `FEATURE_MATRIX.md`, and `BLOCKERS.md` on branch `claude/teamwork-hub`. Run `pnpm install && pnpm db:fresh && pnpm test` first, then take the top unblocked item."
