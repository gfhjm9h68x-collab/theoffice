#!/usr/bin/env bash
# Portable, IDEMPOTENT installer for watchd (the fleet trigger service).
# Detects this install's paths, renders the systemd --user unit from
# watchd.service.template, installs + enables + starts it, and VERIFIES active.
# Safe to re-run any number of times. No hand-editing of any file.
set -euo pipefail

# fold-in 2: derive REPO_ROOT from the SCRIPT's own location, not the CWD, so the
# installer works no matter where it is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
TENANT="${OFFICE_TENANT_ROOT:-$REPO_ROOT/tenant}"
PY="$(command -v python3 || true)"
[ -n "$PY" ] || { echo "watchd install: python3 not found on PATH" >&2; exit 1; }

# Runtime dirs the registry / checks / quarantine live under (created idempotently).
mkdir -p "$TENANT/store/watches/quarantine" "$TENANT/store/watchd-checks"

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

# Render the unit from the template. '#' delimiter so filesystem paths (which
# contain '/') need no escaping.
sed -e "s#@OFFICE_TENANT_ROOT@#${TENANT}#g" \
    -e "s#@REPO_ROOT@#${REPO_ROOT}#g" \
    -e "s#@PYTHON@#${PY}#g" \
    "$SCRIPT_DIR/watchd.service.template" > "$UNIT_DIR/watchd.service"

systemctl --user daemon-reload
systemctl --user enable --now watchd.service

if systemctl --user is-active --quiet watchd.service; then
  echo "watchd: installed + active"
  echo "  repo=$REPO_ROOT"
  echo "  tenant=$TENANT"
  echo "  python=$PY"
else
  echo "watchd: FAILED to become active" >&2
  systemctl --user --no-pager status watchd.service 2>&1 | head -12 || true
  exit 1
fi
