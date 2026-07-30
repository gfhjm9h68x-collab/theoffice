# watchd — the fleet trigger service

Kills the agent-as-babysitter anti-pattern (FLEET RULE 1). Born from the
2026-07-30 incident: Dwight pinned his own session for ~90 min polling the car
tracker boolean and went deaf to the owner + scheduled tasks. No agent should
ever sit in a foreground "check every N seconds until X" loop. Watching is
infra's job; only the *reaction* needs an agent.

## What it is

ONE always-on `systemd --user` service. It holds a registry of *watches*, runs
a single consolidated scheduler for all POLL-type watches, and wakes the owning
agent (POST `/api/messages`) **only when a watch fires**. Agents register
"wake-me-when-X" and immediately release their session.

**Language: Python 3 stdlib, no dependencies.** Deliberate: a Node daemon is
~50–80 MB resident, Python ~15–20 MB, and this box runs under real memory
pressure (earlyoom kills `claude` panes). Szoszo's whole objection to the 60 s
poller was resource cost, so the lighter always-on process is the right call. It
matches the existing poll-tools (curve/kifli) and reads the `inbound_queue`
sqlite DB read-only for delivery confirmation.

## Scope (gate 5 — do NOT over-build)

v1 CORE = **registry + min-heap scheduler for POLL-type watches
(`http` / `shell` / `file_mtime`) + expiry + backoff + dedup + delivery-confirm
+ a status file.**

NATIVE PUSH sources that can already hit `/api/messages` directly — a Home
Assistant automation/webhook (the Task-1 tracker push is exactly this) — do
**not** route through watchd. The event-receiver side stays thin: HA POSTs
straight to `/api/messages`. watchd only exists for conditions that have no
native push and would otherwise force an agent to poll.

## Registration interface (v1 = file registry, no new HTTP surface)

An agent registers by atomically writing a JSON file into
`$OFFICE_TENANT_ROOT/store/watches/<id>.json` (write temp + `os.rename`), and
deregisters by deleting it. No new network endpoint to attack; the registry is
trivially inspectable and survives a service restart on disk.

```jsonc
{
  "id": "kia-tracker-recovered",          // unique; must equal the filename stem
  "owner_agent": "dwight",                // registrant; default wake target
  "description": "wake me when the Kia modem reconnects",
  "check": {                              // POLL-type only
    "type": "http",                       // http | shell | file_mtime
    // http:      { "url":..., "expect_status":200, "expect_body_contains":"..." }
    // shell:     { "cmd":[...], "expect_exit":0, "expect_stdout_contains":"..." }
    // file_mtime:{ "path":..., "newer_than_epoch":<ts> }
    "url": "http://192.168.10.162:8082/api/...",
    "expect_body_contains": "\"valid\":true"
  },
  "fire_when": "match",                   // "match" (check passed) | "nomatch"
  "cadence": { "interval_sec": 300,       // default 300; MIN enforced (see below)
               "backoff": { "factor": 2, "max_sec": 3600 } },
  "on_fire": { "to": "dwight",            // defaults to owner_agent
               "content": "Kia recovered: {result}" },
  "repeat": "once",                       // once | always
  "expires_at": 1785700000,               // MANDATORY (defaulted if omitted)
  "created_at": 1785445000
}
```

## The five merge-gate invariants

### 1. Delivery-confirm before deregister (the load-bearing one)
A `repeat:"once"` watch MUST NOT deregister on POST alone — that would
reintroduce the exact bug class we just fixed (a watcher silently dropping the
event it exists to catch). Fire flow:
1. POST `/api/messages`. Require **HTTP 200 + a message `id`** in the response.
   A non-200 / missing id ⇒ stay `fired-awaiting-delivery`, re-POST with backoff.
