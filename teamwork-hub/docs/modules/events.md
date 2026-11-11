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
- There is no scheduled job yet: release is lazy (see "Not done"). Capacity is still correct because
  every registration releases first.

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
| Family | `/shop/camps/<id>` | Details, athlete checkboxes with a running total, eligibility or permission reasons per athlete, hold and payment status with a link to the invoice |
| Staff | `/events` (nav: Front desk, "Camps & clinics") | List with paid, unpaid, spots left and revenue per event |
| Staff | `/events/new`, `/events/<id>` | Create a draft with sessions; publish, close, edit details and pricing, add a session, register an athlete, cancel a registration, registrations with paid/unpaid |
| Staff | `/events/<id>/roster` | Roster CSV (held and confirmed athletes, age at start, payment, invoice, billing account). Formula-safe; the export is audited |

## Authorization

| Action | Who |
|---|---|
| Create, edit, publish, close, add sessions, cancel registrations, list, roster CSV | owner, admin, operations (`schedule.manage`) |
| Register on a family's behalf, eligibility override | owner, admin, operations (`billing.manage`) |
| Revenue and invoice links on the staff pages | `billing.view_all` |
| Register online | guardian or adult athlete with `can_pay` on the billing account and `booking.create` on the athlete |
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

- **Waitlist: not built.** A full event says "Full". The session waitlist machinery promotes into a
  free seat by reserving a credit; an event seat needs an invoice and a new hold instead, so it could
  not be reused cheaply.
- No scheduled job releases expired holds. They are released on the next registration for that event
  and whenever the family or staff events pages are opened. A job on the existing queue would also
  void lapsed invoices while nobody is looking.
- Families cannot cancel or release their own unpaid hold online.
- No emails or texts (registration received, payment reminder, hold about to expire).
- Sessions cannot be removed from the event page; cancel that day's session on the calendar (it then
  drops out of the family view). Per-session coach or room changes also happen on the calendar.
- Catalog `camp` products (Billing → Products) remain separate and are still not sellable in the shop.
- One sibling rule only (percent off each additional athlete on the same billing account).
- Hosted checkout with real provider credentials was not exercised (no credentials here); settlement
  was tested with staff-recorded payments and with settled provider-verified transactions.
