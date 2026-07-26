import { describe, it, expect } from "vitest";
import { withPaneLock } from "./pane-lock.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const op = (events: string[], tag: string, ms: number) => async () => {
  events.push(`${tag}:start`);
  await sleep(ms);
  events.push(`${tag}:end`);
};

describe("withPaneLock", () => {
  it("serializes operations on the SAME session — a delivery and a tune never interleave", async () => {
    const events: string[] = [];
    // A is slow, B is fast; without the lock B would finish inside A's window (interleave).
    await Promise.all([withPaneLock("s1", op(events, "A", 40)), withPaneLock("s1", op(events, "B", 5))]);
    expect(events).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  it("runs DIFFERENT sessions concurrently (one agent's tune never stalls another's delivery)", async () => {
    const events: string[] = [];
    await Promise.all([withPaneLock("a", op(events, "A", 40)), withPaneLock("b", op(events, "B", 5))]);
    expect(events.indexOf("B:end")).toBeLessThan(events.indexOf("A:end")); // overlapped, B finished first
  });

  it("a rejecting op does not wedge the lock — the next op on that session still runs", async () => {
    await withPaneLock("s2", async () => {
      throw new Error("boom");
    }).catch(() => undefined);
    await expect(withPaneLock("s2", async () => "ok")).resolves.toBe("ok");
  });

  it("returns the op's real result and propagates its rejection to the caller", async () => {
    await expect(
      withPaneLock("s3", async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    await expect(withPaneLock("s3", async () => 42)).resolves.toBe(42);
  });
});
