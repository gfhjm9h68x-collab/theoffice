#!/usr/bin/env bash
# office-tune — how an agent changes its OWN model or thinking effort, live.
#
# An agent (running inside its `claude` tmux session) calls:
#     office-tune effort xhigh
#     office-tune model claude-sonnet-5
# The engine writes the value to that agent's agent.json (so it survives a restart) and then applies
# it to the live session, so the conversation is NOT lost. Effort levels: low medium high xhigh max.
#
# The agent identifies itself with OFFICE_AGENT_ID from its session env. Note this is the SAME trust
# model as office-say: the dashboard token is shared by all agents, so this is a convention that keeps
# agents in their own lane, not a cryptographic boundary between them.
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

python3 - "$KIND" "$VALUE" "$TOKEN" "$PORT" "$AGENT" <<'PY'
import sys, json, urllib.request, urllib.error
kind, value, token, port, agent = sys.argv[1:6]
data = json.dumps({"kind": kind, "value": value}).encode()
req = urllib.request.Request(
    f"http://127.0.0.1:{port}/api/tune",
    data=data,
    headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "X-Office-Agent": agent,
    },
)
try:
    # generous timeout: the engine waits for the current turn to finish before injecting
    out = json.loads(urllib.request.urlopen(req, timeout=180).read())
except urllib.error.HTTPError as e:
    body = e.read().decode("utf8", "replace")
    print(f"office-tune failed ({e.code}): {body}", file=sys.stderr)
    sys.exit(1)
print(out.get("note") or f"{kind} -> {value}")
PY
