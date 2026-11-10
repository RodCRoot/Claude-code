# Showcase module (Athlete Showcase and Monthly Progress Recap)

Owner paths: `src/lib/showcase/**`, `src/db/schema/showcase.ts`, `drizzle/0020_showcase.sql`,
`src/components/showcase/**`, `src/app/s/[token]/**`, `src/app/(app)/showcase/**`,
`src/app/(app)/recap/**`, `src/app/(app)/training/recaps/**`, `src/app/(app)/people/showcases/**`,
`src/app/(app)/settings/showcase/**`, `src/app/api/showcase/**`, `scripts/seed/showcase.ts`,
`tests/showcase*.test.ts`. Screenshots: `docs/screenshots/showcase/`.

Purpose: give athletes and families something worth taking outside the gym. The Showcase is a
page of numbers recorded at Teamwork that an athlete can send to a college or club coach. The
monthly recap is a page a family reads at home. Both are assembled from rows other modules
already write. No other module's write path was changed.

## What's built

| Area | Where | Notes |
| --- | --- | --- |
| Showcase builder | `/showcase` (athlete, guardian) | Pick items, live preview, save draft, publish with consent, turn off, new link, PDF. |
| Public page | `/s/[token]` | No sign-in. One-pager, prints to one page. |
| Showcase PDF | `/api/showcase/[athleteId]/pdf` | Family only. Same payload as the page, content hash in the footer. |
| Staff list | `/people/showcases` | Read-only. Owner and admin can turn a link off. Coaches see assigned athletes only. |
| Settings | `/settings/showcase` (owner, admin) | Showcase on/off, minimum age, default link lifetime, recaps on/off, recap grace days. Audited. |
| Monthly recap | `/recap`, `/recap/[yyyy-mm]?athlete=` | Family list and one month. Staff may preview an athlete in their scope. |
| Coach queue | `/training/recaps` | Notes for the month, optional early finalize. Assigned coach, owner, admin. |
| Monthly job | `recap.monthly` in `src/lib/jobs-registry.ts` | Creates recap records and an in-app notice. Sends nothing. |
| Athlete Home | `src/components/showcase/home-cards.tsx`, mounted in `today/_components/athlete-home.tsx` | Showcase card, "This month's recap" link, "recap is ready" notice. |

## Privacy model

The Showcase is the only place in the Hub where athlete data leaves the signed-in app, so it is
built so that the wrong data cannot get out by accident, rather than relying on each screen to
remember to hide it.

1. **One reader.** `src/lib/showcase/catalog.ts` is the only code that reads athlete data for a
   Showcase. It selects named columns: preferred or first name, last name, sport, position,
   graduation year, school, body mass, test metric values, maxes, a count of attended sessions,
   the first membership month, and the weekly streak. It reads the date of birth once to work
   out an age band and does not return it. It does not query wellness, body map, forms, notes,
   invoices, households, emails or phone numbers at all.
2. **One composer.** `composeShowcase` in `compose.ts` builds the public payload field by field
   from the catalog and the config. The payload type (`ShowcaseData`) has thirteen keys, listed
   in `SHOWCASE_DATA_KEYS`. The public page, the builder preview and the PDF all render that
   object and nothing else.
3. **One allowlist.** `allowlist.ts` defines the only keys a config may hold. `sanitizeConfig`
   rebuilds a config from scratch, so unknown keys are dropped, not stored. Server actions read
   form fields by allowlisted name (`configFromForm`).
4. **Checked against the athlete.** A chosen metric or lift must be in that athlete's catalog, so
   posting another athlete's metric id, or a metric that is not allowed, is refused.

### Allowlist

May appear, each only when chosen:

| Item | Source | Notes |
| --- | --- | --- |
| Name | `people` | First name only, first name and last initial (default), or full name. |
| Sport, position, graduation year, school | `athletes` | |
| Age band | derived | Two-year bands ("15 to 16"), "Under 11", "19 or older". Never an age or birthday. |
| Body weight | `athletes.body_mass_kg` | Shown in lb. Only when on file. |
| Test results (up to 8) | `metric_values` through `athleteMetricSeries` | Categories sprint, jump, strength and force plate only. Latest and best with test date, test name and unit. |
| Lift maxes (up to 6) | `maxes` | Best measured max, or the latest estimate when nothing was measured. Labelled Measured or Estimated. |
| Strength relative to body weight | derived | Only when body weight is on file. |
| Sessions in the last 12 months | count of attended bookings | A count. No dates, times or session names. |
| Weekly streak, member since | engagement streak, first membership start | Month and year only for member since. |
| Bio | typed | Plain text, 400 characters, angle brackets and control characters removed. |
| Highlight video | typed | `https` only, real host, no credentials. Rendered as a link with `rel="noopener noreferrer nofollow"`. Never embedded. |
| Contact email | typed by the publisher | Optional. Account emails and phone numbers are never used. |

Never available, whatever is posted: wellness answers or scores, body map reports, injury or
health intake, coach notes, billing, which days an athlete attended, date of birth, home address,
account emails and phone numbers. Wearable metrics (sleep, heart rate), body composition,
left/right asymmetry measures (coaches read them as an injury screen; `isShareableMetric`) and
uncategorized metrics are not offered. Height is not stored anywhere in the Hub, so it cannot be
shown; adding it would need a column and an allowlist entry.

