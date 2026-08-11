#!/usr/bin/env bash
# Scaffold a new course folder with the standard structure, an 18-hole course.json
# skeleton, storyboard.md, and production-log.md.
# Usage: ./scripts/new-course.sh <course-slug> "<Course Name>" "<Location>" [holes]
set -euo pipefail

SLUG="${1:?usage: new-course.sh <course-slug> \"<Course Name>\" \"<Location>\" [holes]}"
NAME="${2:?course name required}"
LOCATION="${3:?location required}"
HOLES="${4:-18}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/courses/$SLUG"

if [ -e "$DIR" ]; then
  echo "ERROR: $DIR already exists" >&2
  exit 1
fi

for d in references earth-video keyframes generated approved graphics audio renders; do
  mkdir -p "$DIR/$d"
  touch "$DIR/$d/.gitkeep"
done

NAME="$NAME" LOCATION="$LOCATION" HOLES="$HOLES" python3 - "$DIR/course.json" <<'PYEOF'
import json, os, sys

holes = []
for n in range(1, int(os.environ["HOLES"]) + 1):
    holes.append({
        "holeNumber": n,
        "par": None,
        "yardage": None,
        "teeUsed": "",
        "teeLocation": {"lat": None, "lng": None, "elevationFt": None, "description": ""},
        "greenLocation": {"lat": None, "lng": None, "elevationFt": None, "description": ""},
        "dogleg": "none",
        "doglegAtYards": None,
        "water": [],
        "bunkers": [],
        "trees": "",
        "elevation": "",
        "landingZone": {"distanceFromTee": None, "description": ""},
        "landmarks": [],
        "geography": "",
        "strategy": "",
        "voiceover": "",
        "camera": {"pattern": "", "durationSec": 12, "notes": ""},
        "prompt": {"model": "", "mode": "", "text": "", "negative": "", "seed": None, "settings": {}},
        "assets": {
            "sourceAsset": "", "referenceOverhead": "", "keyframes": [],
            "testClips": [], "generatedAsset": "", "approvedAsset": "",
            "cleanRender": "", "strategyRender": ""
        },
        "overlay": {"landingZone": None, "greenMarker": None, "hazards": [], "tracer": [], "strategyText": ""},
        "qc": {"drift": None, "failures": [], "notes": ""},
        "approved": False,
    })

course = {
    "courseName": os.environ["NAME"],
    "location": os.environ["LOCATION"],
    "production": {
        "fps": 30,
        "timeOfDay": "mid-morning, sun ~35 degrees, warm-neutral June light",
        "colorTreatment": "broadcast-natural-v1",
        "defaultModel": "",
        "fallbackModel": ""
    },
    "holes": holes,
}

with open(sys.argv[1], "w") as f:
    json.dump(course, f, indent=2)
    f.write("\n")
PYEOF

cat > "$DIR/storyboard.md" <<EOF
# Storyboard — $NAME

Status board + per-hole shot plans. Status: ⬜ awaiting source · 🎥 source ready ·
✍️ planned · 🧪 testing · ✅ approved · 🎬 rendered

| Hole | Par | Yds | Pattern | Dur | Status | Notes |
|---|---|---|---|---|---|---|
$(for i in $(seq 1 "$HOLES"); do echo "| $i |  |  |  |  | ⬜ |  |"; done)

---

## Shot plans

(One section per hole as it reaches ✍️ — camera start, path beats, hazard reveals,
finish framing. Duplicated into course.json holes[n].camera.)
EOF

cat > "$DIR/production-log.md" <<EOF
# Production Log — $NAME

Every generation attempt gets an entry — model, mode, settings, credits, QC verdict.
Nothing gets generated without being logged.

## Credit ledger

| Date | Hole | Model | Type | Credits | Result |
|---|---|---|---|---|---|

## Log

<!--
### YYYY-MM-DD — Hole N — attempt X
- Model / mode / settings:
- Prompt version: (link to course.json state / commit)
- Credits spent:
- QC verdict: pass | fail (which features drifted)
- Decision: approve | revise (which revision-ladder rung) | switch model
-->
EOF

echo "Scaffolded $DIR"
find "$DIR" -type f | sort
