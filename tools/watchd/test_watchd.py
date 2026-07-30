"""Red-first tests for watchd, the fleet trigger service.

Encodes the five merge-gate invariants as executable checks. Written BEFORE the
implementation: the delivery-confirm-before-deregister test (gate 1) and the
expiry tests (gate 2) are the ones Michael wants to see fail first. Pure logic,
dependency-injected (poster + delivery_checker are callables), so no network or
DB is touched here.

Run: python3 -m unittest tools.watchd.test_watchd  (or from tools/watchd: python3 -m unittest test_watchd)
"""
import unittest

import watchd  # noqa: E402  — intentionally imported at top; absent until implemented


NOW = 1_785_445_000.0
DAY = 86_400.0


def base_watch(**over):
    w = {
        "id": "kia-tracker-recovered",
        "owner_agent": "dwight",
        "description": "wake me when the Kia modem reconnects",
        "check": {"type": "http", "url": "http://192.168.10.162:8082/x", "expect_body_contains": "valid"},
        "fire_when": "match",
        "cadence": {"interval_sec": 300},
        "on_fire": {"content": "Kia recovered: {result}"},
        "repeat": "once",
        "expires_at": NOW + 2 * DAY,
        "created_at": NOW,
    }
    w.update(over)
    return w


class Gate1DeliveryConfirmBeforeDeregister(unittest.TestCase):
    def test_repeat_once_stays_registered_until_delivered(self):
        w = watchd.load_watch(base_watch(repeat="once"), now=NOW)
        # POST succeeds (200 + msg id) but delivery has NOT been confirmed yet.
        poster = lambda to, content, dedup: (200, 42)
        w = watchd.fire(w, poster, now=NOW)
        self.assertEqual(w.state, "fired_awaiting_delivery")
        self.assertEqual(w.fired_msg_id, 42)

        # delivered_at still None -> the watch MUST be kept, never deregistered.
        action, w = watchd.reconcile_delivery(w, lambda mid: None, now=NOW + 5)
        self.assertEqual(action, "keep")

        # once delivered_at is set, a repeat=once watch deregisters.
        action, w = watchd.reconcile_delivery(w, lambda mid: NOW + 6, now=NOW + 6)
        self.assertEqual(action, "deregister")

    def test_post_failure_does_not_advance_or_drop(self):
        w = watchd.load_watch(base_watch(), now=NOW)
        poster = lambda to, content, dedup: (500, None)  # server rejected
        w = watchd.fire(w, poster, now=NOW)
        # Not delivered, not dropped: stays armed for a backed-off re-POST.
        self.assertNotEqual(w.state, "fired_awaiting_delivery")
        self.assertNotEqual(w.state, "deregistered")

    def test_repeat_always_rearms_only_after_delivery(self):
        w = watchd.load_watch(base_watch(repeat="always"), now=NOW)
        w = watchd.fire(w, lambda to, c, d: (200, 7), now=NOW)
        action, w = watchd.reconcile_delivery(w, lambda mid: None, now=NOW + 1)
        self.assertEqual(action, "keep")
        action, w = watchd.reconcile_delivery(w, lambda mid: NOW + 2, now=NOW + 2)
        self.assertEqual(action, "rearm")
        self.assertEqual(w.state, "armed")


class Gate2Expiry(unittest.TestCase):
    def test_missing_expiry_gets_default_ttl(self):
        raw = base_watch()
        del raw["expires_at"]
        w = watchd.load_watch(raw, now=NOW)
        self.assertAlmostEqual(w.expires_at, NOW + watchd.DEFAULT_TTL, delta=2)

    def test_expiry_clamped_to_max_ttl(self):
        w = watchd.load_watch(base_watch(expires_at=NOW + 100 * DAY), now=NOW)
        self.assertAlmostEqual(w.expires_at, NOW + watchd.MAX_TTL, delta=2)

    def test_is_expired(self):
        past = watchd.load_watch(base_watch(expires_at=NOW - 1), now=NOW)
        self.assertTrue(watchd.is_expired(past, now=NOW))
        future = watchd.load_watch(base_watch(expires_at=NOW + DAY), now=NOW)
        self.assertFalse(watchd.is_expired(future, now=NOW))


class Gate3AuthzAndFailSafe(unittest.TestCase):
    def test_on_fire_to_defaults_to_owner(self):
        w = watchd.load_watch(base_watch(), now=NOW)
        self.assertEqual(w.on_fire_to, "dwight")

    def test_cross_agent_target_is_flagged(self):
        w = watchd.load_watch(base_watch(on_fire={"to": "marveen", "content": "x"}), now=NOW)
        self.assertIsNotNone(watchd.authz_note(w))  # cross-agent -> log warning

    def test_malformed_watch_raises(self):
        bad = base_watch()
        del bad["owner_agent"]
        with self.assertRaises(watchd.InvalidWatch):
            watchd.load_watch(bad, now=NOW)


class NoHogGuards(unittest.TestCase):
    def test_interval_floored_to_min(self):
        w = watchd.load_watch(base_watch(cadence={"interval_sec": 5}), now=NOW)
        self.assertGreaterEqual(w.interval_sec, watchd.MIN_INTERVAL)


if __name__ == "__main__":
    unittest.main()
