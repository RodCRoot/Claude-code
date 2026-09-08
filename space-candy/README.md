# Space Candy Mission Control

The system of record for the **Space Candy** freeze-dried candy business
(Shakedown Sweets CO LLC). It runs in three places:

- **The live dashboard** — a private claude.ai artifact. This is the copy that
  matters day-to-day: it opens on phone and desktop, edits made on the page
  save back to the artifact itself, and the morning watcher refreshes it.
- **The morning watcher** — a Claude routine ("Space Candy morning watch",
  weekdays ~7 AM Eastern) that reads new Space Candy email in
  memberships@teamworkbloomington.com, merges what it finds into the
  dashboard's data, republishes it, and push-notifies Rod only when something
  needs action that day.
- **This repo file** (`index.html`) — the canonical template. Page/chrome
  changes happen here and get republished to the same artifact URL; data
  changes happen on the artifact.

## How the data flows

All data lives in one JSON block inside the page
(`<script type="application/json" id="state">`). The page renders entirely
from it.

- On claude.ai, edits republish the artifact with the new state embedded
  (via the `artifact` runtime capability; the save chip in the header shows
  status). Conflicts resolve by reloading to the winning version.
- Opened as a plain file (this repo, a local copy), edits persist to that
  browser's localStorage instead.
- The watcher swaps only the state block and republishes, so Rod's edits and
  email-derived updates share one record.

## What's on it

| Section | What it does |
| --- | --- |
| KPI row | Open POs, units in flight, inventory on hand, dollars owed (sent invoices), open action items |
| Purchase orders | Editable PO line tracker across all accounts |
| Inventory at Arctic Farms | Per-SKU starting count + on-hand with burn-down meters — when it hits zero, fulfillment moves to IFD |
| IFD 3PL cutover | Deal checklist for the fulfillment transition (status: negotiating) |
| Units in flight | Bar chart drawn from the open PO lines |
| Shipping routing helper | Ron Jon rule: UPS Ground Collect under 200 lb & ≤15 cartons, else LTL |
| Accounts | Every customer/prospect: Active, Waiting on inventory, In talks, Paused |
| Invoices | Ledger with SC-#### numbering, sent/due dates, paid status, overdue flags |
| Ron Jon ship-ready checklist | The compliance steps behind the $250-per-shipment chargeback |
| Action items | Open loops — Rod's and ones the watcher finds in email |
| Products & margin | The six IFD styles; margin computes once cost/unit and price/unit are filled |
| Contacts | IFD, Arctic Farms, Ron Jon, legacy, plus invoicing and ship-to addresses |

## Seed data provenance

Orders, contacts, checklist, and action items came from the June–August 2026
email threads with Ron Jon Surf Shop (PO 180963, vendor rename, compliance
terms), Arctic Farms (case pack, fulfillment), and International Freeze Dry
(contacts, spec sheets). Unknown-at-build values (unit counts, UPCs, SKUs,
prices, inventory) are deliberately blank until a real number arrives from
Rod or from email.
