# News watch module

Owner paths: `src/lib/newswatch/**`, `src/db/schema/newswatch.ts` (plus the news columns on
`win_leads` and `wins.news_source` in `src/db/schema/wins.ts`), `drizzle/0030_newswatch.sql`
(renumbered by the lead at merge), `src/components/newswatch/**`, `src/app/(app)/wins/news/**`,
`src/app/(app)/wins/watch/**`, `src/app/(app)/wins/news-actions.ts`,
`src/app/(app)/settings/newswatch/**`, `scripts/seed/newswatch.ts`, `tests/newswatch.test.ts`,
`tests/fixtures/newswatch/**`, `e2e/newswatch.spec.ts`. Screenshots: `docs/screenshots/newswatch/`.

Owner request: "Can you monitor the herald times, Bedford Indiana's newspaper, and Greene county
(if applicable) sports news to get athlete news clips to automatically share? Also, alumni college
athletes and their mentions". Follow-up from the owner: "have me approve them before sharing".

Purpose: look for watched athletes and alumni in the headlines of local news feeds, put possible
matches in the Wins module's "Leads to check" list as **news clips**, and show a clip in the app
and on the gym TV **only after a person approves it**.

## The one rule: nothing is shared without approval

There is no automatic approval of any kind. No setting, no "likely match" shortcut, no code path.

- The nightly job only ever creates clips in the state `suggested`.
- Any staff member who reviews wins can mark a clip "Our athlete" or "Not our athlete". That is
  sorting. It shows the clip to nobody.
- Only an **approver** can approve a clip. Approvers are the owner and admins. In Settings, News
  watch the owner can also allow operations staff and/or coaches (a coach only for athletes they
  coach, and for alumni).
- The database refuses an approved clip that does not record who approved it and when
  (`win_leads_news_approved_ck`), and an approved win likewise (`wins_approved_ck`).
- Approval covers the in-app Wins feed, the alumni section and the gym TV. It never covers public
  marketing: the app posts nothing to social media or any website, and the marketing queue stays
  a staff copy-and-post step that needs the family's own, separate consent per win.

## What's built

| Area | Where | Who |
| --- | --- | --- |
| Settings: on/off, who may approve, daily request cap, sources (add, edit, switch off, delete, last result) and the limits in plain words | `/settings/newswatch` | owner, admin |
| Watch list: current athletes (opt-in state, "Ask the family", matching words, "Stop watching") and alumni (add, edit, basis, remove) | `/wins/watch` | staff who review wins; alumni changes: owner, admin, operations |
| News clips in "Leads to check": our athlete / not our athlete / ignore, and "Add a news clip by hand" | `/wins/leads` | staff who review wins (a coach: own athletes and alumni) |
| Approval queue: pending clips newest first, approve / reject / not our athlete, bulk approve for ticked rows, approved clips with one-step "Take down" | `/wins/news` | approvers act; other staff read |
| "N news clips waiting for your approval" | staff and coach `/today` | approvers only |
| Family opt-in card with the exact wording | `/wins` | guardians, athletes |
| "In the news" filter on the gym wins feed; "Teamwork alumni in college" section | `/wins`, `/wins?show=news` | athletes, guardians, staff |
| "Mark as alumni" card | `/people/[personId]` overview | owner, admin, operations |
| News clips on the gym TV (inside the existing Wins panel) | `/display` | display devices |
| Nightly job with Run now and a result line | `/settings/jobs` | owner, admin |

## Honest limits

- It reads **headlines and short summaries from feeds**. It never opens an article, and never
  stores or shows article text or pictures.
- **Paywalled papers** are covered only through what their own feed or a news search feed
  exposes. The Hub does not get around a paywall or a bot block: a 401, 402 or 403 is reported as
  it is and the source is backed off. A story that names an athlete only inside the article is
  found only if the news search returns it for that name, and then it is marked "possible" because
  the Hub cannot see the name itself.
- **It can miss stories and it can match the wrong person.** Names repeat. That is why every clip
  needs a person's approval and why "Not our athlete" teaches the matcher.
- **A news search feed is a third-party service.** Its availability, results and terms can change
  without notice, and its terms may not allow this kind of automated use. Each source can be
  switched off. A licensed news API could replace it: `NewsSourceAdapter` in
  `src/lib/newswatch/feed.ts` is the seam (two adapters exist, `rss` and `search`; **no paid API is
  integrated**).
- **Searching by name sends that full name to the search service.** Only athletes whose family
  opted in, and alumni staff put on the watch list, are ever searched. The opt-in wording says so.
- **No background worker is deployed yet**, so nothing is monitored on its own until the app is
  hosted with one. Until then the owner uses Run now on Settings, Scheduled jobs.
- News watch is **off by default** (and off in the demo seed). While it is off the job requests
  nothing from any site.
