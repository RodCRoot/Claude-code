# Teamwork Indiana — GoHighLevel Build Guide

How to take the `index.html` design concept and build it as a live, fully
automated site inside GoHighLevel (GHL). The concept mirrors your current
TeamworkIndiana.com content but wires every interactive element to a native GHL
feature or automation.

> Tip: open `index.html` and flip the **"Build view"** switch in the top nav.
> Each ⚡ badge shows exactly which GHL feature powers that element on the page.

---

## 1. Brand kit (set this once)

Pulled directly from your logo so everything matches.

| Token | Hex | Use |
|---|---|---|
| Brand Blue (primary) | `#004CBA` | Buttons, links, primary accents |
| Blue (bright, on dark) | `#2E7BFF` | Eyebrows/labels on navy backgrounds |
| Green | `#009245` | Success, checkmarks, "Recover" |
| Red | `#C1272D` | "Test", energy accents |
| Purple | `#662D91` | "Personalize", coach accent |
| Yellow | `#FFE000` | Highlights, star ratings, offers |
| Navy (ground) | `#0C1A31` / `#08101F` | Dark bands: nav, hero, footer |
| Cool white | `#F4F6FB` | Light section backgrounds |

- **Fonts:** heavy grotesque for display (uppercase headlines), clean sans for
  body. In GHL, set a bold sans (e.g. Anton / Oswald / Archivo for headings,
  Inter / Roboto for body) under **Settings → Custom Fonts**.
- **Logo:** upload `logo.png` to **Media Library**. It's a light wordmark built
  for dark backgrounds — keep it on navy in the header/footer.
- **Recurring motif:** the five colored dots = your five brand colors = the
  "Five F's." Reuse them as section dividers and accents.

---

## 2. Page structure → GHL builder

Build in **Sites → Funnels/Websites**. Each section below maps to a GHL row/block.

| Section on the page | GHL element | Notes |
|---|---|---|
| Sticky nav + logo | Website header | Set as a global/reusable header |
| Hero + "Free Assessment" | Funnel step 1 + **Calendar** embed | Primary conversion point |
| "Your first session FREE" card | 2-step order/booking form | New-athlete offer |
| Trust strip (stats) | Static counter row | Social proof |
| 5-step Method | Icon/columns row | Content only |
| Five F's | 5-column card row | Uses the 5 brand colors |
| Membership pricing | **Order forms + Memberships** | See §4 |
| Coaches | Team card row | Content only |
| Success stories | Testimonial row | Pull from **Reputation** reviews |
| Contact / free assessment | **Form → Workflow → Pipeline** | See §3 |
| Footer | Global footer | Include social + address |

---

## 3. Core automations (Workflows)

Build these under **Automation → Workflows**. These are the engine behind the site.

### A. New lead → instant response (the money maker)
**Trigger:** Contact form submitted OR calendar booked.
1. **Send SMS** immediately: "Hey {{contact.first_name}}, it's Teamwork Indiana!
   Thanks for reaching out — a coach will confirm your free assessment shortly. 💪"
2. **Send Email** with what to expect + address + parking.
3. **Create Opportunity** in the "New Athletes" pipeline → stage *New Lead*.
4. **Assign** to a coach / round-robin.
5. **Internal notification** (SMS/email to staff).

### B. Missed-call text-back
**Trigger:** Inbound call missed on your GHL number.
- Auto-SMS: "Sorry we missed you! This is Teamwork Indiana — how can we help you
  get faster? Reply here and a coach will jump in." *(This is the badge on the
  nav phone number.)*

### C. Free-assessment nurture (if no booking)
**Trigger:** Lead created, tag `no-booking` after 1 hour.
- Day 0, 1, 3 SMS/email drip → link back to the booking calendar.
- Stop on: appointment booked.

### D. Appointment reminders
**Trigger:** Appointment booked (Calendar).
- Confirmation now → reminder 24h before → reminder 2h before.
- No-show branch → "Want to reschedule?" with rebooking link.

### E. Post-assessment → membership
**Trigger:** Appointment status = *Showed*.
- Thank-you + the 3 membership options (Starter/Athlete/All-Access).
- Move opportunity to *Assessment Complete*; if purchased → *Member (Won)*.

### F. Review request (fuels Success Stories)
**Trigger:** 14 days after becoming a member OR after a milestone.
- SMS/email asking for a Google review → **Reputation Management** → best
  reviews feed the testimonials section.

---

## 4. Memberships & payments

- **Payments → Settings:** connect Stripe.
- **Products:** create three recurring subscription products:
  - Starter — $129/mo (1 session/week)
  - Athlete — $189/mo (2 sessions/week) *(mark "Most Popular")*
  - All-Access — $249/mo (3 sessions/week)
- Each pricing button → GHL **Order Form** for that product.
- Optional: gate a training-plan / progress area behind **Memberships**
  (courses) so paying athletes log in for their plan.

---

## 5. Calendars

- **Calendars → Create:** "Free Athlete Assessment" (e.g. 45 min).
- Assign coaches, set availability, buffer times.
- Embed on the hero + contact section (the "Book My Free Session" buttons).
- Connect Google Calendar for two-way sync so coaches never double-book.

---

## 6. Pipelines (see every lead)

Create pipeline **"New Athletes"** with stages:
`New Lead → Contacted → Assessment Booked → Assessment Complete → Member (Won) → Lost`

Workflows above move opportunities automatically so your dashboard always shows
real status.

---

## 7. Extras worth turning on

- **Web chat widget** → routes to the same lead workflow (+ missed-call text-back).
- **Facebook/Instagram** → connect socials; run lead-form ads straight into the
  same pipeline (your current site links FB & IG).
- **Email/SMS templates** → save the messages above as reusable templates.
- **Analytics** → track form conversion + calendar bookings on the dashboard.

---

## 8. Build order (fastest path to live)

1. Brand kit: colors, fonts, logo (§1).
2. Connect Stripe, create the 3 products (§4).
3. Build the "Free Assessment" calendar (§5).
4. Create the "New Athletes" pipeline (§6).
5. Build Workflow **A** + **B** first — instant response + missed-call. (§3)
6. Build the pages, dropping in the calendar, order forms, and contact form.
7. Add the remaining nurture/reminder/review workflows (§3 C–F).
8. Test end-to-end: submit the form → confirm SMS/email/pipeline all fire.

---

*`index.html` is a self-contained concept mockup (your real logo embedded, both
light & dark themes, mobile-responsive). Use it to approve the look, then
rebuild the same sections natively in GHL using this guide.*
