# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**The Office** — a self-hostable AI agent back-office engine. It runs a fleet of AI agents, each as a
persistent CLI TUI (Claude Code by default) inside a tmux pane, wired to Slack with per-agent bot
identities. The engine (Node/TypeScript) provides the durable queues, memory, scheduler, inter-agent
bus, and web dashboard around those sessions. It deliberately uses the interactive `claude` runtime
under a flat-rate subscription (typing into tmux panes), **not** the metered SDK — much of the code's
complexity (pane locks, send/confirm/retry delivery, draft clearing) exists to make that path reliable.

## Commands

```bash
npm install                          # deps (Node >=20 <23; .nvmrc pins the version)
npm run typecheck                    # tsc --noEmit
npm test                             # vitest run (all tests)
npx vitest run src/queue/index.test.ts   # single test file
npx vitest run -t "name"             # single test by name
npm run dev                          # tsx watch src/index.ts (use OFFICE_TENANT_ROOT=./tenant)
npm run build                        # tsc -> dist/
npm run lint                         # eslint .
npm run format / format:check        # prettier
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, typecheck, tests, and
`shellcheck -S error bootstrap.sh scripts/*.sh` — shell scripts must pass shellcheck at error level.

Tests are colocated as `src/**/*.test.ts` and run against in-memory/temp SQLite; no live tenant,
Slack, or tmux needed.

## Three-layer architecture

Effective config = `deepMerge(platform, product, tenant)` (see `src/config.ts`):

- **Platform** — the engine in `src/`. Identical on every install. **Nothing tenant-specific may be
  hardcoded here** (no owner names, agent ids, or absolute install paths).
- **Product** — optional defaults: `product/config.json`, plus shipped templates in `templates/`
  (agent persona template, security profiles, scheduled-task skills).
- **Tenant** — one install's agents + data + secrets under `tenant/` (env-overridable via
  `OFFICE_TENANT_ROOT`). Never committed, never overwritten by updates. Agents live in
  `tenant/agents/<id>/` (persona `CLAUDE.md` + optional `agent.json` metadata); Slack tokens live
  separately in `tenant/secrets/slack/<id>.json`.

The tenant-agnostic rule is **enforced by tests**: `src/eval/prompt-invariants.ts` scans shipped
templates/personas for a denylist of tenant identifiers and absolute paths (`/home/`, `/opt/`, `~/`),
and checks that state-mutating task prompts keep their safety guardrail phrases. If you add or edit
anything in `templates/`, keep it generic or these tests fail.

## Core structural invariants

These two choices are the reliability story — don't undermine them:

1. **The channel is decoupled from the TUI.** A standalone Slack ingest daemon
   (`src/channel/slack-ingest.ts`) writes to a durable SQLite queue; agent sessions are pure (no
   channel plugin inside). Replies go out via the Slack Web API through a durable outbound queue.
2. **One inbound queue, one deliverer.** `inbound_queue` is the single entry point for everything
   that becomes a prompt to an agent (channel messages, scheduler fires, inter-agent bus, manual).
   Exactly one component (`startDeliverer` in `src/session/session-manager.ts`) ever types into a
   tmux pane, with idempotent submit. Never add a second writer to a pane; pane access goes through
   `withPaneLock` (`src/session/pane-lock.ts`).

Boot order matters and is documented phase-by-phase in `src/index.ts` (reap stale deliveries →
deliverer → launch agents → Slack ingest/send → scheduler + bus → web server → auth watchdog).
`OFFICE_SCHEDULER_PAUSED` / `OFFICE_BUS_PAUSED` env vars are incident-mode kill switches.

## Provider-pluggable runtimes

`src/session/runtime.ts` defines the `Runtime` interface (`launch` / `isBusy` / `deliver`) and a
registry. Three providers are wired: `claude` (default; persistent TUI, prompts injected into the
pane), `codex` (one `codex exec` subprocess per turn), `gemini`. The deliverer loop is
provider-agnostic — it only gates on `hasSession` + `isBusy` and hands the item to the runtime, which
**fully owns queue bookkeeping** (markDelivering/markDelivered/markFailed/requeue). A new provider is
one new module registered at the bottom of `runtime.ts`; nothing else should need to know about it.

`src/session/claude-runtime.ts` holds the hard-won tmux delivery mechanics (chunked send-keys,
settle timings, submit confirm/retry, draft clearing). The tunable constants at the top were arrived
at empirically — change with care and keep the corresponding tests green.

## Database rules (important)

SQLite via better-sqlite3, WAL mode. **`src/db/schema.ts` (SCHEMA_SQL) is frozen at the v1
baseline — never edit it for new schema changes.** All post-v1 changes go ONLY into `MIGRATIONS` in
`src/db/migrate.ts` as `{ version, name, sql }` entries (ascending from 2), each run in its own
transaction with a `user_version` bump. Adding a change to both places crash-loops fresh installs on
a duplicate column. Full rationale and the migration-writing recipe: `src/db/MIGRATIONS.md`.

## Memory subsystem

Tiered memories per agent: `hot` (active work) / `warm` (stable facts) / `cold` (history) /
`shared` (cross-agent), with FTS5 keyword search. `src/memory/semantic.ts` adds hybrid recall:
keyword + embedding search fused with RRF, where graceful degradation is load-bearing — if
embeddings are unavailable, results are exactly the keyword results; semantic recall is a bonus,
never a dependency. Session-start priming (`src/memory/recall.ts`) builds a preamble capped at
`PREAMBLE_MAX_CHARS` (byte budget filled in strict hot → warm → topical priority); tests lock the cap.

## Other subsystems

- **Scheduler** (`src/scheduler/`) — cron expressions fire file-based scheduled tasks
  (`tenant/scheduled-tasks/`, the source of truth — there is no DB table for them) into the inbound
  queue. Heartbeats are scheduled tasks of type `heartbeat`.
- **Bus** (`src/bus/`) — inter-agent messages via the `agent_messages` table, delivered as queued prompts.
- **Web** (`src/web/server.ts`) — dashboard HTTP API, bearer-auth, localhost-bound (`:3430`), with
  IP-based brute-force rate limiting; static UI is plain HTML/JS/CSS in `web-ui/` (no framework, no
  build step). `SPEC-trusted-proxy-gate.md` covers the X-Forwarded-For trust model.
- **Security profiles** (`src/session/profile.ts` + `templates/profiles/*.json`) — per-agent deny
  lists written into `tenant/agents/<id>/.claude/settings.json`, regenerated on every launch so they
  can't drift; also deny filesystem access to other agents' secrets, the raw DB, and the vault key.
- **Model/effort pins** (`src/session/tune.ts`, `docs/MODEL-AND-EFFORT.md`) — per-agent model and
  thinking-effort: the pin in `agent.json` is written first (durable truth), then a live switch is
  injected into the running pane so the agent keeps its conversation.
- **tools/watchd** — a small Python systemd watchdog (has its own tests and DESIGN.md).

## Conventions

- ESM throughout (`"type": "module"`); intra-project imports use `.js` suffixes
  (`from "./config.js"`). TypeScript strict with `noUncheckedIndexedAccess`.
- Config/env overrides are all `OFFICE_*` (`OFFICE_TENANT_ROOT`, `OFFICE_PORT`, `OFFICE_TMUX_SOCKET`,
  …). Env is for ops convenience, never for secrets. Numeric env values go through `numEnv()` so a
  malformed value warns and keeps the default instead of poisoning config with NaN.
- Logging via pino: `const logger = log("subsystem")` from `src/logger.ts`.
- Comments in this codebase carry design rationale (why a guard exists, what race it prevents, often
  tagged like `P0#4`). Preserve that style: when touching guarded code, keep or update the rationale
  rather than deleting it.
- Behavior-locking tests: many tests exist specifically to lock an invariant (preamble cap, frozen
  schema, tenant-leak scan, guardrail phrases, delivery races). A failing one usually means you broke
  a documented invariant, not that the test is stale.
- User-facing breaking changes or action-required steps get an entry at the **top** of `UPGRADING.md`
  (newest first).
