# Teamwork Indiana — Project Handoff

**Everything needed to continue this project in a new chat, Codex, or with a
different agent.** Written 2026-08-12.

Repo: `RodCRoot/Claude-code`
Branch: **`claude/teamworkindiana-ghl-redesign-xbtw6n`**
Folder: `teamwork-indiana/`
Owner: Rod Root, rod@teamworkbloomington.com

---

## 1. What this project is

Rod owns **Teamwork Bloomington** (website: TeamworkIndiana.com), a sports
performance training gym in Bloomington, Indiana. We redesigned his website
from scratch and are now migrating it to a platform he can manage himself.

**Three finished pages exist** as self-contained HTML (open in any browser —
logo and photos are embedded as data URIs, no external dependencies):

| File | Page |
|---|---|
| `index.html` | Home |
| `testimonials.html` | Success Stories |
| `faq.html` | FAQ |

They were also published as private Claude Artifacts (Rod can view/share):
- Home: https://claude.ai/code/artifact/68edb656-c225-4707-bdbb-37ef22942876
- Success Stories: https://claude.ai/code/artifact/9c9a184e-a8cc-4bcf-afee-5790d5e85eb1
- FAQ: https://claude.ai/code/artifact/0ccb6690-775b-4189-9ebd-889879e7de00

Each page has a **"Build view" toggle** in the nav that reveals ⚡ badges
showing which GoHighLevel feature powers each interactive element.

---

## 2. Current status / where we left off

**Done:**
- All three pages designed, content fully approved by Rod line-by-line
- Real photos and real Google reviews sourced from Rod's Google Drive
- WordPress.com Premium purchased and confirmed on the right site
- WordPress block markup generated for all three pages (`wordpress/page-*.html`)
- Brand CSS written for WordPress (`wordpress/additional-css.css`)

**Blocked / not done:**
- **Pages are NOT yet in WordPress.** The WordPress.com MCP connector kept
  disconnecting mid-session (worked ~3 times out of ~10 attempts), so pages
  were generated as files instead of pushed via API. A fresh session with a
  freshly-connected connector should be able to push them.
- Domain not yet connected; DNS not yet changed; old site still live.
- GHL build not started (calendar, workflows, pipeline).

**Immediate next steps** — see §7.

---

## 3. Critical facts (verified, don't re-research)

### Domain
- **teamworkindiana.com is registered at GoDaddy.** Registered 2019-09-16.
- ⚠️ **EXPIRES 2026-09-16.** Rod has been told repeatedly to renew; confirm
  he did. Auto-renew should be turned on.
- DNS is managed at GoDaddy (nameservers `ns23/ns24.domaincontrol.com`).
- **The current live site is hosted by Circle City Digital** (an Indiana web
  agency) at `server.circlecitydigital.com` / 159.89.239.43. It is a
  self-hosted WordPress site — NOT on WordPress.com, GHL, or ZenPlanner.
  Rod does not have (and does not need) access to it. Worth requesting a
  backup from them before cutover, and cancelling that hosting after.

### WordPress.com
- Site: `rodf6940d88459c-qwrkz.wordpress.com` — **blog_id `256688996`**
- Plan: **Premium**, $120/yr, renews 2027-07-11 — confirmed attached to the
  correct site (the MCP API misleadingly reported "free"; trust the billing
  page, not the API field)
