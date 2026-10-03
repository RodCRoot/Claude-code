# Pulling data from Zen Planner automatically

Zen Planner has no API we can use, so there is no clean "connect your account"
button to build. What the app does instead is open a real Chrome browser on the
server, sign in as a staff member, open each report you tell it to, read the
grid off the page, and import it — the same thing you'd do by hand, done on a
schedule.

That part is built and tested. Below is what you do to switch it on, and one
decision I need you to make first.

---

## The decision: where your Zen Planner password lives

For the server to sign in to Zen Planner by itself, your Zen Planner staff
password has to be stored on the server (in Render, as an environment variable —
not in the code, and never in this repository).

That is a real tradeoff and it's yours to make, not mine:

- A Zen Planner staff login can see **everything** — every athlete, their
  guardians, contact details, and billing. Most of your athletes are minors.
- Stored as a Render environment variable, the password is not in the codebase
  and not visible in the app. It is visible to anyone who can log into your
  Render account, and it would be exposed if Render itself were breached.

**Two ways to reduce the risk, both worth doing:**

1. **Make a separate Zen Planner staff login just for this** — something like
   `scoreboard@teamworkbloomington.com` — and give it the least access that
   still lets it open your reports (read-only if Zen Planner offers that). Then
   if you ever want to cut it off, you change one password and nothing else
   breaks. Don't use your own `rod@` login.
2. **Turn on two-factor** on your real admin account.

**If you'd rather not store it at all**, that's a legitimate choice. The app
still works — you just keep importing by hand (Data → Import), which takes a
couple of minutes per report. Everything below is optional convenience, not a
requirement. Nothing about the scoreboard depends on it.

---

## Switching it on

### Step 1 — Add the credentials to Render

Render → your service → **Environment** → add two variables:

| Key | Value |
| --- | --- |
| `ZEN_PLANNER_EMAIL` | the Zen Planner login you made for this |
| `ZEN_PLANNER_PASSWORD` | that login's password |

Save. Render restarts the service.

Until both are set, the sync refuses to run and says so plainly — it does not
pretend to work.

### Step 2 — Get each report's URL out of Zen Planner

Do this once per report you want synced. In Chrome:

1. Log into Zen Planner (**studio.zenplanner.com**).
2. Open the report you want — attendance, payments, cancelled memberships, your
   member list.
3. **Set it up exactly how you want it imported**: the date range, and the
   columns. The columns are part of the URL, so the columns you choose here are
   the columns the app imports.
4. Copy the **entire address bar**. It'll be long and ugly, something like:

   ```
   https://studio.zenplanner.com/zenplanner/studio/index.html#/main/iframe/zenplanner/studio/bill/index.cfm?_c=firstName,dueDate,billAmount,status&BillType=Bill
   ```

   The `_c=` part is the column list. That's normal — paste the whole thing.

Tip: use a **rolling date range** ("this month", "last 30 days") rather than
fixed dates, so the same URL keeps working next month.

### Step 3 — Import each report by hand once

This teaches the app which column means what, and it's worth doing because it
also shows you what the import will look like before it runs unattended.

In the app: **Data → Import**, upload or paste that report, check the column
matching, and **save the mapping with a name** — e.g. `ZP Attendance Export`.

The app guesses the columns for you and is usually right. It knows Zen Planner's
habits: that the person column is headed "Name", and that columns come through
as `dueDate` and `billAmount`. Glance at the guesses and fix any that are wrong.

### Step 4 — Point the sync at the reports

**Admin → Settings → "Zen Planner scrape jobs"**. There's one entry per report.
For each one, fill in:

| Field | What to put |
| --- | --- |
| `url` | the long URL from Step 2 |
| `mappingName` | the mapping name you saved in Step 3 |
| `enabled` | `true` |

Leave `mode` as `"table"`. Save.

### Step 5 — Run it once by hand

**Data & Sync → Zen Planner → Sync now.**

Read the result. It tells you per report how many rows it read and how many were
new. If something failed, it says which report and why, and saves a screenshot
of what the browser actually saw under `data/debug/` — so a failure is
diagnosable, not a mystery.

Once a manual run works, the schedule takes over.

---

## What it handles on its own

These are all things that broke during testing and are now handled, so you
don't have to think about them:

- **Reports live inside a frame.** Zen Planner draws each report in a frame
  inside the page, so the data isn't in the page itself. The app searches every
  frame.
- **All the reports share one address.** Zen Planner addresses reports with a
  `#` on the end of the same page, which means a browser moving from one report
  to the next often doesn't actually reload. Without handling this, every report
  after the first would have imported the *first* report's data under the wrong
  name. The app forces a real reload between reports.
- **The idle screen.** Leave Zen Planner alone a while and it shows "It looks
  like you've left us..." with a Reset Session button. That's not a logout. The
  app clicks it and carries on.
- **Grid clutter.** Zen Planner grids end with "Add" rows and "Showing 1-20 of
  200" rows, and reprint their header when they paginate. None of that gets
  imported as if it were an athlete.
- **Empty reports.** Zero cancellations this week is a normal answer, so it's
  reported as "empty for its date range", not as a failure. Only a genuinely
  broken report shows up red.
- **Running twice.** Every sync de-duplicates, so re-running never
  double-counts. Safe to run as often as you like.
- **RSVP'd and cancelled rows.** The attendance report includes people who
  reserved a spot or cancelled. Those are not check-ins and are not counted.

---

## What it does not do

Being straight with you about the limits:

- **It can only read what a report shows.** If a number isn't in a Zen Planner
  report, the app can't get it. There's no back door.
- **Memberships can't be imported at all.** There's no import path for them,
  which is why Monthly Recurring Revenue on your scoreboard is still sample
  data. Either a membership report gets added here, or that figure stays
  untrustworthy. Worth fixing — tell me and I'll add it.
- **If Zen Planner redesigns a report, that job breaks.** It'll fail loudly with
  a screenshot rather than import garbage. Re-copy the URL and it's fine.
- **Two-factor on the synced login will block it.** That's why the separate
  login in Step 1 matters: keep two-factor on your real account, and leave it
  off only on the limited one.

---

## If it breaks

Everything is in **Data & Sync → sync history**: what ran, when, what it read,
and the exact error. Failures also leave a screenshot and a copy of the page
under `data/debug/`, which is usually enough to see what happened — an expired
password, a changed report, a Zen Planner outage.

You can also verify the whole machine end to end without touching Zen Planner:

```
npm run test:scraper
```

That runs the real sync code against a fake Zen Planner built to behave like the
real one — frames, the `#` addressing, the idle screen, the grid clutter. If
that passes and a real report doesn't, the problem is the URL or the login, not
the app.
