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
        "check": {"type": "http", "url": "http://localhost:8082/x", "expect_body_contains": "valid"},
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

    def test_repost_failure_keeps_fired_state(self):
        # A failed RE-POST must stay fired_awaiting_delivery (retry delivery), never
        # revert to armed and re-evaluate the one-shot condition.
        w = watchd.load_watch(base_watch(), now=NOW)
        w = watchd.fire(w, lambda to, c, d: (200, 5), now=NOW)      # first fire ok
        self.assertEqual(w.state, "fired_awaiting_delivery")
        w = watchd.fire(w, lambda to, c, d: (500, None), now=NOW + 130)  # repost fails
        self.assertEqual(w.state, "fired_awaiting_delivery")
        self.assertEqual(w.fire_epoch, NOW)                         # dedup anchor unchanged

    def test_render_is_not_a_format_string(self):
        # Agent content must never reach str.format -> introspection can't resolve.
        w = watchd.load_watch(base_watch(on_fire={"content": "x {result.__class__} {result}"}), now=NOW)
        out = watchd._render(w, NOW, result="hi")
        self.assertIn("{result.__class__}", out)   # left literal, not resolved
        self.assertIn("hi", out)                    # the real token IS substituted

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


class DeliveryCheckResolution(unittest.TestCase):
    def test_find_delivered_at_by_id(self):
        msgs = [{"id": 9, "delivered_at": None}, {"id": 42, "delivered_at": 1785445000},
                {"id": 7, "delivered_at": 1785440000}]
        self.assertEqual(watchd._find_delivered_at(msgs, 42), 1785445000)

    def test_find_delivered_at_undelivered_is_none(self):
        self.assertIsNone(watchd._find_delivered_at([{"id": 42, "delivered_at": None}], 42))

    def test_find_delivered_at_absent_id_is_none(self):
        # id not in the (paginated) window -> None -> KEEP, never false-confirm/deregister.
        self.assertIsNone(watchd._find_delivered_at([{"id": 9, "delivered_at": 1}], 42))


class NoHogGuards(unittest.TestCase):
    def test_interval_floored_to_min(self):
        w = watchd.load_watch(base_watch(cadence={"interval_sec": 5}), now=NOW)
        self.assertGreaterEqual(w.interval_sec, watchd.MIN_INTERVAL)


class RuntimePersistence(unittest.TestCase):
    def test_fired_state_restored_from_rt_across_reload(self):
        # A watch that fired must NOT reload as `armed` and re-fire — its runtime
        # state persists via the `_rt` key (survives loop reloads + restarts).
        raw = base_watch()
        raw["_rt"] = {"state": "fired_awaiting_delivery", "fired_msg_id": 99,
                      "fired_at": NOW, "next_due": NOW + 300, "fail_count": 0}
        w = watchd.load_watch(raw, now=NOW)
        self.assertEqual(w.state, "fired_awaiting_delivery")
        self.assertEqual(w.fired_msg_id, 99)


if __name__ == "__main__":
    unittest.main()