- Theme: **Assembler** (`pub/assembler`), font Inter, grayscale palette (so
  brand colors must be set explicitly — that's what the custom CSS does)
- Site is unlaunched / coming-soon mode. Timezone America/Indiana/Indianapolis.
- `teamworkindiana.com` also appears in Rod's WordPress "Active Upgrades",
  status **"start transfer / setup transfer"** — meaning **no transfer has
  been started**. Recommendation given: **connect (map) the domain, do NOT
  transfer**, at least not until after launch and after the GoDaddy renewal.

### Business facts (all confirmed by Rod)
- Address: **2013 S. Yost Ave, Bloomington, IN 47403** — west side, near
  Walmart, next to Auto Choice, two buildings down from The Doghouse, free parking
- Phone (call/text): **(812) 445-5551** (verified on his live contact page)
- Cancellations email: **memberships@teamworkbloomington.com**
- **Billing statement descriptor: "T2 Indiana INC"**
- Founded 2014; **1,500+ athletes over 13 years**; **100+ NCAA D1**;
  **300+ collegiate**; alumni have competed in **NCAA D1, NFL, WNBA, FIBA**
- Coaches: **Seth** (Head Coach, NSCA-CSCS, IU kinesiology, ~decade),
  **Rod Root** (Co-Founder, CSCS, USAW, TPI in progress),
  **Erin Parks** (Co-Founder, 13 yrs, 6 AM + Saturday sessions),
  **Maddelyn "Madde" Miller** (Assistant Coach, CSCS, IU '25, former athlete).
  *Jordan and Lauren no longer work there* — removed everywhere except inside
  one verbatim Google review that names them (left intact deliberately).
- Session times: 6 AM Mon/Wed/Fri; 3:30/4:30/5:30/6:30 PM Mon–Thu;
  3:30/4:30/5:30 PM Fri; 9 AM Sat; **closed Sunday** (may open with demand)
- Members reserve sessions in the **ZenPlanner app**, at least **2 hours
  before** the session
- Membership: from **$129/mo** (1×/wk), $189 (2×/wk), $249 (3×/wk).
  **6- and 12-month training blocks earn a price break.** Rod's framing:
  *"you're buying development, paid monthly — not renting a gym."*
  **Exact 6/12-month block prices are still UNKNOWN — ask Rod.**
- **Payments stay in ZenPlanner** — decided against Stripe/on-site checkout.
  Pricing buttons link out to ZenPlanner or "contact us."
- Billing: prorated first payment on day one, full term starts on the 1st
- Cancellation: email only, **30 days notice** (blocks) / **2 weeks** (M2M),
  early-cancellation fee if a block isn't complete, auto-rolls to
  month-to-month after a term completes
- **30-Day Risk-Free Guarantee**: "walk away — no questions, no hard feelings."
  Deliberately kept SEPARATE from cancellation policy — it's a sign-up
  risk-remover, not a membership mechanic.
- Free offer: **Free Performance Assessment ($99 value)** — goal-setting and
  injury-history planning, **vertical jump assessment**, **Hawkin Dynamics
  force plates** (CMJ, squat jump, countermovement rebound jump), **sprint
  speed + first-step acceleration**, personalized recommendations, no commitment
- A2P/SMS is **already registered** through Rod's existing GHL texting — no
  new carrier verification needed.

### Content rules (Rod's instructions)
- ❌ **No Linton-facility photos.** That's the old location: the
  ribbon-cutting/grand-opening set, family class on colorful mats, sled lane,
  kids line-up — all excluded. Current Bloomington facility only (red-wall
  gym, navy flag gym, Teamwork Bloomington logo wall).
- ✅ **Every testimonial must be a real, verbatim Google review**, traceable
  to a screenshot in `assets/reviews/`. No invented quotes.
- ⚠️ Photos show recognizable athletes, many minors — **confirm photo
  releases before going live publicly**.
- League logos (NFL/WNBA/FIBA/NSCA) are rendered as **styled wordmark chips,
  not official logo art** — trademark reasons. Swap in real logos only with
  permission.

---

## 4. File map

```
teamwork-indiana/
├── index.html                  Home page (self-contained, 2.4MB w/ embedded images)
├── testimonials.html           Success Stories page
├── faq.html                    FAQ page
├── logo.png                    Logo (light wordmark, for dark backgrounds)
├── README.md                   Folder overview
├── HANDOFF.md                  ← this file
├── GHL-BUILD-GUIDE.md          GoHighLevel build plan (brand kit, page mapping,
│                               7 workflows, memberships, calendar, pipeline,
│                               asset inventory, dated changelog)
├── FAQ-PARENTS-ATHLETES.md     Customer-facing FAQ handout (print/email)
├── FAQ-BOT-KNOWLEDGE.md        Same content structured for Rod's AI customer
│                               service bot, with escalation guardrails
├── assets/
│   ├── hero-bg.jpg             Hero background (athletes pressing dumbbells)
│   ├── web-flags.jpg           Signing-day flags group photo
│   ├── web-logowall.jpg        Kids at the Teamwork Bloomington logo wall
│   ├── carousel/               13 curated photos + contact-sheet.jpg (all
│   │                           candidates) — sprint-frame.jpg and
│   │                           jump-frame.jpg were extracted from training videos
│   └── reviews/                13 Google review screenshots (sources of truth)
└── wordpress/
    ├── README.md               WordPress build + domain cutover runbook
    ├── generate_blocks.py      Regenerates the page markup below
    ├── page-home.html          Gutenberg block markup — Home
    ├── page-success-stories.html
    ├── page-faq.html           (generated from FAQ-PARENTS-ATHLETES.md, so
    │                           the FAQ page and the doc can never drift)
    ├── additional-css.css      Brand styling for WP Additional CSS
    └── reviews.json            The 14 verbatim reviews as data
```

### Brand tokens (sampled from Rod's actual logo)
```
Blue (primary)   #004CBA     Navy (ground)  #0C1A31
Blue (on dark)   #2E7BFF     Navy (deep)    #08101F
Green            #009245     Cool white     #F4F6FB
Red              #C1272D
Purple           #662D91     Display: heavy uppercase grotesque
Yellow           #FFE000     Body: clean sans (Inter on WP)
```
The five colors come from the five dots in the logo and map onto the gym's
"Five F's" — used as a recurring motif (dividers, card accents, tags).

---

## 5. Google Drive assets (Rod's account)

- **"Teamwork Bloomington Marketing Files Logo etc"** — `SquareLogo.ai`
  (vector master, upload to WP/GHL for print), `TWBLogo.ai`, Twitter banner,
  ~46 photos, and the Google review screenshots
- **Social content folder** — ID `1hmALJl2I1p97HBG9ssDFxiGzN5e0jLh5` — named
  athlete photos and training videos: sprints (Anya Bailey, Rowan Miller, Noah
  Ferree, Luke Freel, Jacob Newby, Emmitt Short), box jumps (Layla Mathis),
  hang cleans, med-ball throws, group games, **Gavin Hodgson testimonial
  video**, **James Butcher Athlete of the Week video**. This is the folder Seth
  should keep filling.

---

## 6. Related work already done

- **Email drafted to Seth** (in Rod's Gmail Drafts, may or may not be sent):
  explains the redesign, links the Drive social folder, asks for testimonials
  and more Google reviews, and describes the video→transcript→review workflow.
- **Workflow G** in the GHL guide: when an athlete gives a video testimonial,
  transcribe it and send them *their own words* plus the Google review link so
  posting takes 30 seconds. ⚠️ Deliberately NOT AI-written reviews — Google
  filters ghost-written reviews and it risks the listing.

---

## 7. Next steps (in order)

### A. Immediate, Rod-only
1. **Renew teamworkindiana.com at GoDaddy** (expires 2026-09-16) + auto-renew on.
2. Request a **site backup from Circle City Digital**.
3. Provide the **6-month and 12-month membership prices** (only real content gap).

### B. Get the pages into WordPress
Either:
- **Via connector** (preferred): with a working WordPress.com MCP connection,
  create three pages on blog_id `256688996` using the markup in
  `wordpress/page-*.html`, save as **drafts**, upload `assets/` images to the
  Media Library and replace the `__MEDIA__` placeholders, paste
  `additional-css.css` into Additional CSS, set Home as the static homepage
  (Settings → Reading).
- **Manually**: Pages → Add New → ⋮ → **Code editor** → paste each file →
  Save draft. Full steps in `wordpress/README.md`.

### C. Review, then go live
4. Rod reviews the drafts on the `.wordpress.com` URL and gives edits.
5. **Connect** the domain: WP → Upgrades → Domains → "Use a domain I own" →
   teamworkindiana.com → **Connect** (NOT transfer) → choose the **A-record**
   option (keeps GoDaddy nameservers so email/other records survive).
6. At GoDaddy: DNS → Manage Zones → update the `@` A record and `www` CNAME to
   WordPress's values. Change nothing else.
7. Verify SSL + site loads, keep old hosting live a few days, then cancel it.

### D. GoHighLevel (per `GHL-BUILD-GUIDE.md`)
8. Build the "Free Performance Assessment" calendar (Rod has a Cowork prompt
   for this already; two-way sync to his personal Google Calendar).
9. Build the "New Athletes" pipeline and Workflows A + B (instant lead
   response, missed-call text-back), then C–G.
10. Link the site's booking buttons to the GHL calendar URL (the markup has a
    `GHL_CALENDAR_URL` placeholder in `page-home.html`).

### E. Still wanted (not started)
- **Athlete Hall of Fame page** — Rod asked for this; material exists
  (signing-day photos, college flags, Cooper Bybee's IU story, the
  D1/NFL/WNBA/FIBA claim). Needs Rod to supply athlete names + destinations.
- Additional pages: Apparel, Blog, Become a Coach.

---

## 8. Notes for whoever picks this up

- **Rod's voice matters.** He walked through every FAQ answer verbally and the
  copy reflects how he actually talks ("we're not in the business of building
  bench-press champions"). Don't sanitize it. When adding content, match that
  register: direct, warm, confident, coach-to-parent.
- **Three documents must stay in sync**: `faq.html` (website),
  `FAQ-PARENTS-ATHLETES.md` (handout), `FAQ-BOT-KNOWLEDGE.md` (chat bot).
  `wordpress/page-faq.html` is generated from the markdown by
  `generate_blocks.py` — regenerate rather than hand-editing.
- **Rod has a separate Claude Code project** for a customer service bot. The
  bot knowledge file was written to merge into it. That repo was never
  accessible from this session — ask Rod for the repo name if it needs syncing.
- The MCP connectors in this environment (WordPress, Google Drive, Gmail,
  GHL/Windsor) flap on and off constantly. **Batch operations while a
  connector is up**; don't assume it will still be there next message.
- Everything is committed and pushed. Nothing lives only in chat.
