# Community module (gym TV board, leaderboards, coach shoutouts, team challenges)

Owner paths: `src/lib/community/**`, `src/db/schema/community.ts`, `drizzle/0023_community.sql`,
`src/components/community/**`, `src/app/display/**`, `src/app/api/display/board/route.ts`,
`src/app/(app)/leaderboards/**`, `src/app/(app)/settings/community/**`, `scripts/seed/community.ts`,
`tests/community*.test.ts`, `e2e/community.spec.ts`. Screenshots: `docs/screenshots/community/`.

Purpose: the community layer inside the gym. Athletes see each other's effort on the wall and in
the app, coaches can recognise someone in ten seconds, and families stay in control of how (or
whether) their athlete is named. Everything shown is derived read-only from rows other modules
already write. No message is ever sent from this module.

## Privacy model

1. **One resolver.** Every name another family can see comes from `publicName()` in
   `src/lib/community/display-name.ts`, reached through `communityRoster()`. It returns
   `"Maya P."`, `"Maya"`, or `null`. `null` means the athlete is dropped from the output entirely:
   no placeholder row, no "hidden athlete" count.
2. **What never appears anywhere in this module:** full last names, dates of birth or ages (only
   an age band), body weight or any ratio that would reveal it, health data (wellness answers,
   body-map, notes), billing data, class rosters, birthdays.
3. **No ids leave for the TV.** The board payload carries no athlete, user or challenge ids
   (tested with a UUID pattern over the whole payload). Leaderboard rows carry no ids either; only
   the viewer's own athletes get a `you` line with their athlete id.
4. **Hidden still sees themselves.** The viewer's own athletes always get a line such as
   "Eli: 4th of 12, hidden from the board". That line needs `training.read` on the athlete, because
   it carries the athlete's own numbers.
5. **Small groups.** On a board with fewer than five visible athletes, ranks are counted among
   visible athletes only and totals are withheld, so nobody can work out that someone is hidden or
   where they stand. With five or more visible, true ranks are shown (a hidden athlete leaves a
   gap) along with the total count.
6. **Staff see the public view.** `/leaderboards` shows staff exactly what families see; hidden
   athletes are not listed for staff either.

### Display modes (`community_display_prefs`)

| Mode | Shown as | Notes |
| --- | --- | --- |
| `first_last_initial` (default) | Maya P. | Preferred name when there is one; first word only. |
| `first_name_only` | Maya | |
| `hidden` | not shown | Never on the TV, leaderboards, challenge leaders or shoutouts on the TV. |

No row means the organization default applies (Settings → Community). Who may change it
(`displayModeAccess` / `setDisplayMode`, all derived from `athleteCapabilities` in `policy.ts`):

| Athlete | Who | How |
| --- | --- | --- |
| Under 18, or no birthday on file | A guardian with an active guardianship (profile access) | `/leaderboards` → "How names appear" |
| 18 or older | The athlete, from their own login | same |
| Either | Staff with `profile.write` (owner, admin, operations) on the family's request | Athlete profile → Community. A note of who asked is required and stored in the audit entry. Coaches cannot change it. |

Every change writes `community.display_mode.set` to the audit log.

### Age bands

`ageBandOf(dateOfBirth, today)`: U12 (under 12), U14, U16, U18, Adult (18+), from the age on the
facility-local date. Athletes are only ever ranked inside their own band, also when a training
group filter is applied, so a 12-year-old is never ranked against an adult. An athlete with no
birthday on file has no band and is not ranked (the family sees a note asking for the birthday);
no band is ever guessed.

## Gym TV board (`/display`)

Full screen, dark, type sized in viewport units so it reads from across the room on any 16:9
screen. No interaction needed, no sound.

- **Panels** (each can be turned off in Settings): PR Bell (measured PRs this week: name, lift,
  new value, gain), On a streak, Level ups and new badges (this week), Leaderboards (one board
  per panel, labelled with its age band; at least three visible athletes; relative strength never
  goes on the TV), Today's classes (time, class, coach, spots left; no rosters), Milestones
  (session counts, first 30 days, membership anniversaries; birthdays are never computed for the
  board), Coach shoutouts (last 7 days), Team challenges, and an optional plain-text gym message.
  Panels with nothing to show are skipped.
