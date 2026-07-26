# Per-agent model & thinking effort

Each agent can pin the **model** it runs on and — on the Claude runtime — how hard it **thinks**
(`effort`). A pin survives restarts, and changing it does not throw away the agent's conversation.

## The two layers

| Layer | Where it lives | What it does |
|---|---|---|
| **Pin** | `tenant/agents/<id>/agent.json` | The durable truth. Passed as `--model` / `--effort` when the agent's session launches, so the agent always comes back on its own values. |
| **Live switch** | injected into the running tmux pane | Applies the change to the session that is already running, so no context is lost. |

Every change writes the pin **first**, then attempts the live switch. If the live part cannot happen
(agent stopped, or busy past the timeout), the pin is still correct and takes effect at the next
launch — the API says so explicitly rather than reporting a success that did not happen.

**Why the launch flags matter:** every agent, and your own interactive `claude`, share one
`~/.claude/settings.json` (they share a `HOME`, because the credentials live there). `/model` and
`/effort` save themselves into that file as a default. Because the engine launches agents with
explicit flags, and flags override that file, one agent's switch can never knock another agent onto a
different model. After a successful live switch the engine also restores your own canonical values in
that file — see [Owner defaults](#owner-defaults).

## Effort levels

`low`, `medium`, `high`, `xhigh`, `max` — Claude runtime only.

The CLI also accepts `auto` and `ultracode`; neither is offered here. `auto` defeats the point of
pinning a value per agent, and `ultracode` is a separate feature rather than an effort tier. An
unknown value in `agent.json` normalizes to "unset" instead of failing the launch, so a typo in a
hand-edited file can never stop an agent from starting.

## Setting it

### From Mission Control

Each Claude agent's card has **model** and **effort** dropdowns. Providers without an effort concept
(codex, gemini) show no effort control at all — the runtime advertises an empty list and the UI hides
the whole row.

### From Slack, in plain language

There is no command syntax to learn. Ask the agent:

> Hestia, switch yourself to xhigh effort

The agent calls `office-tune` itself:

```bash
office-tune effort xhigh
office-tune model claude-sonnet-5
```

The instruction lives in the agent template. Agents created before this feature landed need it
backfilled once:

```bash
bash scripts/backfill-office-tune-doc.sh          # every agent
bash scripts/backfill-office-tune-doc.sh hestia   # or just one
```

It is idempotent — agents that already know about `office-tune` are skipped.

### From the API

```bash
TOKEN=$(cat "$OFFICE_TENANT_ROOT/store/.dashboard-token")

curl -X POST http://127.0.0.1:3430/api/agents/<id>/effort \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"effort":"xhigh"}'

curl -X POST http://127.0.0.1:3430/api/agents/<id>/model \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"claude-opus-5"}'
```

Send `"default"` to remove a pin. Removing one only takes effect at the next restart — there is no
"unset" slash command to inject — and the response says so.

Response shape:

```json
{ "ok": true, "effort": "xhigh", "applied": true,
  "note": "Set effort level to xhigh (saved as your default for new sessions)" }
```

`applied` tells you whether the **running** session changed. When it is `false`, `note` carries the
reason (`no-session`, `not-ready`, `no-ack`) and the pin still applies from the next launch.

## Behaviour by runtime

| Runtime | Model | Effort |
|---|---|---|
| `claude` | live switch, no restart | live switch, no restart |
| `gemini`, `codex` | applied by restarting the session | not supported — the API returns 400 |

`/model` and `/effort` are Claude Code slash commands. Injecting them into an `agy` or `codex` pane
would deliver them as an ordinary prompt, so non-Claude runtimes keep the restart-to-apply path.

## Owner defaults

`/model` and `/effort` write themselves into the shared `~/.claude/settings.json`. Agents are immune
(launch flags win), but your own interactive CLI would drift. After a successful live switch the
engine restores:

```jsonc
// tenant/config/overrides.json
{
  "owner": {
    "claudeModel": "claude-opus-5",  // optional; omitted = no model key in settings.json
    "claudeEffort": "high"           // optional; defaults to "high"
  }
}
```

Leave them unset and the engine restores `effortLevel: "high"` and removes any `model` key.

## Waiting, not interrupting

A live switch waits for the agent's current turn to finish, then applies. It does not interrupt
work in progress. If the agent is busy longer than the timeout, the pin is kept and the API reports
`applied: false` — nothing is lost.

## Why the acknowledgement is read back

A slash command sent to a pane that is still processing the previous one is swallowed: no output, no
error. Fire-and-forget would therefore report success for a change that never happened. The engine
reads the pane's own reply and only reports success on seeing it, surfacing rejections verbatim:

```
Invalid argument: banana. Valid options are: low, medium, high, xhigh, max, ultracode, auto
Model 'nonesuch' not found
```

## Security note

`office-tune` names its agent from `OFFICE_AGENT_ID` in the session environment, which keeps agents
in their own lane. This is the same trust model as `office-say`: the dashboard token is shared by
every agent, so it is a convention, not a cryptographic boundary between them. Making it one would
mean per-agent tokens — a separate change that would have to cover `office-say` too.
