import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Locks the follow-up to the 2026-07-31 wedge. The delivery path "cleared" a stray draft with a
 * single C-u, which kills only the line the cursor sits on. Every delivery attempt that aborted
 * mid-prompt therefore left all but the last line of a half-typed prompt parked in the input box,
 * and the next attempt typed on top of it: two hours of failed deliveries silently composted into
 * one unusable draft, with nothing logged and nothing to see from outside.
 *
 * Two invariants:
 *   1. clearing keeps going until the box is EMPTY (multi-line drafts need one pass per line), and
 *   2. a draft that refuses to clear FAILS the delivery — nothing may be typed on top of leftovers.
 *
 * pane-state is deliberately NOT mocked: the pane fixtures are real capture-pane shapes, so a
 * regression in the emptiness predicate turns this red too.
 */

const SEP = "─".repeat(40);
const FOOTER = "  bypass permissions on (shift+tab to cycle)";
const pane = (...lines: string[]) => lines.join("\n");
const EMPTY_BOX = pane("assistant reply", SEP, "❯ ", SEP, FOOTER);
/** A three-line draft, exactly the memory-preamble shape that wedged the fleet. */
const draftBox = (lines: string[]) => pane("assistant reply", SEP, `❯ ${lines[0]}`, ...lines.slice(1), SEP, FOOTER);

const h = vi.hoisted(() => ({
  keys: [] as string[],
  sent: [] as string[],
  /** remaining draft lines; a C-u+BSpace pass drops one, mimicking the real TUI */
  draft: [] as string[],
  /** when true, C-u does nothing at all (draft cannot be cleared) */
  stuck: false,
}));

vi.mock("./tmux.js", () => ({
  sessionNameFor: (id: string) => `agent-${id}`,
  newSession: () => false,
  hasSession: () => true,
  capturePane: () => (h.draft.length ? draftBox(h.draft) : EMPTY_BOX),
  sendText: (_s: string, _n: string, text: string) => {
    h.sent.push(text);
    return true;
  },
  sendKey: (_s: string, _n: string, key: string) => {
    h.keys.push(key);
    if (key === "BSpace" && !h.stuck) h.draft.pop(); // the C-u/BSpace pair eats one line
  },
  clearInput: (_s: string, _n: string) => {
    h.keys.push("C-u");
  },
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
vi.mock("../memory/recall.js", () => ({ recallForPrompt: () => "", PREAMBLE_MAX_CHARS: 6000 }));
vi.mock("../env.js", () => ({ readEnvFile: () => ({}) }));

const { deliverPrompt } = await import("./claude-runtime.js");

beforeEach(() => {
  h.keys.length = 0;
  h.sent.length = 0;
  h.draft.length = 0;
  h.stuck = false;
});

describe("a parked draft is cleared to empty, not one line deep", () => {
  it("clears every line of a multi-line draft before typing", async () => {
    h.draft = ["- (hot) first bullet", "  continuation line", "  another line"];
    const res = await deliverPrompt("test", "agent-drafty", "the real prompt");
    expect(res.ok).toBe(true);
    // one C-u per draft line, not the single pass the old code did
    expect(h.keys.filter((k) => k === "C-u").length).toBeGreaterThanOrEqual(3);
    expect(h.sent.join("")).toBe("the real prompt");
  }, 15000);

  it("fails the delivery when the draft will not clear, typing nothing", async () => {
    h.draft = ["- (hot) wedged bullet", "  and its tail"];
    h.stuck = true; // C-u no longer empties anything
    const res = await deliverPrompt("test", "agent-wedged", "the real prompt");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("not-ready");
    expect(h.sent).toEqual([]); // never type on top of leftovers
    expect(h.keys).not.toContain("Enter"); // and never submit the mess
  }, 20000);
});
