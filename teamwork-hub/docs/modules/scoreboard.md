# Owner scoreboard

One place the owner opens every morning instead of a hand-assembled daily report and a monthly KPI spreadsheet. Every number is defined once, in code, with a version, and opens the list of rows it was counted from. Code lives in `src/lib/scoreboard/*.ts`, pages in `src/app/(app)/scoreboard`, schema in `src/db/schema/scoreboard.ts`, tests in `tests/scoreboard*.test.ts`, e2e in `e2e/scoreboard.spec.ts`.

The scoreboard is read-only apart from four things the owner types in: ideal targets, thresholds, monthly marketing spend and monthly expenses. It sends nothing, charges nothing and calls no outside service. Nothing is stored or snapshotted: every number is recomputed from the other modules' tables on each view.

| Screen | Path | Who |
|---|---|---|
| Daily scoreboard | `/scoreboard` | owner, admin, operations |
| The list behind a number | `/scoreboard/list/[key]` | same |
| Monthly funnel | `/scoreboard/monthly` | same; ideals editable by owner, admin |
| Schedule and payroll | `/scoreboard/efficiency` | same; payroll table needs payroll access; thresholds editable by owner, admin |
| Marketing economics | `/scoreboard/marketing` | same; spend entry by owner, admin |
| Money view | `/scoreboard/money` | same; margin needs payroll access; expense entry by owner, admin |
| CSV of any table | `/api/scoreboard/[table]` | same as the page it belongs to; every export is audited |

## Who sees what (decision)

- `scoreboard.view`: owner, admin, operations. `scoreboard.manage` (targets, thresholds, spend, expenses): owner, admin. Both are in `src/lib/authz/policy.ts`.
- **Coaches never see the scoreboard.** Every tab carries billing figures, so there is no coach version; the page redirects to `/denied`, the CSV route returns 403, and there is no nav item.
- **Operations** sees everything except payroll cost and the operating margin (which reveals payroll). Those follow the payroll module's own rule (`canManagePayroll`: owner, admin, or operations staff granted access in Payroll, Settings). Operations already has `reports.financial` and `billing.view_all`, so nothing else here is new to them.

## How every number is built

`core.ts` defines two SQL CTEs that everything reads:

- `allm`: every non-pending membership with its plan, net price after discount, monthly equivalent, location scope and `ended_on`.
- `ms`: `allm` narrowed by the page filter.

A membership is **active on day D** when `start_date <= D` and (`ended_on` is null or `ended_on > D`). `ended_on` is the end date, else for cancelled / expired memberships the cancel date, else the day it was marked ended. This is the Retention saves report's rule (`churnFacts`), reused rather than restated.

Each daily metric in `daily.ts` is one SQL query that returns rows. The headline is `count(*)` (or `sum(amount)`) over that query, and `/scoreboard/list/[key]` runs the same query, so a number and its list cannot disagree (tested for every metric).

### The location / program filter

