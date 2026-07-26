# Per-agent effort & model switching — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set effort and model per agent from Mission Control and Slack, so the setting survives a restart and changing it does not destroy the agent's running conversation.

**Architecture:** `agent.json` is the durable source of truth; the engine passes `--model` / `--effort` at launch, which provably override the shared `~/.claude/settings.json`. A change is written to `agent.json` first, then injected into the live tmux pane as a `/model` or `/effort` command and confirmed by reading the pane's acknowledgement back. Slack goes through a new `office-tune` helper the agent calls itself, mirroring `office-say`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node, vitest, tmux, plain-JS dashboard (`web-ui/mc/app.js`), bash helper scripts.

**Spec:** `docs/superpowers/specs/2026-07-26-effort-model-switch-design.md`

## Global Constraints

- Claude runtime only. Codex and Gemini get no effort support; the Gemini change in Task 1 is a data fix.
- Import specifiers end in `.js` even for `.ts` sources (ESM/NodeNext) — match the surrounding files.
- Never introduce a per-agent `HOME`: `~/.claude/.credentials.json` lives there and it would force a per-agent login.
- An unknown persisted value must degrade to "unset", never throw — same posture as the existing `runtime` normalisation (`agents.ts:60`).
- Valid effort levels, exactly: `low`, `medium`, `high`, `xhigh`, `max`. `ultracode` and `auto` are accepted by the CLI but deliberately NOT offered.
- Never `killSession` on a model or effort change — that is the context loss this work removes.
- Tests run with `npx vitest run <path>`; typecheck with `npm run typecheck`.
- Commit messages follow the repo's conventional style, e.g. `feat(session): ...`, `fix(web): ...`, `test(session): ...`.
- Do NOT edit anything under `tenant/` — that is the owner's live data (Argus's stale Gemini label is explicitly out of scope).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/session/effort.ts` | **new** — the effort vocabulary and `normalizeEffort`. One tiny module so both `agents.ts` and the runtimes depend on the same list. |
| `src/session/effort.test.ts` | **new** — validation tests. |
| `src/session/tune.ts` | **new** — live switching: wait for idle, inject `/model` or `/effort`, read the acknowledgement back. The only place that knows the CLI's reply wording. |
| `src/session/tune.test.ts` | **new** — tune tests against a mocked pane. |
| `src/session/claude-settings.ts` | **new** — canonical write-back of `~/.claude/settings.json` after an injection, serialized by a promise chain. |
| `src/session/claude-settings.test.ts` | **new** |
| `src/types.ts` | `AgentDef.effort?` |
| `src/agents.ts` | read + normalize `effort` from `agent.json` |
| `src/session/runtime.ts` | `Runtime.efforts` + expose it from `listRuntimes()` |
| `src/session/claude-runtime.ts` | `--effort` at launch; declare `efforts` and the refreshed `models` |
| `src/session/gemini-runtime.ts` | corrected model slugs |
| `src/session/codex-runtime.ts` | `efforts: []` |
| `src/web/server.ts` | `effort` action; `model` action switched to the live path; `office-tune`'s endpoint |
| `web-ui/mc/app.js` | effort dropdown + refreshed model labels |
| `scripts/office-tune.sh` | **new** — the agent-facing helper |
| `scripts/install.sh` | install `office-tune` alongside `office-say` |
| `templates/product/agent.CLAUDE.md` | teach agents when to call `office-tune` |

---

### Task 1: Model registry refresh

**Files:**
- Modify: `src/session/claude-runtime.ts:193`
- Modify: `src/session/gemini-runtime.ts:205-217`
- Modify: `web-ui/mc/app.js:280`
- Test: `src/session/runtime.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the refreshed `models` arrays consumed by `/api/runtimes` and the dashboard.

- [ ] **Step 1: Write the failing tests**

Append to `src/session/runtime.test.ts`, inside the existing `describe("runtime registry", ...)`:

```typescript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/session/runtime.test.ts`
Expected: FAIL — claude list has no `claude-opus-5`; gemini entries contain spaces and capitals.

- [ ] **Step 3: Update the Claude list**

`src/session/claude-runtime.ts:193` — replace the `models:` line:

```typescript
  // Selectable --model ids, verified live against this account's /model menu (2026-07-26).
  // Opus 4.8 is no longer listed in that menu but stays here: `home` and `zeus` run on it and the
  // menu itself notes that previous model names remain usable via --model, which is how we launch.
  models: [
    "claude-opus-5",
    "claude-fable-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-haiku-4-5",
  ],
```

- [ ] **Step 4: Update the Gemini list**

`src/session/gemini-runtime.ts` — replace the `models:` array and its comment:

```typescript
  // Selectable `--model` values, exactly as `agy models` advertises them (verified live 2026-07-26).
  // These are SLUGS. An earlier revision carried human labels ("Gemini 3.1 Pro (High)"), which `agy`
  // does not recognise — it silently falls back to the account default, so the setting looked applied
  // but was not. The runtime.test.ts slug guard exists to stop that regressing.
  models: [
    "gemini-3.6-flash-high",
    "gemini-3.6-flash-medium",
    "gemini-3.6-flash-low",
    "gemini-3.5-flash-high",
    "gemini-3.5-flash-medium",
    "gemini-3.5-flash-low",
    "gemini-3.1-pro-high",
    "gemini-3.1-pro-low",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    "gpt-oss-120b-medium",
  ],
```

- [ ] **Step 5: Refresh the dashboard labels**

`web-ui/mc/app.js:280` — replace the `MODEL_LABEL` line:

