# Events: camps and clinics sold online

Module `events`. Domain code in `src/lib/events/*.ts`, schema in `src/db/schema/events.ts`
(migration `0024_events.sql`), server actions in `src/app/(app)/_events/actions.ts`, staff pages
under `/events`, family pages under `/shop/camps`, seed in `scripts/seed/events.ts`, tests in
`tests/events.test.ts` and `e2e/events.spec.ts`.

An event is a camp, clinic or similar thing a family registers for as a whole: one price, one
capacity, one or more scheduled sessions. It reuses the existing session, eligibility, invoice and
payment machinery. Nothing here charges a card, sends a message or decides a refund.

## Data model

| Table | What |
|---|---|
| `events` | name, description, kind (`camp` / `clinic` / `event`), status (`draft` / `published` / `closed`), capacity, `price_minor`, optional `early_bird_price_minor` + `early_bird_until`, optional `sibling_discount_percent`, optional `registration_opens_on` / `registration_closes_on` (facility local dates, inclusive), `min_age` / `max_age`, `required_form_template_ids`, `hold_hours` (default 48) |
| `event_sessions` | links an event to rows of `schedule_sessions` (a multi-day camp is several sessions). A session belongs to at most one event |
| `event_waitlist_entries` | one per athlete in line for a full event: status `waiting` / `offered` / `accepted` / `expired` / `declined` / `removed`, `position`, `offer_expires_at`, the billing account, the registration an accepted offer created. Partial unique index: one live (`waiting` or `offered`) entry per athlete per event. `events.waitlist_offer_hours` (default 24) |
| `event_registrations` | one per athlete and event: status `held` / `confirmed` / `expired` / `cancelled`, the price it was billed at (base, early bird flag, sibling discount, amount), `hold_expires_at`, billing account, invoice. Partial unique index: one live (`held` or `confirmed`) registration per athlete per event |

Event sessions are ordinary sessions created with `createSession`, with `visibility = private`,
capacity equal to the event's, and a per-kind service type ("Camp session", "Clinic session",
"Event session") that costs no credits. Private visibility means a family cannot book one with
membership credits: the only way in is the registration. Staff see them on the calendar and take
attendance on the normal session page.

`invoice_lines.entitlement` gained one optional key, `eventRegistrationId` (JSON, no column change).

## Pricing (`pricing.ts`, pure)

- Price in effect: the early bird price through the end of `early_bird_until`, then the regular price.
- Sibling discount: every athlete after a billing account's first on the same event gets the percent
  off the price in effect, rounded to the cent. Athletes the family already has registered (held or
  confirmed) count as the first.
- Each athlete is one invoice line at their own amount; the invoice discount field is not used.
- The amounts are stored on the registration, so later price edits never change an issued invoice.
- All prices are typed in by staff. The seed prices are samples.

## Registration (`registerForEvent`)

1. Who: a guardian or adult athlete may register athletes they can both **pay** for (`can_pay` on the
   billing account, via `shopAthletes`) and **book** for (`booking.create` from `policy.ts`). Jordan
   (view only) and Casey (no booking, no payment) see the event with a plain reason and no button.
   Staff with `billing.manage` can register any athlete with a billing account from the event page.
2. The event row is locked `FOR UPDATE`. Under that lock: status and registration window are checked,
   expired holds on this event are released, duplicates and eligibility are checked, and seats are
   counted (`held` + `confirmed`). Concurrent registrations therefore cannot oversell (test: 10
   concurrent requests for 3 seats give exactly 3 registrations and 7 "full" errors).
3. Eligibility reuses `checkEligibility` with the event's age limits and required forms, evaluated on
   the first session's date. Reasons are shown to the family as written there. Staff can override
   with a reason (audited).
4. One `held` registration per athlete and **one open invoice per billing account** through
   `createInvoiceRecord` (due on the day the hold ends). No provider is contacted. The family then
   uses the existing invoice page and hosted checkout, or pays at the front desk when no provider
   is configured (the page says so).
5. Idempotent per submitted form (`submit_key`, advisory lock), so a double tap makes one invoice.

## Unpaid holds

- **How long:** `events.hold_hours`, set per event by staff, default **48 hours**, and never past the
  start of the first session.