### Verified

A result is marked "Verified by Teamwork on <date>" only when every value behind it was imported
from a device or vendor (Hawkin, TeamBuildr) or entered by a login whose role is owner, admin,
operations or coach. A value entered by an athlete or guardian login, or with no author, is shown
as "Recorded <date> (not verified)". Maxes: measured maxes entered by staff or imported are
verified; estimated maxes never are. The methods footnote on the page states this rule, names
each test and its protocol, and says who recorded it.

### Comparability

Latest, best and the trend line come from `athleteMetricSeries`, which applies
`src/lib/science/comparability.ts`: same test type, protocol, source, calculation version,
aggregation level and unit. Results measured another way are never joined to the trend or used
as the best; the footnote says how many were left out. A sparkline appears with three or more
comparable results.

## Consent and control

`showcaseAccess` (`access.ts`) derives everything from `athleteCapabilities` in
`src/lib/authz/policy.ts`.

| Viewer | Draft | Publish | Turn off |
| --- | --- | --- | --- |
| Athlete under 18, at or over the minimum age (default 13) | yes | no | yes |
| Athlete under the minimum age, or with no birthday on file | no | no | yes |
| Adult athlete (18 or older) | yes | yes | yes |
| Guardian with an active guardianship of a minor | yes | yes | yes |
| Guardian of an adult athlete | yes | no | yes |
| Payer-only adult, unrelated guardian, kiosk, another organization | no | no | no |
| Coach, operations | no | no | no |
| Owner, admin | no | no | yes (staff list) |

- A guardian's profile access only ever comes from an active guardianship. Paying for an athlete
  grants `billing.read` and nothing here.
- **Guardian flags.** Health access is irrelevant: nothing health-related exists in a Showcase.
  A guardian **without training access** sees no numbers in the builder, cannot add, remove or
  change test results, lifts or consistency, and cannot publish a Showcase that includes them.
  Their profile edits keep the other guardian's training choices as they were.
- **Publishing records consent** in `showcase_consents`: who (user and person), relationship
  (guardian or self), when, the exact config, the policy version and the full policy text, and
  the expiry. The table is append-only (database trigger). Turning a link off writes a
  `withdrawn` row. Every publish, revoke, rotate, draft change and PDF download is also in the
  audit log. Tokens are never written to either.
- **Any change to what is shown returns a published Showcase to draft.** The link shows the
  generic page until someone who may publish publishes again with fresh consent. This is
  stricter than "a change by a non-guardian": a guardian's own change also needs their consent
  again, so the page can never show something nobody agreed to. Republishing keeps the same link.
- The consent wording (`SHOWCASE_POLICY_TEXT`, version `showcase-2026-1`) is **sample text** and
  should be reviewed before real families use it.
- **Settings** (`organizations.settings.showcase`): `enabled` (default on), `minAge` (default 13,
  range 8 to 17), `defaultExpiryDays` (default 90; choices 30, 90, 180, 365, none),
  `recapEnabled` (default on), `recapGraceDays` (default 3). Turning Showcase off closes every
  link at once without deleting anything.

## Token handling

- A token is 32 bytes from `crypto.randomBytes` (256 bits), written as 43 base64url characters.
  The URL is `/s/<token>` and holds no name or id.
- Only `sha256(token)` is stored (`showcases.token_hash`, unique, CHECK 64 hex characters). A
  database read never yields a working link. The plain token is returned once, by the publish
  or "make a new link" action, and shown to the publisher to copy. It cannot be shown again;
  the remedy is a new link.
- **Revoke** clears the hash and sets `revoked_at`. The old link can never work again, and the
  next publish makes a new one. **Expiry** is checked on every read. **Rotate** replaces the hash.
- `publicShowcase` returns null for a malformed token (no database read), an unknown token, a
  draft, a revoked or expired link, Showcase switched off, and an archived person. The page
  answers all of them with the same generic not-found page, so a link cannot be probed.
- Headers on `/s/*`: `X-Robots-Tag: noindex, nofollow` in every mode, `Cache-Control: private,
  no-store`, the app's strict nonce CSP. The page also sets `<meta name="robots">` and
  `referrer: no-referrer`. It loads nothing from another origin: the logo is used only when it
  is a same-origin path, and the video is a link.
- **Rate limit** (`rate-limit.ts`, called from `src/proxy.ts`): 60 requests a minute per client
  on `/s/*`, then HTTP 429. The counter lives in process memory, keyed by the forwarded client
  address, and is dropped every minute. Nothing about a visitor is written to the database, a
  file or a log. Behind several server instances the limit applies per instance.
- **Views**: `showcase_view_days` has four columns: showcase, organization, day, count. A hit on
  a live link adds one to that day's row. No IP, user agent or referrer is stored anywhere.
- **Demo token.** The demo seed gives the demo organization's published Showcase a fixed token
  (`DEMO_SHOWCASE_TOKEN` in `scripts/seed/showcase.ts`) so docs, screenshots and e2e tests can
  open it. Seeds only run in demo mode. Real tokens are always random.

