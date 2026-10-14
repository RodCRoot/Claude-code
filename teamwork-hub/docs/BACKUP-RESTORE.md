# Backup & restore

Teamwork Hub keeps data in two places. **You must back up both.**

| What | Where | How |
| --- | --- | --- |
| Database (all records, audit trail, import history) | PostgreSQL (`DATABASE_URL`) | `pnpm backup` (pg_dump) |
| Files (signed form PDFs, archived Zen Planner documents, import source files, raw force-time signals, exports) | `STORAGE_DIR` (default `./.storage`) with `STORAGE_BACKEND=local`, or the S3 bucket with `STORAGE_BACKEND=s3` | copy the directory; for S3 enable bucket versioning (+ optional cross-region replication) |

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

## Restore rehearsal (automated)

`scripts/restore-check.sh` performs the restore + verification below end-to-end against a scratch
database, so "we have backups" is a tested claim:

```bash
pnpm backup && pnpm restore:check                       # newest ./backups/*.dump
pnpm restore:check backups/teamwork-<db>-<stamp>.dump   # a specific dump
```

It (1) verifies the `.sha256`, (2) creates an empty scratch database `teamwork_restore_check_<stamp>`
on the same server and runs `pg_restore --exit-on-error`, (3) compares applied migrations (count
and hashes) with `drizzle/*.sql` and with the source database, (4) compares schema object counts
(tables, constraints, indexes, triggers), (5) compares exact row counts for every table,
(6) prints the newest audit event, (7) with `STORAGE_BACKEND=local`, re-hashes every stored-object
file, (8) writes a report to `backups/restore-check-<stamp>.txt` (mode 600) and drops the scratch
database (`KEEP_RESTORE=1` keeps it). Exit code 0 = PASS, 2 = verification failed, 1 = setup error.
Options: `RESTORE_DATABASE_URL` (restore into an existing empty database when the role cannot
`CREATE DATABASE`, e.g. a second Render database), `RESTORE_ADMIN_URL`, `ALLOW_DRIFT=1` (source
changed since the dump: row-count differences warn instead of fail), `BACKUP_DIR`.

### Rehearsal results

**2026-10-12, local development (PostgreSQL 16.15, pg_dump/pg_restore 16.15), seeded demo database `teamwork_hub_train`:**

```
[ok]   dump checksum matches teamwork-teamwork_hub_train-20261012T051736Z.dump.sha256   (672K dump)
[ok]   pg_restore completed in 1s with --exit-on-error
       migrations: restored=4 source=4 repo files=4
[ok]   migrations applied in the restore match the repository and the source database
[ok]   schema objects match: 103 tables, 286 constraints, 191 indexes, 4 triggers
[ok]   row counts identical in all 103 tables (8166 rows)
       key tables: athletes 17, audit_events 154, bookings 191, import_batches 1, invoices 10,
                   memberships 4, metric_values 424, organizations 1, people 50, stored_objects 14
[ok]   14 stored-object files present in ./.storage with matching SHA-256
RESULT: PASS — the dump restores cleanly and matches the source.
```

Also verified: an empty staging-style database (org + owner invite only) restores with PASS; a dump
whose bytes no longer match its `.sha256` fails before restoring (exit 2); a truncated dump with a
matching checksum fails at `pg_restore` (exit 2); the scratch database is dropped in every case.

Not yet rehearsed: a restore on Render (Render's managed backups / PITR restore into a new
instance) and restoring S3 objects — do both before launch (see `docs/DEPLOY.md` checklist).

## Verify a restore (manual)

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
