#!/usr/bin/env bash
# Run the browser suite as if it were another day and time, without any clock hook in the app.
#
#   bash scripts/e2e-at.sh "2026-11-16 10:00" [playwright args...]
#
# The date and time are facility-local (America/Indiana/Indianapolis). Everything that reads a clock runs
# under libfaketime with one shared offset, so they agree with each other and time still moves forward:
#   - a private PostgreSQL cluster on port $FAKE_PG_PORT (now(), current_date, column defaults)
#   - the seed (pnpm db:fresh), so "today", "this week" and "two minutes ago" are relative to the faked time
#   - the production server (next start; build it first with pnpm build)
#   - the Playwright runner (the specs' own Date.now())
# Chromium itself is NOT faked (it stalls under libfaketime), so the browser's own clock stays real. That only
# matters for client-side timers (rest timer, TV board tick, offline queue timestamps); every date the pages show
# is rendered by the server. Pick a faked time in the future so session cookies never look expired to the browser.
#
# Nothing in src/ knows about this: the application has no clock override, so there is nothing to switch on
# in production. This script needs root (it starts its own PostgreSQL as the postgres user), the faketime
# package (apt-get install faketime) and a built app. Results go to $OUT (default .e2e-at/<stamp>/).
set -euo pipefail

WHEN="${1:?usage: e2e-at.sh \"YYYY-MM-DD HH:MM\" [playwright args]}"
shift || true
TZ_FACILITY="America/Indiana/Indianapolis"
PORT="${PORT:-3163}"
FAKE_PG_PORT="${FAKE_PG_PORT:-5563}"
FAKE_PG_DIR="${FAKE_PG_DIR:-/var/lib/postgresql/e2e-faketime}"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)}"
LIB="${FAKETIME_LIB:-/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1}"
DB_NAME="${FAKE_DB_NAME:-teamwork_hub_e2e_clock}"
STAMP="$(echo "$WHEN" | tr ' :' '_-')"
OUT="${OUT:-.e2e-at/$STAMP}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

[ -f "$LIB" ] || { echo "libfaketime not found at $LIB (apt-get install faketime)"; exit 2; }
[ -d "${APP_DIR:-.}/.next" ] || { echo "no production build in ${APP_DIR:-this directory}: run pnpm build first"; exit 2; }

target=$(TZ="$TZ_FACILITY" date -d "$WHEN" +%s)
offset=$(( target - $(date +%s) ))
sign="+"; [ "$offset" -lt 0 ] && sign="-"
FAKE="${sign}${offset#-}s"
fake_env=(LD_PRELOAD="$LIB" FAKETIME="$FAKE" DONT_FAKE_MONOTONIC=1)
echo "e2e-at: $WHEN $TZ_FACILITY  (FAKETIME=$FAKE)  results in $OUT"

# The server is found by process name (next-server, read from /proc/<pid>/comm) and the PORT it was started
# with, never by matching a command line.
server_pids() {
  local d c
  for d in /proc/[0-9]*; do
    c="$(cat "$d/comm" 2>/dev/null || true)"
    case "$c" in
      next-server*) { tr "\\0" "\\n" < "$d/environ" | grep -qx "PORT=$PORT"; } 2>/dev/null && echo "${d#/proc/}" ;;
    esac
  done
  return 0
}
stop_server() {
  local pid
  for pid in $(server_pids); do kill "$pid" 2>/dev/null || true; done
  for _ in $(seq 1 40); do [ -z "$(server_pids)" ] && return 0; sleep 0.5; done
  echo "e2e-at: a next-server on port $PORT would not stop"; return 1
}
pg() { su postgres -c "env ${fake_env[*]} $PG_BIN/pg_ctl -D $FAKE_PG_DIR $*"; }

stop_server
if [ ! -d "$FAKE_PG_DIR" ]; then
  su postgres -c "$PG_BIN/initdb -D $FAKE_PG_DIR -A trust -U postgres" >/dev/null