- **What releases a hold:** `releaseExpiredHolds`. It runs inside every registration (for that event,
  under the event lock) and when the family list, the family detail page or the staff events pages
  are opened. It marks the registration `expired` and **voids the unpaid invoice**, so a lapsed
  registration cannot be paid later by accident. It also releases a hold whose invoice staff voided
  by hand.
- **What does not release it:** money recorded on the invoice (a partial payment), a bank payment
  that is processing, a hosted checkout opened in the last hour, or an invoice row locked by a
  payment being recorded at that moment. Until a hold is actually released it keeps its seat, so a
  payment that arrives late on a still-held registration confirms it.
- A nightly job (`events.holds.nightly`, Settings → Scheduled jobs) runs the same release for the whole
  organization, so a lapsed invoice is voided even when nobody opens a page. Capacity never depended on
  it: every registration releases first.

## Waitlist (`waitlist.ts`, `waitlist-core.ts`)

A full event no longer just says "Full".

- **Joining.** A family joins for named athletes from the camp page; front desk staff can add an
  athlete from the event page. The checks are the same as registering, through the same functions:
  who may pay and book (`resolveSeats`), age and required forms (`checkEligibility`), registration
  open, not already registered or in line. Staff may override eligibility with a reason. Joining is
  only possible while the event is full (or others are already waiting). It creates no bill.
- **A released spot is offered, never charged.** Whenever a held or confirmed spot is released
  (staff cancellation, an unpaid hold running out, a voided invoice, more capacity), the first
  athlete in line is **offered** it: the entry becomes `offered` with `offer_expires_at` =
  now + `waitlist_offer_hours` (default 24, set per event, never past the first session). No
  registration, no invoice, no charge and **no message**: the family sees "A spot has opened for
  <name>" on the camp page and a badge on the camps list.
- **An offer reserves the seat.** `seatsTaken` counts held and confirmed registrations plus live
  offers, so nobody else can register into an offered spot and "spots left" stays 0.
- **Accepting** (`acceptWaitlistOffer`) calls `registerForEvent` with that seat reserved, so the result
  is the normal held registration and open invoice at today's price, confirmed only when paid. If that
  bill is not paid, the hold is released like any other and the spot is offered to the next in line.
- **Declining or running out** passes the spot to the next in line. Expiry is handled in
  `advanceWaitlist`, which the hold-release path calls for every event it visits:
  `releaseExpiredHoldsForEvent` (inside every registration and join) and `releaseExpiredHolds` (camps
  pages, the staff events pages and the nightly job), which also visits events whose only due item is
  an offer.
- **Staff** (`schedule.manage`) see the line on the event page, move a waiting entry up or down, and
  remove an entry with a reason. Staff with `billing.manage` can accept an offer for a family.
- **Concurrency.** Every waitlist decision is made under the event row lock, like registration.
  Tests: 10 simultaneous joins get 10 distinct places; two spots released at once give exactly two
  offers; an offer accepted from four tabs while three others try to register and the sweep runs
  seats exactly one athlete; accept racing the expiry sweep ends in exactly one of the two outcomes.
- **Audit.** `events.waitlist.join`, `.offer`, `.offer_expired`, `.accept`, `.leave`, `.remove`, `.reorder`.
- A family sees only its own athletes' entries and their place, never who else is waiting.

## Confirmation: only on settled payment

`confirmEventRegistration` is called from the billing module's `applyInvoiceEntitlements` for lines
that carry `eventRegistrationId`, and it confirms **only when the invoice status is `paid`**, which
the billing module sets only in `settleInvoiceIfCovered` (settled money covers the total: a verified
provider webhook or a staff-recorded offline payment). A browser redirect, a pending bank payment, a
partial payment, and the org policy "grant on pending" do not confirm (all tested).

On confirmation the athlete is booked into every scheduled session of the event with
`entitlement_source = drop_in_invoice`: no membership is touched and no credit is reserved or used.
The event's capacity already admitted the athlete, so the session capacity is not re-checked.
A free event (price 0) is a $0 invoice, which the invoice flow settles at once, so it confirms
through the same path. Adding a session later books every confirmed athlete into it.

If a payment lands on a registration that was already cancelled (or expired with the event now
full), nobody is seated and a high-priority staff task is created to refund or re-register.

## Cancelling and refunds

