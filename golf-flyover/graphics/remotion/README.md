# Motion Graphics Layer (Remotion)

Graphics are rendered OVER approved AI clips — never generated into them — so
HOLE #, PAR, YARDAGE, markers, and tracers stay accurate and editable
(STYLE-BIBLE.md §5). Marker positions come from `course.json holes[n].overlay`
as normalized 0–1 coordinates on the approved clip's framing.

## Setup

```bash
cd graphics/remotion
npm install
```

## Workflow per hole

1. Copy the approved clip into `public/` (e.g. `public/hole07_approved.mp4`).
2. Set the hole's `overlay` block in `course.json` (open `npx remotion studio`
   and scrub to place markers; coordinates are fractions of frame width/height).
3. Render, passing the hole's data as props (match the clip's duration):

```bash
npx remotion render HoleStrategy169 ../../courses/<slug>/renders/hole07_strategy_4k.mp4 \
  --duration=360 \
  --props='{"courseName":"...","holeNumber":7,"par":4,"yardage":412,
            "videoSrc":"hole07_approved.mp4","showOverlay":true,
            "strategyText":"Favor the left side.",
            "overlay":{...from course.json...}}'
```

Compositions: `HoleClean169` (no overlay, 4K 16:9), `HoleStrategy169` (4K 16:9),
`HoleStrategy916` (1080×1920 vertical, compact card).

The clean version can also be produced without Remotion via
`scripts/finish-hole.sh` — identical output, cheaper. Use Remotion for clean only
when you want the animated lower-third on it.
