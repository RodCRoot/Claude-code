#!/usr/bin/env bash
# Restore rehearsal: proves a `pnpm backup` dump actually restores.
#
#   pnpm restore:check                          # newest ./backups/*.dump
#   pnpm restore:check backups/teamwork-x.dump  # a specific dump
#
# Steps: verify the .sha256 → create an EMPTY scratch database → pg_restore --exit-on-error →
# compare applied migrations (count + hashes) with ./drizzle and with the source database →
# compare schema object counts and exact per-table row counts with the source database →
# optionally verify stored-object files against their SHA-256 (STORAGE_BACKEND=local) →
# write a report → drop the scratch database (KEEP_RESTORE=1 keeps it).
#
# Environment:
#   DATABASE_URL           source database the dump came from (also read from .env); used read-only.
#   RESTORE_DATABASE_URL   optional: restore into this existing EMPTY database instead of creating
#                          a scratch one (for hosts where the app role cannot CREATE DATABASE).
#   RESTORE_ADMIN_URL      optional: connection used to CREATE/DROP the scratch database
#                          (default: DATABASE_URL with the database name replaced by "postgres").
#   BACKUP_DIR             where to find dumps / write the report (default ./backups).
#   ALLOW_DRIFT=1          row-count differences are reported but do not fail (source changed since the dump).
#   KEEP_RESTORE=1         keep the scratch database for manual inspection.
# Exit codes: 0 = restore verified, 1 = usage/setup error, 2 = verification failed.
set -euo pipefail

if [ -f .env ] && [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -n1 | cut -d= -f2- || true)"
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "restore-check: DATABASE_URL is not set — it names the source database to compare against." >&2
  exit 1
fi
for bin in pg_restore psql; do
  command -v "$bin" >/dev/null 2>&1 || { echo "restore-check: $bin not found (install the PostgreSQL 16 client)." >&2; exit 1; }
done

BACKUP_DIR="${BACKUP_DIR:-./backups}"
DUMP="${1:-}"
if [ -z "$DUMP" ]; then
  DUMP="$(ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | head -n1 || true)"
fi
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "restore-check: no dump found (run \`pnpm backup\` first or pass a path)." >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
REPORT="$BACKUP_DIR/restore-check-$STAMP.txt"
FAIL=0
: > "$REPORT"
chmod 600 "$REPORT"
say() { printf '%s\n' "$*" | tee -a "$REPORT"; }
fail() { say "FAIL: $*"; FAIL=1; }

