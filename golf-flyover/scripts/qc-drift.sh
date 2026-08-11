#!/usr/bin/env bash
# Drift QC helper: builds (1) a side-by-side of source vs generated and (2) a 50%
# difference-blend that makes moved/added features pop. Clips are conformed to the
# same height/fps first; durations may differ — comparison runs on the shorter.
# Usage: ./scripts/qc-drift.sh <source> <generated> [outdir]
set -euo pipefail

SRC="${1:?usage: qc-drift.sh <source> <generated> [outdir]}"
GEN="${2:?generated clip required}"
OUTDIR="${3:-$(dirname "$GEN")}"
BASE="$(basename "${GEN%.*}")"

mkdir -p "$OUTDIR"

# Side-by-side (labels burned in so screenshots are self-explanatory)
ffmpeg -hide_banner -loglevel warning -y -i "$SRC" -i "$GEN" -filter_complex "
  [0:v]scale=-2:720:flags=lanczos,fps=30,drawtext=text='SOURCE':x=20:y=20:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=8[a];
  [1:v]scale=-2:720:flags=lanczos,fps=30,drawtext=text='GENERATED':x=20:y=20:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=8[b];
  [a][b]hstack=shortest=1[v]" \
  -map "[v]" -c:v libx264 -crf 20 -preset fast -pix_fmt yuv420p -an \
  "$OUTDIR/${BASE}_qc_sidebyside.mp4"

# Difference blend: static geography cancels out; drifted features glow
ffmpeg -hide_banner -loglevel warning -y -i "$SRC" -i "$GEN" -filter_complex "
  [0:v]scale=1280:720:flags=lanczos,fps=30[a];
  [1:v]scale=1280:720:flags=lanczos,fps=30[b];
  [a][b]blend=all_mode=difference,eq=brightness=0.3:contrast=1.5[v]" \
  -map "[v]" -c:v libx264 -crf 20 -preset fast -pix_fmt yuv420p -an \
  "$OUTDIR/${BASE}_qc_difference.mp4"

echo "QC outputs:"
echo "  $OUTDIR/${BASE}_qc_sidebyside.mp4"
echo "  $OUTDIR/${BASE}_qc_difference.mp4"
echo
echo "Checklist (WORKFLOW.md step 8): bunkers | water | green | tree lines | fairway | horizon | buildings"
