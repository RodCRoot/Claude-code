#!/usr/bin/env bash
# Extract conditioning keyframes (first / 25% / 50% / 75% / last) from a source
# flyover video, plus a 1fps contact sheet for feature cataloging.
# Usage: ./scripts/keyframes.sh <input> <outdir> [prefix]
set -euo pipefail

IN="${1:?usage: keyframes.sh <input> <outdir> [prefix]}"
OUTDIR="${2:?output dir required}"
PREFIX="${3:-$(basename "${IN%.*}")}"

mkdir -p "$OUTDIR"

DUR=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$IN")

for spec in "start:0" "q1:0.25" "mid:0.5" "q3:0.75"; do
  name="${spec%%:*}"; frac="${spec##*:}"
  t=$(python3 -c "print(max(0.0, $DUR * $frac))")
  ffmpeg -hide_banner -loglevel error -y -ss "$t" -i "$IN" -frames:v 1 \
    "$OUTDIR/${PREFIX}_${name}.png"
done

# Last frame: seek near the end and keep the final decoded frame
ffmpeg -hide_banner -loglevel error -y -sseof -0.5 -i "$IN" \
  -vsync 0 -update 1 -frames:v 15 "$OUTDIR/${PREFIX}_end.png"

# Contact sheet: 1 fps tiled
ffmpeg -hide_banner -loglevel error -y -i "$IN" \
  -vf "fps=1,scale=320:-2,tile=5x4:margin=4:padding=4" \
  -frames:v 1 "$OUTDIR/${PREFIX}_contactsheet.png"

echo "Keyframes written to $OUTDIR:"
ls -1 "$OUTDIR" | grep "^${PREFIX}_" || true
