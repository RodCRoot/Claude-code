# Don't quote the scoreboard numbers yet — here's why

Checked against the live app on **October 3, 2026**.

## The short version

Your real Zen Planner data imported correctly. But the made-up starter
("demo") records are still sitting in the same database, and the scoreboard
adds the two together. So the numbers on screen are **real data plus fake
data**, with no way to tell them apart by looking.

One command fixes it. See "The fix" below.

## How I know it's mixed, not just suspected

August is the proof. You imported **nothing** for August — your reports were
all September. If the database were clean, August would read zero. Instead the
live app shows, for August:

| Metric | Shows | Should show |
| --- | --- | --- |
| Total Collected Revenue | $3,862 | $0 |
| Attendance (Check-ins) | 147 | 0 |

Every dollar and every check-in there is invented. July shows $5,811 the same
way. Those same fake records continue into September, mixed in with your real
numbers.

## What's definitely wrong right now

**Monthly Recurring Revenue (EFT) — $4,714 — is 100% fake.**
This is the clearest one. The app has no way to import memberships from Zen
Planner, so every membership in there came from the starter data. Nothing about
that $4,714 is yours. Don't repeat it in a meeting.

**Active Athletes — shows 258, you actually have 230.**
Your import brought in 230 athletes. The other 28 are invented. This one I can
state exactly, because 258 − 230 = 28 matches the starter data precisely.

**Total Collected Revenue — shows $11,092.91 for September, real figure is lower.**
Judging by August's $3,862 of fake payments, something in that neighborhood is
padding September too. I'm deliberately not giving you a subtracted number —
I'd be guessing, and a guess is worse than waiting.

**Attendance (Check-ins) — shows 316 for September, real figure is lower,
and also counts the wrong thing.**
Two separate problems stacked on top of each other:

1. Fake check-ins are mixed in (same as above).
2. The Zen Planner attendance report includes rows that are only *RSVP'd* or
   *cancelled*, not actually attended. The live app counts those as check-ins.
   The fix for this is written and tested but is not on the server yet — see
   "Still waiting on a deploy."

Because attendance is overstated, **At-Risk Athletes (248) and Athletes Below
Expected Attendance (257) are also wrong.** Those are the numbers meant to tell
you who to call, so they matter more than the vanity figures.

## What you *can* trust today

**Cancellations — 21 in September.** This came straight from your cancelled-
memberships report and is yours. The duplicate problem you flagged is handled:
the report had 31 rows, 10 of which were the same people listed twice, and the
app merged them to 21 real cancellations.

Your drop reasons are also being sorted the way you described them:
"distance too far" and college/moved count as **expected**, while
"administrative drop" (ghosted, stopped coming without contact) counts as
**controllable** — the kind you can actually do something about.

## The fix

**Remove the fake records.** Nothing of yours is touched — every row you
imported is tagged as real, and only rows tagged as sample data get deleted.
Your logins, goals, metric definitions, and checklists all stay.

In Render, open your service → **Shell** tab, and run:

```
npm run db:clear-demo
```

It prints what it removed. That's the whole job.

After that there's now also a button for it — **Admin → Demo mode → Remove
sample records** — so you never need the Shell again. It shows you the count
before you delete and asks you to type a confirmation phrase. It goes live with
the next deploy.

## Still waiting on a deploy

The server is running the code from a few merges ago. Two fixes are finished,
tested, and sitting in the repo unused:

- Attendance stops counting RSVP'd and cancelled rows as check-ins
- The Admin button described above

In Render: **Manual Deploy → Deploy latest commit**. Also worth checking
**Settings → Auto-Deploy** is On, since it stopped firing on its own.

**Once the deploy lands, attendance needs re-importing** — the rows already in
there were counted under the old, wrong rule.

## Order of operations

1. Render → Shell → `npm run db:clear-demo`
2. Render → Manual Deploy → Deploy latest commit
3. Re-import the attendance report (Data → Import)
4. Admin → Demo mode → turn the "Demo data" label off

Then the scoreboard is quotable, and I can pull your real month-to-date figures
and hand them to you.
