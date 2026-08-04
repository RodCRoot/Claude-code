# Teamwork Indiana — GoHighLevel Build Guide

How to take the design concept (`index.html` + `testimonials.html`) and build
it as a live, fully automated site inside GoHighLevel (GHL). The concept
mirrors your current TeamworkIndiana.com content but wires every interactive
element to a native GHL feature or automation.

> Tip: open either page and flip the **"Build view"** switch in the top nav.
> Each ⚡ badge shows exactly which GHL feature powers that element on the page.

**This is a living document** — as we build in GHL, check items off and add
notes/changes in the changelog (§10) so the guide always matches the real
account.

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

### Home page (`index.html`)

| Section on the page | GHL element | Notes |
|---|---|---|
| Sticky nav + logo | Website header | Set as a global/reusable header |
| Hero + "Free Assessment" | Funnel step 1 + **Calendar** embed | Primary conversion point |
| "Your first session FREE" card | 2-step order/booking form | New-athlete offer |
| Trust strip (stats) | Static counter row | 2014 · 800+ · 30 days · **CSCS** (same cert required by NCAA & pro sports) |
| 5-step Method | Icon/columns row | Content only |
| Five F's | 5-column card row | Uses the 5 brand colors |
| "This is Teamwork" community | 2-col image row | Real photos: flags wall + logo wall |
| "Life at Teamwork" carousel | Image slider fed by **Media Library** | 13 curated photos incl. sprint & box-jump frames; can auto-sync from socials |
| Membership pricing | **Order forms + Memberships** | See §4 |
| Coaches | Team card row | Rod (USAW), Erin, Seth (CSCS), Jordan, Lauren |
| Success stories (3 reviews) | Testimonial row + link | Pull from **Reputation** reviews; links to Success Stories page |
| Contact / free assessment | **Form → Workflow → Pipeline** | See §3 |
| Footer | Global footer | Include social + address |

### Success Stories page (`testimonials.html`)

| Section on the page | GHL element | Notes |
|---|---|---|
| Hero + "Rated 5 stars on Google" | Page header | Reputation Management badge |
| Featured story (Cooper Bybee) | Rich text / testimonial block | HS → Big Ten (IU Men's Basketball) with owner reply — keep verbatim |
| Video stories | **Video hosting / Media Library** embeds | Currently linking Drive: Gavin Hodgson testimonial, James Butcher Athlete of the Week. In GHL, upload and embed so they play in-page |
| Review wall (14 reviews) | **Reputation Management → review widget** | All verbatim Google reviews; the widget keeps it auto-updated as new reviews land |
| CTA → free assessment | Button → home page calendar/form | Same booking flow as home |

> All review screenshots (the sources for every quote) are archived in
> `assets/reviews/` for verification.

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

### G. Video testimonial → effortless Google review
The workflow behind the ask in Rod's email to Seth (Aug 2026):
1. Coach collects a video testimonial → drops it in the Drive social folder
   and flags it.
2. We transcribe the athlete's video.
3. Send the athlete/parent **their own words** back (SMS/email template) with
   the Google review link — posting takes them ~30 seconds under their own
   account; they can edit freely.
4. New review lands → Reputation Management pulls it onto the site
   automatically.
- ⚠️ Keep the text their words (from the transcript), not invented copy —
  Google filters ghost-written reviews and it protects the listing.
- In GHL: build as a manual-trigger workflow ("Video testimonial received")
  with an email/SMS template containing `{{contact.first_name}}` + transcript
  + review link.

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

Use as a checklist — check items off as they're done in GHL:

- [ ] 1. Brand kit: colors, fonts, logo (§1).
- [ ] 2. Connect Stripe, create the 3 products (§4).
- [ ] 3. Build the "Free Assessment" calendar (§5).
- [ ] 4. Create the "New Athletes" pipeline (§6).
- [ ] 5. Build Workflow **A** + **B** first — instant response + missed-call (§3).
- [ ] 6. Build the home page, dropping in the calendar, order forms, contact form.
- [ ] 7. Build the Success Stories page; connect the Reputation review widget;
      upload the testimonial videos to the Media Library and embed.
- [ ] 8. Add the remaining nurture/reminder/review workflows (§3 C–G).
- [ ] 9. Test end-to-end: submit the form → confirm SMS/email/pipeline all fire.

---

## 9. Asset inventory (what exists and where)

**In this repo:**
| Path | What |
|---|---|
| `index.html` | Home page concept (self-contained, logo + photos embedded) |
| `testimonials.html` | Success Stories page concept |
| `logo.png` | Web logo (light wordmark for dark backgrounds) |
| `assets/carousel/` | 13 web-optimized carousel photos + contact sheet of all 29 candidates |
| `assets/reviews/` | 13 Google-review screenshots — sources for every quote on the site |

**In Google Drive:**
| Location | What |
|---|---|
| "Teamwork Bloomington Marketing Files Logo etc" folder | `SquareLogo.ai` (vector master — upload to GHL for print), `TWBLogo.ai`, Twitter banner, ~46 photos |
| Social content folder (`1hmALJl2I1p97HBG9ssDFxiGzN5e0jLh5`) | Named athlete photos + training videos: sprints (Anya, Rowan, Noah, Luke, Jacob, Emmitt), box jumps (Layla), hang cleans, med-ball throws, group games, **Gavin Hodgson testimonial video**, **James Butcher Athlete of the Week video** |

**Content rules of thumb:**
- Old-facility photos (sled lane / family-class room) are excluded — current
  facility only.
- Photos show recognizable athletes, many minors — confirm photo releases
  before going live.
- Every testimonial quote must trace to a screenshot in `assets/reviews/`
  (verbatim, trimmed only with ellipses).

---

## 10. Changelog

Add a dated line whenever the concept or the GHL build changes.

- **2026-08-04** — Initial concept: home page, brand kit from logo, 6 core
  workflows, pricing/calendar/pipeline plans.
- **2026-08-04** — Added real Drive assets: community section (flags + logo
  wall photos), real Google reviews replace placeholder quotes, Jordan &
  Lauren named on Crew card.
- **2026-08-04** — Added "Life at Teamwork" carousel (13 photos incl.
  sprint-frame and box-jump frame extracted from training videos); removed two
  old-facility photos.
- **2026-08-04** — Added Success Stories page (featured Cooper Bybee Big Ten
  story, 14-review wall, video testimonial links); homepage links to it.
- **2026-08-04** — Trust strip: replaced "5 certified coaches" with **CSCS —
  the same cert required by NCAA & pro sports**.
- **2026-08-04** — Hero: full-bleed action photo background (three athletes
  pressing, current facility) behind a navy gradient; `assets/hero-bg.jpg`.
- **2026-08-04** — Emailed Seth (draft): testimonials → Drive folder, keep
  requesting Google reviews, video→transcript→review workflow (§3G).

---

*The HTML pages are self-contained concept mockups (real logo and photos
embedded, light & dark themes, mobile-responsive). Use them to approve the
look, then rebuild the same sections natively in GHL using this guide.*
