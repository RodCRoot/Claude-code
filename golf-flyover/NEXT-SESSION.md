# NEXT SESSION — Current State & Next Actions

Read this first, then `README.md` and `WORKFLOW.md` in this directory. This file is
the live pointer to where the project stands; update it at the end of every
working session.

## State as of 2026-09-15

| Piece | Status |
|---|---|
| Production system (docs, schema, scripts, Remotion graphics) | ✅ Built and smoke-tested — see `README.md` for the map |
| Course: Victoria National (Newburgh, IN), White tees | ✅ `courses/victoria-national/course.json` filled for all 18 holes (pars, yardages, handicaps, tee/green coords, elevations) |
| Pilot hole 18 plan (Steps 1–5: features, geography clause, shot plan, prompt) | ✅ In `course.json` holes[18] |
| Earth Studio capture of hole 18 | ✅ Done by a Cowork session — **files are on Rod's machine**: `hole18_frames.zip` (~390 JPEGs, 1920×1080/30fps/13s) + `.esp` project. NOT yet in this repo or any session. |
| Higgsfield enhancement pass | 🔄 Being run in a separate session with the Higgsfield connector, per `courses/victoria-national/references/hole18_higgsfield_handoff.md`. Budget: 50 credits total, pilot cap 20. |
| Yardage book side-product | ✅ `courses/victoria-national/graphics/yardage-book*.pdf` (+ generator `scripts/yardage_book.py`) |

## What this session does next (in order, as files arrive from Rod)

1. **Ingest** `hole18_frames.zip` → `courses/victoria-national/earth-video/`;
   assemble mp4 (`ffmpeg -framerate 30 -pattern_type glob -i '*.jpg' -c:v libx264
   -crf 17 -pix_fmt yuv420p hole18_flyover.mp4`); extract keyframes
   (`scripts/keyframes.sh`).
2. **Ingest** `hole18_final.mp4` (+ test clips + settings record) from the
   Higgsfield session → `generated/`; record model/settings/seed/credits in
   `course.json` holes[18].prompt and `production-log.md`.
3. **QC**: `scripts/qc-drift.sh <earth-video mp4> <generated clip>` → check the
   Step-8 table in `WORKFLOW.md` (bunker count is 3 fairway-left + 1 greenside;
   lake shoreline; clubhouse present). Verdict goes in course.json holes[18].qc.
4. On pass: move clip to `approved/`, set `approved: true`, then
   `scripts/finish-hole.sh` (4K master + 9:16 mobile) and the Remotion strategy
   overlay (`graphics/remotion/README.md`; overlay coords already in course.json).
5. Update `storyboard.md` status board and this file.

## Session environment setup (ephemeral containers)

```bash
apt-get update && apt-get install -y ffmpeg poppler-utils
cd golf-flyover/graphics/remotion && npm install   # only for graphics renders
```

## Standing rules (non-negotiable)

- Geographic accuracy is priority #1 — `STYLE-BIBLE.md` §2. Any material geography
  change in a generation = reject.
- Generation credits are spent OUTSIDE this session (Higgsfield connector session
  or web app). This session never triggers paid generation without Rod's explicit
  go-ahead; Rod has ~50 Higgsfield credits total for the whole course.
- Every generation attempt gets logged in `production-log.md` (model, settings,
  credits, verdict). course.json is the single source of truth.
- Commit and push to the working branch as you go; media stays gitignored except
  small reference JPEGs.
