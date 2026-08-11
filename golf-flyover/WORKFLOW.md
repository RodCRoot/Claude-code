# Per-Hole Production Workflow

Every hole moves through these 10 steps. No step is skipped, and nothing advances past
Step 8 without passing the drift QC gate. `course.json` is updated at every step;
`production-log.md` records every generation attempt and its verdict.

---

## STEP 1 — Inspect the source

Open everything supplied for the hole (`references/`, `earth-video/`). Confirm:
- [ ] Source covers the full hole tee → green with no gaps
- [ ] Imagery date is leaf-on season (greens are green, trees have foliage)
- [ ] No UI chrome, labels, or clouds baked into frames
- [ ] Resolution is usable (≥1080p video, or ≥2K stills)

If any of these fail, request a re-capture before spending anything.

## STEP 2 — Identify features

From the overhead + oblique views, catalog with approximate distances from the tee:
tee box(es) · fairway shape · green (size, orientation, tilt if visible) · every
bunker (count them — this number is checked again at QC) · water and its exact
shoreline relationship to the playing line · major/individual trees that define the
hole · dogleg direction and pivot point · elevation change · primary landing area ·
visual landmarks (cart paths, buildings, adjacent holes) that must not be invented
or deleted.

Record all of it in the hole's entry in `course.json` (`bunkers`, `water`,
`landingZone`, `landmarks`, …).

## STEP 3 — Geography description

Write a 3–5 sentence plain-language description of the hole as terrain, not as
marketing. Example: "412-yard par 4, slight dogleg right pivoting at ~260 yards.
Two fairway bunkers guard the outside of the turn at 240 and 265. A pond hugs the
right side of the green from front-right to back-right; green sits 8 feet above the
fairway with a single deep bunker short-left." → `course.json.holes[n].geography`.

This description is reused verbatim inside the generation prompt as the
preservation clause, so precision here pays off downstream.

## STEP 4 — Shot plan

Pick a camera pattern from `STYLE-BIBLE.md` (`par4-standard`, `par5-twostage`,
`par3-reveal`) and adapt it: start position, altitude profile, path over the actual
fairway centerline, hazard-reveal moments, green-reveal finish, duration (8–15s,
target 12s). Write it into `storyboard.md` and `course.json.holes[n].camera`.

## STEP 5 — Write the exact prompt

Use the templates in `prompts/PROMPT-PLAYBOOK.md`. The prompt always has five parts:
shot description, camera path, **preservation clause** (from Step 3), light/style
clause (fixed course-wide), motion-quality clause, plus the standard negative
prompt. Store the final text in `course.json.holes[n].prompt.text` **before**
generating, so every generation is reproducible.

## STEP 6 — Select the model

Follow `prompts/MODEL-SELECTION.md`. Default preference order for geometry:
1. Video-to-video restyle over the Earth Studio render (least drift)
2. First-frame + last-frame conditioned image-to-video
3. Single-image i2v with strong camera prompting (most drift — last resort)

Record model + version + settings in `course.json.holes[n].prompt`.

## STEP 7 — Cheap test first (credit discipline)

- ONE generation, shortest duration the model offers (usually 5s), lowest
  resolution tier, covering the highest-risk segment of the move.
- Never run a 4K or full-length generation before a test has passed QC.
- Log the attempt (model, settings, credits) in `production-log.md` immediately.

## STEP 8 — Drift QC gate

Run `scripts/qc-drift.sh <source> <generated>` to get a side-by-side and a
difference-blend video. Compare against the source, feature by feature:

| Check | Pass condition |
|---|---|
| Bunkers | Same count, same positions, same shapes — none added/removed/moved |
| Water | Shoreline path matches; no new water; no dried-up water |
| Green | Same location, size, orientation relative to fairway |
| Tree lines | Silhouette and density match; no invented specimen trees |
| Fairway | Same routing, same width, same dogleg pivot |
| Horizon | Flat stays flat — no invented hills/mountains; skyline stable |
| Buildings | Nothing invented, nothing deleted, nothing relocated |

**Any material geography change = REJECT.** Log the failure mode, apply the
revision ladder in `PROMPT-PLAYBOOK.md` (strengthen preservation clause → reduce
motion strength → shorten segment → add end-frame conditioning → fall back to
v2v restyle), and re-test. Two consecutive failures on the same model → switch
models before spending again.

## STEP 9 — Final generation

Only after a passing test: generate the final clip at full duration and the
highest quality tier. Re-run the Step 8 checklist on the final (finals can drift
where tests didn't). On pass: move the file to `approved/`, set
`course.json.holes[n].approved = true`, fill in `assets.approvedAsset`.

## STEP 10 — Motion graphics (separate layer, always)

Graphics are NEVER generated into the AI video. Render them in Remotion
(`graphics/remotion/`) over the approved clip:
- **Clean version**: approved clip conformed via `scripts/finish-hole.sh` — no overlays.
- **Strategy version**: `HoleStrategy169` / `HoleStrategy916` compositions pull
  HOLE #, PAR, YARDAGE, markers, and tracer data from `course.json` so they stay
  accurate and editable.

---

## Course-level assembly (after all holes approved)

1. `scripts/finish-hole.sh` every approved clip → per-hole 16:9 4K master + 9:16 mobile.
2. `scripts/assemble-tour.sh courses/<slug>` → full-course sequential tour (both formats).
3. Music/ambience bed added in the assembly step (one bed for the whole tour —
   consistency rule).

## Definition of done (per hole)

- [ ] `course.json` entry complete, `approved: true`
- [ ] Clean 16:9 master in `renders/`
- [ ] Strategy 16:9 render in `renders/`
- [ ] 9:16 mobile exports of both
- [ ] production-log entry closed with credits total for the hole
