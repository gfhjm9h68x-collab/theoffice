import { describe, it, expect } from "vitest";
import { decideGeminiOutcome } from "./gemini-runtime.js";

/**
 * Pure outcome-decision table for a finished gemini (`agy --print`) turn. Completion is keyed off a clean
 * exit (no structured event), so the contract is simpler than codex but the usage/budget rules match.
 */
describe("decideGeminiOutcome", () => {
  it("clean exit (code 0) -> delivered", () => {
    expect(decideGeminiOutcome({ code: 0, sawUsageLimit: false, attempts: 0 })).toBe("delivered");
  });

  it("a clean exit wins even if a usage string was seen mid-stream", () => {
    // exit 0 means the turn completed; a usage-looking line earlier is irrelevant
    expect(decideGeminiOutcome({ code: 0, sawUsageLimit: true, attempts: 3 })).toBe("delivered");
  });

  it("non-zero exit with usage cap -> backoff (no attempt burned)", () => {
    expect(decideGeminiOutcome({ code: 1, sawUsageLimit: true, attempts: 0 })).toBe("backoff");
  });

  it("usage cap OUTRANKS an exhausted budget -> still backoff", () => {
    expect(decideGeminiOutcome({ code: 1, sawUsageLimit: true, attempts: 99 })).toBe("backoff");
  });

  it("non-zero exit, no usage, budget remaining -> requeue", () => {
    expect(decideGeminiOutcome({ code: 1, sawUsageLimit: false, attempts: 0 })).toBe("requeue");
    expect(decideGeminiOutcome({ code: null, sawUsageLimit: false, attempts: 4, maxAttempts: 5 })).toBe("requeue");
  });

  it("non-zero exit, no usage, budget exhausted -> failed", () => {
    expect(decideGeminiOutcome({ code: 1, sawUsageLimit: false, attempts: 5, maxAttempts: 5 })).toBe("failed");
  });
});
