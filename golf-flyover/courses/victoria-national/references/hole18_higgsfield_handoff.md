# HANDOFF — Hole 18 Flyover: Higgsfield Enhancement Pass

You are a Claude session with the **Higgsfield AI connector**. Your job: turn Rod's
Google Earth Studio render of hole 18 at Victoria National Golf Club into ONE
photorealistic drone-style flyover clip, spending as few Higgsfield credits and as
few Claude tokens as possible. Everything is pre-decided below — do not re-research,
re-analyze, re-plan, or rewrite the prompt except where the drift ladder says so.
Keep your own outputs short.

## Hard budgets (these outrank everything else)

- **Rod has 50 Higgsfield credits TOTAL.** This pilot may spend **at most 20**.
- Before EVERY generation, read the credit cost Higgsfield displays for that exact
  model/duration/tier and tell Rod the number. If a single generation costs more
  than 15 credits, STOP and ask him first.
- Maximum 3 generations without new permission: 1 test + 1 revised test (only if
  QC fails) + 1 final. Never run variations, batches, upscales, "enhance" add-ons,
  or 4K. One generation at a time.
- Token discipline: don't open the frames one by one, don't describe images at
  length, don't restate this document back. Work, then report in a few sentences.

## Source material (on Rod's machine, from an earlier Earth Studio capture)

- `hole18_frames.zip` — ~390 numbered JPEGs, 1920×1080, 30 fps, a 13-second camera
  move (behind the tee → push down the fairway → gentle right turn with the dogleg
  → elevated finish over the green). Likely in Downloads; ask Rod if not found.
- Unzip it. You need exactly three frames: **first frame** (tee view), **last
  frame** (green/clubhouse view), and one mid frame (~frame 195) kept aside for QC
  comparison. Google attribution text in the corner is expected — leave it.

## What "incredible" means here (visual target)

Real professional drone footage of a premium Midwest golf course, PGA-Tour-preview
grade: bluegrass fairways with subtle mow lines, mixed hardwood trees, natural
lake water, mid-morning June light, restrained broadcast color. NOT a videogame,
NOT oversaturated, NOT fantasy. **Geographic accuracy is the #1 rule: the AI may
re-light and re-texture, but may not move, add, or remove anything.**

## Generation setup

**Model choice, in order of preference (use the first one Rod's plan offers at
sane credit cost):**
1. Any **video-to-video / restyle** mode that accepts the source clip or frames —
   best geometry lock. (If it needs a video file rather than frames, ask Rod —
   don't transcode yourself unless you have local tools.)
2. **Kling (2.x) with start + end frame** conditioning — the expected workhorse.
3. **Seedance (pro) with start + end frame** — fallback.
Single-image i2v is a last resort; do not use it while start+end is available.

**Settings for the TEST:** 5 seconds, lowest resolution tier, motion
strength/creativity LOW, start frame = first frame, end frame = last frame.
**Settings for the FINAL (only after QC pass):** 10s (or the model's max ≤13s),
highest tier that keeps the pilot under its 20-credit cap, same seed family if
the UI allows.

**PROMPT (use verbatim):**
> Cinematic aerial drone flyover of a real par 4 golf hole, 390 yards, the
> finishing hole. The camera starts behind and slightly above the elevated tee box
> and pushes forward smoothly down the fairway toward the landing area, descending
> gently, then follows the fairway as it bends gently to the right around the
> lake, rising as the green comes into view, finishing on an elevated view of the
> entire green complex beside the water with the clubhouse beyond. 390-yard par 4
> finishing hole bending gently right around a large lake. From a tee elevated
> about 25 feet above the fairway, the fairway curves as a crescent hugging the
> south shore of Lake Victoria - open water tight to the right side from roughly
> 120 yards all the way to the green, and a marshy hazard pinching the left edge
> of the fairway early. A cluster of three bunkers sits left of the fairway at
> 260-275 yards on the outside of the turn, with one more bunker short-left of
> the green. The green sits at the water's edge with the clubhouse complex just
> beyond it to the left. Scattered mature hardwoods line the left side; the
> horizon is gently rolling wooded terrain with no mountains. The layout, bunkers,
> water, shoreline, tree lines, clubhouse and terrain remain exactly as shown in
> the source image - nothing added, removed, or moved. Mid-morning summer light,
> sun about 35 degrees above the horizon, warm-neutral color, soft natural
> shadows. Realistic Midwest golf course: bluegrass fairways with subtle mow
> lines, mixed hardwood trees, natural lake water with soft reflections, clear sky
> with sparse small cumulus clouds. Broadcast-natural color, restrained
> saturation, photorealistic - indistinguishable from real professional drone
> footage. Smooth professional drone cinematography: slow acceleration, gentle
> coordinated turns, subtle elevation changes, natural parallax, perfectly stable
> level horizon, smooth deceleration at the end. Constant gentle forward glide -
> no sudden movements.

**NEGATIVE PROMPT (use verbatim):**
> cartoon, videogame, render, CGI look, oversaturated, fantasy landscape,
> mountains, palm trees, new buildings, extra bunkers, moving terrain, terrain
> morphing, warping ground, melting textures, FPV racing, fast banking turns,
> camera shake, whip pan, speed ramp, fisheye, lens flare, sunset, dramatic sky,
> people, crowds, text, watermark, logo

If the model's prompt limit forces trimming, cut the light/style sentences LAST
and never cut the "exactly as shown / nothing added, removed, or moved" sentence
or the bunker/water/clubhouse description.

## QC gate (run after the TEST, before ANY final)

Show Rod the test clip next to the source frames and check together, feature by
feature — any material change on any row = FAIL:

| Check | Pass condition |
|---|---|
| Bunkers | Exactly 3 left of the fairway at the turn + 1 short-left of green — none added/moved/removed |
| Lake | Shoreline path on the right matches the source; no new water, none dried up |
| Green | Same location, size, orientation, still at the water's edge |
| Clubhouse | Present, same place, same footprint — not deleted, not redesigned |
| Fairway | Same crescent routing and width, dogleg still bends right at the same spot |
| Tree lines | Same silhouettes left of the fairway; no invented specimen trees |
| Horizon | Gently rolling and wooded — NO mountains, no invented buildings |

**If FAIL** (one revision only, then stop): name the failure in the prompt (e.g.
"exactly three bunkers, no other sand anywhere"), lower motion strength further,
and re-run ONE 5s test. If that fails too, STOP — do not spend more. Tell Rod to
bring both test clips back to his Claude Code golf-flyover session for prompt
surgery there.

**If PASS:** confirm the final's credit cost with Rod, run the final once, done.

## Deliverables (report to Rod at the end, briefly)

1. `hole18_test01.mp4` (and test02 if a revision ran) and `hole18_final.mp4` —
   say exactly where they are on disk.
2. A 5-line settings record: model + version, mode, duration, tier, seed (if
   shown), credits spent per generation, total spent.
3. Tell Rod: upload `hole18_final.mp4` + the settings record to his **Claude Code
   golf-flyover session**, which handles conform (4K/mobile), motion graphics,
   and the production log.

## Never do

Redesign the course · generate on-screen text or graphics · add golfers, carts,
wildlife · run anything at 4K · use credit-consuming enhance/upscale features ·
exceed the 20-credit pilot cap · leave a generation running unattended without
recording its cost.
