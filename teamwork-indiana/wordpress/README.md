# WordPress.com build kit

Files for rebuilding the Teamwork Indiana site on Rod's WordPress.com Premium
site (`rodf6940d88459c-qwrkz.wordpress.com`, blog_id 256688996, theme
Assembler). Claude drives this via the WordPress.com connector when it's
connected; these files are also usable manually.

## Manual path (works without Claude)

1. **Site identity:** Settings → General → Site title "Teamwork Indiana",
   tagline "Sports Performance Training · Bloomington, IN".
2. **Custom CSS:** Appearance → Customize (or Editor → Styles) → Additional
   CSS → paste `additional-css.css`.
3. **Media:** upload `../logo.png`, `../assets/hero-bg.jpg`, and the photos in
   `../assets/carousel/` to the Media Library.
4. **Pages:** create pages Home / Success Stories / FAQ. In the block editor,
   open the ⋮ menu → Code editor, and paste the block markup from
   `page-*.html` files as they're added here. Swap image placeholders for the
   Media Library URLs.
5. **Homepage:** Settings → Reading → set "Home" as the static homepage.
6. **GHL wiring (Premium plan = links, not embeds):** point the booking
   buttons at the GHL calendar/funnel URLs once Rod's calendar is live.

## Domain cutover (after pages approved)

1. Renew teamworkindiana.com at GoDaddy (expires 2026-09-16!).
2. WordPress.com → Upgrades → Domains → "Use a domain I already own" →
   teamworkindiana.com → choose **connect** (not transfer).
3. In GoDaddy DNS, set the A/CNAME records WordPress.com specifies (keep
   GoDaddy nameservers).
4. Set teamworkindiana.com as the primary domain; SSL issues automatically.
5. Keep the old Circle City Digital hosting live until confirmed, then cancel.
