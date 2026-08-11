#!/usr/bin/env bash
# Make a cheap 720p/30fps proxy of a source clip for inspection and testing.
# Usage: ./scripts/proxy.sh <input> [output]
set -euo pipefail

IN="${1:?usage: proxy.sh <input> [output]}"
OUT="${2:-${IN%.*}_proxy.mp4}"

ffmpeg -hide_banner -y -i "$IN" \
  -vf "scale=-2:720:flags=lanczos,fps=30" \
  -c:v libx264 -crf 20 -preset fast -pix_fmt yuv420p -an \
  "$OUT"

echo "Proxy: $OUT"
