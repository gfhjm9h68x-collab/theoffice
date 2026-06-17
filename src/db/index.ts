import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "./schema.js";
import { runMigrations } from "./migrate.js";
import { log } from "../logger.js";

const logger = log("db");

export type DB = Database.Database;

let handle: DB | undefined;

/**
 * Open (and cache) the SQLite database at `dbFile`. Creates the file with 0600
 * perms before opening (no world-readable window), enables WAL + sane pragmas,
 * and applies the schema idempotently.
 */
export function openDb(dbFile: string): DB {
  if (handle) return handle;

  mkdirSync(dirname(dbFile), { recursive: true });
  if (!existsSync(dbFile)) {
    // pre-create at 0600 to avoid a world-readable TOCTOU window
    closeSync(openSync(dbFile, "a", 0o600));
  }

  const db = new Database(dbFile);
  try {
    chmodSync(dbFile, 0o600);
  } catch {
    /* best-effort */
  }

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  // SCHEMA_SQL = the full current schema (CREATE ... IF NOT EXISTS): a fresh DB lands fully current here,
  // an existing DB no-ops. Then the user_version-gated runner applies any forward migrations that
  // CREATE-IF-NOT-EXISTS can't express (e.g. ALTER ADD COLUMN on a pre-existing table). See db/migrate.ts.
  db.exec(SCHEMA_SQL);
  const version = runMigrations(db);

  logger.info({ dbFile, schemaVersion: version }, "database ready (WAL)");
  handle = db;
  return db;
}

export function getDb(): DB {
  if (!handle) throw new Error("db not opened — call openDb() first");
  return handle;
}

export function closeDb(): void {
  if (handle) {
    try {
      handle.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      /* ignore */
    }
    handle.close();
    handle = undefined;
  }
}
