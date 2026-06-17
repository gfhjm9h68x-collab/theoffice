# DB migration runner — design (Phase A, #12)

## Problem
`openDb()` applies `SCHEMA_SQL` (all `CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS`). That is fine for
*new tables* on existing installs, but a future **column add** (`ALTER TABLE x ADD COLUMN y`) can NOT be
expressed that way — `CREATE TABLE IF NOT EXISTS` is a no-op once the table exists, so existing tenant DBs
never get the column and the first query referencing it crash-loops the engine. We run schema changes on the
LIVE tenant DB during one-click Update, so this must be safe + recoverable.

## Approach — `PRAGMA user_version`-gated ordered migrations

`openDb()` does, in order:
1. `db.exec(SCHEMA_SQL)` — unchanged. Fresh installs get the **full current** schema here; existing installs
   no-op. This stays the source of truth for a from-scratch DB.
2. `runMigrations(db)` — `src/db/migrate.ts`:
   - Read `PRAGMA user_version` (0 on any DB that predates this system; SQLite default).
   - **Baseline adopt:** if `user_version === 0`, set it to `BASELINE_VERSION` (=1) WITHOUT running anything.
     Rationale: every historical schema change in this repo was an additive `CREATE … IF NOT EXISTS` (new
     tables/indexes/triggers — never a post-hoc `ALTER` on an existing table), so SCHEMA_SQL already brings
     both a fresh DB and any pre-system DB fully to the v1 baseline. Adopting at v1 is therefore correct and
     avoids re-running baseline DDL. *(Toby: please verify this invariant against a real tenant DB — confirm
     every table matches SCHEMA_SQL exactly, no missing columns.)*
   - **Apply pending:** for each `MIGRATIONS` entry with `version > user_version`, in ascending order, run it
     in its OWN transaction that BOTH execs the migration SQL AND bumps `user_version` to that version. So:
     - **transactional:** a throwing step rolls back its DDL *and* the version bump together → DB unchanged,
       `user_version` not advanced past the failure (verified by test).
     - **resumable / idempotent:** a re-run starts at `user_version+1`; already-applied migrations are skipped.
     - **ordered:** sorted by `version`; gaps/dupes are a hard error (caught at load, not at run).

`MIGRATIONS` ships **empty** in this PR (no schema change is being made now — we are installing the
mechanism). `BASELINE_VERSION = 1`, `SCHEMA_VERSION = 1`. The first real future change adds
`{ version: 2, name, sql }` and bumps `SCHEMA_VERSION` to 2; existing v1 DBs then run migration 2, fresh DBs
get it via SCHEMA_SQL and are adopted straight to 2.

### Why per-migration transactions (not one big one)
SQLite DDL is transactional. Per-migration tx gives precise rollback + resumability: if v3 throws, v2 stays
committed (user_version=2) and the operator fixes v3 and re-runs from 2. One giant transaction would redo
v2 every retry. Each tx is `BEGIN; <sql>; PRAGMA user_version=N; COMMIT` (user_version IS settable inside a
transaction in SQLite; asserted by a test).

## Pre-update DB backup (recoverable bad migration)
In `applyUpdate()`, BEFORE `git pull`, snapshot the live DB with `VACUUM INTO '<db>.bak-<UTCstamp>'`
(synchronous, WAL-consistent — captures committed WAL content into a clean standalone file, unlike a raw
`cp` of the -wal-split db). Keep the last N (=5) backups, prune older. The path + a one-line restore hint go
in the update output. Restore = stop engine, `cp` the .bak over theoffice.db, start.

## #11 Update-button hardening (same flow)
- `npm ci` (not `npm install`) — reproducible from the lockfile, fails on lock drift.
- Pre-pull `git rev-parse HEAD` capture; on build/install failure `git reset --hard <pre>` so main is never
  left half-updated (mirrors the manual deploy rollback we just did).
- Recopy `office-say` after build: `install -m 0755 scripts/office-say.sh ~/.local/bin/office-say`.
- Restart only after all steps succeed (already true).
- `UPGRADING.md`: documents the flow + manual restore-from-backup.

## Tests (on the branch, must be green)
- migrate: fresh DB (user_version 0 → BASELINE), idempotent re-run is a no-op, ordering applied ascending,
  a throwing migration rolls back (DDL reverted + user_version unchanged), user_version IS bumped inside a tx.
- A real ALTER fixture migration (v2 ADD COLUMN) proves an existing v1 DB gets the column and a fresh DB
  already has it — exercised in the test list, not shipped in MIGRATIONS.