# Replace the database name (last path segment) of a postgres URL, keeping ?params.
with_db() { printf '%s' "$1" | sed -E "s#/[^/?]+(\\?|\$)#/$2\\1#"; }
db_name() { printf '%s' "$1" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#'; }
q() { psql "$1" -X -v ON_ERROR_STOP=1 -Atqc "$2"; }

SRC_DB="$(db_name "$DATABASE_URL")"
CREATED=0
if [ -n "${RESTORE_DATABASE_URL:-}" ]; then
  TARGET_URL="$RESTORE_DATABASE_URL"
  TARGET_DB="$(db_name "$TARGET_URL")"
  if [ "$(q "$TARGET_URL" "select count(*) from information_schema.tables where table_schema in ('public','drizzle')")" != "0" ]; then
    echo "restore-check: RESTORE_DATABASE_URL ($TARGET_DB) is not empty — refusing to restore over data." >&2
    exit 1
  fi
else
  ADMIN_URL="${RESTORE_ADMIN_URL:-$(with_db "$DATABASE_URL" postgres)}"
  TARGET_DB="teamwork_restore_check_$(date -u +%Y%m%d%H%M%S)"
  TARGET_URL="$(with_db "$DATABASE_URL" "$TARGET_DB")"
fi
if [ "$TARGET_DB" = "$SRC_DB" ]; then
  echo "restore-check: restore target equals the source database ($SRC_DB) — refusing." >&2
  exit 1
fi

cleanup() {
  if [ "$CREATED" = "1" ] && [ "${KEEP_RESTORE:-0}" != "1" ]; then
    q "$ADMIN_URL" "drop database if exists \"$TARGET_DB\"" >/dev/null 2>&1 && say "Dropped scratch database $TARGET_DB." || say "WARN: could not drop scratch database $TARGET_DB — drop it manually."
  elif [ "$CREATED" = "1" ]; then
    say "Kept scratch database $TARGET_DB (KEEP_RESTORE=1). Drop it when done."
  fi
}
trap cleanup EXIT

say "Teamwork Hub restore rehearsal — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "Dump:            $DUMP ($(du -h "$DUMP" | cut -f1))"
say "Source database: $SRC_DB"
say "Scratch target:  $TARGET_DB"
say ""

# 1. Checksum
if [ -f "$DUMP.sha256" ]; then
  if (cd "$(dirname "$DUMP")" && (sha256sum -c --status "$(basename "$DUMP").sha256" 2>/dev/null || shasum -a 256 -c -s "$(basename "$DUMP").sha256")); then
    say "[ok]   dump checksum matches $(basename "$DUMP").sha256"
  else
    fail "dump checksum does NOT match $(basename "$DUMP").sha256"
    exit 2
  fi
else
  say "[warn] no .sha256 next to the dump — integrity not verified"
fi

# 2. Restore into an empty database
T0=$(date +%s)
if [ -z "${RESTORE_DATABASE_URL:-}" ]; then
  q "$ADMIN_URL" "create database \"$TARGET_DB\"" >/dev/null
  CREATED=1
fi
q "$TARGET_URL" "create extension if not exists btree_gist" >/dev/null
if pg_restore --no-owner --no-privileges --exit-on-error -d "$TARGET_URL" "$DUMP" 2>>"$REPORT"; then
  say "[ok]   pg_restore completed in $(( $(date +%s) - T0 ))s with --exit-on-error"
else
  fail "pg_restore failed (details above)"
  exit 2
fi

# 3. Migrations status
FILES=$(ls -1 drizzle/*.sql 2>/dev/null | wc -l | tr -d ' ')
R_MIG=$(q "$TARGET_URL" "select count(*) from drizzle.__drizzle_migrations" 2>/dev/null || echo "missing")
S_MIG=$(q "$DATABASE_URL" "select count(*) from drizzle.__drizzle_migrations" 2>/dev/null || echo "missing")
R_HASHES=$(q "$TARGET_URL" "select string_agg(hash, ',' order by created_at) from drizzle.__drizzle_migrations" 2>/dev/null || echo "")
S_HASHES=$(q "$DATABASE_URL" "select string_agg(hash, ',' order by created_at) from drizzle.__drizzle_migrations" 2>/dev/null || echo "")
say "       migrations: restored=$R_MIG source=$S_MIG repo files=$FILES"
if [ "$R_MIG" = "$FILES" ] && [ "$R_HASHES" = "$S_HASHES" ]; then
  say "[ok]   migrations applied in the restore match the repository and the source database"
elif [ "$R_MIG" = "$S_MIG" ] && [ "$R_HASHES" = "$S_HASHES" ]; then
  say "[warn] restore matches the source database but the repository has $FILES migration files — run \`pnpm db:migrate\` after restoring"
else
  fail "migration history differs (restored=$R_MIG, source=$S_MIG, files=$FILES)"
fi

# 4. Schema objects
SCHEMA_SQL="select (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')||' tables, '||
  (select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public')||' constraints, '||
  (select count(*) from pg_indexes where schemaname='public')||' indexes, '||
  (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal)||' triggers'"
R_SCHEMA=$(q "$TARGET_URL" "$SCHEMA_SQL")
S_SCHEMA=$(q "$DATABASE_URL" "$SCHEMA_SQL")
if [ "$R_SCHEMA" = "$S_SCHEMA" ]; then say "[ok]   schema objects match: $R_SCHEMA"; else fail "schema objects differ: restored [$R_SCHEMA] vs source [$S_SCHEMA]"; fi

# 5. Exact row counts per table
COUNT_SQL="select table_name||'|'||(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', table_schema, table_name), false, true, '')))[1]::text
  from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name"
TMP="$(mktemp -d)"
q "$TARGET_URL" "$COUNT_SQL" | LC_ALL=C sort > "$TMP/restored"
q "$DATABASE_URL" "$COUNT_SQL" | LC_ALL=C sort > "$TMP/source"
TABLES=$(wc -l < "$TMP/restored" | tr -d ' ')
R_ROWS=$(awk -F'|' '{s+=$2} END {print s+0}' "$TMP/restored")
S_ROWS=$(awk -F'|' '{s+=$2} END {print s+0}' "$TMP/source")
DIFF=$(LC_ALL=C join -t'|' -a1 -a2 -e 'absent' -o 0,1.2,2.2 "$TMP/restored" "$TMP/source" | awk -F'|' '$2 != $3 {print "         " $1 ": restored=" $2 " source=" $3}')
if [ -z "$DIFF" ]; then
  say "[ok]   row counts identical in all $TABLES tables ($R_ROWS rows)"
else
  if [ "${ALLOW_DRIFT:-0}" = "1" ]; then say "[warn] row counts differ (ALLOW_DRIFT=1; source changed since the dump):"; else fail "row counts differ (restored $R_ROWS vs source $S_ROWS rows):"; fi
  say "$DIFF"
fi
say "       key tables (restored):"
grep -E '^(organizations|people|athletes|memberships|invoices|payments|bookings|metric_values|form_submissions|audit_events|stored_objects|import_batches)\|' "$TMP/restored" | awk -F'|' '{printf "         %-18s %s\n", $1, $2}' | tee -a "$REPORT" || true
rm -rf "$TMP"

# 6. Audit trail freshness
LAST_AUDIT=$(q "$TARGET_URL" "select coalesce(to_char(max(created_at) at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),'none') from audit_events")
say "       newest audit event in restore: $LAST_AUDIT"

# 7. Stored-object files (local backend only; for S3, use bucket versioning / replication checks)
if [ "${STORAGE_BACKEND:-local}" = "local" ] && [ -d "${STORAGE_DIR:-./.storage}" ]; then
  SD="${STORAGE_DIR:-./.storage}"
  OK=0; MISSING=0; BAD=0
  while IFS='|' read -r key sha; do
    [ -z "$key" ] && continue
    if [ ! -f "$SD/$key" ]; then MISSING=$((MISSING+1)); continue; fi
    got=$( (sha256sum "$SD/$key" 2>/dev/null || shasum -a 256 "$SD/$key") | cut -d' ' -f1)
    if [ "$got" = "$sha" ]; then OK=$((OK+1)); else BAD=$((BAD+1)); fi
  done < <(q "$TARGET_URL" "select storage_key||'|'||sha256 from stored_objects")
  if [ "$MISSING" = "0" ] && [ "$BAD" = "0" ]; then say "[ok]   $OK stored-object files present in $SD with matching SHA-256"
  else fail "stored-object files: $OK ok, $MISSING missing, $BAD checksum mismatch (in $SD)"; fi
else
  say "[skip] stored-object file check (STORAGE_BACKEND=${STORAGE_BACKEND:-local}; verify bucket objects separately)"
fi

say ""
if [ "$FAIL" = "0" ]; then say "RESULT: PASS — the dump restores cleanly and matches the source."; else say "RESULT: FAIL — see above."; fi
say "Report: $REPORT"
[ "$FAIL" = "0" ] || exit 2
