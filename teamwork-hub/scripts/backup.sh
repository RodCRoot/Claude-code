#!/usr/bin/env bash
# Database backup: pg_dump (custom format) to a timestamped file.
#   pnpm backup                 # writes ./backups/teamwork-<db>-<UTC timestamp>.dump
#   BACKUP_DIR=/mnt/backups pnpm backup
# Refuses to run without DATABASE_URL. See docs/BACKUP-RESTORE.md for restore + verification.
set -euo pipefail

if [ -f .env ] && [ -z "${DATABASE_URL:-}" ]; then
  # Load DATABASE_URL from .env without echoing secrets.
  DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -n1 | cut -d= -f2- || true)"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "backup.sh: DATABASE_URL is not set — refusing to guess which database to dump." >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "backup.sh: pg_dump not found (install the PostgreSQL client matching your server version)." >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
DB_NAME="$(printf '%s' "$DATABASE_URL" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/teamwork-${DB_NAME}-${STAMP}.dump"

pg_dump --format=custom --no-owner --no-privileges --file="$OUT" "$DATABASE_URL"
chmod 600 "$OUT"
SHA="$( (sha256sum "$OUT" 2>/dev/null || shasum -a 256 "$OUT") | cut -d' ' -f1)"
printf '%s  %s\n' "$SHA" "$(basename "$OUT")" > "$OUT.sha256"
echo "Wrote $OUT ($(du -h "$OUT" | cut -f1)), sha256 $SHA"
echo "Remember to back up STORAGE_DIR (${STORAGE_DIR:-./.storage}) as well — files are not in the database."
