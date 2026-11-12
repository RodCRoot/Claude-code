# Wins and Competitions module

Owner paths: `src/lib/wins/**`, `src/db/schema/wins.ts`, `drizzle/0027_wins.sql` (renumbered by the
lead at merge), `src/components/wins/**`, `src/app/(app)/wins/**`, `src/app/api/wins/[id]/photo/route.ts`,
`scripts/seed/wins.ts`, `tests/wins.test.ts`, `e2e/wins.spec.ts`. Screenshots: `docs/screenshots/wins/`.

Purpose: the gym knows when its athletes compete, celebrates what they achieve outside the gym,
and turns that into recognition (retention) and, only with a family's recorded consent, marketing
content. Most athletes are minors, so the module is built so the wrong thing cannot be shown by
accident. Nothing in this module sends a message, posts anywhere, or reads another website.

## What's built

| Area | Where | Who |
| --- | --- | --- |
| Wins page: your athletes' wins, add a win, the gym feed, "competing this week" | `/wins` | athletes, guardians, staff |
| Review queue: approve (with a headline edit), approve a photo, remove | `/wins/review` | staff in scope |
| Competition calendar: week and month, filters | `/wins/calendar` | staff in scope |
| Team schedules: enter a season once, attach athletes | `/wins/teams` | staff in scope |
| Leads to check | `/wins/leads` | staff in scope |
| Marketing queue: caption drafts, mark as posted, ask the family, take-down list | `/wins/marketing` | owner, admin, operations |
| "Competing this week" widget | staff and coach `/today` | staff in scope |
| "Your wins" and "athletes competing this week" cards | Athlete Home (`/today`) | athletes, guardians |
| Wins panel on the gym TV | `/display` (Settings, Community, TV panels) | display devices |
| Wins card on the staff profile | `/people/[personId]` overview | staff in scope |
| "Recent wins" card on the retention radar | `/people/retention` | staff with the radar |
| "Wins outside the gym" section of the monthly recap | `/recap/[yyyy-mm]` | whoever may read the recap |

## Competition calendar

Built from two sources and nothing else (`calendar.ts`):

1. **My Season** events the family entered (`anywhere_season_events`), kinds game and tournament.
   Practices, travel and rest days are not competitions.
2. **Team schedules** staff enter once: a school or club team (`competition_teams`), a list of
   dates (`competition_team_events`: game, meet or tournament, optional time, opponent, place) and
   the athletes on it (`competition_team_athletes`). Dates are pasted one per line
   (`2026-11-20, 19:00, Sample Valley, Away`); bad lines are reported by line number; a date and
   time already on the schedule is skipped.

One entry per athlete per day: when both sources have that day, the family's own entry is kept.

- **Staff calendar**: week or month, filters for sport, team, training group and location.
  Athletes have no home location on file, so "Trains at" means the athlete booked or attended a
  session at that location in the last 90 days. On a phone, days with nothing are left out.
- **Scope**: `profile.read`. Owner, admin and operations see every athlete; a coach sees assigned
  athletes only. A coach saving a team's athlete list can only add or remove their own athletes;
  athletes outside their roster stay as they were and show as a count.
- **Staff Today widget**: the next seven days grouped by day, with "N athletes compete tomorrow"
  called out, and a **Load** link per athlete to the existing `/science/load?athlete=` page
  (shown when the viewer has `training.read`). No load logic was added.
- **Family card** "athletes competing this week": display name, sport, kind (game, meet,
  tournament) and day. It deliberately leaves out the team or school, the opponent, the place
  and the time: other families learn that a teammate competes this week, not where a child will
  be. Names come from `communityRoster` / `publicName`, so hidden athletes are dropped with no
  placeholder and no count. The card is empty when community features are off.

## Wins

A win (`wins`): athlete, date, sport, type (personal best, win or placing, selection or
all-conference, college commitment, team championship, character and leadership, other), a
headline (3 to 120 characters), optional detail (500), optional `https` source link, optional photo.

| Status | Meaning |
| --- | --- |
| `awaiting_family` | A staff draft made from a lead. Only the athlete's own family sees it, with Yes / No. |
| `pending` | Submitted, or confirmed by the family. Waiting for staff. Shown to nobody else. |
| `approved` | May be shown, subject to the three levels below and the display-name setting. |
| `declined` | The family said no to a staff draft. |
| `removed` | Taken down by staff (reason required) or withdrawn by the family. Soft delete. |