fi
su postgres -c "$PG_BIN/pg_ctl -D $FAKE_PG_DIR stop -m fast" >/dev/null 2>&1 || true
pg "-o '-p $FAKE_PG_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp -c fsync=off -c synchronous_commit=off -c full_page_writes=off' -l $FAKE_PG_DIR/log.txt -w start" >/dev/null
psql_fake() { psql -h 127.0.0.1 -p "$FAKE_PG_PORT" -U postgres -v ON_ERROR_STOP=1 -Atq "$@"; }
psql_fake -c "do \$\$ begin if not exists (select from pg_roles where rolname = 'teamwork') then create role teamwork login password 'teamwork'; end if; end \$\$"
psql_fake -tc "select 1 from pg_database where datname = '$DB_NAME'" | grep -q 1 || psql_fake -c "create database $DB_NAME owner teamwork"
psql_fake -d "$DB_NAME" -c "create extension if not exists btree_gist"
echo "e2e-at: database clock is $(psql_fake -c "select to_char(now() at time zone '$TZ_FACILITY', 'Dy YYYY-MM-DD HH24:MI')")"

export DATABASE_URL="postgres://teamwork:teamwork@127.0.0.1:$FAKE_PG_PORT/$DB_NAME"
export APP_URL="http://localhost:$PORT" APP_MODE=demo
# The seed and the server must share one object store even when the server runs from APP_DIR.
export STORAGE_BACKEND=local STORAGE_DIR="${STORAGE_DIR:-$PWD/.storage}"
env "${fake_env[@]}" pnpm db:fresh > "$OUT/seed.log" 2>&1 || { tail -20 "$OUT/seed.log"; exit 3; }

# APP_DIR: a directory holding a copy of the production build (.next) to serve, so the working tree can be
# rebuilt while a long sweep is running. Defaults to this directory.
(cd "${APP_DIR:-.}" && exec env "${fake_env[@]}" PORT="$PORT" pnpm start) > "$OUT/server.log" 2>&1 &
trap 'stop_server; su postgres -c "$PG_BIN/pg_ctl -D $FAKE_PG_DIR stop -m fast" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do curl -fsS -o /dev/null "http://localhost:$PORT/login" 2>/dev/null && break; sleep 1; done
curl -fsS -o /dev/null "http://localhost:$PORT/login" || { echo "server did not start"; tail -20 "$OUT/server.log"; exit 4; }
# The server answering on the port must be the one just started, with this run's clock (not a leftover).
for pid in $(server_pids); do
  tr '\0' '\n' < "/proc/$pid/environ" | grep -qx "FAKETIME=$FAKE" || { echo "e2e-at: the server on port $PORT is not running with FAKETIME=$FAKE"; exit 5; }
done
[ -n "$(server_pids)" ] || { echo "e2e-at: no next-server found for port $PORT"; exit 5; }
grep -q "EADDRINUSE" "$OUT/server.log" && { echo "e2e-at: port $PORT was already in use"; exit 5; }

printf '#!/bin/bash\nunset LD_PRELOAD FAKETIME DONT_FAKE_MONOTONIC\nexec %q "$@"\n' "${PW_CHROMIUM:-/opt/pw-browsers/chromium}" > "$OUT/chromium-realtime.sh"
chmod +x "$OUT/chromium-realtime.sh"
set +e
env "${fake_env[@]}" BASE_URL="http://localhost:$PORT" PW_CHROMIUM="$OUT/chromium-realtime.sh" \
  PLAYWRIGHT_JSON_OUTPUT_NAME="$OUT/results.json" \
  npx playwright test --workers=1 --trace off --reporter=line,json --output "$OUT/pw" "$@" > "$OUT/playwright.log" 2>&1
code=$?
set -e
echo "e2e-at: finished at fake $(env "${fake_env[@]}" TZ="$TZ_FACILITY" date '+%a %Y-%m-%d %H:%M'), exit $code"
grep -E "^\s+[0-9]+ (passed|failed|skipped|flaky|did not run)" "$OUT/playwright.log" || tail -5 "$OUT/playwright.log"
exit $code
