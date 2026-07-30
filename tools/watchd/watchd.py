#!/usr/bin/env python3
"""watchd — the fleet trigger service. See DESIGN.md.

One always-on systemd --user process. Holds a file registry of "watches", runs a
single min-heap scheduler for POLL-type watches, and wakes the owning agent
(POST /api/messages) ONLY when a watch fires — with delivery confirmed before a
once-watch deregisters. Kills the foreground poll-loop anti-pattern (FLEET RULE 1).

Python stdlib only (footprint). The pure gate-logic below is dependency-injected
(poster + delivery_checker are callables) so it is unit-testable without IO.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import time
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

log = logging.getLogger("watchd")

# --- Tunables ---------------------------------------------------------------
DEFAULT_TTL = 7 * 86_400          # gate 2: default expiry if omitted
MAX_TTL = 30 * 86_400             # gate 2: hard cap
MIN_INTERVAL = 60                 # no-hog: floor on poll interval (seconds)
DEFAULT_INTERVAL = 300
RELOAD_INTERVAL = 15              # max sleep before re-stat'ing the registry dir
GLOBAL_CHECKS_PER_MIN = 120       # no-hog: global budget. v1 WARNS on cross; enforcement = v2 fast-follow
DELIVERY_REPOST_AFTER = 120       # re-POST a wake if delivered_at not set within this
BACKOFF_FACTOR = 2
BACKOFF_MAX = 3600


class InvalidWatch(Exception):
    """A watch file that fails schema validation -> caller quarantines it."""


@dataclass
class Watch:
    id: str
    owner_agent: str
    check: dict
    on_fire_content: str
    on_fire_to: str
    repeat: str = "once"                 # once | always
    fire_when: str = "match"             # match | nomatch
    description: str = ""
    interval_sec: int = DEFAULT_INTERVAL
    backoff_max: int = BACKOFF_MAX
    expires_at: float = 0.0
    created_at: float = 0.0
    # runtime state
    state: str = "armed"                 # armed | fired_awaiting_delivery | expired | deregistered
    fired_msg_id: Optional[int] = None
    fire_epoch: float = 0.0              # set once per fire episode; STABLE dedup key
    fired_at: float = 0.0               # updated each (re)POST; drives the repost window
    next_due: float = 0.0
    fail_count: int = 0
    last_error: str = ""
    last_check_ok: Optional[bool] = None

    @property
    def dedup_key(self) -> str:
        # Stable across reposts of the SAME fire episode (fire_epoch is set once),
        # so the engine can dedup a re-sent wake instead of double-waking the agent.
        return f"watch:{self.id}:{int(self.fire_epoch) or int(self.created_at)}"


# --- Loading / validation (gates 2, 3) --------------------------------------
def load_watch(raw: dict, now: float) -> Watch:
    """Parse + validate + default a raw watch dict. Raises InvalidWatch on any
    schema violation so the caller can quarantine the file (never crash the loop)."""
    if not isinstance(raw, dict):
        raise InvalidWatch("watch is not an object")
    for req in ("id", "owner_agent", "check", "on_fire"):
        if req not in raw:
            raise InvalidWatch(f"missing required field: {req}")
    if not isinstance(raw["check"], dict) or raw["check"].get("type") not in ("http", "shell", "file_mtime"):
        raise InvalidWatch("check.type must be one of http|shell|file_mtime")
    on_fire = raw["on_fire"]
    if not isinstance(on_fire, dict) or "content" not in on_fire:
        raise InvalidWatch("on_fire.content is required")
    repeat = raw.get("repeat", "once")
    if repeat not in ("once", "always"):
        raise InvalidWatch("repeat must be once|always")

    owner = str(raw["owner_agent"])

    # gate 2: mandatory expiry, defaulted + clamped to the hard cap.
    exp = raw.get("expires_at")
    if exp is None:
        exp = now + DEFAULT_TTL
    exp = min(float(exp), now + MAX_TTL)

    # no-hog: floor the interval.
    interval = int(raw.get("cadence", {}).get("interval_sec", DEFAULT_INTERVAL))
    interval = max(interval, MIN_INTERVAL)

    w = Watch(
        id=str(raw["id"]),
        owner_agent=owner,
        check=raw["check"],
        on_fire_content=str(on_fire["content"]),
        on_fire_to=str(on_fire.get("to") or owner),   # gate 3: default to owner
        repeat=repeat,
        fire_when=raw.get("fire_when", "match"),
        description=str(raw.get("description", "")),
        interval_sec=interval,
        backoff_max=int(raw.get("cadence", {}).get("backoff", {}).get("max_sec", BACKOFF_MAX)),
        expires_at=exp,
        created_at=float(raw.get("created_at", now)),
        next_due=now,
    )
    # Restore watchd-owned runtime state (state machine, fired msg id, schedule)
    # from the `_rt` key watchd itself persisted. Keeps a fired_awaiting_delivery
    # watch from re-firing across loop reloads AND service restarts (the registry
    # file is the single source of truth for both definition and runtime).
    rt = raw.get("_rt")
    if isinstance(rt, dict):
        w.state = rt.get("state", w.state)
        w.fired_msg_id = rt.get("fired_msg_id", w.fired_msg_id)
        w.fire_epoch = float(rt.get("fire_epoch", w.fire_epoch))
        w.fired_at = float(rt.get("fired_at", w.fired_at))
        w.next_due = float(rt.get("next_due", w.next_due))
        w.fail_count = int(rt.get("fail_count", w.fail_count))
    return w


def persist_runtime(w: Watch, wdir: str) -> None:
    """Write watchd's runtime state back into the watch file under `_rt`, atomically,
    so it survives loop reloads and restarts. Best-effort: never raises into the loop."""
    path = os.path.join(wdir, f"{w.id}.json")
    try:
        with open(path) as f:
            raw = json.load(f)
        raw["_rt"] = {"state": w.state, "fired_msg_id": w.fired_msg_id, "fire_epoch": w.fire_epoch,
                      "fired_at": w.fired_at, "next_due": w.next_due, "fail_count": w.fail_count}
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(raw, f, indent=1)
        os.rename(tmp, path)
    except OSError as e:
        log.error("persist_runtime %s failed: %s", w.id, e)


def is_expired(w: Watch, now: float) -> bool:
    return now >= w.expires_at


def authz_note(w: Watch) -> Optional[str]:
    """gate 3: a watch whose wake targets someone other than its registrant is
    allowed but must be logged (a confused/compromised agent must not silently
    spam another agent or the owner)."""
    if w.on_fire_to != w.owner_agent:
        return f"watch {w.id} (owner {w.owner_agent}) targets a DIFFERENT recipient: {w.on_fire_to}"
    return None


# --- Fire + delivery-confirm (gate 1) ---------------------------------------
Poster = Callable[[str, str, str], "tuple[int, Optional[int]]"]       # (to, content, dedup) -> (status, msg_id)
DeliveryChecker = Callable[[int], Optional[float]]                    # msg_id -> delivered_at | None


def fire(w: Watch, poster: Poster, now: float) -> Watch:
    """Wake the owner. Does NOT deregister. On a clean 200+id the watch enters
    fired_awaiting_delivery; on any failure it stays armed for a backed-off
    re-POST (the wake is NEVER dropped — gate 1)."""
    entry_fired = w.state == "fired_awaiting_delivery"   # True when this is a repost
    if not w.fire_epoch:                 # first fire of this episode -> stable dedup anchor
        w.fire_epoch = now
    try:
        status, msg_id = poster(w.on_fire_to, _render(w, now), w.dedup_key)
    except Exception as e:  # noqa: BLE001 — never let a POST error kill the loop
        status, msg_id = 0, None
        w.last_error = f"post error: {e}"
    if status == 200 and msg_id is not None:
        w.state = "fired_awaiting_delivery"
        w.fired_msg_id = msg_id
        w.fired_at = now
        w.fail_count = 0
    elif entry_fired:
        # A REPOST failed: stay fired_awaiting_delivery and retry — never revert to
        # armed (re-evaluating a one-shot condition at the worst moment). fire_epoch
        # stays set so the retry keeps the same dedup key.
        w.fired_at = now
        w.last_error = w.last_error or f"repost not confirmed (status={status})"
    else:
        # First fire failed: keep armed, back off, retry the POST. NEVER deregister.
        w.fail_count += 1
        w.state = "armed"
        w.next_due = now + _backoff(w)
        w.last_error = w.last_error or f"wake POST not confirmed (status={status})"
    return w


def reconcile_delivery(w: Watch, delivery_checker: DeliveryChecker, now: float):
    """A fired watch only leaves fired_awaiting_delivery once delivered_at is set.
    Returns (action, watch): keep | deregister | rearm | repost."""
    if w.state != "fired_awaiting_delivery" or w.fired_msg_id is None:
        return "keep", w
    delivered_at = delivery_checker(w.fired_msg_id)
    if delivered_at is None:
        # still undelivered — re-POST after a window rather than let it vanish.
        if now - w.fired_at >= DELIVERY_REPOST_AFTER:
            return "repost", w
        return "keep", w
    # delivered.
    if w.repeat == "always":
        w.state = "armed"
        w.fired_msg_id = None
        w.fire_epoch = 0.0               # next fire is a fresh episode (new dedup key)
        w.next_due = now + w.interval_sec
        return "rearm", w
    w.state = "deregistered"
    return "deregister", w


def _backoff(w: Watch) -> float:
    return min(w.interval_sec * (BACKOFF_FACTOR ** min(w.fail_count, 16)), w.backoff_max)


def _render(w: Watch, now: float, result: Any = "") -> str:
    # Explicit token replace, NOT str.format: agent-authored content must never
    # reach a format string, so `{result.__class__...}` introspection can't resolve.
    out = w.on_fire_content
    for tok, val in (("{result}", str(result)), ("{id}", w.id), ("{now}", str(int(now)))):
        out = out.replace(tok, val)
    return out


# --- POLL checks (gate 5: http | shell | file_mtime) ------------------------
def run_check(w: Watch) -> "tuple[bool, str]":
    """Return (fired, result_str). fired reflects fire_when (match/nomatch)."""
    c = w.check
    t = c["type"]
    try:
        if t == "http":
            req = urllib.request.Request(c["url"], headers=c.get("headers", {}))
            with urllib.request.urlopen(req, timeout=c.get("timeout", 10)) as r:
                body = r.read(65536).decode("utf-8", "replace")
                ok = r.status == c.get("expect_status", 200)
                if "expect_body_contains" in c:
                    ok = ok and (c["expect_body_contains"] in body)
                result = body[:200]
        elif t == "shell":
            p = subprocess.run(c["cmd"], capture_output=True, text=True,
                               timeout=c.get("timeout", 30))
            ok = p.returncode == c.get("expect_exit", 0)
            if "expect_stdout_contains" in c:
                ok = ok and (c["expect_stdout_contains"] in p.stdout)
            result = (p.stdout or p.stderr)[:200]
        elif t == "file_mtime":
            m = os.path.getmtime(c["path"])
            ok = m > c.get("newer_than_epoch", 0)
            result = f"mtime={m}"
        else:
            return False, f"unknown check type {t}"
    except Exception as e:  # noqa: BLE001 — a failing check backs off, never crashes
        w.last_error = f"check error: {e}"
        return False, str(e)
    fired = ok if w.fire_when == "match" else (not ok)
    w.last_check_ok = ok
    return fired, result


# --- Real IO (prod poster + delivery checker) -------------------------------
def _api_base() -> str:
    return os.environ.get("WATCHD_API_BASE", "http://192.168.10.162:3430")


def _bearer() -> str:
    root = os.environ["OFFICE_TENANT_ROOT"]
    with open(os.path.join(root, "store", ".dashboard-token")) as f:  # perms 600, owner szoszo
        return f.read().strip()


def make_poster() -> Poster:
    def post(to: str, content: str, dedup: str):
        body = json.dumps({"from": "watchd", "to": to, "content": content,
                           "dedup_key": dedup}).encode()
        req = urllib.request.Request(
            _api_base() + "/api/messages", data=body, method="POST",
            headers={"Authorization": f"Bearer {_bearer()}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode())
            return r.status, data.get("id")
    return post


def _find_delivered_at(messages: list, msg_id: int) -> Optional[float]:
    """Pure: pull delivered_at for msg_id out of an /api/messages payload.
    Absent id or null delivered_at -> None (fail toward keep-watching, never a
    false-confirm)."""
    for m in messages:
        if m.get("id") == msg_id:
            return m.get("delivered_at")
    return None


def make_delivery_checker() -> DeliveryChecker:
    """Delivery confirmation via the runtime API — the runtime is the ONLY DB
    authority. watchd NEVER opens the engine's sqlite (direct-sqlite fork-drift is
    what killed claudeclaw.db). The wake POST returns an agent_messages id; GET
    /api/messages exposes that row's `delivered_at`, same id space, no DB touch.

    The network GET is GUARDED: an API blip (routine on a deploy/repo-update
    restart) must NOT crash watchd — a reliability daemon can't be fragile to the
    very restarts it exists to survive. On any error the check returns None
    (treated as not-yet-delivered), so the watch simply retries next loop."""
    def check(msg_id: int) -> Optional[float]:
        try:
            req = urllib.request.Request(_api_base() + "/api/messages?from=watchd",
                                         headers={"Authorization": f"Bearer {_bearer()}"})
            with urllib.request.urlopen(req, timeout=10) as r:
                return _find_delivered_at(json.loads(r.read().decode()), msg_id)
        except Exception as e:  # noqa: BLE001 — API blip => undelivered, retry; never crash
            log.warning("delivery-check GET failed (treating as undelivered): %s", e)
            return None
    return check


# --- Daemon -----------------------------------------------------------------
def watches_dir() -> str:
    return os.path.join(os.environ["OFFICE_TENANT_ROOT"], "store", "watches")


def status_path() -> str:
    return os.path.join(os.environ["OFFICE_TENANT_ROOT"], "store", "watchd-status.json")


def load_registry(now: float) -> "dict[str, Watch]":
    d = watches_dir()
    qdir = os.path.join(d, "quarantine")
    os.makedirs(qdir, exist_ok=True)
    out: dict[str, Watch] = {}
    for name in os.listdir(d):
        if not name.endswith(".json"):
            continue
        path = os.path.join(d, name)
        try:
            with open(path) as f:
                raw = json.load(f)
            w = load_watch(raw, now)
            note = authz_note(w)
            if note:
                log.warning("authz: %s", note)
            out[w.id] = w
        except Exception as e:  # noqa: BLE001 — quarantine, never crash (gate 3)
            log.error("quarantining malformed watch %s: %s", name, e)
            try:
                os.rename(path, os.path.join(qdir, name))
            except OSError:
                pass
    return out


def write_status(reg: "dict[str, Watch]") -> None:
    snap = {"updated_at": time.time(), "count": len(reg), "watches": [
        {"id": w.id, "owner": w.owner_agent, "state": w.state, "next_due": w.next_due,
         "last_check_ok": w.last_check_ok, "last_error": w.last_error,
         "expires_at": w.expires_at, "fired_msg_id": w.fired_msg_id} for w in reg.values()]}
    tmp = status_path() + ".tmp"
    with open(tmp, "w") as f:
        json.dump(snap, f, indent=1)
    os.rename(tmp, status_path())


def deregister(w: Watch) -> None:
    p = os.path.join(watches_dir(), f"{w.id}.json")
    try:
        os.remove(p)
    except OSError:
        pass


def main() -> None:  # pragma: no cover — the IO loop; logic is unit-tested above
    logging.basicConfig(level=logging.INFO, format="%(asctime)s watchd %(levelname)s %(message)s")
    poster, checker = make_poster(), make_delivery_checker()
    log.info("watchd started; registry=%s", watches_dir())
    while True:
        now = time.time()
        wdir = watches_dir()
        reg = load_registry(now)
        # no-hog: GLOBAL_CHECKS_PER_MIN is not yet ENFORCED (fast-follow, tracked).
        # Make a runaway VISIBLE not silent: warn if the aggregate armed check-rate
        # would cross the declared budget. TODO(watchd-v2): throttle instead of warn.
        _rate = sum(60.0 / max(w.interval_sec, 1) for w in reg.values() if w.state == "armed")
        if _rate > GLOBAL_CHECKS_PER_MIN:
            log.warning("aggregate check-rate %.0f/min exceeds budget %d/min -- throttle is a v2 fast-follow", _rate, GLOBAL_CHECKS_PER_MIN)
        for w in list(reg.values()):
          # Defense in depth: one watch's unexpected error must never kill the
          # daemon or starve the other watches — log it and move on.
          try:
            if is_expired(w, now) and w.state != "fired_awaiting_delivery":
                log.info("watch %s expired unfired -> deregister", w.id)
                deregister(w)
                continue
            if w.state == "fired_awaiting_delivery":
                action, w = reconcile_delivery(w, checker, now)
                if action == "deregister":
                    deregister(w)
                    continue
                if action == "repost":
                    # The event already fired; re-SEND the wake (idempotent via the
                    # stable dedup_key), do NOT re-evaluate the condition — a one-shot
                    # condition may no longer be true and the wake would be lost.
                    log.warning("watch %s wake undelivered -> re-POST", w.id)
                    w = fire(w, poster, now)
                persist_runtime(w, wdir)
                continue
            if w.state == "armed" and now >= w.next_due:
                fired, _ = run_check(w)
                if fired:
                    log.info("watch %s FIRED -> wake %s", w.id, w.on_fire_to)
                    if not w.fire_epoch:            # persist the dedup anchor BEFORE the
                        w.fire_epoch = now          # POST, so a crash in the POST->persist
                        persist_runtime(w, wdir)    # window can't lose it and double-wake.
                    w = fire(w, poster, now)
                else:
                    w.next_due = now + w.interval_sec
                persist_runtime(w, wdir)
          except Exception as e:  # noqa: BLE001 — never let one watch crash the loop
            log.error("watch %s tick error (skipped): %s", getattr(w, "id", "?"), e)
        write_status(reg)
        # sleep until the next due watch, capped so new registrations are noticed.
        due = [w.next_due for w in reg.values() if w.state == "armed"]
        sleep = RELOAD_INTERVAL if not due else max(1.0, min(RELOAD_INTERVAL, min(due) - time.time()))
        time.sleep(sleep)


if __name__ == "__main__":  # pragma: no cover
    main()