- Program = the membership's product. Location = the membership's location scope (its own override, else the product's) covers the location. A plan valid at every location matches every location.
- Session numbers use the session's own location (strict match, like the Attendance and Utilization reports). With a program filter, only athletes holding that plan on the session's day are counted.
- Money numbers under a filter keep only invoices tied to a membership in the filtered set. Shop, drop-in and camp invoices have no membership and drop out.
- A number that cannot be attributed is **withheld** (shown as "n/a" with the reason), never shown unfiltered. Leads store neither a location nor a program, so the three lead tiles and the Leads row are withheld under any filter; assessments are withheld under a program filter; unreconciled payment items are left out of Needs a decision.
- Marketing is always organization-wide (spend carries no location or program). Payroll and the margin are withheld under a filter.
- Filter ids come from the query string and are checked against the viewer's organization.

### Yesterday's change

For point-in-time numbers the change is the number recomputed as of the end of yesterday minus the number as of the end of the day before, from dated rows. For event counts the tile says what is compared (yesterday against the same weekday last week, or "collected yesterday"). Where history is not stored (lead stages, the radar, billing method) the tile says so instead of showing 0.

## Daily numbers (all version 1)

The exact text is in the Definitions drawer on the page (`definitionsFor("daily")`); this is the short form.

| Number | Rule |
|---|---|
| Active members | Distinct athletes with an active, non-trial membership today; memberships beside it. Per-location table partitions memberships by scope (single location, or "Multiple / all locations") so it adds up |
| Active trial clients | Only membership is a trial (trial product, or inside the plan's trial days), plus unexpired trial passes with no membership |
| New leads, last 24 hours | Lead records created in the 24 hours before the page loaded |
| Open pipeline | Not converted, not in a won or lost stage; by current stage |
| Leads with no follow-up logged | Open leads with no "Mark contacted" |
| Assessments and consults today | Each lead linked to a session today, flagged when no booking for the same person exists on it; plus booked athletes on assessment sessions |
| Memberships sold, month to date | Start date this month, not a trial product, not a plan change / rebuild |
| Attendance / no-shows yesterday | Bookings marked attended / no-show on yesterday's non-cancelled sessions |
| Bookings today + class table | Booked, attended, no-show per class against capacity |
| Past due | Unpaid balance of open invoices due before today, in four aging buckets that sum to the total |
| Bills due in the next 14 days | Open invoices due in the window plus scheduled membership bills with no invoice yet (same rules as `scheduledBills`; tested against it) |
| Failed payments, month to date | Failed payment attempts, plus failed charges with no attempt |
| Holds active / ending within 7 days | Hold records covering today on active memberships |
| At-risk members | **The retention radar's own At risk result** (`retentionRadar`), not a second definition |
| Slipping: last visit 10 to 25 days ago | Active, non-trial, not on hold, days since last attended visit inside the cohort limits (configurable). A cohort, not a risk level |
| Collected month to date / last month | Settled charges and manual payments by settlement time (Collected revenue report's rule) |
| Billed this month | Invoices issued, excluding drafts and voids (Invoiced report's rule) |
| Projected recurring revenue, next month | Monthly-equivalent net price x share of next month's days the membership is running and not on hold. Zen Planner-billed and trial memberships excluded |
| Memberships with autopay off (definition v2) | Active memberships invoiced by Teamwork where nothing is charged automatically: autopay is off for the membership, or it is on but the payer has no active saved payment method (`AUTOPAY_READY_SQL` in `billing/payment-methods.ts`) |
| Memberships expiring in 30 days | End date or scheduled cancellation in the next 30 days |
| People with more than one active membership | Two or more active non-trial memberships (a regular plan paused for in-season is not a second one) |
| Attending above the plan's weekly limit | The membership audit's `over_cap_usage` exceptions |
| Attending under half of the plan | Fewer than half of allowance x weeks attended over the last full weeks (4 by default) |
| Needs a decision | Open confirmed member requests; unreconciled payment items from `paymentExceptions`; membership-audit conflicts (unsigned documents while billed, hold with no end, missing family discount and so on) |

### Where existing screens defined the same thing differently

One definition was picked for the scoreboard and the difference is stated in the definition text on the page:

- **Active membership.** The Active memberships report goes by status and still counts a membership on its end date. The radar goes by status and counts trials. The scoreboard uses the dated rule above (not counted on the end day) and counts trials separately.
- **Past due vs receivables.** The Receivables report lists all open invoices including ones not yet due. The scoreboard's past due is due-before-today only.
- **Churn.** The Retention report's membership churn counts every cancelled or expired membership. The scoreboard separates real losses from plan changes and rebuilds.
- **Uncontacted leads.** The staff dashboard counts leads in the New stage for over 48 hours. The scoreboard counts open leads with no contact logged.
- **Utilisation.** The Utilization report's fill rate is booked / capacity. The scoreboard's utilisation is attended / capacity (that report's second column) and shows booked beside it.
- **Tenure.** The radar's average tenure covers current members. Length of engagement here includes members who left.

## Monthly funnel

`monthlyScoreboard` returns one column per calendar month (6, 12 or 24), computed in one SQL statement over `generate_series`. Point-in-time rows are taken on the month's last day, or today for the month in progress (marked "to date").

Rows: Leads, Showed consults / assessments, New trials sold, New memberships sold, Close rate, Holds processed, Cancellations processed (real losses), Plan changes / rebuilds (not losses), Net growth, Active clients, Active trial clients, Trial conversion, Clients on hold, At-risk clients, Average session attendance, Total visits, Average revenue per member, Length of engagement.

- **Sold vs lost vs plan change.** A membership that starts within `rebuildWindowDays` (default 14) of the same athlete's previous one ending is a plan change / rebuild: not a sale, and the ended one is not a loss. In-place `plan_changed` events also count as plan changes. Net growth = sold minus lost.
- **At-risk** has a value for the current month only. The radar keeps no history, so past months say "not recorded".
- **Ideals** are stored in `organizations.settings.scoreboard.targets`, edited in the table, audited (`scoreboard.targets_update`).

### Where is the bottleneck?

A pure function (`bottleneck`) reads the last complete month against the ideals and reports the first step under its ideal, in this order: leads (marketing), showed consults (follow-up and show rate), new memberships sold (sales), active clients or negative net growth (retention). A step with no ideal or no value is skipped and named. The page shows the rule that fired with its numbers, the full rule list, and a caution that it is only a rule of thumb.

## Schedule and payroll

- **Slots.** One row per weekday + local start time + class title + location over 4, 8, 12 or 26 past weeks, for non-cancelled class and semi-private sessions with capacity over 1. Flags: consistently full (at least `slotConsistencyPercent` of sessions at or above `slotFullPercent` attended / capacity) and consistently under (`slotUnderPercent`). Defaults 75 / 90 / 40, minimum 4 sessions. All are starting points, editable on the page, stored in `organizations.settings.scoreboard.thresholds`.
- **Payroll.** Per month through `calculatePayroll`, so hours and gross pay equal what Payroll shows for the same dates. A month with no time-clock entries is "not available", never 0. A month with hours that have no pay rate is "incomplete". Payroll % = gross pay / collected.

## Marketing economics

`scoreboard_marketing_spend`: one amount per month and channel, typed in (no ad-platform integration). A channel is matched to a CRM lead source by name. Cost per lead, cost per new member (a member belongs to the source of the lead they were converted from), average monthly revenue per member, length of engagement, estimated lifetime revenue (the two multiplied) and its ratio to acquisition cost. The page states that this is gross revenue, not profit. Missing spend gives a blank, not $0.

## Money view

Collected, refunds, net, billed, outstanding, account credits issued (referral rewards) and camp / clinic revenue per month; collected by membership option and by location (each a partition that adds up to collected). `scoreboard_expenses` holds optional monthly rent, software, other and a hand-entered payroll figure used only for months with no time-clock data. Operating margin = net collected minus those, marketing spend and payroll. It is labelled a management estimate, not accounting, on the page and in the export; when payroll is unknown or incomplete the margin is "not available" and the figure before payroll is shown.

### Billed in Zen Planner, imported

When the organization has rows in `zp_bills` (a Zen Planner bill export committed in Imports), the money view shows one more card, "Billed in Zen Planner, imported": bills, billed, paid and unpaid-at-import per month of the bill's due date (`importedBillsView`, definition `mv_zp_imported` v1, export table `money-zp-imported`). It is imported history from another system and is **never** added to Collected, Billed, Outstanding, the revenue groups or the margin; `mv_collected` and `mv_billed` say so (both now version 2, wording only, the rule did not change). A month with no imported bills is blank, not $0. Under a filter only bills matched to a filtered membership count. The card is hidden when nothing was imported; the demo seed imports no bills.

## Charts

Two charts, both using the reports' `ChartFigure` + `ReportBarChart` (sold vs lost; collected vs billed), each with a text summary and a data table.

## Demo data

`scripts/seed/scoreboard.ts` adds about six months of synthetic history: invented members joining, rebuilding, holding and leaving; weekly classes with attendance (one slot consistently full, one consistently under); monthly invoices and payments with an unpaid invoice in each aging bucket; leads by source with consults; older time-clock shifts; sample spend, expenses and ideals. Every row is flagged `is_demo` and every price is labelled sample. It is **opt-in** (`HISTORY_SEEDS` in `scripts/seed/modules.ts`): `pnpm db:fresh` runs it, the default test seed does not, a test asks for it by naming `scoreboard` in `modules`.

## Not done / limits

- No stored history: "yesterday's change" for lead stages, the radar and billing method is not available; monthly At-risk has the current month only.
- A lead who showed and was later marked Lost is not counted as showed unless a booking was checked in (the CRM keeps only the current stage). Close rate can exceed 100% when a sale follows an earlier month's consult.
- Leads cannot be filtered by location or program.
- Autopay off now uses the per-membership autopay flag and saved payment methods (see `payments-autopay.md`); autopay history is not stored, so past days use today's state. Zen Planner-billed memberships are not judged. `expiringCards()` (cards expiring within 60 days) is exposed for a future tile; the scoreboard page does not show it yet.
- No accounting integration, no ad-platform integration, no scheduled email of the scoreboard.
- Money is assumed to be in the organization's one currency.

## Assumptions to confirm with the owner

- Operations may see revenue on the scoreboard but not payroll cost or the margin.
- The rebuild window (14 days), the slipping cohort (10 to 25 days) and the slot thresholds are sensible starting points.
- "Program" in the filter means the membership plan.
- Memberships sold are counted on their start date, not the day they were keyed in.
- Family holds only count as "holds processed" and "clients on hold"; in-season pauses are shown separately on the daily page.
