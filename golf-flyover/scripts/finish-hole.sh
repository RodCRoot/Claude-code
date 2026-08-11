#!/usr/bin/env bash
# Conform an approved clip to delivery specs:
#   - 16:9 master (4K by default; pass 1080 as third arg if source can't support 4K)
#   - 9:16 mobile 1080x1920 (center crop; optional horizontal pan offset -1..1)
# Usage: ./scripts/finish-hole.sh <approved-clip> <outdir> [2160|1080] [pan-offset]
set -euo pipefail

IN="${1:?usage: finish-hole.sh <approved-clip> <outdir> [2160|1080] [pan-offset]}"
OUTDIR="${2:?output dir required}"
HEIGHT="${3:-2160}"
PAN="${4:-0}"   # -1 = far left, 0 = center, 1 = far right (for the 9:16 crop)

BASE="$(basename "${IN%.*}")"
mkdir -p "$OUTDIR"

case "$HEIGHT" in
  2160) W=3840; LABEL=4k ;;
  1080) W=1920; LABEL=hd ;;
  *) echo "ERROR: height must be 2160 or 1080" >&2; exit 1 ;;
esac

# 16:9 master — scale to fit, pad if aspect differs slightly
ffmpeg -hide_banner -loglevel warning -y -i "$IN" \
  -vf "scale=${W}:${HEIGHT}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${W}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,fps=30" \
  -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p -an \
  "$OUTDIR/${BASE}_master_${LABEL}.mp4"

# 9:16 mobile — scale so height fills 1920, then crop width to 1080 with pan offset
ffmpeg -hide_banner -loglevel warning -y -i "$IN" \
  -vf "scale=-2:1920:flags=lanczos,crop=1080:1920:x='(in_w-1080)/2*(1+(${PAN}))':y=0,fps=30" \
  -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p -an \
  "$OUTDIR/${BASE}_mobile_1080x1920.mp4"

echo "Delivered:"
echo "  $OUTDIR/${BASE}_master_${LABEL}.mp4"
echo "  $OUTDIR/${BASE}_mobile_1080x1920.mp4"
