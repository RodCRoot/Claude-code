# Backup & restore

Teamwork Hub keeps data in two places. **You must back up both.**

| What | Where | How |
| --- | --- | --- |
| Database (all records, audit trail, import history) | PostgreSQL (`DATABASE_URL`) | `pnpm backup` (pg_dump) |
| Files (signed form PDFs, archived Zen Planner documents, import source files, raw force-time signals, exports) | `STORAGE_DIR` (default `./.storage`) or the object-storage bucket | copy the directory / bucket |

Each `stored_objects` row records the file's SHA-256, so a restore can be verified file-by-file.

## Backup

```bash
# Database: custom-format dump + .sha256 alongside it. Refuses to run if DATABASE_URL is unset.
pnpm backup                              # → ./backups/teamwork-<db>-<UTC timestamp>.dump
BACKUP_DIR=/mnt/backups pnpm backup      # elsewhere

# Files (same moment, after the dump):
tar -C "$(dirname "${STORAGE_DIR:-./.storage}")" -czf "backups/storage-$(date -u +%Y%m%dT%H%M%SZ).tgz" "$(basename "${STORAGE_DIR:-./.storage}")"
```

`scripts/backup.sh` runs `pg_dump --format=custom --no-owner --no-privileges`, sets the file mode to 600 and writes a checksum file. Install a `pg_dump` matching the server's major version (16). Keep backups off the app server, encrypted at rest — they contain minors' personal data.

Schedule both, e.g. nightly cron, and keep at least 7 daily + 4 weekly copies.

## Restore

```bash
# 1. Verify the dump checksum
sha256sum -c backups/teamwork-<db>-<stamp>.dump.sha256

# 2. Restore into an EMPTY database (never over a live one)
createdb teamwork_hub_restore
psql teamwork_hub_restore -c 'CREATE EXTENSION IF NOT EXISTS btree_gist'
pg_restore --no-owner --no-privileges --exit-on-error -d teamwork_hub_restore backups/teamwork-<db>-<stamp>.dump

# 3. Restore files
mkdir -p /srv/teamwork/storage && tar -xzf backups/storage-<stamp>.tgz -C /srv/teamwork/
```

Point `DATABASE_URL` and `STORAGE_DIR` at the restored copies and start the app.

## Verify a restore

1. **Schema/migrations:** `psql "$DATABASE_URL" -c 'select count(*) from drizzle.__drizzle_migrations'` matches the number of files in `drizzle/*.sql`.
2. **Row counts:** compare against the source (run on both):
   ```sql
   select 'people', count(*) from people union all select 'athletes', count(*) from athletes
   union all select 'memberships', count(*) from memberships union all select 'invoices', count(*) from invoices
   union all select 'bookings', count(*) from bookings union all select 'metric_values', count(*) from metric_values
   union all select 'audit_events', count(*) from audit_events union all select 'stored_objects', count(*) from stored_objects;
   ```
3. **Files:** every stored object exists and matches its checksum:
   ```bash
   psql "$DATABASE_URL" -Atc "select storage_key, sha256 from stored_objects" | while IFS='|' read -r key sha; do
     echo "$sha  ${STORAGE_DIR:-./.storage}/$key"; done | sha256sum -c --quiet && echo "all files OK"
   ```
4. **App smoke test:** sign in as an owner, open Import Center → history (batches present), open a person with archived documents and download one, generate an organization export and confirm `manifest.json` checksums (the export test suite does this automatically: `pnpm test tests/exports.test.ts`).
5. **Audit trail intact:** `select max(created_at) from audit_events` is close to the backup time.

Verified in development (2026-10-12): `pnpm backup` produced a dump that `pg_restore --list` reads (104 table-data entries); the script exits 1 without `DATABASE_URL`.

## Portable exports (not a backup)

Import Center → Exports produces a zip of CSV + JSON + original files with a `manifest.json` (schema `teamwork-export/1`, SHA-256 per file). Use it for data portability or handing a family their athlete's records — not for disaster recovery (it cannot restore auth, audit history, or internal ids' relationships fully).
