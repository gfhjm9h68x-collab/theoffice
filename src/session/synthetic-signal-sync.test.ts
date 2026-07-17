import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { SYNTHETIC_SIGNAL_USERS } from "./delivery.js";

// The synthetic-signal exclusion set (ocr-signal / bill-signal / archive-signal) is duplicated across
// THREE files in TWO repos: the engine's SYNTHETIC_SIGNAL_USERS here, plus two gitignored agent-dir
// Python guards. A future edit that updates 2-of-3 silently reintroduces the drift trap Toby flagged
// (a bill/archive wake false-firing as an unanswered owner message). This test fails the moment any of
// the three drifts, so the coupling self-polices.
//
// The .py guards live under gitignored tenant/, so they may be ABSENT in a fresh checkout / CI — there
// the test skips (nothing to compare). On the dev/prod box where the files exist and get edited, it
// enforces exact equality with SYNTHETIC_SIGNAL_USERS.
const GUARDS = [
  "/opt/claude/theoffice/tenant/agents/darryl/tools/drift-detector/drift_detect.py",
  "/opt/claude/theoffice/tenant/agents/marveen/hooks/office-say-stop-guard.py",
];

// Extract every `NOT IN ('a','b',...)` clause's quoted set from a .py source.
function pyExclusionSets(src: string): string[][] {
  const clauses: string[][] = [];
  for (const m of src.matchAll(/NOT IN \(([^)]*)\)/g)) {
    clauses.push([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort());
  }
  return clauses;
}

describe("synthetic-signal exclusion sync (engine set == both .py guards)", () => {
  const expected = [...SYNTHETIC_SIGNAL_USERS].sort();

  it("the engine set is non-empty (sanity)", () => {
    expect(expected.length).toBeGreaterThan(0);
    expect(expected).toContain("ocr-signal");
  });

  for (const path of GUARDS) {
    const name = path.split("/").slice(-1)[0];
    (existsSync(path) ? it : it.skip)(`${name} exclusion list matches SYNTHETIC_SIGNAL_USERS`, () => {
      const clauses = pyExclusionSets(readFileSync(path, "utf8"));
      // The guard MUST have at least one exclusion clause, and EVERY clause must equal the engine set.
      expect(clauses.length).toBeGreaterThan(0);
      for (const clause of clauses) expect(clause).toEqual(expected);
    });
  }
});
