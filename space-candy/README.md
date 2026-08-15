# Space Candy — Ops Dashboard

A single-file command center for the **Space Candy** freeze-dried candy
business (Shakedown Sweets CO LLC). Open `index.html` in any browser —
no install, no server, no account. Every edit saves automatically to that
browser's localStorage and never leaves the machine.

## What's on it

| Section | What it does |
| --- | --- |
| KPI row | Open POs, units in flight (+ carton equivalent at 12/case), ship-ready checklist progress, open action items — all computed live from the data below |
| Purchase orders | Editable tracker for wholesale order lines (PO #, retailer, product, units, status, notes) |
| Units in flight by product | Bar chart of open order lines, drawn from the PO table |
| Ron Jon ship-ready checklist | The compliance steps from Ron Jon's vendor terms, with a progress meter and the **$250-per-shipment chargeback** warning. Reset it before each new shipment |
| Shipping routing helper | Enter weight + carton count → UPS Ground Collect (under 200 lb and ≤ 15 cartons, on the PO's UPS account) or LTL via Ron Jon logistics |
| Action items | Open loops from the email threads; add your own |
| Product catalog | The six styles from IFD's spec sheets, with blanks for UPCs and Ron Jon SKUs (both required on carton labels) |
| Contacts | IFD (production), Arctic Farms (fulfillment), Ron Jon (retail), plus the invoicing address, ship-to address, and vendor record |

## Where the seed data came from

The pre-filled orders, checklist, contacts, and action items were pulled from
the June–August 2026 email threads:

- **Ron Jon Surf Shop** (Dave Buteau, Cheryl Howe) — revised PO 180963, the
  vendor rename from Space Candy (VSPACAN) to Shakedown Sweets, and the
  packing/labeling compliance terms.
- **Arctic Farms** (Gadi Briskman, Tima) — fulfillment, case-pack dimensions,
  and the pack-list/carton-label template request.
- **International Freeze Dry** (Shannan Rhoades, Tim Lawlor, Robert Bao) —
  production contacts and the six product spec sheets.

Anything that was still unknown at build time (unit quantities on the PO,
UPCs, Ron Jon SKU numbers) is left blank on purpose — fill it in on the page
as the answers come in.

## Resetting

- **Reset for next shipment** clears just the ship-ready checklist.
- **Reset everything to seed data** (footer) throws away all edits in that
  browser and restores the seeded state.

The page follows the system light/dark theme; the button in the header
overrides it.