## PDF

`renderShowcasePdf` (`pdf.ts`) draws the same `ShowcaseData` with pdf-lib and the Noto Sans fonts
already bundled for completed forms. The content hash is SHA-256 over the payload with a fixed
key order. It is printed in the footer, stored in the PDF keywords, and returned in the
`X-Content-SHA256` response header (it identifies the content shown, not the file bytes). The
PDF is generated on request and not stored. A draft is labelled "DRAFT, NOT PUBLISHED". A minor
athlete can download it only while a guardian's publication is live.

## Monthly recap

`recap.ts`. One recap per athlete per facility-local calendar month.

| Section | Source | Needs |
| --- | --- | --- |
| Sessions attended, missed, plan | bookings; plan = membership's classes per week x days in month / 7, rounded | profile access |
| Workouts logged and planned, weekly streak | workouts, engagement streak as of the month's last day | training access |
| New personal records | `detectPrs` over maxes, recorded in the month | training access |
| Badges earned | `athlete_badges` earned in the month | training access |
| Tests taken | latest result per metric in the month, change against the comparable result before it | training access |
| Goals | active goals and goals reached in the month | titles: profile access; measured progress: training access |
| Coach note | written in the coach queue | training access |
| Next month | booked sessions and goals with a target date next month | profile access |

- **No health values.** The recap reads no wellness, body map, injury or wearable data. Test
  metrics are limited to the same categories as the Showcase.
- **Guardian flags.** A viewer without training access gets `training: null`, no coach note and
  goal titles without numbers: the same things Athlete Home already shows them. Health access
  makes no difference. A payer-only adult sees nothing.
- **Open, closing, final.** The current month is computed live. After the month ends there is a
  grace period (default 3 days) for coach notes. From then on the recap is finalized by the
  monthly job, or on first view if the job has not run.
- **Snapshot.** Finalizing writes the numbers once to `monthly_recaps.snapshot` with the
  calculation key `tw_recap_v1`. A database trigger refuses any later change to the snapshot,
  coach note, month, status or key, and any delete. A corrected attendance or a new test never
  rewrites a month a family has read. A changed formula gets a new key; old months keep theirs.
- **Coach queue.** Assigned coach, owner or admin (`training.manage` and `training.write` on the
  athlete). Notes are plain text, 1,200 characters, optional, and lock at finalization. The
  audit log records who saved a note and when, not its text. Operations cannot write notes.
- **Job.** The worker enqueues `recap.monthly` once per organization per day (deduped). The
  handler finalizes last month for every active athlete who trained in it, once the grace period
  has passed. It is idempotent. It creates the recap record and sets `notice_at`, which shows a
  "recap is ready" card on Athlete Home for 21 days. **It sends no email, SMS or push.** Emailing
  a recap would go through the existing delivery settings, which are off by default; nothing in
  this module adds an external send.

## Seed

`scripts/seed/showcase.ts` (registered after engagement): a published Showcase for Maya with
Alex's consent and the fixed demo token, a draft for Leo saved by Sam, and last month's finalized
recap for both with a sample coach note. Two demo-only edits: hand-entered test values for these
two athletes are attributed to the coach (the science seed leaves them without an author, which
would read as not verified), and Maya gets a body weight.

## Tests

- `tests/showcase.test.ts` (18 tests, real Postgres): allowlist and input rules; token entropy,
  hash-only storage and non-enumerability; public payload and rendered HTML free of forbidden
  data for an athlete who has wellness, body map, notes and invoices; verified rule; comparable
  trends; view counting without visitor data; minor athlete drafts but cannot publish; change
  returns to draft; append-only consent; unrelated guardian, payer-only adult, kiosk and another
  organization; staff and coach scope; extra posted keys and foreign metrics; guardian without
  training access; minimum age and the org switch; adult self-publish; PDF text, hash and page
  count; revoke, expiry, rotation and staff revoke.
- `tests/showcase-recap.test.ts` (10 tests): month helpers; month boundaries in facility time;
  no health values; snapshot immutability including the database trigger; open, closing and
  final states; guardian flags; unrelated viewers; coach scope; the monthly job (grace period,
  idempotent, no deliveries or jobs created); worker registration and dedupe.
- `e2e/a11y.spec.ts` and `e2e/csp.spec.ts` include the seeded `/s/<demo token>`, a dead link,
  `/showcase` and `/recap` for guardian and athlete, a recap month, `/training/recaps` and
  `/people/showcases` for owner and coach, and `/settings/showcase`.

## Known limits

- Height is not on file in the Hub, so it is not offered.
- The share link is shown once. Families who lose it make a new one.
- The rate limit is per server process and in memory.
- The public inquiry form does not record the `ref=showcase` value yet; it is only in the URL.
- The "Train at Teamwork" button uses the organization's primary color with white text. A very
  light brand color would need a darker button color.
- Goal progress in a recap is the value when the recap was finalized, not on the month's last day.
- An athlete who leaves keeps a published page until it expires, is turned off, or the person is
  archived.
- The recap notice is a card on Athlete Home. There is no push or email.