- **Rotation:** panels CUT from one to the next. There is no fade, slide or other animation
  (a fade lowers text contrast mid-transition and fails axe; cuts are also what
  `prefers-reduced-motion` asks for). Seconds per panel is a setting (6 to 120, default 15).
  A keyboard-reachable "Pause rotation" button exists for WCAG 2.2.2; it is invisible until focused.
- **Refresh:** a client timer fetches `GET /api/display/board` every 60 seconds and swaps the data
  in place, with no page reload. If the request fails the last data stays on screen and the footer
  shows "Offline, showing the last update." next to the "Last updated" time. A 401 (screen revoked)
  blanks the board.
- **Clock:** shown in the facility timezone, whatever the TV's own clock is set to.
- **CSP:** the strict nonce policy applies unchanged. Timers live in the client component
  (`src/app/display/board.tsx`); there are no inline handlers, no third-party scripts, and the
  client bundle imports only `src/lib/community/shared.ts` (no zod, no database code).
- `?panel=3` pins one panel (used for previews, screenshots and the per-panel axe run).

### Board access

A display is **not a user and not a role**. This was chosen over a `display` login role because a
role would be a session that every existing page has to remember to refuse; a token that is not a
session is refused everywhere by default.

1. Settings → Community → "Add a screen" creates a random 256-bit token. Only its SHA-256 hash is
   stored (`community_display_tokens.token_hash`); the link is shown once.
2. Opening `/display/link/<token>` on the TV moves the token into an httpOnly, SameSite=Lax cookie
   (`tw_display`) and redirects to `/display`, so the token does not stay in the address bar.
3. That cookie is read by exactly one function, `displayAccess()`
   (`src/lib/community/display-access.ts`), which is called by exactly two handlers: the `/display`
   page and `GET /api/display/board`. `getViewer()` ignores it, so every other page redirects the
   TV to `/login` and every other API answers 401. The endpoint exports GET only (other methods:
   405) and `boardPayload` performs no writes (tested: row counts unchanged).
4. Revoking a screen sets `revoked_at`. The token never resolves again: the endpoint returns 401
   on the next refresh and the board blanks itself within a minute. Up to 10 screens can be
   connected at once. Creating and revoking are audited (`community.display.create` / `.revoke`);
   the token itself is never written to the audit log.
5. A signed-in owner or admin can open `/display` as a preview (marked "Preview"). Coaches,
   operations, families and the kiosk login get the "not connected" screen.

Checked in `tests/community.test.ts` (token lifecycle, payload contents) and
`e2e/community.spec.ts` (a display context cannot open any app route or other API; revoke kills
the token; offline keeps the last data).

## Leaderboards (`/leaderboards`)

For athletes, guardians and staff. Families see the bands their own athletes are in (and those
athletes' training groups as a filter); staff see every band.

| Board | Source | Notes |
| --- | --- | --- |
| Sessions this month | attended bookings in the facility-local month | |
| Weekly streaks | `computeStreak` from the engagement module | same rule as Athlete Home, holds included |
| Most improved | percent gained on a measured max in the last 90 days | baseline = last measured max on or before the window start, else the first one inside it; latest must be at least 7 days after the baseline; lb and kg compare by exact conversion; best lift per athlete; only gains are listed |
| Exercise maxes | best measured max per lift (up to six lifts per band) | "Measured maxes only": tested, coach-entered and imported. Estimated maxes are filtered out in SQL and again in code |
| Pound for pound | measured max divided by body mass | order only: no ratio, no weight; needs body mass on file; never on the TV |

Ties share a rank. The existing coach-only e1RM leaderboard in Training → Reports (opt-in) is
unchanged and separate.

## Coach shoutouts

Staff post from the athlete's profile (Overview → Community): one of four chips (Great effort,
Leader today, New PR, Consistency) plus an optional note of up to 140 characters.

- Staff-authored only; coaches only for athletes in their scope (`profile.read`).
- The note is flattened to one plain line and must pass `lintFamilyMessage` (no em dashes, no card
  or ID numbers).
