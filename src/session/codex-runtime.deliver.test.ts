import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/**
 * Regression net for the codex deliver()'s STATEFUL guards (Toby proved these had no coverage — he could
 * delete the settled-latch / spawn-safety and the suite stayed green). These drive the real deliver fn with
 * a faked child process + spied queue, so removing a guard turns a test red.
 */

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}
let fakeChild: FakeChild;
let spawnThrows = false;
const spawnMock = vi.fn(() => {
  if (spawnThrows) throw new Error("ENOENT: codex not found");
  fakeChild = new FakeChild();
  return fakeChild;
});

vi.mock("node:child_process", () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));
const q = {
  markDelivering: vi.fn(),
  markDelivered: vi.fn(),
  markFailed: vi.fn(),
  requeue: vi.fn(),
  requeueNoPenalty: vi.fn(),
  MAX_DELIVERY_ATTEMPTS: 5,
};
vi.mock("../queue/index.js", () => q);
vi.mock("../memory/conversation.js", () => ({ recordInbound: vi.fn() }));
vi.mock("../env.js", () => ({ readEnvFile: () => ({}) }));

const { deliverCodexPrompt, isCodexBusy } = await import("./codex-runtime.js");

const cfg = { owner: { timezone: "UTC" }, paths: { tenantRoot: "/t" }, web: { port: 3430 } } as never;
let n = 0;
const freshAgent = () => ({ id: `codex-test-${++n}`, dir: "/tmp/does-not-exist" }) as never;
const itemFor = (agentId: string, attempts = 0) =>
  ({ id: 100 + n, agent_id: agentId, source: "manual", prompt: "hi", reply_channel: null, attempts }) as never;

const terminalCount = () =>
  q.markDelivered.mock.calls.length + q.markFailed.mock.calls.length + q.requeue.mock.calls.length + q.requeueNoPenalty.mock.calls.length;

beforeEach(() => {
  spawnThrows = false;
  for (const f of Object.values(q)) (f as { mockClear?: () => void }).mockClear?.();
  spawnMock.mockClear();
});

describe("codex deliver settled-latch", () => {
  it("'error' THEN 'close' (the common codex failure sequence) books exactly ONE terminal outcome", () => {
    const agent = freshAgent();
    deliverCodexPrompt(cfg, agent, itemFor((agent as { id: string }).id));
    // codex commonly emits 'error' immediately followed by 'close' — without the settled latch this books twice
    fakeChild.emit("error", new Error("boom"));
    fakeChild.emit("close", 1);
    expect(terminalCount()).toBe(1);
    expect(isCodexBusy((agent as { id: string }).id)).toBe(false); // inFlight released
  });

  it("a clean turn (close 0 + turn.completed) books exactly one delivered", () => {
    const agent = freshAgent();
    deliverCodexPrompt(cfg, agent, itemFor((agent as { id: string }).id));
    fakeChild.stdout.emit("data", Buffer.from(JSON.stringify({ type: "turn.completed" }) + "\n"));
    fakeChild.emit("close", 0);
    expect(q.markDelivered).toHaveBeenCalledTimes(1);
    expect(terminalCount()).toBe(1);
  });
});

describe("codex deliver spawn-safety", () => {
  it("a synchronous spawn throw does NOT wedge the agent busy and requeues once", () => {
    const agent = freshAgent();
    spawnThrows = true;
    deliverCodexPrompt(cfg, agent, itemFor((agent as { id: string }).id, 0));
    expect(isCodexBusy((agent as { id: string }).id)).toBe(false); // inFlight never held -> not stuck busy
    expect(q.requeue).toHaveBeenCalledTimes(1);
    expect(q.markDelivered).not.toHaveBeenCalled();
  });
});
