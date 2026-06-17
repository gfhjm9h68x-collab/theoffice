import { describe, it, expect } from "vitest";
import { decideCodexOutcome } from "./codex-runtime.js";

/**
 * Pure outcome-decision table for a finished codex turn. Locks the (exit, completion, usage, attempts)
 * -> outcome contract so the watchdog/settled-latch refactor can't silently regress the queue semantics.
 */
describe("decideCodexOutcome", () => {
  it("clean exit WITH turn.completed -> delivered", () => {
    expect(decideCodexOutcome({ code: 0, sawCompleted: true, sawUsageLimit: false, attempts: 0 })).toBe("delivered");
  });

  it("clean exit but NO turn.completed -> not delivered (requeue)", () => {
    // exit 0 with no completion event is a truncated/partial turn — must retry, never count as delivered
    expect(decideCodexOutcome({ code: 0, sawCompleted: false, sawUsageLimit: false, attempts: 0 })).toBe("requeue");
  });

  it("usage cap -> backoff (no attempt burned), even on a clean-ish exit without completion", () => {
    expect(decideCodexOutcome({ code: 0, sawCompleted: false, sawUsageLimit: true, attempts: 0 })).toBe("backoff");
    expect(decideCodexOutcome({ code: 1, sawCompleted: false, sawUsageLimit: true, attempts: 2 })).toBe("backoff");
  });

  it("usage cap OUTRANKS an exhausted budget -> still backoff, never failed", () => {
    // a cap window must never mark a message failed even when attempts are maxed
    expect(decideCodexOutcome({ code: 1, sawCompleted: false, sawUsageLimit: true, attempts: 99 })).toBe("backoff");
  });

  it("genuine error with budget remaining -> requeue", () => {
    expect(decideCodexOutcome({ code: 1, sawCompleted: false, sawUsageLimit: false, attempts: 0 })).toBe("requeue");
    expect(decideCodexOutcome({ code: null, sawCompleted: false, sawUsageLimit: false, attempts: 4, maxAttempts: 5 })).toBe("requeue");
  });

  it("genuine error with budget exhausted -> failed", () => {
    expect(decideCodexOutcome({ code: 1, sawCompleted: false, sawUsageLimit: false, attempts: 5, maxAttempts: 5 })).toBe("failed");
    expect(decideCodexOutcome({ code: null, sawCompleted: false, sawUsageLimit: false, attempts: 7, maxAttempts: 5 })).toBe("failed");
  });

  it("completion flag without a clean exit code does NOT count as delivered", () => {
    // turn.completed seen but the process then crashed (non-zero) -> retry, do not mark delivered
    expect(decideCodexOutcome({ code: 1, sawCompleted: true, sawUsageLimit: false, attempts: 0 })).toBe("requeue");
  });
});