- **Approval** (`approveWin`): staff with `wins.review` and `profile.read` on the athlete. The
  headline and detail can be edited in the same step; the photo is approved only when its box is
  ticked. The audit entry `wins.approve` stores who, and the wording before and after. A database
  CHECK refuses an approved row without `approved_by` and `approved_at`.
- **Text rules** (`checkWinText`, applied on submit, edit and again on approve): one plain line,
  the family style rules (no em dashes, no card or ID numbers), no last name of the athlete, and a
  keyword screen for **health and injuries, body weight, and school grades** (`bannedTopic`).
  The screen is a word list, not understanding. The staff approval step is the real check.
- **Source link**: `https` only, no credentials, never fetched. Shown to staff and the athlete's
  own family only. It is never in the feed, on the TV or in a caption, because a news article
  usually carries a full name.
- **Photo**: added after submitting, through `POST /api/wins/[id]/photo` (a route handler,
  because server actions cap the body at 1 MB). JPEG or PNG up to 5 MB, checked by magic bytes.
  **EXIF, XMP, IPTC and PNG text chunks are stripped before storing** (`photo.ts`), so GPS
  position and device details do not travel with a photo of a child. Stored with the existing
  `saveObject` (`subject_and_guardians`). Served only by `GET /api/wins/[id]/photo`: the family
  and staff in scope always; anyone else only when the win is approved, the photo is approved,
  level (a) is on and the athlete is not hidden; otherwise 404. Replacing a photo clears its
  approval. Photos never go on the TV.
- **XP**: approving awards the new kind `win_approved` (default 15, Settings, Engagement) once,
  key `win:<id>`, when levels are on. XP stays if the win is later removed (the ledger is
  append-only).
- **Staff edits after consent**: once a family has given marketing consent, staff cannot change
  the wording. The family consented to the words they saw.

## Consent and privacy

Three separate levels, each stored on the win:

| Level | What | Default | Who decides |
| --- | --- | --- | --- |
| (a) `show_in_app` | The Wins feed other gym families see, under the display name | on | see below |
| (b) `show_on_tv` | The gym TV board, under the display name | on | see below |
| (c) `marketing_consent` | The gym's public marketing (social posts, website) | **no** | see below |

(a) and (b) follow the existing display-name setting: every community surface goes through one
filter (`shown()` in `wins.ts`) that needs status approved, the level on, and a non-null name from
`communityRoster`. A hidden athlete never appears, also not to staff on the feed, and cannot be
consented into marketing. As defence in depth the same filter drops a win whose wording contains
the athlete's last name (for example after a rename).

### Who may do what (all derived from `policy.ts` in `access.ts`)

| Action | Needs |
| --- | --- |
| See an athlete's wins | `profile.read` (the athlete, an active guardian, staff in scope) |
| Submit a win; confirm or decline a staff draft; add a photo | staff: `wins.review` + `profile.read`. Athlete: self. Guardian: `profile.read` **and `booking.create`** |
| Change levels (a) and (b) after submitting | minor: a guardian with `profile.read` and `booking.create`. Adult: the athlete. The submitter may switch them off at submission |
| Give or decline (c) marketing consent | minor: a guardian with `profile.read` **and `forms.sign`**. Adult (18+): the athlete only. Never staff |
| Withdraw (c), or withdraw the whole win | minor: any active guardian. Adult: the athlete |
| Approve, edit, remove | `wins.review` + `profile.read` (a coach: assigned athletes only) |
| Marketing queue, mark as posted, ask the family | `wins.marketing` (owner, admin, operations) |

**Guardian flags chosen, and why.**

- `can_book` (`booking.create`) gates submitting and the in-app and TV levels. It is the existing
  flag for acting on the child's activities and already gates editing My Season. In the demo,
  Casey (cannot book) sees Leo's wins but cannot add one or answer a draft.
- `can_sign_forms` (`forms.sign`) gates marketing consent: a marketing release is a signed
  permission. A guardian without it sees why, and can still withdraw consent another guardian gave.
- `can_view_health` and `can_view_training` are irrelevant: a win holds neither. Jordan (no
  health access) can submit and consent.
