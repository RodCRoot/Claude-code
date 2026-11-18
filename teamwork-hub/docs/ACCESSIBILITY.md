# Accessibility

Target: **WCAG 2.1 AA** for every signed-in role and the public site, at desktop (1366px) and phone (390px) widths.

## Automated audit

`e2e/a11y.spec.ts` signs in as **owner, coach, guardian, athlete and kiosk** (plus signed-out public pages) and runs
[axe-core](https://github.com/dequelabs/axe-core) with the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` tags on every
main route for that role, including one detail page per entity (person, invoice, membership, thread, athlete
performance). One test per route; each project (`desktop`, `mobile`) runs the full list.

```bash
pnpm db:fresh && pnpm build && pnpm start -p 3104
BASE_URL=http://localhost:3104 PW_CHROMIUM=/path/to/chrome pnpm test:e2e e2e/a11y.spec.ts
# Optional: A11Y_REPORT=./a11y-out writes one JSON result per page;
#           A11Y_BEST_PRACTICE=1 also enforces axe best-practice rules (landmarks, heading order, empty headers).
```

Both the WCAG run and the best-practice run currently report **0 violations** (217–219 page audits per run: 210 tests, two viewports; the number of detail pages depends on which links the seeded data exposes).

## What was fixed (Oct 2026 audit)

Baseline on a production build: 219 page audits, 209 with violations, 263 rule violations across 958 elements.

| Rule | Cause | Fix |
| --- | --- | --- |
| `color-contrast` (870 nodes) | Status text (`text-ok`, `text-warn`, `text-info`) on its own 10–15% tint — badges, the DEMO DATA pill, status chips — fell to ~4.0–4.4:1 in light mode. | Light-mode `--ok`, `--warn`, `--info` tokens moved one step darker (`#166534`, `#92400e`, `#075985`); all ≥ 4.5:1 on their tints. Dark mode unchanged (already passing). |
| `aria-hidden-focus` (63 nodes) | Recharts 3 makes the chart SVG keyboard-focusable, inside a wrapper that is `aria-hidden` (the data table is the accessible view). | `accessibilityLayer={false}` on every chart; the text summary and "Show data table" carry the data. |
| `scrollable-region-focusable` (25 nodes) | Horizontally scrolling table wrappers / season timeline could not be scrolled from the keyboard. | `<Table>` wrapper, chart data tables and the training timeline are focusable regions labelled by their caption. |
| `region` (best practice) | Mobile top bar sat outside any landmark. | Mobile bar is now a `<header>`; sidebar `<aside>` is labelled. |
| `landmark-unique` (best practice) | Two unlabelled `<aside>`s on thread/document pages. | Each page aside has an `aria-label`. |
| `empty-table-header` (best practice) | Action columns had empty `<th>`. | `<Th>` without children renders a visually hidden "Actions". |

Also: `<Field>` now links its hint or error text to the control with `aria-describedby`.

## Deferred / known limits

- **Automated coverage only.** axe finds roughly a third of WCAG issues. Not yet done: a full manual pass with
  VoiceOver/NVDA, keyboard-only walkthroughs of multi-step flows (booking, POS checkout, e-signature, weight-room
  logging), and 200% zoom / text-spacing checks.
- **Chart hover tooltips are pointer-only.** Charts are decorative (`aria-hidden`); every chart ships a text summary
  and a data table, which are the keyboard/screen-reader path. Keyboard-navigable tooltips are not planned.
- **Org brand color.** Settings → Branding accepts any hex; white text on a light brand color can fail contrast.
  The field hint warns about it, but the value is not validated yet.
- **Mobile menu** uses `aria-controls` pointing at a panel that is only rendered when open; harmless, but a
  persistent hidden panel would be cleaner.
- **Dynamic states not crawled:** open dialogs/`<details>`, form error states, and empty/edge data sets are only
  partially covered by the seeded demo data.
- No axe rules are disabled (`DISABLED_RULES` in the spec is empty); add any future exception there **and** here.
