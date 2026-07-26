# Per-agent effort & model switching — design

**Date:** 2026-07-26
**Status:** design, awaiting approval
**Scope:** Claude-runtime agents only. Codex and Gemini runtimes are untouched except for the
model-registry data fix in Part 1.

## Goal

Set **effort** and **model** per agent, from Mission Control and from Slack, so that:

1. the setting **survives a restart** — engine restart, host reboot, tmux session loss — and comes
   back automatically for that agent, and
2. changing it does **not** destroy the agent's running conversation.

Today only `model` is settable, only from Mission Control, and changing it kills the tmux session
(`server.ts:567`), so the agent loses its context. There is no `effort` support at all.

## Evidence

Everything below was verified live on a throwaway tmux pane running `claude` 2.1.220, on an
isolated socket, not against any live agent.

| Probe | Result |
|---|---|
| `/effort xhigh` typed into a pane | `Set effort level to xhigh (saved as your default for new sessions)`, status line shows `◉ xhigh` |
| `/model claude-sonnet-5` | `Set model to Sonnet 5 and saved as your default for new sessions` |
| `/model nincsilyen-modell` | `Model 'nincsilyen-modell' not found` |
| `/effort banana` | `Invalid argument: banana. Valid options are: low, medium, high, xhigh, max, ultracode, auto` |
| Launch with `--effort max --model claude-haiku-4-5` while `~/.claude/settings.json` said `effortLevel: high` | `/status` → `Model: claude-haiku-4-5`; `/effort` slider sat on `max` — **the launch flags win over the shared settings file** |
| Seed context → `/model claude-sonnet-5` + `/effort low` → ask for the seeded value | returned `4271`, `/status` → `claude-sonnet-5`, **same Session ID** — the switch is live and lossless |

Two findings that shape the design:

- **Both commands accept an argument and apply immediately** — no menu navigation, so a single
  `sendText` + `Enter` is enough.
- **A command sent while the pane is still processing the previous one is silently swallowed.**
  During the probe, `/effort low` sent ~3s after `/model` produced no output and no error. Therefore
  the implementation must read the acknowledgement back, not fire-and-forget.

## The shared-HOME constraint

All three runtimes launch agents with `HOME: process.env.HOME` (`claude-runtime.ts:116`), so every
agent **and the owner's own interactive CLI share `~/.claude/settings.json`**. Both `/effort` and
`/model` persist themselves into that file as a default.

This is *not* solved by giving each agent its own HOME: `~/.claude/.credentials.json` lives there
too, so per-agent HOME would mean per-agent login.

It does not need to be. Because the launch flags override the settings file (verified above), an
agent that always launches with its own `--model` / `--effort` is **immune** to whatever another
agent wrote there. The only party left exposed is the owner's interactive CLI, which is handled by
writing the canonical value back after an injection (Part 3).

## Part 1 — Model registry refresh

Server-side data only; both UIs read it through `/api/runtimes`.

**Claude** (`claude-runtime.ts:193`):

```
["claude-opus-5", "claude-fable-5", "claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"]
```

- Adds Opus 5 and Sonnet 5, which were missing.
- **Adds Fable 5.** The previous exclusion assumed it was access-restricted; the `/model` menu on
  this account lists it (`Fable — Fable 5 · Most capable for your hardest and longest-running
  tasks`), so that assumption was wrong here. It is the most expensive tier — roughly double Opus 5
  per token — so it belongs in the list as an option, not as anyone's default.
- `claude-opus-4-8` stays: `home` and `zeus` currently run on it. Note the `/model` menu no longer
  lists 4.8, but the menu itself says *"For other/previous model names, specify with `--model`"* —
  and `--model` is exactly how the engine launches agents, so those two keep working.
- `claude-haiku-4-5-20251001` → `claude-haiku-4-5` (the dated ID is a snapshot, the alias is what
  should be offered).

**Gemini** (`gemini-runtime.ts:210`): replace the human labels with the slugs `agy models` actually
advertises, verified live on this host:

```
gemini-3.6-flash-{high,medium,low}
gemini-3.5-flash-{high,medium,low}
gemini-3.1-pro-{high,low}
claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium
```

The whole list is taken, because the field is documented as "exactly as `agy models` advertises
them" — and a 3.6 series now exists that the code does not know about.

**Live-data consequence:** `argus/agent.json` currently holds `"Gemini 3.1 Pro (High)"`, which is
not in that list. It has been running without visible error, which strongly suggests `agy` silently
falls back to the account default on an unknown name. Migrating it to `gemini-3.1-pro-high` is
tenant data, so it is called out separately and needs the owner's explicit go-ahead — it is not part
of the code change.

