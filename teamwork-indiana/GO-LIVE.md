# Teamwork Indiana — Go-Live Critical Path

Last updated: 2026-08-31

**Site:** WordPress.com blog_id `256688996` — https://rodf6940d88459c-qwrkz.wordpress.com
**Plan:** Premium (renews 2027-07-11) · **Theme:** Assembler
**Status:** unlaunched / coming soon · 3 pages exist as drafts

| Page | ID | Slug | Preview |
|---|---|---|---|
| Home | 9 | (front page) | `?page_id=9&preview=true` |
| Success Stories | 8 | success-stories | `?page_id=8&preview=true` |
| FAQ | 7 | faq | `?page_id=7&preview=true` |

---

## Hard deadline

**Renew teamworkindiana.com at GoDaddy — expires 2026-09-16.**
Registrar GoDaddy, registered 2019-09-16, GoDaddy nameservers. Turn on
auto-renew while you're in there. Nothing else on this list matters if the
domain lapses.

---

## The critical path, in order

### 1. Rod: renew the domain (5 min) — blocking everything
GoDaddy → My Products → Domains → teamworkindiana.com → Renew + auto-renew ON.

### 2. Rod: review the three drafts (30 min)
Open the three preview links above, mark anything wrong, send edits.
Known content gap: **6-month and 12-month training block prices.** Until you
give me those numbers the FAQ says "ask us" instead of quoting a price.

### 3. Rod: upload the photos (5 min)
Drag the contents of `teamwork-photos.zip` into
**WP Admin → Media → Add New**. Full quality, no re-compression.
Once they're in, I place them into the pages — hero background, coach
headshots, the photo grid on Home.
The logo is already uploaded (media ID 10).

### 4. Rod: photo releases — before launch, not after
Several photos include minors. Confirm you have releases on file for
every athlete pictured, or tell me which ones to pull.

### 5. Rod: decide what to do with the placeholder "About" page
WordPress created a sample page (id 1, slug `about`) that is already
**published**. At launch it would be publicly reachable at
`/about/` with default filler text. Say the word and I'll trash it, or
tell me what you want on it.

### 6. Me: place images + set Home as the static homepage
**Settings → Reading → A static page → Homepage: Home.**
Has to happen after the pages are published (WordPress won't let a draft
be the front page).

### 7. Rod + me: publish and launch
Publish all three pages, then **launch the site out of coming-soon mode.**
Nothing is public until you say go.

### 8. Connect the domain — **Connect, not Transfer**
This is the step that goes wrong most often, so read it twice.

- In WordPress: **Upgrades → Domains → Add a domain → Use a domain I own**
  → enter `teamworkindiana.com` → choose **Connect**, NOT Transfer.
  If it says "start transfer or setup transfer," you're on the wrong path —
  back out and look for the connect/DNS option.
- Choose the **A-record method** (not the nameserver method). This keeps
  GoDaddy as your registrar and keeps your email working.
- At GoDaddy → DNS: point the `@` A record and the `www` CNAME at the
  values WordPress gives you. Leave the MX records alone.
- Propagation is usually under an hour, sometimes up to 48.

**Keep the current site up until the new one is verified live.** It's hosted
by Circle City Digital (`server.circlecitydigital.com` / 159.89.239.43).
Ask them for a full backup before you cut over — you can't get it back
afterward.

---

## After launch (not blocking)

- **GoHighLevel:** Free Performance Assessment calendar, "New Athletes"
  pipeline, Workflows A–G. Then swap the `#contact` booking buttons on all
  three pages to the real GHL calendar URL.
- **Athlete Hall of Fame page** — requested, not started. Needs a list of
  athlete names + college destinations.
- Optional later pages: Apparel, Blog, Become a Coach.

---

## What is already done

- Three pages built as Gutenberg blocks and pushed to WordPress as drafts
  (27 FAQ questions, 14 verbatim Google reviews, full home page).
- Site title and tagline set.
- Logo uploaded to the Media Library (media ID 10) and placed in the header,
  linked back to the homepage.
- Brand CSS applied site-wide via global styles — the same layer as
  Appearance → Customize → Additional CSS.
- **Footer rewritten with real information.** The theme shipped with
  "123 Example Street, San Francisco, CA 12345 / hi@example.com /
  (123) 456-7890" — all of it placeholder. It now carries the Yost Ave
  address, the real session-time grid, (812) 445-5551,
  memberships@teamworkbloomington.com, and the T2 Indiana INC billing note.
- Header CTA button now reads "Free Assessment" and links to `/#contact`
  (was an inert "Learn more").
- Navigation set to Home · Success Stories · FAQ (was a stub pointing at
  the placeholder About page).
- Success Stories CTA verified pointing at `/#contact`.
- FAQ page is generated directly from `FAQ-PARENTS-ATHLETES.md`, so the
  page and the parent handout can never drift apart.
- `FAQ-BOT-KNOWLEDGE.md` ready for the customer-service bot, including
  escalation rules (call (812) 445-5551, route cancellations to
  memberships@teamworkbloomington.com, don't quote block prices, explain
  that T2 Indiana INC is what shows up on billing).