```javascript
const MODEL_LABEL = { default: "default", "claude-opus-5": "Opus 5", "claude-fable-5": "Fable 5", "claude-sonnet-5": "Sonnet 5", "claude-opus-4-8": "Opus 4.8", "claude-haiku-4-5": "Haiku 4.5" };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/session/runtime.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/session/claude-runtime.ts src/session/gemini-runtime.ts src/session/runtime.test.ts web-ui/mc/app.js
git commit -m "fix(runtime): refresh model registries — add Opus 5/Fable 5/Sonnet 5, fix gemini label-vs-slug bug"
```

---

### Task 2: `effort` on AgentDef

**Files:**
- Create: `src/session/effort.ts`
- Create: `src/session/effort.test.ts`
- Modify: `src/types.ts` (after the `model?: string;` line)
- Modify: `src/agents.ts` (the object literal built in `loadAgents`)

**Interfaces:**
- Consumes: nothing.
- Produces: `EFFORT_LEVELS: readonly string[]`, `normalizeEffort(v: string | undefined): string | undefined`, and `AgentDef.effort?: string`. Tasks 3, 4 and 7 all depend on these exact names.

- [ ] **Step 1: Write the failing test**

Create `src/session/effort.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/session/effort.test.ts`
Expected: FAIL — cannot resolve `./effort.js`.

- [ ] **Step 3: Create the module**

Create `src/session/effort.ts`:

```typescript
/**
 * Claude Code effort levels — how hard the model thinks before answering.
 *
 * Verified live against `claude` 2.1.220: `/effort banana` replies
 * "Invalid argument: banana. Valid options are: low, medium, high, xhigh, max, ultracode, auto".
 * We deliberately offer only the five pinnable levels: `auto` defeats the point of pinning a value
 * per agent, and `ultracode` is a separate feature, not an effort tier.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Normalize a persisted/user-supplied effort value. Unknown or blank input resolves to undefined
 * ("no effort pinned"), never an error — agent.json is hand-editable, and a typo must not stop an
 * agent from launching. Mirrors how `runtime` is normalized in agents.ts.
 */
export function normalizeEffort(v: string | undefined): EffortLevel | undefined {
  const s = v?.trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(s ?? "") ? (s as EffortLevel) : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/session/effort.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the field to AgentDef**

`src/types.ts` — insert directly after the `model?: string;` line:

```typescript
  /**
   * Claude "thinking effort" for this agent (low | medium | high | xhigh | max), passed as --effort at
   * launch. Claude runtime only; ignored by codex/gemini. Unset = whatever the CLI defaults to.
   * An unknown value normalizes away to unset (see session/effort.ts) so a typo can't block a launch.
   */
  effort?: string;
```

- [ ] **Step 6: Read it in loadAgents**

`src/agents.ts` — in the `out.push({...})` literal, add directly after the `model: meta.model,` line:

```typescript
      // normalize like `runtime`: an unknown effort resolves to unset rather than reaching the CLI
      effort: normalizeEffort(meta.effort),
```

Add the import next to the existing runtime import at the top of the file:

```typescript
import { normalizeEffort } from "./session/effort.js";
```

Extend the `AgentMeta` interface in the same file with `effort?: string;` (find it with `grep -n "interface AgentMeta" src/agents.ts`).

- [ ] **Step 7: Verify the wiring compiles and nothing regressed**

Run: `npm run typecheck && npx vitest run`
Expected: PASS, no new failures.

- [ ] **Step 8: Commit**

```bash
git add src/session/effort.ts src/session/effort.test.ts src/types.ts src/agents.ts
git commit -m "feat(agents): per-agent effort field, normalized like runtime"
```

---

### Task 3: Pass `--effort` at launch

This is the whole restart-survival story: the flag beats the shared `~/.claude/settings.json`.

**Files:**
- Modify: `src/session/claude-runtime.ts` (`launchClaude`, around line 114)
- Test: `src/session/claude-runtime.effort.test.ts` (new)

**Interfaces:**
- Consumes: `AgentDef.effort` (Task 2).
- Produces: nothing new; behavioural change only.

- [ ] **Step 1: Write the failing test**

Create `src/session/claude-runtime.effort.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The launch flags are what make a pinned model/effort survive a restart: verified live that
 * `--effort max` wins over an `effortLevel: high` in the shared ~/.claude/settings.json. This test
 * locks in that the flags are actually built from agent.json.
 */
const h = vi.hoisted(() => ({ command: [] as string[] }));

vi.mock("./tmux.js", () => ({
  sessionNameFor: (id: string) => `agent-${id}`,
  newSession: (_s: string, _n: string, opts: { command: string[] }) => {
    h.command = opts.command;
    return true;
  },
  hasSession: () => true,
  capturePane: () => "PANE",
  sendText: () => {},
  sendKey: () => {},
  clearInput: () => {},
}));
vi.mock("./pane-state.js", () => ({ detectPaneState: () => "idle", decideSubmitFollowup: () => "done" }));
vi.mock("./profile.js", () => ({ writeAgentSettings: () => {} }));
vi.mock("./trust.js", () => ({ ensureFolderTrusted: () => {} }));
vi.mock("../env.js", () => ({ readEnvFile: () => ({}) }));

import { claudeRuntime } from "./claude-runtime.js";
import type { AgentDef, EngineConfig } from "../types.js";

const cfg = {
  tmux: { socket: "s" },
  owner: { timezone: "Europe/Budapest" },
  paths: { tenantRoot: "/t", agentsDir: "/t/agents" },
  web: { port: 3430 },
} as unknown as EngineConfig;

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "x", displayName: "X", dir: "/tmp/x", enabled: true, ...over,
});