2. Hold `fired-awaiting-delivery`, recording the returned `msg_id`. Each loop,
   check `delivered_at` **via the runtime API** (`GET /api/messages` exposes the
   `agent_messages` row's `delivered_at`, same id space as the POST response).
   watchd **never opens the engine's sqlite** — the runtime is the sole DB
   authority (direct-sqlite fork-drift is what killed `claudeclaw.db`). Not
   delivered within a window ⇒ re-POST (idempotent by the stable `fire_epoch`
   dedup key). Only once `delivered_at` is set:
   - `repeat:"once"` → deregister.
   - `repeat:"always"` → re-arm (state `armed`, `next_due = now + interval`) with
     a dedup guard so the same still-true condition does not immediately re-fire.

### 2. Mandatory expiry with a hard cap
Every watch carries `expires_at`. The loader **defaults** a missing one to
`now + DEFAULT_TTL` (7 days) and **clamps** to `now + MAX_TTL` (30 days). No
immortal watches — a forgotten watch is the zombie failure mode we are fixing,
just slower. On expiry: deregister and (optional) notify the owner it expired
**unfired**.

### 3. Authz + fail-safe parsing
- `on_fire.to` defaults to `owner_agent`. If it targets a *different* agent or
  the human owner, it is allowed but **validated and logged** (a confused or
  compromised registrant must not silently spam the owner via a watch).
- `content` is **data** on the receiving side — the engine wraps inbound as
  untrusted; watchd never marks it trusted.
- A malformed / unparseable / schema-invalid watch file is **moved to
  `store/watches/quarantine/` and logged** — it never crashes the loop or takes
  the service down. Every per-file parse is isolated in try/except.
- The bearer for the POST is read from `$OFFICE_TENANT_ROOT/store/.dashboard-token`
  (perms `600`, owner `szoszo`); it is never logged.

### 4. Auditability
watchd writes `$OFFICE_TENANT_ROOT/store/watchd-status.json` every loop: for each
active watch `{id, owner, state, next_due, last_check_ok, last_error,
expires_at, fired_msg_id}`. A human (or a future dashboard view) can see exactly
what is being watched and spot a zombie. Trust needs a window into it.

## Scheduler — how it does NOT become a resource hog

- **Event-first.** If a condition has a native push, it does not belong here at
  all (gate 5). watchd only polls conditions that genuinely have no push.
- **Min-heap, sleep-until-due.** A heap keyed on `next_due`. The loop sleeps
  until the *earliest* due watch (capped at `RELOAD_INTERVAL` = 15 s so new
  registrations are noticed; the cap is a single cheap `stat` of the registry
  dir, not N external checks). No tight loop.
- **Minutes, not seconds.** Default `interval_sec` = 300; a `MIN_INTERVAL` (e.g.
  60 s) floor is enforced and anything lower is clamped + logged.
- **Exponential backoff on error**, capped at `max_sec` (default 3600), so a
  flapping/erroring check backs off instead of hammering.
- **Global frequency budget.** `GLOBAL_CHECKS_PER_MIN` bounds total checks/minute
  across all watches. **v1 WARNS** when the aggregate armed check-rate would cross
  it (runaway is visible, never silent); actual throttling is a tracked **v2
  fast-follow** — v1's per-watch `MIN_INTERVAL` floor + backoff + sleep-until-due
  already bound the real rate, and v1 has only a handful of watches.

## Failure modes handled
- Service crash → `Restart=always` + on-disk registry ⇒ watches survive a
  restart, reloaded from `store/watches/`.
- Double-wake → dedup key + `repeat:"once"` + delivery-confirm.
- A check that errors → backoff + surfaced in the status file after N fails
  (never silently dies — the lesson of today).
- Undelivered wake → gate 1 re-fires instead of vanishing.

## Deployment
`watchd.service` (`systemd --user`), `Restart=always`, `EnvironmentFile` for
`OFFICE_TENANT_ROOT`. Rollback-safe: it only ever *reads* the tracker/HA/DB and
*writes* to `/api/messages` + its own status file; disabling the unit stops all
watching with zero side effects on the engine (separate process, separate
concern). Deploy = install unit, `enable --now`, verify status file appears +
one smoke watch fires end-to-end.

## Build discipline
worktree + branch, TDD **red-first** (the delivery-confirm-before-deregister and
expiry tests fail first, by design), self-review, Toby adversarial QA,
rollback-safe systemd deploy, merge to main. This doc is committed with the code.
