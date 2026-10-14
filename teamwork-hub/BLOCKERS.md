# Blockers & access requests

Items that need Rod (or a provider) to unblock. Independent work continues without them.

| Item | Status | What's needed | Impact while blocked |
|---|---|---|---|
| Zen Planner Studio read-only exploration (studio.zenplanner.com, rod@teamworkbloomington.com); also TeamBuildr, Hawkin Cloud and GoHighLevel (all confirmed in use, 2026-10-14) | **Blocked** (Rod asked to use his logins, 2026-10-12) | This cloud container has no Claude in Chrome connection to Rod's browser and no stored credentials. Unblock by either (a) adding `ZEN_PLANNER_EMAIL` / `ZEN_PLANNER_PASSWORD` (ideally a separate read-only staff login) as environment secrets in the cloud environment settings — a new session can then sign in with the built-in headless browser, read-only — or (b) running from the Claude desktop app with Claude in Chrome connected. Never paste passwords in chat. Alternatively export reports as CSV into the Import Center. | Zen Planner parity is based on public product docs + the field names the existing scoreboard already parses (`teamwork-scoreboard/docs/DATA-MAPPING.md`). Marked "public docs" in FEATURE_MATRIX. |
| Hawkin Cloud sign-in / API token | **Blocked** | A Hawkin Cloud API refresh token set as the environment secret `HAWKIN_REFRESH_TOKEN` (and `HAWKIN_API_BASE` for the account's region). Adapter is implemented and tested with mocked HTTP; first real sync should be a short historical window with auto-commit off. | Hawkin adapter implemented against public docs and tested with fixtures only; status shows "not configured". |
| TeamBuildr account access | **Blocked** | Account exports (Max, Raw Data, Questionnaire reports) as CSV, or `TEAMBUILDR_EMAIL`/`TEAMBUILDR_PASSWORD` environment secrets for read-only exploration. Research found no public data API (outbound webhooks only). | Import mappings are configurable and marked unverified. |
| Stripe sandbox | **Blocked** | `STRIPE_SECRET_KEY` (test mode `sk_test_…`), `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`. | Adapter tested with signed fixture webhooks (contract tests); no sandbox verification yet. |
| PayPal / Venmo sandbox | **Blocked** | PayPal REST sandbox app client id/secret + webhook id. Venmo requires US merchant eligibility via PayPal. | Adapter tested with fixtures; Venmo shown as "eligibility unverified". |
| Google Calendar | **Blocked** | OAuth client id/secret + consent for the coach calendars. | Internal scheduling unaffected; sync shows "not configured". |
| Email/SMS provider | Deliberately off | Provider keys + `DELIVERY_ENABLED=true` + consent records. | All external delivery recorded as `not_configured`/`suppressed`; in-app messaging works. |
| Approved Teamwork legal language (waiver, membership agreement) | Needed | Final approved text from Rod/counsel. | Forms use clearly labeled SAMPLE text. |
| Real prices & policies | Needed | Rod to enter in Settings → Products / Policies. | Products are "Sample …" with placeholder prices. |

## Zen Planner sign-in (updated 2026-10-12)
Rod retired the old "never submit Zen Planner login credentials" rule: Claude may click Login with Chrome's saved, autofilled credentials. Two practical notes stay: keep only one Zen Planner tab/session open at a time (a second session resets the first), and never type or paste a password into chat.
