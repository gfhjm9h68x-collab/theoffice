import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

/** Regression net for the gemini deliver()'s settled-latch + spawn-safety (mirror of the codex one). */

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}
let fakeChild: FakeChild;
let spawnThrows = false;
const spawnMock = vi.fn(() => {
  if (spawnThrows) throw new Error("ENOENT: agy not found");
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

const { deliverGeminiPrompt, isGeminiBusy } = await import("./gemini-runtime.js");

const cfg = { owner: { timezone: "UTC" }, paths: { tenantRoot: "/t" }, web: { port: 3430 } } as never;
let n = 0;
const freshAgent = () => ({ id: `gem-test-${++n}`, dir: "/tmp/does-not-exist" }) as never;
const itemFor = (agentId: string, attempts = 0) =>
  ({ id: 200 + n, agent_id: agentId, source: "manual", prompt: "hi", reply_channel: null, attempts }) as never;

const terminalCount = () =>
  q.markDelivered.mock.calls.length + q.markFailed.mock.calls.length + q.requeue.mock.calls.length + q.requeueNoPenalty.mock.calls.length;

beforeEach(() => {
  spawnThrows = false;
  for (const f of Object.values(q)) (f as { mockClear?: () => void }).mockClear?.();
  spawnMock.mockClear();
});

describe("gemini deliver settled-latch", () => {
  it("'error' THEN 'close' books exactly ONE terminal outcome", () => {
    const agent = freshAgent();
    deliverGeminiPrompt(cfg, agent, itemFor((agent as { id: string }).id));
    fakeChild.emit("error", new Error("boom"));
    fakeChild.emit("close", 1);
    expect(terminalCount()).toBe(1);
    expect(isGeminiBusy((agent as { id: string }).id)).toBe(false);
  });

  it("a clean exit (close 0) books exactly one delivered", () => {
    const agent = freshAgent();
    deliverGeminiPrompt(cfg, agent, itemFor((agent as { id: string }).id));
    fakeChild.emit("close", 0);
    expect(q.markDelivered).toHaveBeenCalledTimes(1);
    expect(terminalCount()).toBe(1);
  });
});

describe("gemini deliver spawn-safety", () => {
  it("a synchronous spawn throw does NOT wedge the agent busy and requeues once", () => {
    const agent = freshAgent();
    spawnThrows = true;
    deliverGeminiPrompt(cfg, agent, itemFor((agent as { id: string }).id, 0));
    expect(isGeminiBusy((agent as { id: string }).id)).toBe(false);
    expect(q.requeue).toHaveBeenCalledTimes(1);
    expect(q.markDelivered).not.toHaveBeenCalled();
  });
});