- The sensitive-topic check and the wins topic screen are word lists, not understanding.
- The opt-in wording (`NEWS_WATCH_POLICY_TEXT`, version `newswatch-optin-2026-1`) is **sample
  text**. It, the source list and each source's terms of use need review before real families use
  this, as does a check of children's privacy rules.

## Sources

`news_sources`, one row per source, per organization:

- **Publisher feed** (`rss`): an RSS or Atom address the publisher offers. One request per run.
- **News search feed** (`search`): a search feed address containing `{query}`, restricted to named
  publication domains. The query is `"First Last" (site:a.com OR site:b.com)`: the exact full
  name, only on the named sites. One request **per watched person**, shared by every search source
  that uses the same search address (their sites are OR'd into one query), so adding a paper does
  not multiply requests.
- Each source has an on/off switch, an audience (everyone, current athletes only, alumni only), a
  minimum interval (60 minutes or more) and a "last read" line with the result or the error.
- Addresses must be `https` on a public host name. IP addresses, localhost and internal names are
  refused, redirects are followed by hand (three at most) with the same check on every hop.

### Sample defaults (created once per organization; all editable, all can be switched off)

| Name | Kind | Address | Sites |
| --- | --- | --- | --- |
| Greene County Daily World (publisher feed) | rss | `https://www.suncommercial.com/search/?f=rss&t=article&c=gcdailyworld&l=50&s=start_time&sd=desc` | |
| The Herald-Times, Bloomington (news search) | search | `https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en` | `heraldtimesonline.com` |
| The Times-Mail, Bedford (news search) | search | same search address | `tmnews.com` |
| Greene County Daily World (news search) | search | same search address | `suncommercial.com` |

### What each returned in one manual check (2026-11-12, from the build machine)

One request per address, user agent `TeamworkHub-NewsWatch/1.0 (feed reader)`. Nothing fetched was
committed; test fixtures are invented.

- `https://www.heraldtimesonline.com/sports/` and `https://www.tmnews.com/sports/` (checked by the
  lead): HTTP **402**. Paywalled or bot-blocked. Not used, and not worked around.
- `https://www.gcdailyworld.com/`: 301 to `https://www.suncommercial.com/gcdailyworld/` (the
  Greene County Daily World is now a section of the Vincennes Sun-Commercial's site). That page
  advertises an RSS feed in a `<link rel="alternate" type="application/rss+xml">` tag.
- That feed (the first default): **200**, `application/rss+xml`, RSS 2.0 from TNCMS, **50 items**.
  Each item has `title`, `description` (one or two plain sentences), `pubDate`, `guid`, `link`
  (an `https` article address), sometimes `dc:creator` and an image `enclosure` (ignored). It
  covers the whole Greene County section, not only sports.
- News search restricted to `heraldtimesonline.com`: **200**, `application/xml`, **66 items**,
  all with `<source url="https://www.heraldtimesonline.com">The Herald-Times</source>`, all dated
  that day. Each item: `title` ("Headline - The Herald-Times"), `link` (an opaque redirect link on
  the search service, not the paper's address), `guid`, `pubDate`, and a `description` that is only
  an HTML link repeating the title (so there is no usable summary).
- News search restricted to `tmnews.com`: **200**, **26 items**, source "The Times-Mail", but
  **every item was dated December 2012**, including index pages. The search service's coverage of
  the Bedford paper looked stale in this check. The maximum-age setting drops such items. This
  source may find little or nothing; it is on by default so the owner can see its result line and
  decide.
- News search restricted to `suncommercial.com`: **200**, **100 items**, source shown as
  "suncommercial.com" or "Vincennes Sun-Commercial", dates from 2024 to that week, a mix of
  section index pages and articles from the whole Sun-Commercial site.

The check used a section word, not a person's name. The per-name query form
(`"First Last" site:...`) uses the same address and was not fetched live.

## Who is watched

**Current athletes: opt-in, default off** (`news_watch_athletes`).

- A minor: a guardian with the **can-sign-forms** flag (`forms.sign`), the same flag the Wins
  module uses for marketing consent. An adult athlete decides alone. Staff can never switch it on
  (the database refuses an opt-in decided "as staff").
- Off again: any active guardian, the athlete, or staff who manage people ("Stop watching").
- "Ask the family" (staff who review wins, athletes in scope) puts the question on the family's
  Wins page. **It sends no message.** A family that said no is not asked again from there.
- An athlete whose name is hidden from other families cannot be opted in: a clip could not be shown.
- Staff can add matching words per athlete (school, sport, town); school and sport default to the
  athlete record.

**Alumni** (`alumni`): first and last name, sport, college or team, graduation year, optional link
to the former athlete record, notes, active flag, and "full name is fine".

- Owner, admin and operations add and edit alumni. Putting one on the watch list needs a recorded
  **basis** ("gave permission at alumni day", "public college roster"); the database refuses a
  watched alumnus without one. One step removes them.
- "Mark as alumni" on a profile copies name, sport and graduation year into an alumni record. It
  does not change the athlete record and does not start watching.
- An alumni record linked to an athlete who is under 18 on file, or has no birthday on file,
  cannot be put on the watch list by staff. A minor needs the guardian opt-in.

Every opt-in, opt-out, request and watch-list change is in the audit log and in the append-only
`news_watch_events` (database trigger), with who, in what relationship, when, and the wording or
basis.

## Matching (`scoreMatch`, pure)

The matcher **never matches a first name or a last name alone**. A headline is considered for a
person only when their full name ("first last" or "preferred last") appears as a phrase in the
headline or the feed's summary, or when a news search for exactly that full name returned it.

| Evidence | Points |
| --- | --- |
| Full name in the headline | +60 |
| Full name only in the feed's summary | +50 |
| Neither, but a search for this exact name returned it | +30 |
| School or college named | +20 |
| Sport named | +10 |
| Town named | +10 |
| Someone else at this gym has the same full name | -30 |
| Very common first and last name (very common last name only) | -20 (-10) |
| Each earlier "not our athlete" from the same publication | -15, up to -45 |

60 or more is **likely**, 30 to 59 **possible**, lower is dropped and not stored. Each clip keeps
the reasons in plain sentences ("Why it matched").

**Deduplication.** An article is stored once per organization: same link (tracking parameters and
fragments removed), or the same headline from the same publication within three days (which
catches a publisher feed and a search feed carrying the same story). A person gets at most one clip
per article, ever, whatever was decided about it. Headlines that match nobody are not stored.

**"Not our athlete"** stores a per-person negative: that article is never suggested for them
again, later headlines from the same publication score lower, and an optional word (a town, a
school) drops any later headline that contains it.

## Sensitive topics

- A headline that mentions **health or injuries, body weight or school grades** (the Wins module's
  existing topic screen) **cannot be approved at all**. It can only be rejected.
- A headline that may mention **an arrest or crime, a court case, a death, discipline or a crash**
  carries a visible **warning label** on the pending clip ("Check before approving"). The approver
  decides.

## What an approved clip shows

- Headline, publication name, date and a link out. Never article text, never an image.
- **Current athlete**: approval creates an approved win of the new type **"In the news"**
  (`wins.type = 'in_the_news'`, with `news_source` and the link). From there the Wins rules apply
  unchanged: the display-name setting, the hidden-athlete filter, the family's in-app and TV
  switches, withdrawal by the family, removal by staff, separate marketing consent, XP for an
  approved win. In the headline the athlete's full name (and a last name standing alone) is
  replaced by the first name, so the "no last names" rule of wins still holds; long dashes become
  plain ones; it is cut to 120 characters. The linked public article may show the full name; the
  opt-in wording says so. This is the one place a win's source link is shown to other families.
- **Alumni**: shown in "Teamwork alumni in college" straight from the clip, as first name and last
  initial, or the full name when staff recorded that it is fine.
- **Gym TV**: athlete display name (or the alumni name form), headline and publication. No link.
- Both feeds are empty when community features are switched off, and never include the kiosk.

**Revoking.** Switching news watch off for an athlete, or taking an alumnus off the watch list,
stops matching at once, closes their unapproved clips and takes their approved clips down.

## The job

`newswatch.fetch.nightly` (`runNewsWatch`), registered with the other nightly jobs, per
organization, with Run now on `/settings/jobs`.

- Does nothing while News watch is off or nobody is watched.
- Skips a source inside its minimum interval or its backoff.
- One daily cap on requests for the whole organization (default 100). When the cap stops a search
  part-way, a different person goes first the next day.
- A failing source is recorded on its row, backed off (30 minutes, doubling, at most 24 hours) and
  never stops the others. Timeout 10 seconds, feeds up to 2 MB.
- Idempotent: a second run makes no second clip.
- Result line: sources read, headlines read, new clips to review, sources not due, and how many
  sources failed.

## Permissions

| Action | Needs |
| --- | --- |
| Settings and sources | `settings.manage` (owner, admin) |
| See and sort clips, add a clip by hand, ask the family, matching words | `wins.review` + `profile.read` on the athlete (a coach: own athletes; alumni clips: any staff who review wins) |
| Approve, reject, bulk approve, take down | `news.approve` (owner, admin), or operations / coach when allowed in Settings (`canApproveNews`) |
| Add, edit, watch or unwatch an alumnus; mark as alumni; stop watching an athlete | `people.manage` (owner, admin, operations) |
| Opt in | minor: guardian with `profile.read` and `forms.sign`. Adult: the athlete |
| Opt out | minor: any active guardian or the athlete. Adult: the athlete. Staff with `people.manage` |
| Guardians, athletes, the kiosk, another organization | no access to clips, sources or the watch list |

One capability was added to `policy.ts`: `news.approve` (owner, admin).

## Seed (`scripts/seed/newswatch.ts`, demo database only)

Opt-in seed (listed in `HISTORY_SEEDS`): it runs for `pnpm db:fresh` and for tests that name it,
not in the default test seed. All invented: Maya (parent opted in) and Dana (adult, opted in
herself); Leo's family asked, no answer; alumni "Quinn Madeupson" (Fictional State University
(sample), watched, first name and last initial) and "River Notarealname" (Imaginary College
(sample), full name agreed); nine clips from the "Sampleton Gazette (sample)" and two invented
college sites with `example.com` links, in every state: approved (one athlete win, one alumni
clip), confirmed and waiting, suggested, suggested with a warning label, suggested and blocked
(an injury headline), and "not our athlete". News watch itself is left off.

## Tests

- `tests/newswatch.test.ts` (36 tests, real Postgres, **no network**: fixture feeds served by a fake
  fetcher): RSS, Atom, search-style, empty and malformed feeds; dedupe keys; address rules;
  scoring (exact phrase, summary only, search-asserted, same-name, common name, first or last name
  alone never matches, negatives); the sensitive check; display helpers; opt-in for every demo role
  (owner, operations, both coaches, Alex, Jordan without the sign flag, Chris, Sam, Casey, Dana,
  Maya, kiosk, another organization); adult self opt-in; hidden athlete; append-only ledger and
  CHECKs; alumni permissions, basis, minor guard, mark as alumni; source permissions and
  validation; default sources; job off / on, failure isolation (malformed, HTTP 402, connection
  error), backoff, idempotency, daily cap, only feed addresses requested; triage publishes
  nothing; approval by role and by setting; the "In the news" win, feed, TV and audit; never
  marketing; blocked and warning headlines; bulk approve; "not our athlete" suppression; alumni
  display and removal; revocation; same-name ambiguity; clips added by hand.
- `e2e/newswatch.spec.ts` (2 tests, desktop and 390px): a coach adds and confirms a clip, another
  family does not see it, the coach cannot approve, the owner sees the Today count, approves, the
  family sees it with display name, first-name headline and link, the owner takes it down;
  settings, watch list and family opt-in card. Checks for sideways scrolling.
- `e2e/a11y.spec.ts` and `e2e/csp.spec.ts` include the new routes.

## Shared-file edits

`src/db/schema/index.ts`, `src/db/schema/wins.ts` (news columns on `win_leads`,
`wins.news_source`, win type `in_the_news`, `SUBMITTABLE_WIN_TYPES`); `src/lib/authz/policy.ts`
(one capability); `src/lib/scheduled/jobs.ts` (job, handler, result labels);
`src/lib/wins/wins.ts` (feed item `news`, `onlyNews`, TV publication, manual `in_the_news`
refused), `src/lib/wins/leads.ts` (staff leads only; news clips cannot be converted or dismissed
there), `src/lib/wins/shared.ts` (labels); `src/lib/community/board.ts` (alumni clips in the Wins
panel); `src/components/wins/family.tsx`, `staff.tsx` (feed link, two tabs);
`src/components/settings-tabs.tsx`; mount lines on `/wins`, `/wins/leads`, both staff Today views
and the staff profile; `scripts/seed/modules.ts`; e2e route lists.

Hand-written SQL at the end of the migration (after the last generated statement): the wider
`wins_type_ck` (all eight types), `wins_news_source_ck`, `win_leads` checks for kind, news status,
match level, shape and "approved needs who and when", `news_sources` checks (kind, audience, https,
interval), `news_items` checks (https link, headline and summary size), `alumni_watch_basis_ck`,
`news_watch_athletes` checks, `news_watch_events` checks and its append-only trigger. The XP kind
CHECK is not touched.

## Gaps and assumptions

- Not run against the real feeds end to end: the job was only exercised with fixtures. The one
  live check above confirmed addresses and shapes, not matching on real names.
- The Bedford paper's search coverage looked stale in the live check, and the Herald-Times search
  feed has no summaries, so for both papers a match depends on the name being in the headline or
  on the search service returning the article for the name.
- The family's own "Your wins" list shows a news win with the existing wins controls (levels,
  withdraw). There is no separate per-clip question to the family before approval: the opt-in is
  the family's consent, the approver is the check.
- The athlete opt-in is all or nothing: it covers both the app feed and the TV. A family can
  switch either level off per win afterwards.
- Redirect checks are by host name; the Hub does not resolve DNS to rule out a public name that
  points at a private address.
- The common-name lists are short built-in lists of United States names.
- Clip rows are kept after they are closed (needed so an article is not suggested twice). No
  expiry job deletes old closed clips or stored headlines yet.
- No notification of any kind: a request or a pending clip waits in the app.
