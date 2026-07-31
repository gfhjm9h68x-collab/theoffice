import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Locks FIX2: session-freshness priming. The recalled-memory preamble must be injected on the FIRST
 * delivery to a genuinely NEW session and never again, and an existing/surviving session (engine restart,
 * newSession=false) must NOT be primed. The load-bearing invariant is the INVERSION: an agent the launcher
 * never flagged defaults to do-NOT-prime, so a refactor can't silently regress to the old engine-lifetime
 * bug (where every engine restart re-primed live sessions).
 *
 * `needsPrime` is module-private and the logic runs through launchClaude/deliverClaude (tmux + pane), so we
 * drive the real code via the public claudeRuntime interface with tmux/pane/IO mocked, and observe whether
 * the preamble reaches the pane (spying on the injected send-keys text). recallForPrompt is stubbed to a
 * sentinel so the assertion is purely about the prime GATE, not recall content.
 */

const h = vi.hoisted(() => ({
  sent: [] as string[],
  newSessionOk: true,
  sendTextOk: true,
  /** when set, decides per-call whether the burst lands (for the retry test) */
  sendTextFn: null as null | (() => boolean),
}));

vi.mock("./tmux.js", () => ({
  sessionNameFor: (id: string) => `agent-${id}`,
  newSession: () => h.newSessionOk, // controllable: true = fresh session created, false = already existed
  hasSession: () => true,
  capturePane: () => "PANE",
  sendText: (_socket: string, _name: string, text: string) => {
    h.sent.push(text);
    return h.sendTextFn ? h.sendTextFn() : h.sendTextOk; // real signature: false = tmux rejected it
  },
  sendKey: () => {},
  clearInput: () => {},
}));
vi.mock("./pane-state.js", () => ({
  detectPaneState: () => "idle", // always ready, so deliverClaude proceeds to injection
  decideSubmitFollowup: () => "done", // submit confirmed on the first check
  isInputBoxEmpty: () => true, // nothing parked; the draft-clear path is exercised elsewhere
}));
vi.mock("./profile.js", () => ({ writeAgentSettings: () => {} }));
vi.mock("./trust.js", () => ({ ensureClaudeGatesAccepted: () => {} }));
vi.mock("../queue/index.js", () => ({
  markDelivering: () => {},
  markDelivered: () => {},
  markFailed: () => {},
  requeue: () => {},
}));
vi.mock("../memory/conversation.js", () => ({ recordInbound: () => {} }));
vi.mock("../memory/recall.js", () => ({ recallForPrompt: () => "MEM_PREAMBLE_SENTINEL", PREAMBLE_MAX_CHARS: 6000 }));
vi.mock("../env.js", () => ({ readEnvFile: () => ({}) }));

import { claudeRuntime, deliverPrompt } from "./claude-runtime.js";

const cfg = {
  tmux: { socket: "test" },
  owner: { timezone: "UTC" },
  paths: { tenantRoot: "/tmp", agentsDir: "/tmp" },
  web: { port: 0 },
} as unknown as Parameters<typeof claudeRuntime.launch>[0];

const agent = (id: string) => ({ id, displayName: id, dir: "/tmp", enabled: true }) as never;
const item = (id: string, n: number) =>
  ({ id: n, agent_id: id, source: "manual", prompt: "hello there", reply_channel: null, attempts: 0 }) as never;

/** Text injected into the pane during the current delivery (chunks concatenated). */
const injected = () => h.sent.join("");

beforeEach(() => {
  h.sent.length = 0;
});

describe("FIX2 — priming keyed to session freshness, not engine lifetime", () => {
  it("a NEW session (newSession=true) is primed once, then the flag clears", async () => {
    h.newSessionOk = true;
    expect(claudeRuntime.launch(cfg, agent("fresh"))).toBe(true); // launcher flags it for prime

    h.sent.length = 0;
    await claudeRuntime.deliver(cfg, agent("fresh"), item("fresh", 1));
    expect(injected()).toContain("MEM_PREAMBLE_SENTINEL"); // primed on first delivery
    expect(injected()).toContain("hello there");

    h.sent.length = 0;
    await claudeRuntime.deliver(cfg, agent("fresh"), item("fresh", 2));
    expect(injected()).not.toContain("MEM_PREAMBLE_SENTINEL"); // flag cleared -> no re-prime
    expect(injected()).toContain("hello there");
  }, 15000);

  it("a surviving session (newSession=false, e.g. engine restart) is NOT primed", async () => {
    h.newSessionOk = false;
    expect(claudeRuntime.launch(cfg, agent("survivor"))).toBe(false); // not flagged

    h.sent.length = 0;
    await claudeRuntime.deliver(cfg, agent("survivor"), item("survivor", 3));
    expect(injected()).not.toContain("MEM_PREAMBLE_SENTINEL");
    expect(injected()).toContain("hello there");
  }, 15000);

  it("the inversion guard: an agent never flagged defaults to do-NOT-prime", async () => {
    // No launch() at all for this agent — exactly the engine-restart-with-live-session shape. The old bug
    // would prime here (default = prime); the fixed default (empty needsPrime) must NOT.
    h.sent.length = 0;
    await claudeRuntime.deliver(cfg, agent("unflagged"), item("unflagged", 4));
    expect(injected()).not.toContain("MEM_PREAMBLE_SENTINEL");
    expect(injected()).toContain("hello there");
  }, 15000);
});

/**
 * Locks the 2026-07-30 incident: a prompt is typed as a sequence of send-keys bursts, and one burst
 * was silently dropped mid-message. The two halves closed up, two open items vanished from a status
 * report, and nothing logged anything — the text that arrived looked entirely valid. A hole in a
 * delivered prompt is undetectable downstream, so the ONLY acceptable outcomes are "all of it landed"
 * or "the delivery failed". Never "most of it".
 */
describe("a burst tmux rejects must never leave a hole in the prompt", () => {
  const longPrompt = "A".repeat(200) + "TAIL_SENTINEL"; // >1 chunk, so there IS a seam to lose

  it("fails the delivery instead of submitting a partially typed prompt", async () => {
    h.sendTextOk = false; // tmux rejects every burst
    h.sent.length = 0;
    const res = await deliverPrompt("test", "agent-dropper", longPrompt);
    h.sendTextOk = true; // restore before the next test
    expect(res.ok).toBe(false); // reported as failed, so the queue can retry the whole message
  }, 15000);

  it("retries the rejected burst and still delivers the whole prompt", async () => {
    // Reject the first attempt only, then let everything through: the retry must close the gap, so
    // the pane still receives every chunk including the tail.
    let rejectionsLeft = 1;
    h.sendTextFn = () => rejectionsLeft-- <= 0;
    h.sent.length = 0;
    const res = await deliverPrompt("test", "agent-retrier", longPrompt);
    h.sendTextFn = null; // back to the plain h.sendTextOk path
    expect(res.ok).toBe(true);
    expect(h.sent.join("")).toContain("TAIL_SENTINEL"); // nothing lost despite the rejection
  }, 15000);
});
