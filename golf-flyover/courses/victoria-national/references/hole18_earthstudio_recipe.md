# Hole 18 — Google Earth Studio Capture Recipe

The exact camera move for the test hole. Total time in Earth Studio: ~15 minutes.
Coordinates are WGS84; altitudes are meters ABOVE GROUND (ground at the tee is
~125 m / 410 ft ASL; the fairway sits ~8 m below the tee).

## Project setup

| Setting | Value |
|---|---|
| Project type | Blank |
| Dimensions | 3840×2160 (or 1920×1080 if renders are slow) |
| Frame rate | 30 fps |
| Duration | 13 seconds (390 frames) |
| Map style | Turn OFF all labels, borders, roads, POIs; clouds off; 3D terrain ON |

Search "Victoria National Golf Club, Newburgh IN" to fly there, then set up the
four camera keyframes below (keyframe Camera Position lat/lng/altitude and
Camera Rotation, default auto-ease between keyframes).

## Camera keyframes

| KF | Time | Lat | Lng | Alt (AGL) | Aim |
|---|---|---|---|---|---|
| 1 | 0.0s | 37.99897 | -87.34089 | 35 m | Down the fairway, heading ~277° (WNW), pitch ~ -12° |
| 2 | 4.5s | 37.99931 | -87.34432 | 25 m | Ahead along fairway, water right, bunker cluster left in frame |
| 3 | 8.5s | 38.00000 | -87.34480 | 30 m | Turning right with the dogleg, heading ~330°, green entering frame |
| 4 | 13.0s | 38.00045 | -87.34495 | 45 m | Settled nearly stationary, looking ~315° at green + lake + clubhouse |

Flight logic: open behind and above the elevated tee → smooth push down the
fairway (lake on the right the whole way) → gentle right turn following the
crescent → rise into the final elevated reveal of the green complex with the
clubhouse behind. If a keyframe position looks slightly off the visible fairway
centerline, trust the imagery on screen and nudge — the fairway is the truth.

Tee is at (37.999062, -87.341785); green center at (38.000638, -87.345144).

## Renders to deliver

1. **The move**: full 390-frame render → `earth-video/hole18_flyover.mp4`
   (or the JPEG sequence zipped as `hole18_frames.zip`)
2. **Save the project file** → `earth-video/hole18.esp`
3. **Three stills** (render single frames at KF1, KF2, KF4):
   `references/hole18_still_tee.jpg`, `hole18_still_landing.jpg`, `hole18_still_green.jpg`
4. A straight-down overhead is already captured (`references/hole18_ortho.jpg`)
   — no need to make one.

Don't worry about season, flat lighting, or texture pop-in in the render — the
AI pass restyles all of that (our style clause forces mid-morning June light).
Only geometry and the camera path matter.

## Delivery

Upload to this chat, or drop in a Google Drive folder and share the folder name.