`cancelEventRegistration` (staff, `schedule.manage`, reason required) releases the spot at once and
cancels the athlete's bookings in sessions that have not started. **It makes no money decision:**

- Unpaid invoice with no payments: voided. If siblings on the same invoice keep their spots, a new
  invoice is issued for just them at their original amounts.
- Paid or part-paid invoice: left exactly as it is. Any refund is issued from the invoice page with
  the existing refund flow (`billing.refund`, owner/admin). Event revenue subtracts settled refunds
  recorded on the event's invoices.

Families cannot cancel online; the page tells them to contact the front desk.

## Pages

| Who | Where | What |
|---|---|---|
| Family | `/shop/camps` (also a card on `/shop` and on Athlete Home) | Published events that have not finished: dates, ages, price in effect, spots left, the family's own registrations |
| Family | `/shop/camps/<id>` | Details, athlete checkboxes with a running total, eligibility or permission reasons per athlete, hold and payment status with a link to the invoice. When full: join the waitlist, place in line, leave; when a spot is offered: take it or pass |
| Staff | `/events` (nav: Front desk, "Camps & clinics") | List with paid, unpaid, spots left and revenue per event |
| Staff | `/events/new`, `/events/<id>` | Create a draft with sessions; publish, close, edit details and pricing, add a session, register an athlete, cancel a registration, registrations with paid/unpaid, the waitlist (reorder, remove, add an athlete, accept for a family) |
| Staff | `/events/<id>/roster` | Roster CSV (held and confirmed athletes, age at start, payment, invoice, billing account). Formula-safe; the export is audited |

## Authorization

| Action | Who |
|---|---|
| Create, edit, publish, close, add sessions, cancel registrations, list, roster CSV | owner, admin, operations (`schedule.manage`) |
| Register on a family's behalf, eligibility override | owner, admin, operations (`billing.manage`) |
| Revenue and invoice links on the staff pages | `billing.view_all` |
| Register online, join or leave the waitlist, accept or decline an offer | guardian or adult athlete with `can_pay` on the billing account and `booking.create` on the athlete |
| See the waitlist, reorder, remove | owner, admin, operations (`schedule.manage`) |
| Add an athlete to the waitlist or accept an offer for a family | owner, admin, operations (`billing.manage`) |
| See published events | any guardian or athlete login in the organization |

Coaches have no access to the events pages (they see event sessions and rosters on the calendar).
Every query filters on `org_id`. Every mutation is audited (`events.*`).

## Lock order

Registration, hold release and cancellation lock **event, then invoice**. Payment settlement locks
**invoice, then event**. To avoid a deadlock the event-first paths never wait for an invoice lock:
they use `SKIP LOCKED` and either leave that hold for the next pass (release) or ask staff to retry
(cancel).

## Demo data

`pnpm db:fresh` seeds three events, all flagged demo and named "Sample: ...": a three-day Holiday
Speed Camp (sample prices: $180, early bird $160, 10% sibling discount, ages 10 to 16), a one-day
Change of Direction Clinic (sample $45, ages 12 and up) and a draft. Three front-desk registrations
for roster-filler athletes: two paid by sample checks, one holding a spot unpaid.

## Not done / follow-ups

- **Waitlist offers are not announced.** No email, text or in-app notification is sent when a spot is
  offered: the family has to open the camps page within the offer window (default 24 hours). Until
  messaging is connected, the front desk should call the family; the event page shows who holds an
  offer and until when.
- Offers and holds that run out while nobody opens a page are processed by the nightly job, so an
  offer can outlive its expiry by up to a day before the next family is offered the spot. Any camps
  page view or registration processes it sooner.
- An athlete who declines or lets an offer run out can rejoin at the back; there is no limit on that.
- The demo seed has no waitlisted athletes (the seeded events are not full).
- Families cannot cancel or release their own unpaid hold online.
- No emails or texts (registration received, payment reminder, hold about to expire).
- Sessions cannot be removed from the event page; cancel that day's session on the calendar (it then
  drops out of the family view). Per-session coach or room changes also happen on the calendar.
- Catalog `camp` products (Billing → Products) remain separate and are still not sellable in the shop.
- One sibling rule only (percent off each additional athlete on the same billing account).
- Hosted checkout with real provider credentials was not exercised (no credentials here); settlement
  was tested with staff-recorded payments and with settled provider-verified transactions.
