# Golf Course Flyover Production System

A repeatable pipeline for producing cinematic, geographically accurate, hole-by-hole golf
course flyovers from real Google Earth / Google Earth Studio imagery, enhanced with AI
image-to-video models and finished with a separate motion-graphics layer.

**Prime directive: geographic accuracy.** The AI enhances presentation and motion.
It never redesigns the property. See `STYLE-BIBLE.md` for the full list of hard rules.

---

## Directory map

```
golf-flyover/
├── README.md                  ← you are here
├── WORKFLOW.md                ← the 10-step per-hole production pipeline + QC gates
├── STYLE-BIBLE.md             ← visual target, camera grammar, consistency lock
├── SOURCE-CAPTURE-GUIDE.md    ← exactly what to capture from Google Earth
├── production.config.json     ← global output specs (fps, resolutions, durations)
├── prompts/
│   ├── PROMPT-PLAYBOOK.md     ← prompt architecture + templates (par 3/4/5)
│   └── MODEL-SELECTION.md     ← which model to use and why, test protocol
├── schema/
│   ├── course.schema.json     ← JSON Schema for course.json validation
│   └── course.example.json    ← filled-in example (one hole)
├── scripts/                   ← ffmpeg + scaffolding utilities (bash)
│   ├── new-course.sh          ← scaffold a course folder + 18-hole course.json
│   ├── proxy.sh               ← cheap 720p/30fps proxy for testing
│   ├── keyframes.sh           ← extract keyframes + contact sheet from source video
│   ├── qc-drift.sh            ← side-by-side + difference video for drift QC
│   ├── finish-hole.sh         ← conform approved clip to 4K master + 9:16 mobile
│   └── assemble-tour.sh       ← concat approved holes into the full course tour
├── graphics/remotion/         ← motion graphics layer (Remotion project)
│   └── src/                   ← HoleInfoCard, StrategyOverlay, compositions
└── courses/
    └── <course-slug>/         ← one folder per course (created by new-course.sh)
        ├── references/        ← stills, overheads, scorecard, notes (small jpgs OK in git)
        ├── earth-video/       ← raw Google Earth Studio renders (gitignored)
        ├── keyframes/         ← extracted conditioning frames (gitignored)
        ├── generated/         ← AI test + candidate clips (gitignored)
        ├── approved/          ← QC-passed clips only (gitignored)
        ├── graphics/          ← rendered overlay passes for this course
        ├── audio/             ← music, ambience, VO (gitignored)
        ├── renders/           ← final conformed masters + mobile (gitignored)
        ├── course.json        ← single source of truth for the whole course
        ├── storyboard.md      ← per-hole shot plans + status board
        └── production-log.md  ← every generation attempt, credits spent, QC verdicts
```

## Quickstart

```bash
# 1. Scaffold a course
./scripts/new-course.sh sample-valley "Sample Valley Golf Club" "Bloomington, IN"

# 2. Drop source material into courses/sample-valley/ per SOURCE-CAPTURE-GUIDE.md

# 3. Follow WORKFLOW.md hole by hole. course.json is the source of truth;
#    storyboard.md is the human-readable status board.

# 4. Motion graphics
cd graphics/remotion && npm install
npx remotion render HoleStrategy169 out/hole01_strategy.mp4 --props='{"holeNumber":1}'
```

## Generation tooling status

The pipeline is model-agnostic. Generation happens through whichever of these is
available in the session, in order of preference (see `prompts/MODEL-SELECTION.md`):

1. **Higgsfield MCP** — not yet connected to this Claude workspace. Connect it at
   claude.ai → Settings → Connectors (add Higgsfield if listed, or as a custom
   connector using the MCP endpoint from your Higgsfield account). Once connected,
   Claude can drive generation directly from this workflow.
2. **Higgsfield web app** — manual fallback: Claude writes the exact prompt +
   settings into `course.json` / `production-log.md`, you run it in the browser and
   drop the result into `generated/`.
3. Any other connected video model (Kling, Seedance, Veo via their own MCPs/APIs).

ffmpeg and Remotion run locally in the session — no credits involved.

## Session environment setup

Remote session containers are ephemeral and don't ship with ffmpeg. At the start of
any media-processing session run:

```bash
apt-get update && apt-get install -y ffmpeg   # verified working in this environment
cd graphics/remotion && npm install            # only needed for graphics renders
```

All scripts in `scripts/` are smoke-tested against ffmpeg 6.1 with synthetic clips.

## Media & git policy

Video, audio, and renders are **gitignored** (see `.gitignore`) — they're too large
for the repo. Compressed reference JPEGs and all JSON/markdown/graphics source are
committed. Since remote sessions are ephemeral, park heavy media in Google Drive
(connector available) or re-upload per session; everything needed to *reproduce* a
hole (prompts, settings, camera plans, QC notes) lives in git.

## Licensing note

Google Earth / Earth Studio imagery carries Google's geo-content terms, which
restrict some commercial/promotional uses and require attribution. Fine for internal
testing; before publishing a commercial course promo, review Google's geo permissions
guidelines (or plan to reshoot finals from licensed aerial/drone sources using this
same pipeline — the workflow is identical).
