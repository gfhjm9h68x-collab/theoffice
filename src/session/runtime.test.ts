import { describe, it, expect } from "vitest";
import type { AgentDef } from "../types.js";
import {
  getRuntime,
  runtimeFor,
  isKnownRuntime,
  listRuntimes,
  DEFAULT_RUNTIME,
  type QueuedItem,
} from "./runtime.js";
import { frameForDelivery } from "./delivery.js";

const agent = (runtime?: string): AgentDef => ({
  id: "x",
  displayName: "X",
  dir: "/tmp/x",
  enabled: true,
  runtime,
});

describe("runtime registry", () => {
  it("ships claude + codex + gemini as registered providers", () => {
    const ids = listRuntimes().map((r) => r.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("gemini");
  });

  it("defaults unset/unknown runtimes to claude (safe revert semantics)", () => {
    expect(getRuntime(undefined).id).toBe(DEFAULT_RUNTIME);
    expect(getRuntime("nope").id).toBe(DEFAULT_RUNTIME);
    expect(DEFAULT_RUNTIME).toBe("claude");
  });

  it("resolves a known runtime by id", () => {
    expect(getRuntime("codex").id).toBe("codex");
    expect(runtimeFor(agent("codex")).id).toBe("codex");
    expect(runtimeFor(agent()).id).toBe("claude");
  });

  it("isKnownRuntime gates only registered ids", () => {
    expect(isKnownRuntime("claude")).toBe(true);
    expect(isKnownRuntime("codex")).toBe(true);
    expect(isKnownRuntime("gemini")).toBe(true);
    expect(isKnownRuntime("nonsense")).toBe(false);
    expect(isKnownRuntime(undefined)).toBe(false);
  });

  it("advertises claude --model ids and no per-launch model for codex", () => {
    expect(getRuntime("claude").models.length).toBeGreaterThan(0);
    expect(getRuntime("codex").models.length).toBe(0);
  });

  it("advertises the current claude models, aliases not dated snapshots", () => {
    const models = getRuntime("claude").models;
    expect(models).toContain("claude-opus-5");
    expect(models).toContain("claude-fable-5");
    expect(models).toContain("claude-sonnet-5");
    // opus 4.8 stays: live agents (home, zeus) still run on it
    expect(models).toContain("claude-opus-4-8");
    // the dated snapshot id must not come back — offer the alias
    expect(models).toContain("claude-haiku-4-5");
    expect(models).not.toContain("claude-haiku-4-5-20251001");
  });

  it("advertises gemini models as agy slugs, never human labels", () => {
    const models = getRuntime("gemini").models;
    expect(models.length).toBeGreaterThan(0);
    // this is the bug class that got in: "Gemini 3.1 Pro (High)" instead of gemini-3.1-pro-high
    for (const m of models) expect(m).toMatch(/^[a-z0-9.-]+$/);
    expect(models).toContain("gemini-3.6-flash-high");
    expect(models).toContain("gemini-3.1-pro-high");
  });

  it("claude readiness is decided live (isBusy always false), not via a tracked flag", () => {
    expect(getRuntime("claude").isBusy("x")).toBe(false);
  });
});

describe("frameForDelivery", () => {
  const item = (over: Partial<QueuedItem>): QueuedItem => ({
    id: 1,
    agent_id: "marveen",
    source: "channel",
    prompt: "hi",
    reply_channel: "C123",
    reply_user: "U0BA6GF2VTJ",
    attempts: 0,
    ...over,
  });

  it("frames a real owner channel message as from the owner", () => {
    expect(frameForDelivery(item({ prompt: "meds?" }))).toBe("[Slack message from the owner]\n\nmeds?");
  });

  it("frames a synthetic ocr-signal as a system signal, NOT the owner", () => {
    const t = frameForDelivery(item({ reply_user: "ocr-signal", prompt: "OCR-SIGNAL: run x" }));
    expect(t).toBe("[System signal, not from the owner]\n\nOCR-SIGNAL: run x");
    expect(t).not.toContain("[Slack message from the owner]"); // never mislabeled as owner
  });

  it("frames a synthetic bill-signal as a system signal too, NOT the owner", () => {
    const t = frameForDelivery(item({ reply_user: "bill-signal", prompt: "BILL-SIGNAL: submission x" }));
    expect(t).toBe("[System signal, not from the owner]\n\nBILL-SIGNAL: submission x");
    expect(t).not.toContain("[Slack message from the owner]");
  });

  it("frames a synthetic archive-signal as a system signal too, NOT the owner", () => {
    const t = frameForDelivery(item({ reply_user: "archive-signal", prompt: "POST-GENERATE: 2026/001" }));
    expect(t).toBe("[System signal, not from the owner]\n\nPOST-GENERATE: 2026/001");
    expect(t).not.toContain("[Slack message from the owner]");
  });

  it("passes non-channel items through unwrapped (bus/scheduler/manual)", () => {
    expect(frameForDelivery(item({ source: "bus", prompt: "peer msg" }))).toBe("peer msg");
    expect(frameForDelivery(item({ source: "scheduler", prompt: "heartbeat" }))).toBe("heartbeat");
  });

  it("owner framing is unaffected by a null reply_user", () => {
    expect(frameForDelivery(item({ reply_user: null, prompt: "yo" }))).toBe("[Slack message from the owner]\n\nyo");
  });
});
