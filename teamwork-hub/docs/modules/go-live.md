# Go-live readiness

Module `golive`. Page `/settings/go-live` (owner and admin, `settings.manage`), card on the owner
and admin Today page. Code in `src/lib/golive/*`, table `go_live_attestations`
(`src/db/schema/golive.ts`), tests `tests/golive.test.ts`, browser test `e2e/golive.spec.ts`.

The page answers one question: what is left before real families use this? Every status is
computed on each page load from the server environment and the database. Nothing is stored as
"done" and nothing is green by default.

## Statuses

| Status | Meaning |
|---|---|
| Done | The hub verified it, or (for the few items it cannot see) a named person attested it |
| Needs attention | Started, or present but wrong |
| Not started | No evidence at all |
| Not applicable | Does not apply right now; left out of the "N of M done" count |

## What "blocks going live" means

A fixed subset, defined in `readiness.ts` (`BLOCKING_SECTIONS`, `NON_BLOCKING_ITEM_IDS`):

- every item in **Hosting and safety** (includes the rehearsed backup),
- every item in **Legal text** except the message template count,
- every item in **Payments**, but only when the hub bills families itself. "Bills families itself"
  means at least one Stripe value is set, or at least one current membership is billed by Stripe,
  PayPal or by hand (not by Zen Planner).

An item blocks only while it is neither Done nor Not applicable. Everything else (messages, catalog,
migration, people, integrations, open decisions) is listed but never blocks, with one exception: an
item outside those sections may set `blocksWhenWrong` when the hub has positive evidence that it is
set up wrongly. Today that is only "The hub sees each visitor's real address" (see Integrations).

## Items and where each status comes from

### Hosting and safety
| Item | Source |
|---|---|
| Not in demo mode | `APP_MODE` |
| Session secret | `SESSION_SECRET`: not the `.env.example` value, 32+ characters, not a repeated pattern. The value is never shown |
| https | `APP_URL` starts with `https://` |
| File storage | `STORAGE_BACKEND=s3` **and** a passing storage check for that backend. "Check storage now" writes a small file, reads it back and deletes it (`storage-check.ts`), and records the result on the File storage integration row. A failure is recorded as a failure. Local disk is always Needs attention |
| Restore rehearsed | **Attested** (date, who, required note). The hub cannot see the hosting provider's backups |
| Worker ran in 24 h | A `jobs` row for this organization finished by a `worker-…` process in the last 24 hours. Jobs run with "Run now" (`manual-…`) do not count |
| Error reporting | `SENTRY_DSN` set, or **attested** "going live without it" |
| Staff two-step policy | `settings.requireStaffMfa` |
| Owner/admin enrolled | `users.mfa_enabled` for every owner and admin that is not disabled; lists who is missing |
| No demo data | In a non-demo mode: counts of `is_demo` logins, people and products. Not applicable while `APP_MODE=demo` |

### Payments
| Item | Source |
|---|---|
| Stripe keys | The three Stripe variables; mode from the key prefix (TEST / LIVE). Live keys are Needs attention until both test-mode items below are Done, and outside production mode (where the hub refuses them) |
| Webhook reached the hub | A `webhook_events` row with a valid signature. `webhook_events` has no organization column: an event counts when its metadata names this organization, or when this is the only organization in the database |
| Test-mode saved method | A Stripe payment method whose setup was confirmed by a processed, verified `setup_intent.succeeded` event with `livemode = false` |
| Test-mode charge | A settled, provider-verified Stripe charge matched to a processed, verified event with `livemode = false` |
| Fee data | Stripe-reported fees on any transaction, or owner-entered estimates for both card and bank |
| Retry schedule confirmed | The autopay settings no longer list the retry days as unconfirmed (saving Settings → Payments confirms them); shows who saved and when from the audit log |