- Per-author daily limit in the facility-local day (default 10, configurable). Removed shoutouts
  still count for the day. An advisory lock stops two tabs from slipping past the limit.
- Awards XP through the engagement ledger: new kind `coach_shoutout` (default 10, set in
  Settings → Engagement), idempotency key `shoutout:<id>`. Skipped when levels are off.
- Visible on Athlete Home (the athlete and their guardians), on the staff profile, and on the TV
  under the athlete's display name (never when hidden).
- Removal is a soft delete by the author or by owner/admin/operations, audited
  (`community.shoutout.remove`, with the text that was removed). XP already awarded stays: the
  ledger is append-only by database trigger.

## Team challenges

Staff create a time-boxed challenge from `/leaderboards` (coaches: only for a group they coach;
gym-wide needs owner, admin or operations). Up to 120 days.

| Field | Options |
| --- | --- |
| Type | each athlete (`individual`) or team total (`group_total`) |
| Counts | sessions attended, workouts logged, or weeks trained (distinct Monday-start weeks with a session, a logged workout or an On Your Own session) |
| Who | one training group, or every active athlete |

Progress is computed read-only on every view from existing rows, with the window taken as
facility-local dates, inclusive (a session at 11:30 PM local on the last day counts; 12:30 AM the
next day does not). Completion (`syncChallengeCompletions`, run when Athlete Home or
`/leaderboards` loads, never by the TV) writes one `community_challenge_completions` row per
finisher, awards the `challenge_complete_v1` badge (and `challenge_3_v1` at three), and writes a
`community.challenge.complete` audit entry. A team total finishes for everyone who contributed at
least once. No prizes, no money. An ended challenge stays visible for 7 days; archiving removes it
at once and keeps earned badges.

## Settings (Settings → Community, owner/admin)

Stored at `organizations.settings.community`; every save is audited
(`org.community_settings_update`).

| Setting | Default | Notes |
| --- | --- | --- |
| Community features | on | Off: the TV shows a plain welcome screen, leaderboards and challenges are empty, shoutouts cannot be posted or seen |
| Default name on boards | first name and last initial | Applies to athletes with no explicit choice |
| TV panels | all on | One checkbox per panel |
| Seconds per panel | 15 | 6 to 120 |
| Shoutouts per staff member per day | 10 | 1 to 50 |
| Gym message | none | Plain text, up to 160 characters, family style rules apply |
| Screens | none | Add (one-time link) and revoke |

## Shared-file edits (all additive)

`src/db/schema/index.ts` (export), `src/db/schema/engagement.ts` + `src/lib/engagement/settings.ts`
(XP kind `coach_shoutout`), `src/lib/engagement/badges.ts` + `components/engagement/medallion.tsx`
(badge family `challenge`, two badges), `src/lib/nav.ts` + `src/components/icons.tsx`
(Leaderboards nav item, trophy icon), `src/components/settings-tabs.tsx`, `src/proxy.ts`
(`/leaderboards` in the signed-out redirect list), Athlete Home (one mount line), the staff profile
page (one mount line), `scripts/seed/modules.ts`, e2e route lists.

## Seed (`scripts/seed/community.ts`)

Synthetic only: a sample gym message, Eli hidden by his guardian, Liam first-name-only, three
tested PRs this week, five shoutouts, two current challenges (one gym-wide individual, one team
total for the HS group) and one display screen. The demo organization's screen uses the fixed
token `DEMO_DISPLAY_TOKEN` so docs and e2e can open `/display/link/<token>`; real tokens are
random.

## Not built

- Sound, animations and transitions (deliberately).
- A per-location board. Owner decision (2026-11): one board for the whole business is fine, so this is not planned.
- Photos or avatars on the board.
- Family-to-family reactions or comments (shoutouts are staff-authored only).
- (Built since: challenge completions are also recorded nightly by `community.challenges.nightly`,
  the same `syncChallengeCompletions` the pages call. See `docs/modules/scheduled-jobs.md`.)
- A per-challenge transaction in that job: one organization's challenges are evaluated together.
