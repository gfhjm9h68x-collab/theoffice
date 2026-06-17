import type { DB } from "./index.js";
import { log } from "../logger.js";

const logger = log("db-migrate");

export interface Migration {
  /** strictly ascending, > BASELINE_VERSION (the SCHEMA_SQL baseline is version 1) */
  version: number;
  name: string;
  /** one or more SQL statements; ALTER/CREATE that SCHEMA_SQL's "IF NOT EXISTS" cannot express on an existing DB */
  sql: string;
}

/**
 * The schema that `SCHEMA_SQL` produces == version 1. Any DB at user_version 0 (fresh install, or any DB
 * predating this runner) is ADOPTED at this baseline without running migration DDL: every historical schema
 * change in this repo was an additive `CREATE ... IF NOT EXISTS`, so SCHEMA_SQL already brings both a fresh
 * and a pre-system DB fully to v1. See src/db/MIGRATIONS.md.
 */
export const BASELINE_VERSION = 1;

/**
 * Ordered, forward-only migrations applied AFTER SCHEMA_SQL. EMPTY today — this PR installs the mechanism;
 * no schema change is being made.
 *
 * IMPORTANT (Model A): SCHEMA_SQL is FROZEN at the v1 baseline. EVERY post-v1 change — new columns AND new
 * tables — goes ONLY here as { version, name, sql } (version strictly ascending from 2). Do NOT also edit
 * SCHEMA_SQL: on a fresh install SCHEMA_SQL(v1) -> adopt v1 -> these migrations run, so a column added in
 * BOTH places would hit "duplicate column" when the migration re-adds what SCHEMA_SQL already created and
 * crash the fresh install. Frozen baseline + migrations-only = a fresh DB and an existing DB take the exact
 * same path (adopt v1, then run v2+). New tables use plain CREATE TABLE in a migration (not IF NOT EXISTS,
 * so a genuine collision is loud).
 */
export const MIGRATIONS: Migration[] = [];

/** Highest known schema version (the baseline, or the max migration version). */
export function schemaVersion(migrations: Migration[] = MIGRATIONS): number {
  return migrations.reduce((mx, m) => Math.max(mx, m.version), BASELINE_VERSION);
}

/** Validate the list ONCE, loudly — a bad list is a programmer error, caught before it touches a DB. */
export function assertMigrationsValid(migrations: Migration[]): void {
  let prev = BASELINE_VERSION;
  const seen = new Set<number>();
  for (const m of migrations) {
    if (!Number.isInteger(m.version)) throw new Error(`migration "${m.name}" version must be an integer`);
    if (m.version <= BASELINE_VERSION) throw new Error(`migration "${m.name}" version ${m.version} must be > baseline ${BASELINE_VERSION}`);
    if (seen.has(m.version)) throw new Error(`duplicate migration version ${m.version}`);
    if (m.version < prev) throw new Error(`migrations not in ascending order at version ${m.version}`);
    seen.add(m.version);
    prev = m.version;
  }
}

/**
 * Apply pending migrations and return the resulting user_version. Each migration runs in its OWN
 * transaction that execs the SQL AND bumps user_version together — so a throwing step rolls back both
 * (DB unchanged, version not advanced past the failure). Idempotent: already-applied versions are skipped,
 * so a re-run (or a resumed run after a mid-way failure) does the right thing.
 */
export function runMigrations(db: DB, migrations: Migration[] = MIGRATIONS): number {
  assertMigrationsValid(migrations);
  let current = Number(db.pragma("user_version", { simple: true }));

  if (current === 0) {
    // adopt fresh/pre-system DB at the baseline (SCHEMA_SQL already produced it) — run no migration DDL
    db.pragma(`user_version = ${BASELINE_VERSION}`);
    current = BASELINE_VERSION;
    logger.info({ baseline: BASELINE_VERSION }, "db adopted at baseline schema version");
  }

  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    const apply = db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`); // bumped INSIDE the tx -> rolls back with the DDL on throw
    });
    try {
      apply();
    } catch (err) {
      logger.error({ version: m.version, name: m.name, err }, "migration failed -> rolled back (DB unchanged, user_version not advanced)");
      throw new Error(`db migration ${m.version} (${m.name}) failed: ${String((err as Error).message ?? err)}`);
    }
    current = m.version;
    logger.warn({ version: m.version, name: m.name }, "applied db migration");
  }
  return current;
}
