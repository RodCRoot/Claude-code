# Decisions

## Five decisions that change the architecture or migration

These are the decisions whose answer changes what gets built or how the migration runs. Where the code already takes a default, that default is named so Rod can confirm or overturn it. Details and evidence are in `docs/REPLACEMENT-PLAN.md`.

1. **Which subscriptions are actually in use and intended for retirement.**
   Confirmed by Rod (2026-10-14): Zen Planner Studio; Hawkin Cloud with leased force plates; GoHighLevel on the "Automatic Members" agency plan; Google Workspace; TeamBuildr. PushPress is not in use. Tiers, renewal dates, the plate lease terms and the Automatic Members agreement are still unknown.
   Recommended default: Zen Planner and GoHighLevel are the retirement targets under decision 1, as two separate cutovers (GHL last, since it can stay as the SMS transport); TeamBuildr is gated on the essentials list; Google Workspace stays (email and calendar); Hawkin is never a retirement target (see decision 3), and the plate lease makes that firmer.
   Consequence: three cutovers to plan (Zen Planner, GHL, TeamBuildr) and one system to keep integrating with (Hawkin). GHL automations built inside GHL must be inventoried and rebuilt as Hub rules before GHL goes; the SMS number needs a porting decision.

2. **Stripe as the primary processor, with PayPal and Venmo for one-time payments only.**
   Decision: which provider owns recurring billing.
   Recommended default (what the code does): Stripe Billing or PayPal Subscriptions may hold a recurring membership, but the UI offers Venmo for one-time invoices only because recurring Venmo is not documented by PayPal (`docs/modules/billing.md`, "Venmo decision"). Stripe is the processor the cutover plan and the sandbox checklist are written around.
   Consequence: payers re-enter payment details on hosted checkout (or Rod requests a PAN migration through Stripe's Data Migrations team). Every recurring charge has exactly one owner, enforced by DB checks and the renewal job. Choosing PayPal Subscriptions as primary instead would be supported by the code but would need its own sandbox verification first.

3. **Hawkin stays the capture system; the Hub syncs read-only.**
   Decision: whether the Hub ever replaces force-plate acquisition.
   Recommended default (what the code does): no. The Hub holds a read-only API client and a CSV import; it never writes to Hawkin and never talks to a plate. Metrics imported from Hawkin keep `defined_by = hawkin`; Teamwork-derived values carry their own formula keys.
   Consequence: the Hawkin subscription cannot be cancelled by this project under any outcome. The dependencies that would have to be resolved first are listed in `docs/REPLACEMENT-PLAN.md`, decision 4. Historical import and ongoing sync are valuable on their own but do not change this.

4. **TeamBuildr retirement gate: which features must exist first.**
   Decision: what has to be true before the TeamBuildr subscription ends.
   Recommended default: the essentials list in `docs/REPLACEMENT-PLAN.md`, decision 2: program building and assignment, athlete logging on phones and weight-room tablets with offline tolerance (checked on real devices), maxes with percentage loading, coach review, a confirmed historical import of maxes and workout logs, and a comparison period signed off by the coaches. Historical import alone is not enough.
   Consequence: three of those items are not done (device check, confirmed import mappings, comparison period). Until they are, TeamBuildr stays. Nice-to-have items (calendar-wide drag, native app, full report catalogue, VBT UI) do not gate retirement.

5. **Family discount and the other policy confirmations.**
   Decision: the 13 membership and payroll policy questions listed under "Open decisions for Rod (Teamwork membership policy, wave 4)" below, starting with the family discount percentage (10% is in use and flagged; one source says 15%).
   Recommended default (what the code does): every value is a Settings entry with a "Needs confirmation" badge until confirmed; the seeded plans are labelled samples; the discount is applied by `syncFamilyDiscount` at the saved percentage.
   Consequence: no member can be cut over at a real price until these are answered, because the renewal job would invoice sample amounts. Answers are Settings changes, not code, so they do not block anything else.

## Implementation decisions

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
| D12 | Separate worktree per parallel module agent; lead merges and renumbers Drizzle migrations | Parallel delivery without shared-file churn; migrations regenerated against merged schema (no drift) | Low |
| D13 | Job runners claim only job types they have handlers for | Specialised runners (and parallel tests) never steal and fail others' jobs | Low |
| D14 | Body-map review tasks carry no symptom details | Operations staff can see tasks but have no health access | Low |
| D15 | Signer identity step-up on by default for waivers/agreements; staff-witnessed in-person fallback when email isn't configured | Typed name alone is not adequate identity evidence | Low (org setting) |
| D16 | Google Calendar scope `calendar.app.created` + `calendar.freebusy` (Teamwork-owned calendar per coach) | Narrower than full calendar access | Low |
| D17 | Scheduled work rides the existing Postgres outbox: the worker creates one job per organization, job type and facility-local date (dedupe key) after 2:00 AM local; each athlete or referral runs in its own transaction; pages keep calling the same evaluators | No second scheduler to deploy; idempotent evaluators make reruns and concurrent page loads safe; one bad record cannot stop a night's run | Low |

## Open decisions for Rod (from the security review)
- Which proxy hop to trust for client IP (rate limit + signature evidence) — set at deployment.
- Coaches currently see facility-wide attendance/no-show reports (not health data). Restrict to assigned athletes?
- Guardians see co-guardians' email/phone on their child's page (separated parents). Hide?
- Login resolves by email across orgs; fine single-tenant, revisit if multi-tenant.
- Exporting an approved payroll run marks it "exported" on download (GET, audited, idempotent; approved runs are immutable). Move to an explicit "Mark exported" button?

## Open decisions for Rod (Teamwork membership policy, wave 4)
Defaults come from Rod's documented procedures; every value is editable in Settings → Membership policy, and unconfirmed ones show "Needs confirmation".
1. Family discount: 10% or 15%? (Sources disagree; 10% is in use and flagged.) Reference plan prices also differ between sources; the seeded "Sample —" plans are labelled to confirm.
2. Does the partial first month (stub) count toward a 6- or 12-month commitment? Currently no: the term starts on the 1st after the stub.
3. Should a hold extend the commitment end date? Currently no.
4. In Season "commitment carries over": read as In Season months counting toward the commitment, end date unchanged.
5. Are In Season terms capped for members not on a 12-month plan? Currently uncapped.
6. "2 months" of hold / In Season is counted as 62 days. Calendar months instead?
7. Unused sessions when a paid month goes on hold: weekly limit × days left ÷ 7, minus attended/no-show sessions; unlimited plans need staff to enter the number.
8. Do past-due memberships count as "active" for punch-card use? Currently no.
9. Generic decline / "do not honor" treated as retryable; family card-update wording is sample text.
10. A plan version's own cancellation notice overrides the 30-day policy. Intended?
11. College weekly plan bills every 7 days from start. Align to Mondays instead?
12. Membership audit: In Season plans are recognised by name ("In Season"); siblings are grouped by payer account; Zen Planner-era amounts are estimates (no ZP billing history imported).
13. Payroll: flag thresholds (over 12 h, 2.5× usual shift, under 0.5 h, 90 min off usual start) and the flat 17% deduction are placeholders; confirm with the accountant.

## Open decisions for Rod (athlete experience wave)
Each one is a setting or a small change, not a rebuild. The current behaviour is listed first.
1. Any edit to a recruiting showcase pauses its public link until it is published again. Keep links live through small edits?
2. Left/right asymmetry numbers are kept off showcases and monthly recaps. Show them?
3. The showcase consent wording and the referral page wording are labelled sample text. Supply the real wording.
4. Referral program: does "signs up" mean the first settled payment (current) or a number of days active? And when the new family's first invoice is smaller than their discount, the rest is not carried over to a later invoice (current). Carry it over instead?
5. Camps and clinics are not sellable online yet: a product is not linked to a specific session series.
6. XP is never taken back after an attendance correction or a removed shoutout (the ledger is append-only).
7. Leaderboards: an athlete with no birthday on file is not ranked; staff see the same public rows as families; families only see the age bands their own athletes are in.
8. Gym TV links never expire; they work until revoked. Add an expiry?
9. Operations staff can read session feedback; coaches never see billing signals on the retention board. Confirm both.

## Decisions Rod has made
- **Referral reward (2026-11-11):** $50 when the referred family signs up. Implemented as a $50 account credit to the referring family, earned when the new family's first payment settles, and issued only after a staff member approves it. The demo seed uses this value. In a real org it is set in Settings → Growth (the program stays off until an owner turns it on). Still open: whether "signs up" should mean the first settled payment (current) or a number of days active.
- **Referral reward for the new family (2026-11-11):** the referred family also gets $50 off. Implemented as a configurable amount in Settings → Growth ("Discount for the new family"; empty, meaning off, in a real org; $50 in the demo seed, replacing the sample session credit).
  - *When it applies:* it is reserved when the referred lead is converted to an athlete on a new billing account, and it comes off that account's **first open invoice above $0** as an invoice discount. This happens the moment the invoice is created (billing calls the referral evaluator), and also on page load and in the nightly job.
  - *No staff approval, on purpose:* a discount only lowers an invoice the family still has to pay. Nothing is paid out, nothing is recorded as a payment, and a refund returns only what the family actually paid, so the discount reverses itself. Staff can still decline a reserved discount before it applies (People → Referrals).
  - *The one case that does need approval:* if the first invoice was already paid before the discount could apply (for example the amount was configured afterwards, or the first invoice is billed by a provider subscription), it becomes a pending **account credit** and waits for the same staff approval as the referring family's credit, because credit is money-like.
  - *Abuse guards:* one per new payer account and one per referral (database unique indexes), so a second child or a second referral never stacks; never for existing or returning families (nobody on the account had a membership, and the account had no invoice, before the inquiry; enforced even if "the referred family must be new" is switched off); never for self-referrals or leads put on the referrer's own account (rejected at attribution and again at conversion); not applied while a payment is in flight; not on invoices billed by a provider subscription or Zen Planner; capped at the invoice balance with no carry-over; a voided unpaid invoice gives the discount back for the next invoice.
  - *Refunds, both sides the same:* a first payment refunded in full does not earn; if it is refunded after earning, every reward still pending (the referrer's credit and any converted new-family credit) is withheld automatically with the reason "First payment was refunded", and approval is refused in the meantime. Credit a staff member already approved is not taken back automatically; the Referrals page flags it for review.
- **Parents can log at-home sessions for athletes under 13 (2026-11):** a guardian may finish an On Your Own session and enter its effort rating for a child.
  - *Which guardians:* the guardian link must have **both training access and booking access** (new capability `training.log_at_home` in `policy.ts`). Training access because they already see the library and logged effort; booking access because that is the existing flag for acting on the child's activity. A co-parent who cannot book (Casey) or cannot see training cannot log. Health access is not required: effort ratings are training data, as on the load page.
  - *Which athletes:* under 13 by the birthday on file. **An athlete with no birthday on file does not count as under 13 here.** Elsewhere an unknown age takes the more restrictive reading (the library is limited to under-13 sessions); here the restrictive reading is that nobody else may log in the athlete's name. Staff enter the birthday to enable it. It stops on the 13th birthday.
  - *Scope:* at-home sessions only. Workouts, habits and practice or game logs stay with the athlete and coaches.
  - *Record:* the completion stores who logged it and `logged_as = guardian`; the audit entry says a parent logged it on behalf of an athlete under 13; coaches see a "Logged by parent: name" badge in the review queue and families see "logged by a parent" in the history. It counts toward streaks, XP and load exactly like the athlete's own log (same rows).
- **One gym TV board for the whole business is fine (no per-location boards).** Nothing to build; the board stays one per organization.
- **News clips need approval (2026-11-12):** "have me approve them before sharing". No auto-sharing exists; owner/admin approve every clip, with a setting to extend approval to operations or coaches.
- **Local news sources (2026-11-12):** watch the Herald-Times, the Bedford paper and Greene County sports coverage, plus alumni college athletes.
- **Pre and post session check-ins (2026-11-12):** short questionnaires tracked over time: liked, did not like, anything that hurt, notes, intensity and soreness, not only a 1 to 5 rating.
- **Parent screens should match Zen Planner closely (2026-11-11):** built from memory; awaiting Rod's screenshots or screen recording to verify details (`docs/modules/zp-parity.md`).

## Open decisions for Rod (owner tools wave)
1. Check-ins: likes, dislikes and rating reach the coach with the athlete's name only if the athlete ticks "show my coach" (the old form's promise). Make named the default?
2. Check-ins: should a coach be able to fill one in on behalf of a young athlete?
3. News watch: the Bedford Times-Mail is effectively not covered by free feeds. Paid news service, or add Bedford clips by hand?
4. News watch: the news search feed is a third-party service; review its terms before real use.
5. Wins: consent wording, caption templates and XP values are sample values.
6. Existing saved cards in Zen Planner: ask Zen Planner's processor for a transfer to Stripe, or have families re-enter once at cutover?
7. Bank pay: offer a monthly discount for paying by bank account? (Card surcharges are not built; ask the accountant.)
8. Membership agreement and waiver wording: everything in the app is sample text until the real documents are supplied.

## Zen Planner import, catalog and discounts (2026-11-13)

Built from `docs/ZENPLANNER-MAP.md`. Defaults in use, each changeable without code:
- **Prospect Status → lead stage:** New Prospect → New; Call 1 and Call 2 → Contacted; Ready to Sign → Assessment Done; Not Interested → Lost. The hub's own stages were kept rather than replaced with Zen Planner's five. Say so if the pipeline should use Zen Planner's stages instead.
- **Health columns** (Special Needs, Medications, Allergies) are visible to owner, admin, the assigned coach and guardians with health access; operations sees only that something is on file.
- **Imported guardians** get no health access and are not emergency contacts until staff change it per family.
- **Plan catalog:** 20 draft plans at the Zen Planner prices, named by us, unpublished. To confirm per plan: the name, the weekly limit for In Season (1x assumed) and Linton (unset), monthly billing for Bootcamp and Fitness Together Unlimited, and what sits between the $10 and $60 Fitness Together options.
- **Discount review** groups by the saved family percent (10%, still unconfirmed; the 10 vs 15 question above decides it). For each non-standard rate the owner decides: keep, convert to the family discount, or end.
- **Short-run programs** (challenges, Summer 8-week, Vertical Jump, All-Girl Speed & Strength) are not memberships here; they belong in Events.