describe("launchClaude flags", () => {
  beforeEach(() => { h.command = []; });

  it("passes --effort when the agent pins one", () => {
    claudeRuntime.launch(cfg, agent({ effort: "xhigh" }));
    expect(h.command).toContain("--effort");
    expect(h.command[h.command.indexOf("--effort") + 1]).toBe("xhigh");
  });

  it("omits --effort entirely when unset, so the CLI default applies", () => {
    claudeRuntime.launch(cfg, agent());
    expect(h.command).not.toContain("--effort");
  });

  it("still passes --model, and both flags coexist", () => {
    claudeRuntime.launch(cfg, agent({ model: "claude-opus-5", effort: "max" }));
    expect(h.command[h.command.indexOf("--model") + 1]).toBe("claude-opus-5");
    expect(h.command[h.command.indexOf("--effort") + 1]).toBe("max");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/session/claude-runtime.effort.test.ts`
Expected: FAIL — `expected [ 'claude', '--dangerously-skip-permissions' ] to contain '--effort'`.

- [ ] **Step 3: Add the flag**

`src/session/claude-runtime.ts` — directly after the existing `if (agent.model) command.push("--model", agent.model);`:

```typescript
  // Effort is pinned the same way as the model. Both flags override whatever is in the SHARED
  // ~/.claude/settings.json (all agents run on one HOME), which is exactly why a pinned value
  // survives restarts and can't be knocked over by another agent's switch.
  if (agent.effort) command.push("--effort", agent.effort);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/session/claude-runtime.effort.test.ts && npx vitest run src/session/claude-runtime.test.ts`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/session/claude-runtime.ts src/session/claude-runtime.effort.test.ts
git commit -m "feat(session): launch claude agents with --effort from agent.json"
```

---

### Task 4: Advertise selectable efforts through the runtime registry

**Files:**
- Modify: `src/session/runtime.ts` (`Runtime` interface + `listRuntimes`)
- Modify: `src/session/claude-runtime.ts`, `src/session/codex-runtime.ts`, `src/session/gemini-runtime.ts`
- Test: `src/session/runtime.test.ts`

**Interfaces:**
- Consumes: `EFFORT_LEVELS` (Task 2).
- Produces: `Runtime.efforts: readonly string[]`, surfaced by `listRuntimes()` as `{ id, label, models, efforts }` — consumed by the dashboard in Task 8.

- [ ] **Step 1: Write the failing test**

Append inside `describe("runtime registry", ...)` in `src/session/runtime.test.ts`:

```typescript
  it("advertises effort levels for claude only", () => {
    expect([...getRuntime("claude").efforts]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // non-claude providers have no equivalent knob; the UI hides the control when the list is empty
    expect(getRuntime("codex").efforts.length).toBe(0);
    expect(getRuntime("gemini").efforts.length).toBe(0);
  });

  it("exposes efforts through listRuntimes for the dashboard", () => {
    const claude = listRuntimes().find((r) => r.id === "claude")!;
    expect(claude.efforts).toContain("xhigh");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/session/runtime.test.ts`
Expected: FAIL — `efforts` is not a property of `Runtime`.

- [ ] **Step 3: Extend the interface**

`src/session/runtime.ts` — directly after the `readonly models` declaration inside `interface Runtime`:

```typescript
  /**
   * Selectable "thinking effort" levels for this provider (UI hint only; empty = the provider has no
   * such knob and the dashboard hides the control). Claude exposes five; codex and gemini none.
   */
  readonly efforts: readonly string[];
```

And in `listRuntimes`, include it:

```typescript
export function listRuntimes(): { id: string; label: string; models: readonly string[]; efforts: readonly string[] }[] {
  return [...registry.values()].map((r) => ({ id: r.id, label: r.label, models: r.models, efforts: r.efforts }));
}
```

- [ ] **Step 4: Declare it on each runtime**

`src/session/claude-runtime.ts`, in the `claudeRuntime` object right after `models`:

```typescript
  efforts: EFFORT_LEVELS,
```

with the import at the top of the file:

```typescript
import { EFFORT_LEVELS } from "./effort.js";
```

`src/session/codex-runtime.ts` after its `models: []`:

```typescript
  efforts: [],
```

`src/session/gemini-runtime.ts` after its `models: [...]`:

```typescript
  efforts: [],
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/session/runtime.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/session/runtime.ts src/session/claude-runtime.ts src/session/codex-runtime.ts src/session/gemini-runtime.ts src/session/runtime.test.ts
git commit -m "feat(runtime): advertise selectable effort levels per provider"
```

---

### Task 5: Live switching with acknowledgement read-back

The core of the "no context loss" promise. Injection is cheap; **believing** it worked is the hard part — a command sent while the pane is still busy is silently swallowed, observed live.

**Files:**
- Create: `src/session/tune.ts`
- Create: `src/session/tune.test.ts`

**Interfaces:**
- Consumes: `capturePane`, `sendText`, `sendKey`, `hasSession` from `./tmux.js`; `detectPaneState` from `./pane-state.js`.
- Produces:
  - `type TuneKind = "model" | "effort"`
  - `interface TuneResult { ok: boolean; reason?: "no-session" | "not-ready" | "rejected" | "no-ack"; message?: string }`
  - `applyTune(socket: string, session: string, kind: TuneKind, value: string): Promise<TuneResult>`

  Task 7 calls `applyTune` and maps its result onto HTTP responses.

- [ ] **Step 1: Write the failing tests**

Create `src/session/tune.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Live switching must be believed only when the pane says so. Observed on claude 2.1.220: a command
 * sent while the pane is still processing the previous one is swallowed with no output and no error,
 * so fire-and-forget would report a success that never happened.
 */
const h = vi.hoisted(() => ({
  frames: [] as string[],   // successive capture-pane results
  sent: [] as string[],
  keys: [] as string[],
  hasSession: true,
  state: "idle" as string,
}));

vi.mock("./tmux.js", () => ({
  hasSession: () => h.hasSession,
  capturePane: () => (h.frames.length > 1 ? h.frames.shift()! : h.frames[0] ?? ""),
  sendText: (_s: string, _n: string, t: string) => { h.sent.push(t); },
  sendKey: (_s: string, _n: string, k: string) => { h.keys.push(k); },
  clearInput: () => {},
}));
vi.mock("./pane-state.js", () => ({ detectPaneState: () => h.state }));

import { applyTune } from "./tune.js";

beforeEach(() => {
  h.frames = [""]; h.sent = []; h.keys = []; h.hasSession = true; h.state = "idle";
});

describe("applyTune", () => {
  it("injects the slash command and reports success on the CLI's acknowledgement", async () => {
    h.frames = ["", "  ⎿  Set effort level to xhigh (saved as your default for new sessions)"];
    const r = await applyTune("s", "agent-x", "effort", "xhigh");
    expect(r.ok).toBe(true);
    expect(h.sent).toContain("/effort xhigh");
    expect(h.keys).toContain("Enter");
  });

  it("reports success for a model switch too", async () => {
    h.frames = ["", "  ⎿  Set model to Sonnet 5 and saved as your default for new sessions"];
    const r = await applyTune("s", "agent-x", "model", "claude-sonnet-5");
    expect(r.ok).toBe(true);
    expect(h.sent).toContain("/model claude-sonnet-5");
  });

  it("surfaces an invalid effort verbatim instead of claiming success", async () => {
    h.frames = ["", "  ⎿  Invalid argument: banana. Valid options are: low, medium, high, xhigh, max, ultracode, auto"];
    const r = await applyTune("s", "agent-x", "effort", "banana");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("rejected");
    expect(r.message).toContain("Invalid argument: banana");
  });

  it("surfaces an unknown model verbatim", async () => {
    h.frames = ["", "  ⎿  Model 'nope' not found"];
    const r = await applyTune("s", "agent-x", "model", "nope");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("rejected");
    expect(r.message).toContain("not found");
  });

  it("reports no-ack rather than success when the command is swallowed", async () => {
    h.frames = [""]; // pane never changes — the swallowed-command case
    const r = await applyTune("s", "agent-x", "effort", "high");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no-ack");
  });

  it("refuses to inject into a busy pane instead of interleaving with the running turn", async () => {
    h.state = "busy";
    const r = await applyTune("s", "agent-x", "effort", "high");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not-ready");
    expect(h.sent).toHaveLength(0);
  });

  it("reports no-session when the agent is not running", async () => {
    h.hasSession = false;
    const r = await applyTune("s", "agent-x", "effort", "high");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no-session");
    expect(h.sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/session/tune.test.ts`
Expected: FAIL — cannot resolve `./tune.js`.

- [ ] **Step 3: Implement the module**

Create `src/session/tune.ts`:

```typescript
import { hasSession, capturePane, sendText, sendKey } from "./tmux.js";
import { detectPaneState } from "./pane-state.js";
import { log } from "../logger.js";

const logger = log("tune");

/** How long to wait for the pane to go idle before giving up on injecting. */
const READY_WAIT_MS = 120_000;
const READY_POLL_MS = 1_000;
/** How long to wait for the CLI to acknowledge the command. */
const ACK_WAIT_MS = 8_000;
const ACK_POLL_MS = 400;

export type TuneKind = "model" | "effort";

export interface TuneResult {
  ok: boolean;
  reason?: "no-session" | "not-ready" | "rejected" | "no-ack";
  /** The pane's own wording, for surfacing to the owner unchanged. */
  message?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Acknowledgement wording, verified live against claude 2.1.220. */
const ACK_OK = [/Set effort level to /i, /Set model to /i];
const ACK_BAD = [/Invalid argument: /i, /Model '.*' not found/i];

function matchAck(pane: string): { ok: boolean; message: string } | null {
  for (const re of ACK_BAD) {
    const line = pane.split("\n").reverse().find((l) => re.test(l));
    if (line) return { ok: false, message: line.replace(/^\s*⎿\s*/, "").trim() };
  }
  for (const re of ACK_OK) {
    const line = pane.split("\n").reverse().find((l) => re.test(l));
    if (line) return { ok: true, message: line.replace(/^\s*⎿\s*/, "").trim() };
  }
  return null;
}

/**
 * Switch a live agent's model or effort WITHOUT killing its tmux session, so it keeps its context.
 *
 * Waits for the pane to go idle first (the owner's choice: finish the current turn, then switch),
 * injects `/model <v>` or `/effort <v>`, then READS THE ACKNOWLEDGEMENT BACK. The read-back is not
 * optional: a command sent while the pane is still busy is swallowed silently, so without it we would
 * report a success that never happened.
 *
 * The caller is expected to have already persisted the value to agent.json — a `no-ack` here is
 * therefore "not applied to the running session, but correct at next launch", not data loss.
 */
export async function applyTune(
  socket: string,
  session: string,
  kind: TuneKind,
  value: string,
): Promise<TuneResult> {
  if (!hasSession(socket, session)) return { ok: false, reason: "no-session" };

  // wait for the current turn to finish rather than interleaving with it
  const deadline = Date.now() + READY_WAIT_MS;
  for (;;) {
    const pane = capturePane(socket, session);
    if (pane != null && detectPaneState(pane) === "idle") break;
    if (Date.now() >= deadline) return { ok: false, reason: "not-ready" };
    await sleep(READY_POLL_MS);
  }

  const before = capturePane(socket, session) ?? "";
  sendText(socket, session, `/${kind} ${value}`);
  await sleep(500);
  sendKey(socket, session, "Enter");

  const ackDeadline = Date.now() + ACK_WAIT_MS;
  for (;;) {
    await sleep(ACK_POLL_MS);
    const pane = capturePane(socket, session) ?? "";
    if (pane !== before) {
      const ack = matchAck(pane);
      if (ack) {
        logger.info({ session, kind, value, ok: ack.ok }, "tune acknowledged");
        return ack.ok ? { ok: true, message: ack.message } : { ok: false, reason: "rejected", message: ack.message };
      }
    }
    if (Date.now() >= ackDeadline) {
      logger.warn({ session, kind, value }, "tune not acknowledged — swallowed?");
      return { ok: false, reason: "no-ack" };
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/session/tune.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/session/tune.ts src/session/tune.test.ts
git commit -m "feat(session): live model/effort switching with pane acknowledgement read-back"
```

---

### Task 6: Restore the owner's canonical Claude settings after an injection

`/model` and `/effort` also write themselves into the SHARED `~/.claude/settings.json` as a default. Agents are immune (launch flags win, Task 3), but the owner's own interactive CLI would drift.

**Files:**
- Create: `src/session/claude-settings.ts`
- Create: `src/session/claude-settings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `restoreOwnerSettings(canonical: { model?: string; effortLevel?: string }): Promise<void>` — called by Task 7 after a successful tune.

- [ ] **Step 1: Write the failing test**

Create `src/session/claude-settings.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let home = "";
const settingsPath = () => join(home, ".claude", "settings.json");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "office-settings-"));
  mkdirSync(join(home, ".claude"));
  process.env.HOME = home;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("restoreOwnerSettings", () => {
  it("puts back the canonical effort the injection overwrote, leaving other keys alone", async () => {
    const { restoreOwnerSettings } = await import("./claude-settings.js");
    writeFileSync(settingsPath(), JSON.stringify({ theme: "dark", effortLevel: "xhigh", model: "claude-sonnet-5" }));
    await restoreOwnerSettings({ effortLevel: "high" });
    const after = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(after.effortLevel).toBe("high");
    expect(after.theme).toBe("dark");   // untouched
    expect(after.model).toBeUndefined(); // canonical has no model -> key removed
  });

  it("is a no-op when there is no settings file, instead of creating one", async () => {
    const { restoreOwnerSettings } = await import("./claude-settings.js");
    rmSync(settingsPath(), { force: true });
    await restoreOwnerSettings({ effortLevel: "high" });
    expect(() => readFileSync(settingsPath(), "utf8")).toThrow();
  });

  it("serializes concurrent restores so two agents switching at once can't interleave writes", async () => {
    const { restoreOwnerSettings } = await import("./claude-settings.js");
    writeFileSync(settingsPath(), JSON.stringify({ effortLevel: "xhigh" }));
    await Promise.all([
      restoreOwnerSettings({ effortLevel: "high" }),
      restoreOwnerSettings({ effortLevel: "high" }),
      restoreOwnerSettings({ effortLevel: "high" }),
    ]);
    const after = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(after.effortLevel).toBe("high");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/session/claude-settings.test.ts`
Expected: FAIL — cannot resolve `./claude-settings.js`.

- [ ] **Step 3: Implement the module**

Create `src/session/claude-settings.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";

const logger = log("claude-settings");

/**
 * `/model` and `/effort` do not only affect the running session — they also save themselves as the
 * default in ~/.claude/settings.json. Every agent AND the owner's own interactive CLI share that file
 * (one HOME for all runtimes, by design: the credentials live there too).
 *
 * Agents are unaffected either way, because the engine launches them with explicit --model/--effort
 * flags which override the file. This restore exists purely so the owner's own CLI does not silently
 * drift onto whatever an agent was last switched to.
 *
 * Serialized through a promise chain: several agents can be tuned at once, and a read-modify-write
 * race on a shared json would lose one of the edits.
 */
let queue: Promise<void> = Promise.resolve();

export interface CanonicalSettings {
  model?: string;
  effortLevel?: string;
}

export function restoreOwnerSettings(canonical: CanonicalSettings): Promise<void> {
  queue = queue.then(() => {
    try {
      const path = join(process.env.HOME ?? "", ".claude", "settings.json");
      if (!existsSync(path)) return; // nothing to restore; never create the owner a file
      const cur = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      for (const key of ["model", "effortLevel"] as const) {
        const want = canonical[key];
        if (want === undefined) delete cur[key];
        else cur[key] = want;
      }
      writeFileSync(path, JSON.stringify(cur, null, 2) + "\n");
    } catch (err) {
      logger.warn({ err }, "could not restore owner settings"); // never fail a tune over this
    }
  });
  return queue;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/session/claude-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session/claude-settings.ts src/session/claude-settings.test.ts
git commit -m "feat(session): restore the owner's canonical claude settings after a tune injection"
```

---

### Task 7: HTTP surface — `effort` action, live `model` action, and `office-tune`'s endpoint

**Files:**
- Modify: `src/web/server.ts` (the `/api/agents/<id>/<action>` block, lines ~521-605)
- Test: `src/web/server.test.ts`

**Interfaces:**
- Consumes: `applyTune` (Task 5), `restoreOwnerSettings` (Task 6), `normalizeEffort` (Task 2).
- Produces: `POST /api/agents/<id>/effort {effort}` and a changed `POST /api/agents/<id>/model {model}` — both write `agent.json`, then tune the live pane instead of killing the session. Response: `{ ok, effort|model, applied: boolean, note?: string }`.

- [ ] **Step 1: Write the failing test**

Append to `src/web/server.test.ts`. This mirrors the file's existing harness (real server on an
ephemeral port via `freePort()`, called with `fetch`). There is deliberately no tmux session, so
`applyTune` returns `no-session` — which is exactly the case that must still persist to `agent.json`:

```typescript
describe("agent effort/model tuning", () => {
  let tempDir: string;
  let cfg: any;
  let stopServer: () => void;
  let base: string;

  const agentJson = () =>
    JSON.parse(readFileSync(join(tempDir, "agents", "home", "agent.json"), "utf8"));

  const tune = (action: string, body: unknown) =>
    fetch(`${base}/api/agents/home/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    tempDir = join(tmpdir(), "theoffice-tune-" + Math.random().toString(36).slice(2));
    mkdirSync(join(tempDir, "store"), { recursive: true });
    mkdirSync(join(tempDir, "agents", "home"), { recursive: true });
    writeFileSync(join(tempDir, "store", ".dashboard-token"), MOCK_TOKEN);
    writeFileSync(
      join(tempDir, "agents", "home", "agent.json"),
      JSON.stringify({ displayName: "Home", model: "claude-opus-4-8" }),
    );
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    cfg = {
      web: { host: "127.0.0.1", port, rateLimit: { maxFails: 50, windowMs: 1000, blockMs: 1000 } },
      paths: {
        dashboardTokenFile: join(tempDir, "store", ".dashboard-token"),
        agentsDir: join(tempDir, "agents"),
        tenantRoot: tempDir,
      },
      owner: { timezone: "UTC" },
      channel: { provider: "none" },
      // no tmux session exists for this agent -> applyTune reports no-session
      tmux: { socket: "theoffice-test-nonexistent" },
    };
    stopServer = startServer(cfg);
    await new Promise((r) => setTimeout(r, 100));
  });

  afterEach(() => {
    if (stopServer) stopServer();
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects an unknown effort level with 400 and does not touch agent.json", async () => {
    const res = await tune("effort", { effort: "banana" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown effort/i);
    expect(agentJson().effort).toBeUndefined();
  });

  it("persists a valid effort even when the live pane cannot be tuned", async () => {
    const res = await tune("effort", { effort: "xhigh" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effort).toBe("xhigh");
    expect(body.applied).toBe(false); // no session -> not live, but…
    expect(agentJson().effort).toBe("xhigh"); // …durable truth is written regardless
  });

  it('clears the pin when given "default"', async () => {
    await tune("effort", { effort: "xhigh" });
    const res = await tune("effort", { effort: "default" });
    expect(res.status).toBe(200);
    expect(agentJson().effort).toBeUndefined();
  });

  it("a model change no longer kills the session — agent.json is written and the pin persists", async () => {
    const res = await tune("model", { model: "claude-opus-5" });
    expect(res.status).toBe(200);
    expect(agentJson().model).toBe("claude-opus-5");
  });
});
```

Add `readFileSync` to the `node:fs` import at the top of the file if it is not already there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/web/server.test.ts`
Expected: FAIL — the route regex does not match `effort`, so the request 404s.

- [ ] **Step 3: Widen the route and add the shared tune helper**

`src/web/server.ts` — extend the action regex to include `effort`:

```typescript
  const am = path.match(/^\/api\/agents\/([A-Za-z0-9_-]+)\/(model|effort|runtime|enabled|restart|start|stop|cleanreset)$/);
```

Add the imports at the top of the file:

```typescript
import { applyTune } from "../session/tune.js";
import { restoreOwnerSettings } from "../session/claude-settings.js";
import { normalizeEffort } from "../session/effort.js";
```

- [ ] **Step 4: Replace the `model` action with the live path and add `effort`**

Replace the whole existing `if (action === "model") { ... }` block with:

```typescript
    // model / effort: persist to agent.json FIRST (durable truth, survives restart), then tune the
    // LIVE pane so the agent keeps its conversation. Never killSession here — that was the old
    // behaviour and it threw away the agent's context on every model change.
    if (action === "model" || action === "effort") {
      const raw2 = action === "model" ? body.model : body.effort;
      const wanted = typeof raw2 === "string" ? raw2.trim() : "default";
      const clearing = !wanted || wanted === "default";

      let value: string | undefined;
      if (!clearing) {
        if (action === "effort") {
          value = normalizeEffort(wanted);
          if (!value) return json(res, 400, { error: "unknown effort", effort: wanted });
        } else {
          value = wanted;
        }
      }

      if (clearing) delete meta[action];
      else meta[action] = value;
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));

      // Clearing a pin has no live equivalent (there is no "unset" slash command) — it takes effect
      // at the next launch, so say so rather than pretending it applied now.
      if (clearing) {
        return json(res, 200, { ok: true, [action]: "default", applied: false, note: "cleared; applies at next restart" });
      }

      const tuned = await applyTune(cfg.tmux.socket, session, action, value!);
      if (tuned.ok) await restoreOwnerSettings(ownerCanonicalSettings(cfg));
      return json(res, 200, {
        ok: true,
        [action]: value,
        applied: tuned.ok,
        note: tuned.ok ? tuned.message : `saved; not applied live (${tuned.reason}) — takes effect at next restart`,
      });
    }
```

- [ ] **Step 5: Add the canonical-settings helper**

Near the other small helpers at the bottom of `src/web/server.ts`:

```typescript
/**
 * The owner's own default Claude settings, which a tune injection would otherwise overwrite.
 * Read from config when present so it is not hardcoded; falls back to the CLI's own default.
 */
function ownerCanonicalSettings(cfg: EngineConfig): { model?: string; effortLevel?: string } {
  return {
    model: cfg.owner.claudeModel,
    effortLevel: cfg.owner.claudeEffort ?? "high",
  };
}
```

Add the two optional fields to `OwnerConfig` in `src/types.ts`:

```typescript
  /** The owner's own interactive-CLI defaults, restored after an agent tune overwrites them. */
  claudeModel?: string;
  claudeEffort?: string;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/web/server.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/server.ts src/web/server.test.ts src/types.ts
git commit -m "feat(web): effort endpoint + live model switching without killing the session"
```

---

### Task 8: Mission Control effort dropdown

**Files:**
- Modify: `web-ui/mc/app.js` (`agentCard`, the `.selrow` block, and the actions section)
- Modify: `src/web/server.ts` (`/api/agents` payload — add `effort`)

**Interfaces:**
- Consumes: `runtimes[].efforts` (Task 4) and `POST /api/agents/<id>/effort` (Task 7).
- Produces: nothing downstream.

- [ ] **Step 1: Expose the current effort in the agents payload**

`src/web/server.ts`, in the `/api/agents` response object, directly after `model: a.model ?? "default",`:

```typescript
        effort: a.effort ?? "default",
```

- [ ] **Step 2: Build the dropdown**

`web-ui/mc/app.js`, in `agentCard` right after the `modelSel` assignment:

```javascript
  const efforts = rdef.efforts || [];
  let effortOpts = ["default", ...efforts];
  if (a.effort && !effortOpts.includes(a.effort)) effortOpts = [a.effort, ...effortOpts];
  // providers without an effort knob (codex, gemini) advertise an empty list -> no control at all
  const effortSel = efforts.length
    ? `<div class="r"><span class="k">effort</span><select onchange="setEffort('${esc(a.id)}', this)">${effortOpts.map((ee) => `<option value="${esc(ee)}"${(a.effort || "default") === ee ? " selected" : ""}>${esc(ee)}</option>`).join("")}</select></div>`
    : "";
```

- [ ] **Step 3: Render it next to the model control**

In the same template literal, replace the model row line with:

```javascript
      <div class="r"><span class="k">model</span>${modelSel}</div>
      ${effortSel}
```

- [ ] **Step 4: Wire the action**

`web-ui/mc/app.js`, next to the existing `window.setModel`:

```javascript
window.setEffort = async (id, sel) => {
  sel.disabled = true;
  const r = await post(`/api/agents/${id}/effort`, { effort: sel.value });
  if (r && r.applied === false && r.note) alert(r.note);
  await softRefresh();
};
```

Update `setModel` the same way, so a swallowed or deferred model switch is visible rather than silent:

```javascript
window.setModel = async (id, sel) => {
  sel.disabled = true;
  const r = await post(`/api/agents/${id}/model`, { model: sel.value });
  if (r && r.applied === false && r.note) alert(r.note);
  await softRefresh();
};
```

Also update the fallback runtime constant at line 117 so a failed `/api/runtimes` fetch does not crash on `rdef.efforts`:

```javascript
let RUNTIMES = [{ id: "claude", label: "Claude Code", models: [], efforts: [] }];
```

- [ ] **Step 5: Verify in the real dashboard**

Run: `npm run build && systemctl --user restart theoffice.service`
Then open `http://127.0.0.1:3430/mc/` and confirm: Claude agents show an effort dropdown, Argus (gemini) does not, and switching a Claude agent's effort does NOT clear its pane.

- [ ] **Step 6: Commit**

```bash
git add web-ui/mc/app.js src/web/server.ts
git commit -m "feat(dashboard): per-agent effort dropdown, surfaced only for providers that support it"
```

---

### Task 9: Slack path — `office-tune` + agent instructions

**Files:**
- Create: `scripts/office-tune.sh`
- Modify: `scripts/install.sh` (wherever `office-say` is installed)
- Modify: `templates/product/agent.CLAUDE.md`
- Modify: `src/web/server.ts` (a self-scoped endpoint for the helper)

**Interfaces:**
- Consumes: `POST /api/agents/<id>/{model,effort}` (Task 7).
- Produces: `POST /api/tune {kind, value}` — the agent id comes from the caller's own environment, never the request body.

- [ ] **Step 1: Write the helper**

Create `scripts/office-tune.sh` (mirrors `office-say.sh` exactly — same token, same env contract):

```bash
#!/usr/bin/env bash
# office-tune — how an agent changes its OWN model or thinking effort, live.
#
# An agent (running inside its `claude` tmux session) calls:
#     office-tune effort xhigh
#     office-tune model claude-sonnet-5
# The engine writes the value to this agent's agent.json (so it survives a restart) and then applies
# it to this live session, so the conversation is NOT lost. The agent id comes from the session env,
# never from an argument — one agent cannot retune another.
set -euo pipefail

KIND="${1:?usage: office-tune <model|effort> <value>}"
VALUE="${2:?usage: office-tune <model|effort> <value>}"
AGENT="${OFFICE_AGENT_ID:?OFFICE_AGENT_ID not set (run inside an agent session)}"
TENANT="${OFFICE_TENANT_ROOT:?OFFICE_TENANT_ROOT not set}"
PORT="${OFFICE_PORT:-3430}"
TOKEN="$(cat "$TENANT/store/.dashboard-token")"

case "$KIND" in
  model|effort) ;;
  *) echo "office-tune: kind must be 'model' or 'effort', got '$KIND'" >&2; exit 1 ;;
esac

python3 - "$KIND" "$VALUE" "$TOKEN" "$PORT" <<'PY'
import sys, json, urllib.request
kind, value, token, port = sys.argv[1:5]
data = json.dumps({"kind": kind, "value": value}).encode()
req = urllib.request.Request(
    f"http://127.0.0.1:{port}/api/tune",
    data=data,
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
)
out = json.loads(urllib.request.urlopen(req, timeout=180).read())
print(out.get("note") or f"{kind} -> {value}")
PY
```

- [ ] **Step 2: Add the self-scoped endpoint**

`src/web/server.ts`, near the other POST routes:

```typescript
  // POST /api/tune {kind, value} — office-tune's endpoint. The agent is taken from OFFICE_AGENT_ID in
  // the CALLER's environment (forwarded as X-Office-Agent by the helper's own shell), never from the
  // body, so one agent cannot retune another. Same trust model as /api/outbound.
  if (path === "/api/tune" && m === "POST") {
    const raw = await readBody(req, res); if (raw === null) return;
    const body = parseJson(raw) ?? {};
    const who = String(req.headers["x-office-agent"] ?? "");
    const agent = loadAgents(cfg).find((a) => a.id === who);
    if (!agent) return json(res, 400, { error: "unknown calling agent" });
    const kind = body.kind === "model" || body.kind === "effort" ? body.kind : null;
    if (!kind) return json(res, 400, { error: "kind must be model or effort" });
    return tuneAgent(cfg, res, agent, kind, String(body.value ?? ""));
  }
```

Extract the body of the Task 7 `model|effort` action into a shared function so the dashboard and
Slack paths cannot drift apart. Add near the other helpers in `src/web/server.ts`:

```typescript
/**
 * Persist a model/effort pin to agent.json, then apply it to the live pane. Shared by the dashboard
 * action and by office-tune, so both paths have identical semantics: agent.json is the durable truth
 * and is written even when the live injection cannot happen.
 */
async function tuneAgent(
  cfg: EngineConfig,
  res: ServerResponse,
  agent: AgentDef,
  kind: "model" | "effort",
  wanted: string,
): Promise<void> {
  const metaPath = join(agent.dir, "agent.json");
  const meta = existsSync(metaPath) ? (parseJson(readFileSync(metaPath, "utf8")) ?? {}) : {};
  const trimmed = wanted.trim();
  const clearing = !trimmed || trimmed === "default";

  let value: string | undefined;
  if (!clearing) {
    if (kind === "effort") {
      value = normalizeEffort(trimmed);
      if (!value) return json(res, 400, { error: "unknown effort", effort: trimmed });
    } else {
      value = trimmed;
    }
  }

  if (clearing) delete meta[kind];
  else meta[kind] = value;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  if (clearing) {
    return json(res, 200, { ok: true, [kind]: "default", applied: false, note: "cleared; applies at next restart" });
  }

  const tuned = await applyTune(cfg.tmux.socket, sessionNameFor(agent.id), kind, value!);
  if (tuned.ok) await restoreOwnerSettings(ownerCanonicalSettings(cfg));
  return json(res, 200, {
    ok: true,
    [kind]: value,
    applied: tuned.ok,
    note: tuned.ok ? tuned.message : `saved; not applied live (${tuned.reason}) — takes effect at next restart`,
  });
}
```

Then replace the whole `if (action === "model" || action === "effort") { ... }` body written in
Task 7 with a single delegating call, so there is exactly one implementation:

```typescript
    if (action === "model" || action === "effort") {
      const rawVal = action === "model" ? body.model : body.effort;
      return tuneAgent(cfg, res, agent, action, typeof rawVal === "string" ? rawVal : "default");
    }
```

Import `ServerResponse` from `node:http` if it is not already imported in this file.

Add the header to the helper's request in `scripts/office-tune.sh` (the `headers={...}` dict):

```python
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "X-Office-Agent": __import__("os").environ["OFFICE_AGENT_ID"]},
```

- [ ] **Step 3: Install it alongside office-say**

`scripts/install.sh` — replace lines 84-86 (the `office-say` install block) with:

```bash
say "Installing the office-say / office-tune helpers -> ~/.local/bin/"
mkdir -p "$HOME/.local/bin"
install -m 0755 "$INSTALL_DIR/scripts/office-say.sh" "$HOME/.local/bin/office-say"
install -m 0755 "$INSTALL_DIR/scripts/office-tune.sh" "$HOME/.local/bin/office-tune"
```

Then install it for the current fleet without a full reinstall:

```bash
install -m 0755 scripts/office-tune.sh "$HOME/.local/bin/office-tune"
```

- [ ] **Step 4: Teach the agents**

`templates/product/agent.CLAUDE.md` — add near the `office-say` section:

```markdown
- **Changing your own model or thinking effort.** If the owner asks you to change how hard you think
  or which model you run on ("állítsd magad xhigh effortra", "switch to sonnet"), run:
  `office-tune effort xhigh` or `office-tune model claude-sonnet-5`.
  Valid effort levels: low, medium, high, xhigh, max. The change is saved to your agent.json, so it
  survives a restart, and applies to this session without losing our conversation. It takes effect
  after your current turn finishes — tell the owner that via `office-say`, and report the result the
  command printed. Only the owner may ask for this; if a non-owner asks, decline and say why.
```

- [ ] **Step 5: Verify end-to-end**

Run: `npm run build && systemctl --user restart theoffice.service`
Then from Slack, DM an agent: *"állítsd magad xhigh effortra"*. Confirm it replies with the change and that its pane's status line shows `◉ xhigh` without the conversation resetting.

- [ ] **Step 6: Commit**

```bash
git add scripts/office-tune.sh scripts/install.sh templates/product/agent.CLAUDE.md src/web/server.ts
git commit -m "feat(channel): office-tune — agents change their own model/effort from a Slack request"
```

---

## Final verification

- [ ] `npm run typecheck && npx vitest run` — all green
- [ ] `npm run lint`
- [ ] Restart the engine, confirm every agent comes back up: `systemctl --user restart theoffice.service && tmux -L <socket> ls`
- [ ] Confirm `home` and `zeus` still launch on `claude-opus-4-8` (they are the reason 4.8 stays in the registry)
- [ ] Set an effort on one agent, restart the engine, confirm it comes back with that effort (`ps aux | grep -- --effort`)

## Deliberately not in this plan

- Migrating `tenant/agents/argus/agent.json` off the stale `"Gemini 3.1 Pro (High)"` label — owner's live data, needs their explicit go-ahead.
- Codex model support.
- Interrupting a busy agent to switch immediately (belongs with the open "STOP cannot interrupt" bug).
