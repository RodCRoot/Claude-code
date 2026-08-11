# Style Bible — Visual Target, Camera Grammar, Consistency Lock

This file is the creative contract for the entire production. Every prompt, every
grade, every graphic conforms to it. If a choice isn't covered here, decide it once,
write it here, and it becomes law for all 18 holes.

---

## 1. Visual target

**It should feel like:** a PGA Tour course preview · a Golf Channel hole flyover ·
a premium destination-golf commercial · real professional drone cinematography.

**It must never feel like:** a videogame · a fantasy course · a hyper-saturated AI
landscape · obviously AI-generated imagery.

Concretely:
- Natural Midwest vegetation — bluegrass/bent fairways, mixed hardwoods (oak, maple,
  sycamore), no palm trees, no alpine conifers, no exotic flora.
- Grass reads as maintained turf with visible mow lines where the source shows them —
  not carpet, not neon.
- Water is pond/lake water: slightly green-brown, soft reflections — not Caribbean teal.
- Sunlight is believable for the chosen hour; soft shadows with real direction.
- Skies: natural blue with sparse fair-weather clouds. No dramatic sunset walls,
  no god rays, no lens-flare theatrics.

## 2. Geographic accuracy — the hard rules

The source Google Earth imagery **is** the course. AI enhances presentation and
motion only. Never:

- move / add / remove bunkers
- move water or change shorelines
- change fairway routing or width
- change green, tee, or landing-area locations
- invent buildings or delete existing ones
- substantially change tree lines or add specimen trees
- create hills, mountains, or terrain that isn't present
- alter the tee → fairway → green relationship in any way

Violations are caught at the Step 8 QC gate (see `WORKFLOW.md`) and are automatic
rejections regardless of how good the clip looks.

## 3. Consistency lock (course-wide constants)

| Element | Locked value |
|---|---|
| Time of day | Mid-morning, sun ~35° elevation, warm-neutral light ("9:30 AM in June") |
| Weather | Clear, light fair-weather cumulus, no wind gusts visible |
| Color treatment | Broadcast-natural: neutral whites, restrained saturation, gentle filmic curve; single shared LUT applied at conform, never per-hole grading drift |
| Grass | Uniform green tone across holes; mow patterns only where source shows them |
| Typography | One family course-wide (default: Archivo/Inter stack in `graphics/remotion/src/theme.ts`) |
| Graphics package | HoleInfoCard lower-third + StrategyOverlay markers — identical layout all 18 holes |
| Camera philosophy | High-end DJI drone realism (Section 4) — every hole |
| Transitions | Simple 12-frame crossfade between holes in the tour; nothing flashier |
| Duration | 8–15s per hole, target 12s |
| Frame rate | 30 fps everywhere |

## 4. Camera grammar

Movement always resembles a professional DJI drone flown by a careful pilot:
slow acceleration · smooth deceleration · gentle coordinated turns · subtle
elevation changes · natural parallax · stable horizon at all times.

Forbidden: FPV racing moves · sudden banking · impossible turns · excessive speed ·
terrain morphing · flying through trees or objects · whip pans · speed ramps.

### Pattern `par4-standard` (also default for short par 5s)

1. Open behind and slightly above the tee box (~25–40 m up, ~60–100 m behind).
2. Push forward smoothly toward the primary landing area, following the actual
   fairway centerline.
3. Gradually descend or hold altitude along the fairway.
4. Approaching the landing area, ease into a subtle climb.
5. Continue along the real routing (turn gently with the dogleg — never cut the corner).
6. Let hazards reveal themselves naturally as the camera passes.
7. Transition toward the approach-shot view.
8. Rise slightly as the green comes into view.
9. Finish on a cinematic elevated reveal of the full green complex, easing to
   near-stationary.

### Pattern `par5-twostage`

As `par4-standard`, but with two landing-area beats: subtle climb over the drive
zone, settle back down through the second-shot zone, then the standard green-reveal
climb. Prefer the 14–15s end of the duration range.

### Pattern `par3-reveal`

1. Open behind the tee, low and steady.
2. Slow push toward the green — one continuous move.
3. Frame so the complete tee → hazard → green relationship stays readable.
4. If water is present, keep the carry line visually understandable (don't fly
   around it — fly over the line the ball must take).
5. Rise gently on approach; finish elevated over the entire green complex.

## 5. Graphics style (strategy version)

- Lower-third: HOLE # (large), PAR and YARDAGE (chips), course name (small).
- Landing zone: soft pulsing ring, white/gold.
- Hazards: minimal diamond markers — red for water, sand-tone for bunkers.
- Green: subtle flag marker.
- Optional tracer: thin animated line tee → landing → green, broadcast style.
- Optional strategy text: one short line, bottom-right, ≤8 words.
- Everything animates in with soft springs, out before the final second.
- All colors/typography from `graphics/remotion/src/theme.ts` — never ad-hoc.
