# Prompt Playbook — Image-to-Video Prompt Architecture

Every generation prompt is assembled from five fixed parts plus a standard negative
prompt. The final assembled text is stored in `course.json.holes[n].prompt.text`
**before** the generation runs, so every attempt is reproducible and diffable.

```
[1 SHOT]  [2 CAMERA PATH]  [3 PRESERVATION CLAUSE]  [4 LIGHT/STYLE]  [5 MOTION QUALITY]
```

- **[1] Shot** — one sentence: what this clip is.
- **[2] Camera path** — the pattern from STYLE-BIBLE.md §4 translated into concrete
  language for THIS hole (direction of the dogleg, where the climb happens).
- **[3] Preservation clause** — the Step-3 geography description, phrased as
  constraints. This is the geographic-accuracy payload. It names the exact bunker
  count, water position, and tree lines so the model has no room to invent.
- **[4] Light/style** — fixed course-wide, verbatim from the consistency lock.
- **[5] Motion quality** — fixed drone-realism language.

Parts 4 and 5 never change between holes. Part 3 changes the most.

---

## Fixed clauses (use verbatim)

**[4] LIGHT/STYLE (course-wide):**
> Mid-morning summer light, sun about 35 degrees above the horizon, warm-neutral
> color, soft natural shadows. Realistic Midwest golf course: bluegrass fairways
> with subtle mow lines, mixed hardwood trees, natural pond water with soft
> reflections, clear sky with sparse small cumulus clouds. Broadcast-natural color,
> restrained saturation, photorealistic — indistinguishable from real professional
> drone footage.

**[5] MOTION QUALITY (course-wide):**
> Smooth professional drone cinematography: slow acceleration, gentle coordinated
> turns, subtle elevation changes, natural parallax, perfectly stable level horizon,
> smooth deceleration at the end. Constant gentle forward glide — no sudden
> movements.

**NEGATIVE PROMPT (course-wide):**
> cartoon, videogame, render, CGI look, oversaturated, fantasy landscape, mountains,
> palm trees, new buildings, extra bunkers, moving terrain, terrain morphing,
> warping ground, melting textures, FPV racing, fast banking turns, camera shake,
> whip pan, speed ramp, fisheye, lens flare, sunset, dramatic sky, people, crowds,
> text, watermark, logo

---

## Template — Par 4 / short Par 5 (`par4-standard`)

> Cinematic aerial drone flyover of a real par {PAR} golf hole, {YARDAGE} yards.
> The camera starts behind and slightly above the tee box and pushes forward
> smoothly down the fairway toward the landing area, {DESCEND_OR_HOLD}, then
> follows the fairway as it {DOGLEG_TEXT}, rising gently as the green comes into
> view, finishing on an elevated view of the entire green complex.
> {PRESERVATION_CLAUSE}
> The layout, bunkers, water, tree lines and terrain remain exactly as shown in the
> source image — nothing added, removed, or moved.
> {LIGHT_STYLE} {MOTION_QUALITY}

`{DOGLEG_TEXT}` examples: "bends gently to the right at the landing area" /
"runs dead straight to the green".

`{PRESERVATION_CLAUSE}` example (from Step 3):
> The hole has exactly two fairway bunkers on the right side of the landing area
> and one deep bunker short-left of the green. A single pond borders the right side
> of the green from front-right to back-right; its shoreline stays fixed. Mature
> hardwood tree lines border both sides of the fairway. The green sits slightly
> above the fairway. The horizon is flat farmland.

## Template — Par 5 (`par5-twostage`)

Same as par 4, but the camera sentence becomes:

> ...pushes forward smoothly over the drive landing zone, climbing subtly, then
> settles lower through the second-shot area following the fairway as it
> {DOGLEG_TEXT}, then rises as the green comes into view...

## Template — Par 3 (`par3-reveal`)

> Cinematic aerial drone shot of a real par 3 golf hole, {YARDAGE} yards. The
> camera starts behind the tee box and pushes slowly and steadily straight toward
> the green in one continuous move, keeping the tee, {HAZARD_SUMMARY} and green in
> view so the full shot the golfer faces stays readable, rising gently on approach
> and finishing elevated above the entire green complex.
> {PRESERVATION_CLAUSE}
> The layout, bunkers, water, tree lines and terrain remain exactly as shown in the
> source image — nothing added, removed, or moved.
> {LIGHT_STYLE} {MOTION_QUALITY}

For a water carry, add to the camera sentence: "flying directly along the carry
line over the water so the forced carry is clearly visible."

---

## Drift-revision ladder (Step 8 failures)

Apply in order; re-test (one cheap test) after each rung. Two consecutive failures
on the same model → switch models (see MODEL-SELECTION.md).

1. **Name the failure in the prompt.** If it invented a bunker: "exactly two
   bunkers, no other sand anywhere on the hole." If it grew mountains: "completely
   flat horizon, flat Midwest farmland in the distance."
2. **Reduce motion strength / creativity settings** (model-dependent: lower
   motion scale, lower CFG/creativity, keep-style-of-input toggles).
3. **Shorten the segment.** Two 6s generations drift less than one 12s. Split the
   move at a natural beat (landing-area climb) and plan an edit point.
4. **Add end-frame conditioning.** Supply both the start frame and the green-reveal
   frame so the model must land on real geography.
5. **Fall back to video-to-video restyle** over the Earth Studio render — geometry
   is then pinned by real footage and the model only re-lights/re-textures.

## Prompt hygiene

- Never mention hole numbers, pars, yardages as ON-SCREEN text — no text in
  generations, ever. Graphics are a separate Remotion layer.
- Never prompt for golfers, carts, or wildlife — moving subjects invite drift and
  break the empty-course broadcast look.
- Keep the total prompt under ~150 words where the model allows; preservation
  clause gets priority if trimming is needed.
