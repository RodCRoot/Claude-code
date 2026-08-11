# Source Capture Guide — What to Collect from Google Earth (per hole)

Capture quality is the ceiling for the whole pipeline: the AI can only preserve
geography it can see clearly. There are three capture paths — use the best one you
have access to. **Path A (Google Earth Studio) is strongly preferred** because a
real rendered camera move is the strongest possible geometry anchor for the AI pass.

---

## Path A — Google Earth Studio (preferred)

Earth Studio (https://earth.google.com/studio) is free but requires a one-time
access request with a Google account (approval usually takes a day or two).

### Project settings
- Resolution: **3840×2160** if your machine renders it comfortably, else 1920×1080
- Frame rate: **30 fps**
- Duration: **12–15 seconds** (360–450 frames)

### Map style panel
- Turn OFF: labels, borders, roads, points of interest — the frame must be clean imagery
- Clouds: off
- 3D buildings/terrain: leave ON (we want the real terrain relief)

### Camera move (per the pattern in STYLE-BIBLE.md §4)
- Keyframe the camera along the pattern for the hole type (par4-standard /
  par5-twostage / par3-reveal)
- Start ~25–40 m above ground, ~60–100 m behind the tee, looking down the hole
- Fly the actual fairway centerline; ease-in/ease-out on every keyframe
  (Earth Studio's default easing is fine — the AI pass will smooth further)
- Use a target/point-of-interest track on the landing zone, then the green,
  to keep the framing motivated
- Finish elevated over the green complex, nearly stationary
- **Don't worry about texture pop-in, flat lighting, or the "satellite look"** —
  that's exactly what the AI pass fixes. Only the geometry and path matter.

### Deliverables from Path A
1. The rendered flyover — either an .mp4, or the raw JPEG/PNG image sequence as a
   .zip (either works; the sequence is slightly better)
2. **The saved .esp project file** — so the move can be re-rendered with tweaks
   without re-keyframing
3. 3 render-quality single frames: (a) opening frame behind the tee,
   (b) mid-fairway/landing zone, (c) final green-complex frame
   → these become first/last-frame conditioning images
4. A straight-down orthographic still of the entire hole (used for feature
   mapping, the strategy overlay, and QC)

## Path B — Google Earth Pro desktop (no Earth Studio access)

Google Earth Pro (free desktop app) can produce nearly as good source material:

1. **View → Historical Imagery**: scrub to the greenest, sharpest capture date
   (leaf-on, mid-summer). Note the date you chose.
2. Hide ALL layers (borders, labels, roads, photos) — clean imagery only.
3. Fly the hole manually with smooth mouse/keyboard input following the camera
   pattern, and screen-record at the highest resolution you can (4K display ideal),
   30 fps or higher. Practice the move 2–3 times, record the best take.
   (Tools → Movie Maker also works if you build a saved tour.)
4. Save high-res stills via **File → Save → Save Image** (max resolution, clean
   map elements): behind-tee view, landing-zone view, approach view, green-complex
   view, and a straight-down overhead of the full hole.

## Path C — Web Google Earth screenshots (minimum viable)

If A and B are both unavailable: full-screen browser screenshots from
earth.google.com on the largest display available, clean UI (hide the sidebar,
hit the fullscreen toggle), leaf-on imagery:

1. Behind and above the tee, looking down the hole
2. Over the fairway at the landing zone, looking toward the green
3. Approach view, ~120 yards out
4. Elevated over the green complex, looking back toward the tee
5. Straight-down overhead of the entire hole
6. One wider context shot showing the hole plus its surroundings

This path relies on single-image i2v (the drift-prone path), so expect more QC
rejections and more credits per approved hole.

---

## The per-hole data sheet (required on every path)

Alongside the imagery, supply:

| Field | Example |
|---|---|
| Course name + location | "Sample Valley GC, Bloomington, IN" |
| Hole number | 7 |
| Par | 4 |
| Yardage (which tees) | 412 (blues) |
| Dogleg | slight right, pivots ~260 yds |
| Bunkers | 2 fairway right (240, 265), 1 greenside short-left |
| Water | pond right of green, front-right to back-right |
| Elevation | green ~8 ft above fairway |
| Landing zone | 230–260 off the tee, favor left-center |
| Landmarks | cart path crosses at 150; maintenance barn beyond green stays out of frame if possible |
| Strategy note (for overlay/VO) | "Favor the left side — everything kicks toward the pond." |

A photo of the scorecard covers par/yardage for all 18 at once.

## Naming convention

```
courses/<slug>/earth-video/hole07_flyover.mp4         (or hole07_frames.zip + hole07.esp)
courses/<slug>/references/hole07_still_tee.jpg
courses/<slug>/references/hole07_still_landing.jpg
courses/<slug>/references/hole07_still_green.jpg
courses/<slug>/references/hole07_ortho.jpg
courses/<slug>/references/hole07_notes.md             (the data sheet)
courses/<slug>/references/scorecard.jpg
```

## Choosing the pilot hole (for the one-hole workflow test)

Pick a **par 4 of medium complexity**: at least one fairway bunker, one greenside
hazard (water if the course has it), and a gentle dogleg. That exercises every part
of the pipeline — feature cataloging, hazard reveals, dogleg camera path, drift QC
on both sand and water — without the length of a par 5. A featureless straight hole
would pass QC trivially and prove nothing; the hardest hole first wastes credits
while the prompt recipe is still being tuned.
