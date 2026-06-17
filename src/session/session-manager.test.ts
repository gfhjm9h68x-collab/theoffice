import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression net for the deliverer reentrancy guard (P0#4). Toby proved it had no coverage — removing the
 * running-guard kept the suite green. This drives two overlapping ticks while a deliver() is still awaiting
 * and asserts the second tick is SKIPPED (no double-inject).
 */

const deliver = vi.fn();
const fakeRuntime = { isBusy: () => false, deliver };

vi.mock("./tmux.js", () => ({
  hasSession: () => true,
  sessionNameFor: (id: string) => `agent-${id}`,
}));
vi.mock("../queue/index.js", () => ({
  listQueued: () => [{ id: 1, agent_id: "a", source: "manual", prompt: "x", reply_channel: null, reply_user: null, attempts: 0 }],
}));
vi.mock("../agents.js", () => ({ loadAgents: () => [{ id: "a", dir: "/tmp/a", enabled: true }] }));
vi.mock("./runtime.js", () => ({ runtimeFor: () => fakeRuntime }));

const { startDeliverer } = await import("./session-manager.js");
const cfg = { tmux: { socket: "test" } } as never;

beforeEach(() => {
  vi.useFakeTimers();
  deliver.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("deliverer reentrancy guard", () => {
  it("skips a tick while the previous tick is still awaiting deliver() (no double-inject)", async () => {
    let release!: () => void;
    deliver.mockImplementation(() => new Promise<void>((r) => (release = r))); // deliver hangs until released

    const stop = startDeliverer(cfg);
    try {
      await vi.advanceTimersByTimeAsync(2000); // tick #1 fires -> deliver() called, now awaiting (running=true)
      expect(deliver).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2000); // tick #2 fires -> running guard -> SKIPPED
      expect(deliver).toHaveBeenCalledTimes(1); // still once, not twice

      release(); // tick #1 completes -> running=false
      await Promise.resolve();
      deliver.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(2000); // a later tick can run again
      expect(deliver.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      stop();
    }
  });
});
