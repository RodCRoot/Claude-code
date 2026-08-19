# HANDOFF — Drive Chrome to capture a Google Earth Studio flyover (Victoria National, Hole 18)

You are Claude with browser control of the user's Chrome. The user (Rod) is already
logged into Google Earth Studio. Your ONLY job in this session: build and render one
13-second Earth Studio camera move of hole 18 at Victoria National Golf Club
(Newburgh, Indiana), export the results, and tell Rod exactly which files to send back
to his Claude Code session. Everything is pre-decided — no creative choices needed.

This footage is the geometry ground-truth for an AI restyle pass. Ignore how the
imagery looks (season, flat lighting, texture pop-in are all fine). Only the camera
path and the terrain matter.

## 1. Create the project

Open https://earth.google.com/studio → New project → Blank.

- Name: `VN-hole18-flyover`
- Dimensions: 3840×2160 (drop to 1920×1080 only if the machine clearly struggles)
- Frame rate: 30 fps
- Duration: 13 seconds (390 frames)

In the Map Style panel: turn OFF all labels, borders, roads, and points of interest;
clouds off; leave 3D terrain on. The frame must be clean imagery only.

## 2. The camera move

Hole 18 runs WNW from an elevated tee, the fairway curving gently RIGHT as a crescent
along the south shore of a large lake (water on the right the whole way), to a green
on the shore with the clubhouse just beyond it. The move: start behind/above the tee →
smooth push down the fairway → gentle right turn following the fairway's curve →
rise into an elevated, nearly stationary reveal of green + lake + clubhouse.

Set 4 keyframes on Camera Position and Camera Rotation (default auto-easing is fine):

| KF | Time | Latitude | Longitude | Camera altitude | Heading | Framing check |
|---|---|---|---|---|---|---|
| 1 | 0.0s | 37.99897 | -87.34089 | ~160 m ASL (35 m above tee ground) | 277° | Tee bottom of frame, fairway centerline up the middle, lake right, horizon in top ~15% |
| 2 | 4.5s | 37.99931 | -87.34432 | ~142 m ASL (25 m above fairway) | 285° | Over the landing area; 3-bunker cluster visible left, water right |
| 3 | 8.5s | 38.00000 | -87.34480 | ~148 m ASL | 330° | Mid right-turn with the dogleg; green entering frame |
| 4 | 13.0s | 38.00045 | -87.34495 | ~163 m ASL (45 m up) | 315° | Settled + nearly stationary: green at water's edge, clubhouse beyond, whole green complex readable |

Ground reference: tee ~125 m ASL, fairway ~117 m, green ~118 m. Earth Studio altitude
fields are typically absolute (ASL) — use the ASL numbers, then trust your eyes.

**The imagery outranks the numbers.** If a keyframe sits slightly off the visible
fairway centerline, nudge position/heading/tilt until the framing-check column is
true. Coordinates are for getting close; the on-screen fairway is the truth. Tilt on
every keyframe: comfortably above the terrain looking ahead and down (~12–20° below
horizontal), horizon always level, never pointing steeply down.

Preview the full move once. It should feel like a calm professional drone: no whip,
no sudden banking, eases in and out. Fix any keyframe that pops.

## 3. Render and export

1. Full render: Render button → full work area → 3840×2160, JPEG image sequence
   (default), attribution ON (required by Google — leave it). Download the result.
2. Save the project so it can be re-rendered later: File → Save. If a local
   download/export of the project file (.esp) is offered, grab it too.
3. Three stills: move the playhead to KF1, KF2, and KF4 and render a single frame
   at each (set the work area to one frame), or download those frames from the
   image sequence after the render.

## 4. Tell Rod to send back

To his Claude Code session (upload to the chat, or a Google Drive folder named
`VN-hole18`):

- `hole18_flyover` render — the mp4 if Earth Studio produced one, otherwise the
  frame-sequence folder zipped as `hole18_frames.zip`
- `hole18.esp` project file (if a local export was possible; otherwise just confirm
  the cloud project name `VN-hole18-flyover`)
- The three stills, named `hole18_still_tee.jpg`, `hole18_still_landing.jpg`,
  `hole18_still_green.jpg`

## Guardrails

- Right course, right hole: Victoria National GC, Newburgh IN. Hole 18's tee is at
  (37.999062, -87.341785), green at (38.000638, -87.345144), clubhouse NW of the green.
  If the search lands anywhere else, navigate by these coordinates.
- Do not change project dimensions/fps/duration after keyframing.
- Do not add labels, markers, or overlays to the render.
- If Earth Studio access is missing or something blocks rendering, stop and tell Rod
  what you see — don't improvise a different capture method in this session.
