# Blockers & access requests

Items that need Rod (or a provider) to unblock. Independent work continues without them.

| Item | Status | What's needed | Impact while blocked |
|---|---|---|---|
| Zen Planner Studio read-only exploration (studio.zenplanner.com, rod@teamworkbloomington.com) | **Blocked** | This cloud container has no Chrome extension/browser session for Rod and no stored credentials. Passwords must not be shared in chat. Options: (a) run a session with Claude in Chrome attached to Rod's signed-in browser, or (b) export reports (members, family links, memberships, attendance, billing) as CSV and drop them into the Import Center. | Zen Planner parity is based on public product docs + the field names the existing scoreboard already parses (`teamwork-scoreboard/docs/DATA-MAPPING.md`). Marked "public docs" in FEATURE_MATRIX. |
| Hawkin Cloud sign-in / API token | **Blocked** | A Hawkin Cloud API refresh token (Cloud → Settings → Integrations) set as `HAWKIN_REFRESH_TOKEN` on the server. Region/base URL to confirm. | Hawkin adapter implemented against public docs and tested with fixtures only; status shows "not configured". |
| TeamBuildr account access | **Blocked** | Account exports (maxes, workout logs, questionnaires) as CSV/XLSX. No public unrestricted API is assumed. | Import mappings are configurable and marked unverified. |
| Stripe sandbox | **Blocked** | `STRIPE_SECRET_KEY` (test mode `sk_test_…`), `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`. | Adapter tested with signed fixture webhooks (contract tests); no sandbox verification yet. |
| PayPal / Venmo sandbox | **Blocked** | PayPal REST sandbox app client id/secret + webhook id. Venmo requires US merchant eligibility via PayPal. | Adapter tested with fixtures; Venmo shown as "eligibility unverified". |
| Google Calendar | **Blocked** | OAuth client id/secret + consent for the coach calendars. | Internal scheduling unaffected; sync shows "not configured". |
| Email/SMS provider | Deliberately off | Provider keys + `DELIVERY_ENABLED=true` + consent records. | All external delivery recorded as `not_configured`/`suppressed`; in-app messaging works. |
| Approved Teamwork legal language (waiver, membership agreement) | Needed | Final approved text from Rod/counsel. | Forms use clearly labeled SAMPLE text. |
| Real prices & policies | Needed | Rod to enter in Settings → Products / Policies. | Products are "Sample …" with placeholder prices. |
