import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import type { DB } from "./index.js";
import { SCHEMA_SQL } from "./schema.js";
import { runMigrations, assertMigrationsValid, schemaVersion, BASELINE_VERSION, type Migration } from "./migrate.js";

const mem = () => new Database(":memory:") as unknown as DB;
const uv = (db: DB) => Number(db.pragma("user_version", { simple: true }));
const hasTable = (db: DB, t: string) =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
const cols = (db: DB, t: string) =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

describe("runMigrations — baseline adopt", () => {
  it("a fresh DB (user_version 0) is adopted at the baseline with no migration DDL", () => {
    const db = mem();
    expect(uv(db)).toBe(0);
    expect(runMigrations(db, [])).toBe(BASELINE_VERSION);
    expect(uv(db)).toBe(BASELINE_VERSION);
  });

  it("is idempotent — re-running with no pending migrations is a no-op", () => {
    const db = mem();
    runMigrations(db, []);
    expect(runMigrations(db, [])).toBe(BASELINE_VERSION);
    expect(uv(db)).toBe(BASELINE_VERSION);
  });
});

describe("runMigrations — applying", () => {
  const migs: Migration[] = [
    { version: 2, name: "create t2", sql: `CREATE TABLE t2 (id INTEGER PRIMARY KEY);` },
    { version: 3, name: "add col", sql: `ALTER TABLE t2 ADD COLUMN label TEXT;` },
  ];

  it("applies pending migrations in ascending order and bumps user_version each step", () => {
    const db = mem();
    expect(runMigrations(db, migs)).toBe(3);
    expect(uv(db)).toBe(3);
    expect(hasTable(db, "t2")).toBe(true);
    expect(cols(db, "t2")).toContain("label"); // the ALTER (v3) ran after the CREATE (v2)
  });

  it("re-run after full apply skips everything (idempotent, no 'table exists' error)", () => {
    const db = mem();
    runMigrations(db, migs);
    expect(() => runMigrations(db, migs)).not.toThrow();
    expect(uv(db)).toBe(3);
  });

  it("an EXISTING DB already at v2 gets ONLY the later v3 column (forward-only, skips applied versions)", () => {
    const db = mem();
    db.exec(`CREATE TABLE t2 (id INTEGER PRIMARY KEY);`); // simulate v2 already applied historically
    db.pragma("user_version = 2");
    expect(cols(db, "t2")).not.toContain("label");
    runMigrations(db, migs); // v2 skipped (would re-CREATE + throw if not skipped); only v3 runs
    expect(uv(db)).toBe(3);
    expect(cols(db, "t2")).toContain("label");
  });
});

describe("Model A — frozen SCHEMA_SQL + migrations-only (fresh-install trap guard)", () => {
  // The real future flow: SCHEMA_SQL is frozen at v1 (does NOT contain the new column); the change is
  // ONLY a v2 migration. A fresh install must run SCHEMA_SQL -> adopt v1 -> apply v2 with NO duplicate column.
  const futureColumn: Migration[] = [
    { version: 2, name: "add memories.pinned", sql: `ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;` },
  ];

  it("a FRESH install applies a v2 ADD COLUMN cleanly (no duplicate-column crash)", () => {
    const db = mem();
    db.exec(SCHEMA_SQL); // frozen v1 baseline — memories has NO 'pinned' column
    expect(cols(db, "memories")).not.toContain("pinned");
    expect(() => runMigrations(db, futureColumn)).not.toThrow(); // adopt v1 -> run v2; would throw if SCHEMA_SQL also had the col
    expect(uv(db)).toBe(2);
    expect(cols(db, "memories")).toContain("pinned"); // column came from the migration
  });

  it("an EXISTING v1 DB gets the same v2 column via the same path", () => {
    const db = mem();
    db.exec(SCHEMA_SQL);
    db.pragma("user_version = 1"); // already adopted at baseline in a prior boot
    runMigrations(db, futureColumn);
    expect(uv(db)).toBe(2);
    expect(cols(db, "memories")).toContain("pinned");
  });

  it("guards the trap: if SCHEMA_SQL ALSO had the column, the v2 ALTER would throw duplicate-column", () => {
    // proves WHY the doc forbids double-adding: simulate SCHEMA_SQL already containing 'pinned'
    const db = mem();
    db.exec(SCHEMA_SQL);
    db.exec(`ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;`); // as if SCHEMA_SQL had it
    expect(() => runMigrations(db, futureColumn)).toThrow(/duplicate column|migration 2/i);
  });
});

describe("runMigrations — transactional rollback (touches live data, must be atomic)", () => {
  it("a throwing migration rolls back its DDL AND does not advance user_version", () => {
    const db = mem();
    runMigrations(db, []); // baseline = 1
    const bad: Migration[] = [
      {
        version: 2,
        name: "half-then-throw",
        // first statement succeeds, second is invalid -> the whole tx must roll back
        sql: `CREATE TABLE should_not_survive (id INTEGER); INSERT INTO no_such_table VALUES (1);`,
      },
    ];
    expect(() => runMigrations(db, bad)).toThrow(/migration 2/);
    expect(uv(db)).toBe(BASELINE_VERSION); // NOT advanced to 2
    expect(hasTable(db, "should_not_survive")).toBe(false); // DDL rolled back -> DB unchanged
  });

  it("a partial failure is resumable: fix-and-rerun applies the rest from where it stopped", () => {
    const db = mem();
    runMigrations(db, [{ version: 2, name: "ok", sql: `CREATE TABLE a (id INTEGER);` }]); // -> v2
    expect(uv(db)).toBe(2);
    // now v3 throws
    const withBadV3: Migration[] = [
      { version: 2, name: "ok", sql: `CREATE TABLE a (id INTEGER);` },
      { version: 3, name: "boom", sql: `INSERT INTO missing VALUES (1);` },
    ];
    expect(() => runMigrations(db, withBadV3)).toThrow(/migration 3/);
    expect(uv(db)).toBe(2); // v2 stayed committed, v3 rolled back
    // operator fixes v3 -> re-run resumes at 3 only (v2 skipped)
    const fixed: Migration[] = [
      { version: 2, name: "ok", sql: `CREATE TABLE a (id INTEGER);` },
      { version: 3, name: "fixed", sql: `CREATE TABLE b (id INTEGER);` },
    ];
    expect(runMigrations(db, fixed)).toBe(3);
    expect(hasTable(db, "b")).toBe(true);
  });
});

describe("assertMigrationsValid / schemaVersion", () => {
  it("rejects a duplicate version", () => {
    expect(() => assertMigrationsValid([
      { version: 2, name: "a", sql: "" },
      { version: 2, name: "b", sql: "" },
    ])).toThrow(/duplicate/);
  });
  it("rejects out-of-order versions", () => {
    expect(() => assertMigrationsValid([
      { version: 3, name: "a", sql: "" },
      { version: 2, name: "b", sql: "" },
    ])).toThrow(/ascending/);
  });
  it("rejects a version at/below the baseline", () => {
    expect(() => assertMigrationsValid([{ version: 1, name: "x", sql: "" }])).toThrow(/must be > baseline/);
  });
  it("schemaVersion is the max migration version, or the baseline when empty", () => {
    expect(schemaVersion([])).toBe(BASELINE_VERSION);
    expect(schemaVersion([{ version: 2, name: "a", sql: "" }, { version: 5, name: "b", sql: "" }])).toBe(5);
  });
});
