import { describe, it, expect } from "vitest";
import { EFFORT_LEVELS, normalizeEffort } from "./effort.js";

describe("effort vocabulary", () => {
  it("offers exactly the five pinnable levels, in ascending order", () => {
    expect([...EFFORT_LEVELS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("does not offer auto or ultracode (not pinnable settings)", () => {
    expect(EFFORT_LEVELS).not.toContain("auto");
    expect(EFFORT_LEVELS).not.toContain("ultracode");
  });

  it("passes known levels through", () => {
    expect(normalizeEffort("xhigh")).toBe("xhigh");
    expect(normalizeEffort("low")).toBe("low");
  });

  it("degrades unknown/blank values to undefined instead of throwing", () => {
    expect(normalizeEffort("banana")).toBeUndefined();
    expect(normalizeEffort("")).toBeUndefined();
    expect(normalizeEffort(undefined)).toBeUndefined();
    expect(normalizeEffort("  ")).toBeUndefined();
  });

  it("is case- and whitespace-tolerant, since it comes from a hand-edited json", () => {
    expect(normalizeEffort(" XHigh ")).toBe("xhigh");
  });
});
