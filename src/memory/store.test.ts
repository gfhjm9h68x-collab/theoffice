import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../db/index.js";
import { saveMemory, searchMemories } from "./store.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "office-store-"));
  openDb(join(dir, "test.db"));
  for (const c of ["hot", "warm", "cold", "shared"] as const) saveMemory({ agentId: "a", category: c, content: `${c}-row` });
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const cats = (rows: { category: string }[]) => new Set(rows.map((r) => r.category));

describe("searchMemories category filter", () => {
  it("a single tier filters with '= ?'", () => {
    expect(cats(searchMemories({ agentId: "a", category: "hot" }))).toEqual(new Set(["hot"]));
  });

  it("a tier SET filters with IN (...) — the always-bundle fetch", () => {
    expect(cats(searchMemories({ agentId: "a", category: ["hot", "warm"] }))).toEqual(new Set(["hot", "warm"]));
    expect(cats(searchMemories({ agentId: "a", category: ["cold", "shared"] }))).toEqual(new Set(["cold", "shared"]));
  });

  it("no category returns all tiers", () => {
    expect(cats(searchMemories({ agentId: "a" }))).toEqual(new Set(["hot", "warm", "cold", "shared"]));
  });

  it("combines with an FTS query", () => {
    saveMemory({ agentId: "a", category: "cold", content: "a very specific quokka fact" });
    const rows = searchMemories({ agentId: "a", q: "quokka", category: ["cold", "shared"] });
    expect(rows.length).toBe(1);
    expect(rows[0].content).toContain("quokka");
  });
});