- A payer-only adult, an unrelated guardian, the kiosk and another organization get nothing.
- No birthday on file is treated as a minor. A guardian linked to an adult athlete can see and
  submit, but cannot consent, change levels or withdraw.

Two new organization capabilities were added to `policy.ts`: `wins.review` (owner, admin,
operations, coach) and `wins.marketing` (owner, admin, operations).

### Marketing consent record

`win_consent_events` is append-only (database trigger): win, athlete, action (`requested`,
`granted`, `declined`, `revoked`), user and person, relationship (`guardian`, `self`, `staff`),
time, policy version and the full wording shown. A CHECK allows the staff relationship only for
`requested`, and another refuses any consent state on a win without who and when. Every step is
also in the audit log. The wording (`MARKETING_POLICY_TEXT`, version `wins-marketing-2026-1`) is
**sample text** and needs review before real families use it.

Consent is per win, not per athlete: a family that says yes to one result has not said yes to
the next.

## Where wins show up

- **TV board**: panel `wins` ("Wins outside the gym"), switchable in Settings, Community like the
  others. Up to four approved wins from the last 30 days with level (b) on: display name,
  headline, type, sport, date. No ids, photos or links. The payload type gained one variant.
- **Wins feed** on `/wins`: approved wins from the last year with level (a) on. Staff see exactly
  what families see.
- **Athlete Home**: "Your wins" (a draft to confirm and a marketing question come first) and the
  competing card. **Staff profile**: status, levels and consent at a glance, remove with a reason.
- **Monthly recap**: approved wins that happened in the month (`RecapSnapshot.wins`, optional, so
  recaps finalized earlier are unchanged; the calculation key stays `tw_recap_v1` because no
  existing number changed meaning). Visible with profile access.
- **Retention**: "Recent wins: a reason to say congratulations" on the radar page, last 14 days,
  with "Open conversation" (you write and send it yourself). It is a separate card. It is **not a
  risk signal**: nothing in `src/lib/retention` reads wins and the risk level is unchanged.

## Marketing queue

`/wins/marketing` (`marketing.ts`):

- **Ready to post**: approved + consent given + a visible display name. Nothing else can be in
  it. Each has three caption drafts from fixed templates filled in locally (`captionDrafts`: no AI,
  no outside service), using the display name only, with a Copy button, and "Mark as posted"
  with a channel (Instagram, Facebook, website, newsletter, other) and a date. Marking re-checks
  consent. **The app posts nothing anywhere.**
- **Approved, no marketing consent**: "Ask the family" sets a request the guardian (or adult
  athlete) sees on Home and on `/wins`, with the wording and Agree / No thanks. **It sends no
  message.** A family that said no or withdrew is not asked again from here; they can change
  their answer themselves.
- **Take these down**: wins that were marked as posted and whose consent was later withdrawn, or
  that were removed or hidden. Staff remove the outside posts and confirm.

Withdrawing consent removes the win from "Ready to post" at once (tested).

## Leads to check

