# COWORK TASK — Capture the Hole 18 Earth Studio flyover (Victoria National)

You are Claude with control of Rod's Chrome. Google Earth Studio is approved and
logged in. Your ONLY job: build and render one 13-second camera move of hole 18 at
Victoria National Golf Club (Newburgh, Indiana), then get two files onto Rod's disk.
Everything is pre-decided — no creative choices. This footage is geometry
ground-truth for an AI restyle: ignore how imagery looks (season, flat light,
pop-in are fine); only the camera path and terrain matter.

## Step 1 — Project

Open https://earth.google.com/studio → New Project → Blank.
- Name: `VN-hole18-flyover`
- Dimensions: **1920×1080** · Frame rate: **30 fps** · Duration: **13 s** (390 frames)
  (settings are in the new-project dialog; later via the project settings menu)

## Step 2 — Map Style

Open the Map Style panel and choose the **Clean** preset (no labels/borders/roads).
Leave 3D imagery on if a toggle exists. Nothing else in this panel.

## Step 3 — Fly to the hole

Search `37.999062, -87.341785` — the 18th tee. Verify you're on the right hole:
a crescent fairway wrapping the south shore of a big lake, bending right to a green
at the water's edge with the clubhouse complex just beyond it (northwest). The tee
is elevated. If the view doesn't match, navigate by these coordinates:
tee (37.999062, -87.341785), green (38.000638, -87.345144).

## Step 4 — Keyframes (frame by eye; coordinates are guides, the fairway is truth)

With the playhead at 0, position the opening shot, then click the keyframe diamonds
for **Camera Position** and **Camera Rotation**. After that, moving the playhead and
then moving the camera auto-drops new keyframes.

| Time | Position (guide) | Alt (guide) | What the frame must show |
|---|---|---|---|
| 0.0s | 37.99897, -87.34089 | ~160 m ASL | Behind/above the tee: tee at bottom, fairway running away WNW up the middle, lake right, clubhouse in the distance, horizon in top ~15% |
| 4.5s | 37.99931, -87.34432 | ~142 m | Pushed forward over the landing zone, slightly lower; 3-bunker cluster visible left, water right |
| 8.5s | 38.00000, -87.34480 | ~148 m | Turning right with the fairway's bend; green entering frame |
| 13.0s | 38.00045, -87.34495 | ~163 m | Climbed, nearly stationary, short-right of green: green + lake + clubhouse composed together |

Play it back (spacebar) twice — first pass caches imagery. It must feel like a calm
professional drone: no pops, no whip. If start/stop is abrupt: drag-select all
keyframes → right-click → Auto-Ease (or ease the first and last).

## Step 5 — Save the project

File → Save Project. If it downloads a `.esp` file, that's deliverable #1.
If it saves to the account instead, note the project name for Rod.

## Step 6 — Render

Click **Render** (top right): full work area, 1920×1080, JPEG image sequence (the
default), attribution ON (required — leave it). Choose/note the destination folder
and start. Keep the tab open and in the foreground — backgrounding can stall the
render. Expect 5–15 minutes; wait for it to finish and confirm the frames exist
(~390 numbered .jpg files).

## Step 7 — Package and finish

Zip the frames folder as `hole18_frames.zip`. Then tell Rod exactly:
1. Where `hole18_frames.zip` and the `.esp` are on disk
2. To upload both files to his Claude Code session (the golf-flyover chat) —
   that session takes over from there.

## Guardrails

- Wrong course/hole = wasted render. Re-verify with the coordinates above.
- Don't change dimensions/fps/duration after keyframing.
- No labels, markers, or overlays in the render.
- If anything blocks you (access, rendering errors, missing UI), stop and tell Rod
  exactly what's on screen — do not improvise a different capture method
  (no screen recording).