### Messages
Email provider variables and `DELIVERY_ENABLED`; an email the provider confirmed as delivered (for
SMTP, accepted); SMS provider variables or an **attested** "not used"; quiet hours and consent
settings **attested** as reviewed (the current values are shown next to the tick).

### Legal text
One item per active form template (the published version's `is_sample_text`), a "missing" item when
there is no waiver or no membership agreement template, one item per built-in wording, the referral
"How it works" text, and a count of message templates still marked sample.

**The sample marker.** Before this module, sample wording was marked three ways: a column on form
versions, a column on message templates, and the words "SAMPLE TEXT" inside code constants. It is
now one boolean everywhere (`src/lib/sample-text.ts`):

- `form_template_versions.is_sample_text` and `message_templates.is_sample` (unchanged columns);
- built-in wording declares a `Wording` with `defineWording({ …, isSample })` next to its text:
  e-signature consent, bank debit authorization, showcase consent, news watch opt-in, wins
  marketing consent, card update instructions. `src/lib/golive/wordings.ts` lists them;
- the referral text has `howItWorksIsSample` beside it in the growth settings, with a checkbox in
  Settings → Growth;
- seeds and starter templates write `SEEDED_AS_SAMPLE` instead of a bare `true`.

Nothing reads the prose to decide. Built-in wording is replaced in code: when the approved text
arrives, change the text, bump its version string and set `isSample: false`.

### Catalog and policy
Teamwork catalog plans loaded and how many are still inactive drafts (`catalogStatus`), the family
discount and other membership policy keys still in `unconfirmed`, active locations, repeating
classes and upcoming sessions.

### Data migration
Committed Zen Planner imports per kind (people, memberships, bills, attendance) with date and row
counts, rows waiting for an identity decision, the latest saved reconciliation and its differences,
memberships still billed in Zen Planner versus cut over, and cut-over memberships without a signed
agreement or an active saved payment method.

### People
Non-demo staff logins (active, invited, expired invite), guardians with and without a login,
athletes under 18 with no guardian link, athletes with no birthday.

### Integrations
Optional connections. An integration that is simply not set up is **Not applicable** (the gym may
never use it), so it does not count against "N of M done". None has a tick, because each is checked
from real state.

| Item | Source | Statuses |
|---|---|---|
| PayPal and Venmo | The three PayPal variables and `PAYPAL_ENV`; proof is a settled PayPal transaction on this organization's books with `verification = provider_verified` (the date of the latest is shown). The raw `webhook_events` count is not used: that table has no organization column | Not applicable with no values (Needs attention if a current membership is marked billed by PayPal); Needs attention when partly set (names the missing variables), when live credentials are set outside production mode, or when configured with no confirmed payment yet; Done once PayPal has confirmed a payment |
| Hawkin Dynamics force plates | `HAWKIN_REFRESH_TOKEN`, `sync_runs` for provider `hawkin`, the Hawkin integration row's last error | Not applicable with no token (still says when a sync last worked); Not started with a token and no run; Needs attention when no run has succeeded or the most recent failed; Done with a successful run and no later failure |
| Google Calendar for coaches | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CALENDAR_TOKEN_KEY`; `calendar_connections` (connected, in error, latest `last_sync_at`) | Not applicable with no values; Needs attention when partly set, when a connection is in error (lists whose), or connected but never synced; Not started when no coach has connected; Done with a connected calendar and a recorded sync |
| TeamBuildr history | `import_batches` with source `teambuildr`. There is no live connection, only file imports | Not applicable with none; Needs attention with an upload waiting; Done with a committed import (date of the latest) |
| The hub sees each visitor's real address | See below | See below |

**Visitor address (the "trusted proxy" question).** The hub has no setting for this. It always takes
the **first** value of the `X-Forwarded-For` header: for the address on a sign-in record, the
per-address limits on the public forms and the showcase page, and the address kept as signature
evidence. That is correct only when the hosting proxy sets or replaces the header; if the proxy only
appends to it, a visitor can choose the address the hub sees. The item says this in its detail every
time, then:

- **Not a hosted deployment** (demo mode, or `APP_URL` is not https): Not applicable. There is no
  hosting proxy to check.
- **Hosted, fewer than 5 sign-ins on record:** Not started (too little evidence).
- **Hosted, and none of the last 20 sign-ins (at least 5) carries any address:** Needs attention and
  **blocks going live**. This is the one thing the hub can actually see is wrong: the header is not
  arriving, so every visitor shares one rate-limit bucket and signatures record no address. It
  cannot be ticked away.
- **Hosted and addresses arrive:** the hub shows how many of the last sign-ins carried one and how
  many different addresses, but it cannot see whether the proxy replaces the header. So this is
  Needs attention (not blocking) until a person attests `proxy_header_checked` ("I checked with the
  hosting provider's documentation that its proxy sets or replaces the header", note required);
  then Done, shown as attested. This is the only tick in the section, and only because the hub
  truly cannot check it.

A real trusted-hop setting (choose which hop to trust) is still not built; see `DECISIONS.md`.

### Open decisions
`src/lib/golive/decisions.ts` is a typed list (id, question, current behaviour, where to change it,
how to read the current value) of the open decisions in `DECISIONS.md` that map to a setting.
`DECISIONS.md` is never parsed. Each shows its current setting value and "Confirm as is", which
stores who confirmed, when, and the value confirmed. If the setting changes later, the item goes
back to Needs attention and says what it was when confirmed. Decisions that are not a setting
(wording, provider choices, code changes) are only in `DECISIONS.md`.

## Manual ticks

Only the keys in `ATTESTATIONS` (`attestations.ts`) and the decision keys can be ticked. Anything
the system can check has no key, so `attest` refuses it (tested). A tick stores the person's name,
the date they give (not in the future) and a note, is shown as "Attested by a person", is audited
(`golive.attested`, `golive.decision_confirmed`, `golive.attestation_withdrawn`,
`golive.storage_check`) and can be withdrawn; withdrawn rows are kept.

## Today card

Owners and admins see "Go-live: N blocking items" at the top of Today, linking to the page. It is
the same computation and renders nothing when N is 0.

## Not done

- No "send a test email" button: the email item reads real delivery records, so the first real
  message to a staff member's own address is the test.
- There is still no setting for which proxy hop to trust; the page reports what the hub does and
  what it can see (Integrations, visitor address). GoHighLevel and Zen Planner webhooks are not in the
  Integrations section (GoHighLevel shows under Messages when it is the text provider).
- PayPal proof needs a real confirmed payment; there is no "test the connection" button, and no
  PayPal sandbox was contacted here.
- The Today card recomputes the whole report on each load (about forty small queries). Fine at this
  size; cache it if Today becomes slow.
- Built-in wording cannot be edited in the app; it needs a code change.
- Verified against synthetic data and unit-test fixtures only. No real Stripe, email or bucket was
  contacted.

## Browser test note: the access test that failed once

`e2e/golive.spec.ts` "operations and families cannot open the page" failed once at 390px with
"Tearing down context exceeded the test timeout". Reproduced on 2026-11-14: 2 failures in 15 runs,
then 2 in 10 with protocol logging. Cause: the refusal is a redirect to `/denied` that arrives after
the first bytes of the page (the loading shell streams first), so `page.goto` returned before it.
The test then asserted only an absence (no "Go-live readiness" heading), which is true of the
loading shell, and ended; the browser context was closed while the redirect was still committing
and the close hung until the timeout. The page and the access rule were never wrong. The test now
waits for `/denied` and its heading before asserting the absence, and waits for the Today page's
heading before asserting that the card is absent. 15 of 15 after the change. The same ending in
`e2e/events-waitlist.spec.ts` (coach refused on `/events`) was fixed the same way. No timeout was
lengthened and no retry was added.

