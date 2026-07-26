#!/usr/bin/env bash
# backfill-office-tune-doc — teach EXISTING agents about `office-tune`.
#
# templates/product/agent.CLAUDE.md carries the instruction for newly created agents, but agents that
# already exist have their own hand-evolved CLAUDE.md and never see it. This inserts the same block
# into each of them, immediately before the SLACK FORMATTING bullet (where the template puts it).
#
# Idempotent: an agent whose CLAUDE.md already mentions office-tune is skipped. Safe to re-run after
# adding a new agent from an older template.
#
# Usage: bash scripts/backfill-office-tune-doc.sh [agentId ...]     (no args = every agent)
set -euo pipefail

TENANT="${OFFICE_TENANT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tenant}"
AGENTS_DIR="$TENANT/agents"
[ -d "$AGENTS_DIR" ] || { echo "no agents dir at $AGENTS_DIR" >&2; exit 1; }

if [ "$#" -gt 0 ]; then
  IDS=("$@")
else
  IDS=()
  for d in "$AGENTS_DIR"/*/; do IDS+=("$(basename "$d")"); done
fi

for id in "${IDS[@]}"; do
  f="$AGENTS_DIR/$id/CLAUDE.md"
  [ -f "$f" ] || { echo "$id: no CLAUDE.md, skipped"; continue; }
  python3 - "$f" "$id" <<'PY'
import sys

path, agent_id = sys.argv[1], sys.argv[2]
block = (
    "- **Changing your own model or thinking effort.** If the owner asks you to think harder or "
    "lighter, or to run on a different model (\"állítsd magad xhigh effortra\", \"switch to sonnet\"), "
    "run in Bash:\n"
    "  `office-tune effort xhigh` or `office-tune model claude-sonnet-5`\n"
    "  Effort levels: low, medium, high, xhigh, max. The value is saved to your `agent.json`, so it "
    "survives a restart, and it is applied to this session **without losing our conversation** — it "
    "takes effect once your current turn finishes. Report back with `office-say`, quoting what the "
    "command printed (it tells you whether it applied live or only from the next restart). Only the "
    "owner may ask for this: if a non-owner asks, decline and say why.\n"
)

text = open(path, encoding="utf8").read()
if "office-tune" in text:
    print(f"{agent_id}: already documented, skipped")
    sys.exit(0)

marker = "- **SLACK FORMATTING**"
idx = text.find(marker)
if idx == -1:
    # No slack-formatting bullet (older or hand-written persona) — append a short section instead,
    # rather than guessing at a position inside someone's carefully ordered file.
    text = text.rstrip("\n") + "\n\n## Changing your own model or thinking effort\n" + block
else:
    text = text[:idx] + block + text[idx:]

open(path, "w", encoding="utf8").write(text)
print(f"{agent_id}: office-tune documented")
PY
done
