# Family scheduling and billing: parity with the previous member site

Owner request: the family-facing scheduling and billing screens should feel like the member site and app
families already use, so they find everything where they expect it, with the same flow and the same words.

What this is: a presentation and navigation change. Booking, credit, waitlist, cancellation, billing and
authorization rules are untouched. No schema change, no migration. Nothing of the previous vendor's
branding (name, logo, colours, icons, images, copy) is used; the vendor is not named on any family screen.

**Source of the reference shape.** We could not sign in to the previous system and did not try. The
vendor's public help centre was not reachable from the build machine (the help host answered with a
"missing page" and the marketing site with HTTP 429), so every "what we matched" below is **from memory of
the public member experience** plus the owner's brief. Nothing here is account-verified. The last column
is the checklist to walk through with real screenshots from the owner.

Screenshots (before / after, desktop and 390 px): `docs/screenshots/zpfeel/`.

## Checklist

| Screen | Where | What we matched | Confidence | What to verify against the owner's screenshots |
|---|---|---|---|---|
| Calendar landing | `/schedule` (families) | Opens on a single **day**. Date header with previous / next arrows, "Go to date" field, Today, a strip of the week's seven days, then the day's classes in time order. Day / Week / Month switch kept. | Medium | Whether the member site opens on today's day list or a week list. Whether the week strip starts on Sunday (ours starts Monday, like the staff calendar). Position of the date picker. |
| Class row | `/schedule` | Start time and length ("4:30 PM", "60 min"), class name, instructor, location and room, spots ("11 of 12 spots open"), one action on the right. | Medium | Exact spots wording: we show **open** spots of capacity; the member site may show **reserved** of capacity ("5 of 12"). Whether duration or end time is shown. Whether instructor photos appear. |
| Row action | `/schedule` | **Reserve**; **Join waitlist** when full; **Reserved** badge with **Cancel reservation** when already in; **Waitlist #n** with **Leave waitlist**. Closed states say why (ended, reservations closed, opens on a date, full). | Medium-high | Exact button words ("Reserve" vs "Register", "Cancel reservation" vs "Cancel"). Whether a reserved class shows a tick or a coloured row. |
| Family member choice | `/schedule`, class detail | Chosen **at the moment of reserving**: Reserve opens a "Who is this for?" checklist of the family members who can be reserved; several can be ticked at once. With one eligible person the button reserves directly ("Reserve for Maya" when the family has more than one child). | Medium | The member site uses a person switcher at the top of the app for some accounts and a checklist for others. Confirm which one Teamwork families see and whether several children can be reserved in one tap. |
| Class detail | `/schedule/classes/<id>` (new) | Tap the class name: when, instructor, location, program, spots, description, "Attending from your family", the same action, and the cancellation policy sentence. | Medium | Field order on the detail screen. Whether other attendees are listed to members (we show only the viewer's own family, on purpose). |
| Filters | `/schedule` | Optional Program, Location, Instructor filters in a collapsed "Filters" row. | Medium | Which filters the member calendar actually offers, and their labels ("Program" vs "Class type", "Instructor" vs "Staff"). |
| My Reservations | `/schedule/reservations` (new) | Upcoming reservations and waitlist spots for the whole family, each with Cancel reservation; Reschedule kept where another time is open. | Medium | Name of the screen ("My Reservations" vs "Upcoming"), and whether it is a tab or a menu entry. |
| My Attendance | `/schedule/attendance` (new) | By month, one family member at a time, previous / next month, attended count for the month. Full history and milestones stay on the per-athlete page. | Medium | Whether attendance is a list by month or a calendar grid with marked days. |
| Appointments | `/schedule/book` | Separate "Appointments" entry: appointment type, family member, staff member, date, then open times with Reserve. | Medium | Order of the steps (type then staff then date) and whether the member site shows a month calendar of available days rather than a 7-day list. |
| Late-cancel rule | calendar, class detail, My Reservations | Stated in the confirm at the moment of cancelling, on the class detail, and once at the top of My Reservations. Wording comes from the configured policy (the seed policy is a SAMPLE). | High (behaviour), n/a (wording) | The gym's real policy text. |
| Profile area | sidebar "My Profile" → `/billing` | Tabs in this order: **Family, Memberships, Bills, Payment Methods, Payment History, Documents, Attendance**. Documents and Attendance link to the existing screens. | Medium | Tab names and order on the member site ("Profile" vs "Family", "Purchase History" vs "Payment History"). Whether families expect a "Profile" tab with contact details (we have no family-editable contact screen yet). |
| Bills | `/billing/invoices` | **Unpaid bills** table: Due date, Description, Amount, Status, **Pay Now**. **Upcoming bills** (Scheduled) listed separately. **Bill history** with Receipt. Each bill opens a detail with a printable receipt. | Medium-high | Column order. Status words (we use Paid, Unpaid, Unpaid · past due, Failed, Scheduled, plus Processing / Void / Closed for states this app has). Whether upcoming bills sit above or below unpaid ones. |
| Memberships | `/billing/memberships` | One card per membership per person: name, begin date, end or renewal date, status, price and billing day, what it includes, sessions remaining (not shown for unlimited or per-week plans), hold status. | Medium | Field names ("Begin date", "End date", "Renews"). Whether punch cards appear as memberships or separately (ours: a "Session credits" list per person below the cards). |
| Payment Methods | `/billing/payment-methods` (new) | Card or bank on file per billing account: brand, last four, expiry, default, and which memberships it is charged for automatically. | Low-medium | Layout of the card on file and where "Update" lives. |
| Payment History | `/billing/history` (new) | Date, description (payment or refund, linked bill), method, amount, status, receipt link. | Medium | Whether the member site lists purchases (items) or payments (money) here. |

## Family-facing words changed

| Before | After |
|---|---|
| Book sessions (page title) | Calendar |
| Book &lt;name&gt; / Join waitlist for &lt;name&gt; | Reserve / Join waitlist (person chosen in the checklist) |
| Booked: &lt;name&gt; | Reserved · &lt;name&gt; |
| Cancel | Cancel reservation |
| Upcoming bookings | My Reservations (own tab) |
| Move booking | Move reservation |
| Book a private / assessment (tab), Book a private session or assessment (title) | Appointments |
| Service / Athlete / Coach / Week starting (appointment form) | Appointment type / Family member / Staff member / Date |
| Book (open-time button) | Reserve |
| Attendance history (button) | My Attendance (tab), Attendance |
| Book several athletes / Book several weeks | Reserve several weeks (several people are chosen in the checklist) |
| Booked. / Cancelled. (confirmation messages to families) | Reserved. / Reservation cancelled. |
| Book for the family, Choose athletes | Reserve for the family, Choose family members |
| Online booking opens N days ahead | Reservations open N days ahead |
| Booking for &lt;name&gt; isn't enabled on your account | Reserving for &lt;name&gt; isn't enabled on your account |
| Memberships & Billing (sidebar, families only) | My Profile |
| Overview (tab) | Family |
| Invoices & receipts (tab and title) | Bills |
| Amount due | Balance due, Unpaid bills |
| Pay / View (on an open invoice) | Pay Now / View |
| Invoice · &lt;account&gt; (kicker), Lines, Athlete (column) | Bill · &lt;account&gt;, Bill details, Family member |
| Pay (card title), Pay with &lt;provider&gt; | Pay Now, Pay Now with &lt;provider&gt; |
| Printable invoice | Print bill |
| Zen Planner (external) (badge on a family's membership) | Billed in the previous system |
| Open invoices, Billing (family dashboard card) | Unpaid bills, Bills |
| Book a session / Book another / Nothing booked yet (family dashboard) | Reserve a class / Reserve another / Nothing reserved yet |
| "creates an invoice", "View invoice" (shop, referral) | "creates a bill", "View bill" |

Staff screens keep the accounting and operations terms (invoice, booking, payer, roster).

## Known gaps (not built)

- **Update payment method.** Built (see `payments-autopay.md`): the Payment Methods tab lets a person allowed
  to pay the account add a card or bank account on Stripe's hosted page, set the default, remove one and switch
  autopay per membership. Without Stripe keys it says plainly that saving is not available yet and that bills are
  paid at the front desk. Never exercised against a Stripe sandbox.
- **Profile / contact details.** There is no family-editable profile (address, phone, emergency contact).
  The first tab is "Family" (members, memberships, credits, balance) rather than "Profile".
- **Attendance calendar grid.** Attendance is a monthly list, not a month grid with marked days.
- **Appointments by calendar.** Open times are listed for 7 days from a chosen date, not a month view of
  available days.
- **Membership self-service.** Families cannot place holds or cancel in the app (staff-only, unchanged).
- **Page titles in the browser tab** for the shared bill and receipt routes still read "Invoice" / "Receipt".
- **Line descriptions on bills** are produced by the billing engine (and the SAMPLE seed) and contain an
  em dash and ISO dates, for example "Sample — Unlimited Monthly Membership — 2026-11-01 to 2026-11-30".
  Changing that text is a billing-logic change and was left alone.

## Staff side

Compared with a studio calendar (day / week time grid, coloured class blocks, click a block for the roster
with check-in, add a person from the roster):

| Expectation | Teamwork Hub today | Gap |
|---|---|---|
| Day and week grid by time with coloured blocks | `/schedule` staff view: week grid (one column per day) and day grid (one column per coach), blocks tinted by service colour, month view, filters | None found |
| Click a block → roster with check-in | Block opens `/schedule/sessions/<id>`: roster with Check in / No-show per person, waitlist, promote | Check-in is a button per person, not a tick box; no "check in all" |
| Add a person from the roster | Roster page has athlete search and add (with comp / override reasons) | None found |
| Staff billing screens | Unchanged (accounting views) | Not restyled; out of scope for this pass |

Nothing on the staff side was rebuilt.
