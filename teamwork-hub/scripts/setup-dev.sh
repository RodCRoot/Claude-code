#!/usr/bin/env bash
# Rebuilds a local development machine from nothing: PostgreSQL role and databases, .env,
# dependencies, and the synthetic demo data. Safe to run again; it only creates what is missing.
# Local development only. It never touches a staging or production database.
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v service >/dev/null && ! pg_isready -q 2>/dev/null; then
  service postgresql start >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pg_isready -q && break; sleep 1; done
fi
pg_isready -q || { echo "PostgreSQL is not running. Start it, then run this script again." >&2; exit 1; }

psql_admin() { if [ "$(id -u)" = "0" ]; then su postgres -c "psql -v ON_ERROR_STOP=1 -qtA $*"; else psql -v ON_ERROR_STOP=1 -qtA "$@"; fi; }

[ "$(psql_admin -c "\"select 1 from pg_roles where rolname='teamwork'\"")" = "1" ] ||
  psql_admin -c "\"create role teamwork login createdb password 'teamwork'\""
for db in teamwork_hub teamwork_hub_test; do
  [ "$(psql_admin -c "\"select 1 from pg_database where datname='$db'\"")" = "1" ] ||
    psql_admin -c "\"create database $db owner teamwork\""
  psql_admin -d "$db" -c "\"create extension if not exists btree_gist\""
done

if [ ! -f .env ]; then
  cp .env.example .env
  secret="$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | head -c 48)"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$secret|" .env
  echo "Created .env with a random SESSION_SECRET (local demo mode)."
fi

pnpm install --frozen-lockfile
pnpm db:fresh
echo "Ready. Run 'pnpm dev' (or 'pnpm build && pnpm start'), then open http://localhost:3000"