`/wins/leads` (`leads.ts`): a staff member types what they heard ("heard Maya made
all-conference") and may paste a link by hand. A lead is staff-only. "Turn into a draft win"
attaches it to an athlete as `awaiting_family`; the family confirms or declines in the app;
confirmed drafts still need staff approval. A coach sees their own leads and leads about athletes
they coach. The link is never opened by the app.

### Not built, on purpose: scraping social media or news sites

Reading social feeds or news sites for athletes' names would collect data about minors without
their families knowing, and it breaks those sites' terms. It is not built and should not be.

**A possible later option (not implemented):** a staff-reviewed search of local news RSS feeds,
or a licensed search API, for the names of athletes whose guardians opted in. It would need:

1. **Its own opt-in per athlete**, separate from all three levels above, given by a guardian with
   the sign-forms flag (or the adult athlete), recorded like marketing consent (who, when,
   wording), default off, revocable. The wording must say plainly that the gym will search public
   news for the athlete's name.
2. **A named, lawful source list** chosen by the owner: publishers' RSS feeds or a search API
   whose terms allow this use. No social networks, no sign-in walls, no scraping of pages.
3. **Minimum data out and in**: only opted-in names leave the Hub (a full name sent to a search
   provider is a disclosure the consent text must cover), and only a title, link and date come
   back. No article text or images are stored.
4. **Suggestions only.** A match becomes a lead in this same list, marked as a suggestion. A
   staff member checks it is the right person (common names will mismatch), then it follows the
   existing path: family confirmation, staff approval, the three levels. Nothing is ever shown
   automatically.
5. **Housekeeping**: withdrawing the opt-in stops searches and deletes that athlete's unhandled
   suggestions; old suggestions expire; every search and decision is audited; the search runs as
   a scheduled job with a rate limit; a legal review of children's privacy rules for the gym's
   state before turning it on.

## Seed (`scripts/seed/wins.ts`)

Written through the real paths. Four team schedules with obviously invented names ("Fictional
Falls High School Volleyball (sample)", "Imaginary Ironmen Football (sample)", "Sampleton Storm
Soccer Club (sample)", "Nowhere Track Club (sample)"), with dates tomorrow and through the next
two weeks. Wins: Maya (parent-submitted, approved, marketing consent given), Leo (commitment to
"Fictional State University (sample)", staff asked the family, no answer), Dana (adult, consented
herself, marked posted on Instagram), four staff-entered approved wins, hidden Eli (approved, and
on no community surface), two pending, three leads (one already a draft awaiting Maya's family).

## Tests

- `tests/wins.test.ts` (36 tests, real Postgres): text rules, link rules, captions, schedule
  parser, EXIF stripping; submit for every demo role (owner, operations, both coaches, Alex,
  Jordan, Chris, Sam, Casey, Dana, Maya, kiosk, another organization); approval flow, audit and
  XP; levels (a) and (b); hidden athlete on no surface; TV and feed payloads without ids, last
  names or links; the defensive last-name drop; panel and master switches; consent by role
  including a guardian without the sign flag, a guardian of an adult and a minor athlete;
  append-only ledger and CHECKs; queue lists only consented wins; revocation removes a win;
  posted then revoked goes to take-down; ask the family writes no job; leads and drafts;
  calendar merge, scope, filters, the Today widget and the family card; retention scope; recap
  rows; photo access.
- `e2e/wins.spec.ts` (3 tests, desktop and 390px): the full parent, coach, operations loop
  including consent and withdrawal; staff Today, calendar, filters, teams, leads, retention;
  family Home cards, a minor without a consent button, hidden athlete absent. Checks for sideways
  scrolling at 390px.
- `e2e/community.spec.ts`: the board payload test now also checks the wins panel.
  `e2e/a11y.spec.ts` and `e2e/csp.spec.ts` include the new routes for owner, coach, guardian and
  athlete, and one more pinned TV panel.

## Shared-file edits (all additive)

`src/db/schema/index.ts`; `src/db/schema/engagement.ts` + `src/lib/engagement/settings.ts` (XP kind
`win_approved`); `src/lib/authz/policy.ts` (two capabilities); `src/lib/community/shared.ts`,
`board.ts`, `src/app/display/board.tsx`, `settings/community/page.tsx` (panel `wins`);
`src/lib/showcase/recap.ts` + the recap page (optional `wins` section); `src/lib/nav.ts`;
`src/proxy.ts` (`/wins` in the signed-out redirect list); mount lines on Athlete Home, both staff
Today views, the staff profile and the retention page; `scripts/seed/modules.ts`; e2e route lists.

Hand-written SQL at the end of the migration: the wider `xp_events_kind_ck` (all nine kinds),
CHECK constraints for kinds, types, statuses, lengths, `https` links, "approved needs who and
when", "consent needs who and when", "staff may only be recorded as asking", and the append-only
trigger on `win_consent_events`.

## Gaps and assumptions

- There is no settings page for this module. The feed, the family card and the TV panel follow the
  community master switch; the TV panel has its own checkbox. The family "competing" card cannot
  be turned off on its own.
- Staff-entered wins are shown once approved without a family confirmation step (the brief lets
  staff submit). The family sees them under "Your wins" and can switch levels off or withdraw.
  Only leads go through family confirmation first.
- Families cannot edit a win after sending it; they withdraw it and send a new one.
- The topic screen is a word list. It will miss things and will sometimes block harmless wording.
- A photo is not shown in the marketing queue itself; staff open it from the Review tab.
- Team schedule dates are single days with no repeat rule, and cannot be edited in place.
- "Trains at" is derived from bookings, not a stored home location.
- No notifications of any kind: a draft or a marketing question waits in the app until the family
  next opens it.
- The caption templates, the consent wording and the 15 XP default are sample starting points.