**Guard test:** assert every Gemini entry matches `^[a-z0-9.-]+$`. That is exactly the class of bug
that got in here — a human label where a slug was required.

## Part 2 — Persistence (this is what survives a restart)

- `AgentDef` (`types.ts:17`) gains `effort?: string` next to the existing `model?`.
- Read from `agent.json`, validated against the five known levels. An unknown value means "no
  effort", never an error — same shape as the existing `runtime` normalisation (`agents.ts:60`).
- `claude-runtime.ts:115` gains `command.push("--effort", agent.effort)` beside the existing
  `--model` push.

That is the whole restart story: the agent's own `agent.json` is the source of truth, and the launch
flags beat the shared settings file, so an agent always comes up on its own configured pair.

`ultracode` and `auto` are accepted by the CLI but deliberately not offered: `auto` defeats the
purpose of pinning a value, and `ultracode` is a different feature.

## Part 3 — Live switch (so a change does not cost the conversation)

Every change is two steps, in this order:

1. **Write `agent.json`** — the durable truth. If everything after this fails, the value is still
   correct at next launch.
2. **Inject into the live pane** — `sendText` + `Enter` over the existing tmux path, gated on
   `isReady` (`claude-runtime.ts:58`) so it waits for the current turn to finish, per the owner's
   decision. No `killSession`, so the conversation survives.

**Acknowledgement read-back is mandatory**, given the swallowed-command finding: after injecting,
capture the pane and require one of

- `Set effort level to <x>` / `Set model to <x>` → success,
- `Invalid argument: …` / `Model '…' not found` → report the error verbatim,
- neither, within a timeout → report "queued, applies at next restart" (which is true, because
  step 1 already succeeded).

**Settings write-back:** immediately after a successful injection, rewrite `~/.claude/settings.json`
to the owner's canonical values. The injected command has already taken effect in the running
process, so this only undoes the default-file side effect. Agents are unaffected either way (launch
flags win); this exists purely so the owner's own CLI does not drift. It needs a small lock, since
several agents could be switched at once.

## Part 4 — Slack: natural language

No new command syntax. A new `office-tune` script, modelled directly on `office-say.sh` (lives in
`~/.local/bin`, already on the agent's PATH via `claude-runtime.ts:118`, authenticates to the local
engine API with the dashboard token). The agent's `CLAUDE.md` documents it:

```
Owner  →  "Hestia, állítsd magad xhigh effortra"
Agent  →  office-tune effort xhigh
Agent  →  office-say "⚙️ effort: high → xhigh — applies after the current turn"
```

The model interprets the request, so there is no Hungarian-inflection regex to maintain. The cost is
that the agent must be responsive for this path to work; if it is wedged, Mission Control still
works, and that is the documented fallback.

## Part 5 — Mission Control

An effort dropdown beside the model dropdown, both fed from `/api/runtimes`. `Runtime` gains an
`efforts` field: the five levels for Claude, empty for Codex and Gemini. The UI only renders the
dropdown when the list is non-empty, so it does not appear for non-Claude agents. The existing model
dropdown is repointed from the kill-session path to the Part 3 path, so MC-initiated changes stop
discarding context too.

## Security

`office-tune` may only tune **its own** agent: the engine takes the agent id from `OFFICE_AGENT_ID`
in the session env, never from a caller-supplied argument, so one agent cannot retune another. This
mirrors how `office-say` derives its identity. Non-owner Slack senders are already tagged by the
existing banner mechanism (`slack-ingest.ts:171`), which warns the agent off owner-only actions.

## Out of scope

- Codex: the CLI has `-m/--model` but the runtime never passes it and advertises an empty list.
  Unchanged, per earlier decision.
- Interrupting a busy agent to switch immediately. The owner chose wait-then-switch; the Escape-based
  variant belongs with the open "STOP cannot interrupt" bug.
- Migrating `argus/agent.json` off the stale Gemini label — flagged above, owner's call.

## Test plan

- Effort validation: known values accepted, unknown value degrades to "no effort" without throwing.
- Launch: an agent with `effort` in `agent.json` gets `--effort` on its command line.
- Gemini registry guard: every entry is slug-shaped.
- Claude registry: contains Opus 5 and Sonnet 5; the Haiku entry is the alias, not the dated ID.
- Live switch: `agent.json` is written before injection, and a failed acknowledgement still leaves
  the file correct.
- Ordering: a second command injected before the first is acknowledged is not silently lost.
