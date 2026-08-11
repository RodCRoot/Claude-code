#!/usr/bin/env bash
# Assemble the full-course tour from per-hole conformed renders, in hole order,
# with the course-standard 12-frame crossfade between holes.
# Expects files named hole01*_master_*.mp4 (or *_mobile_* with --mobile) in <course>/renders.
# Usage: ./scripts/assemble-tour.sh <course-dir> [--mobile] [output]
set -euo pipefail

COURSE="${1:?usage: assemble-tour.sh <course-dir> [--mobile] [output]}"
shift || true

PATTERN="_master_"
SUFFIX="tour_16x9"
if [ "${1:-}" = "--mobile" ]; then
  PATTERN="_mobile_"
  SUFFIX="tour_9x16"
  shift || true
fi
OUT="${1:-$COURSE/renders/${SUFFIX}.mp4}"

XFADE_SEC=0.4   # 12 frames @ 30fps

mapfile -t CLIPS < <(find "$COURSE/renders" -maxdepth 1 -name "hole*${PATTERN}*.mp4" | sort)
N=${#CLIPS[@]}
if [ "$N" -eq 0 ]; then
  echo "ERROR: no hole*${PATTERN}*.mp4 files in $COURSE/renders" >&2
  exit 1
fi
echo "Assembling $N holes -> $OUT"

if [ "$N" -eq 1 ]; then
  cp "${CLIPS[0]}" "$OUT"
  echo "Single clip copied."
  exit 0
fi

# Build an xfade filter chain: each transition needs the running offset
# (sum of durations so far minus accumulated fade overlap).
INPUTS=()
for c in "${CLIPS[@]}"; do INPUTS+=(-i "$c"); done

FILTER=$(python3 - "$XFADE_SEC" "${CLIPS[@]}" <<'PYEOF'
import subprocess, sys

fade = float(sys.argv[1])
clips = sys.argv[2:]

def dur(p):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", p])
    return float(out.strip())

durs = [dur(c) for c in clips]
parts, prev, offset = [], "[0:v]", 0.0
for i in range(1, len(clips)):
    offset += durs[i - 1] - fade
    out = f"[vx{i}]" if i < len(clips) - 1 else "[v]"
    parts.append(f"{prev}[{i}:v]xfade=transition=fade:duration={fade}:offset={offset:.3f}{out}")
    prev = f"[vx{i}]"
print(";".join(parts))
PYEOF
)

ffmpeg -hide_banner -loglevel warning -y "${INPUTS[@]}" \
  -filter_complex "$FILTER" -map "[v]" \
  -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p -an \
  "$OUT"

echo "Tour assembled: $OUT"
echo "(Audio bed: mux music/ambience afterward, e.g."
echo "  ffmpeg -i $OUT -i bed.wav -c:v copy -c:a aac -shortest ${OUT%.*}_audio.mp4)"
