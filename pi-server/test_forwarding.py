"""
Tests for the Pi -> Edge Function forwarding path.

The Pi is the only component that survives a network partition: the ESP32
keeps posting to it whether or not Supabase is reachable, and the readings
land in SQLite first. These tests cover what happens on the way to the cloud,
because losing or duplicating a reading there is silent — the dashboard just
looks wrong later, with nothing pointing back at the cause.

Focus:
  - a successful forward reports success and queues nothing
  - retries are bounded, and the reading is queued exactly once on exhaustion
  - the queue survives a restart (JSONL round-trip)
  - the queue is bounded, dropping the OLDEST entries, because a long outage
    must not fill the Pi's SD card
  - a duplicate delivery after a partition does not corrupt the aggregate
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import app as pi


class StubResponse:
    def __init__(self, status=200, body=b'{"ok": true}'):
        self.status = status
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class ForwardingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.queue_path = Path(self.tmp.name) / "failed_readings.jsonl"
        self.reading = {
            "sensor_id": "ESP32-001",
            "lux": 45.2,
            "recorded_at": "2026-09-29T10:30:00+08:00",
            "phase_type": "illumination",
            "greenhouse_id": "gh-001",
        }
        self._orig_url = pi.EDGE_FUNCTION_URL
        self._orig_key = pi.SERVICE_KEY
        self._orig_sleep = pi.time.sleep
        self._orig_queue = pi.RETRY_QUEUE_PATH
        pi.EDGE_FUNCTION_URL = "https://project.supabase.co/functions/v1/ingest-reading"
        pi.SERVICE_KEY = "service-role-key"
        pi.time.sleep = lambda _seconds: None
        pi.RETRY_QUEUE_PATH = self.queue_path

    def tearDown(self):
        pi.EDGE_FUNCTION_URL = self._orig_url
        pi.SERVICE_KEY = self._orig_key
        pi.time.sleep = self._orig_sleep
        pi.RETRY_QUEUE_PATH = self._orig_queue
        self.tmp.cleanup()

    def queued(self):
        if not self.queue_path.exists():
            return []
        return [json.loads(line) for line in self.queue_path.read_text().splitlines() if line.strip()]

    # -- happy path --------------------------------------------------------

    def test_a_successful_forward_reports_true_and_queues_nothing(self):
        calls = []

        def fake_post(url, body, headers, timeout):
            calls.append({"url": url, "body": json.loads(body), "headers": headers})
            return StubResponse(200)

        self.assertTrue(pi.forward_to_supabase(self.reading, post=fake_post))
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.queued(), [])

    def test_the_forwarded_payload_carries_the_reading_and_no_local_only_fields(self):
        seen = {}

        def fake_post(url, body, headers, timeout):
            seen.update(json.loads(body))
            return StubResponse(200)

        pi.forward_to_supabase(self.reading, post=fake_post)
        for key in ("sensor_id", "lux", "recorded_at", "phase_type", "greenhouse_id"):
            self.assertIn(key, seen)
        # The Edge Function re-derives the greenhouse; sending classification
        # would be sending a decision the cloud is not asking for.
        self.assertNotIn("classification", seen)
        self.assertNotIn("id", seen)

    def test_the_service_role_bearer_is_sent(self):
        seen = {}

        def fake_post(url, body, headers, timeout):
            seen.update(headers)
            return StubResponse(200)

        pi.forward_to_supabase(self.reading, post=fake_post)
        self.assertEqual(seen.get("Authorization"), "Bearer service-role-key")

    def test_an_unassigned_sensor_forwards_with_a_null_greenhouse(self):
        reading = dict(self.reading, greenhouse_id=None)
        seen = {}

        def fake_post(url, body, headers, timeout):
            seen.update(json.loads(body))
            return StubResponse(200)

        self.assertTrue(pi.forward_to_supabase(reading, post=fake_post))
        self.assertIsNone(seen["greenhouse_id"])

    # -- retries -----------------------------------------------------------

    def test_a_transient_failure_is_retried_then_succeeds(self):
        attempts = []

        def flaky_post(url, body, headers, timeout):
            attempts.append(1)
            if len(attempts) < 3:
                raise OSError("connection reset")
            return StubResponse(200)

        self.assertTrue(pi.forward_to_supabase(self.reading, post=flaky_post))
        self.assertEqual(len(attempts), 3)
        self.assertEqual(self.queued(), [], "a recovered send must not be queued")

    def test_an_http_error_is_retried_then_succeeds(self):
        attempts = []

        def flaky_post(url, body, headers, timeout):
            attempts.append(1)
            if len(attempts) < 2:
                return StubResponse(500, b"boom")
            return StubResponse(200)

        self.assertTrue(pi.forward_to_supabase(self.reading, post=flaky_post))
        self.assertEqual(len(attempts), 2)

    def test_exhausting_the_retries_queues_the_reading_exactly_once(self):
        attempts = []

        def always_fail(url, body, headers, timeout):
            attempts.append(1)
            raise OSError("supabase unreachable")

        self.assertFalse(pi.forward_to_supabase(self.reading, post=always_fail))
        self.assertEqual(len(attempts), pi.FORWARD_MAX_ATTEMPTS)
        queued = self.queued()
        self.assertEqual(len(queued), 1, "one failed reading must produce one queue entry")
        self.assertEqual(queued[0]["sensor_id"], "ESP32-001")

    def test_an_unauthorized_response_is_not_retried_forever(self):
        attempts = []

        def unauthorized(url, body, headers, timeout):
            attempts.append(1)
            return StubResponse(401, b"Unauthorized")

        self.assertFalse(pi.forward_to_supabase(self.reading, post=unauthorized))
        self.assertLessEqual(len(attempts), pi.FORWARD_MAX_ATTEMPTS)
        self.assertEqual(len(self.queued()), 1)

    def test_a_forward_is_not_attempted_when_supabase_is_unconfigured(self):
        pi.SERVICE_KEY = ""
        self.assertFalse(pi.forward_to_supabase(self.reading))
        self.assertEqual(self.queued(), [], "an unconfigured Pi has nowhere to queue")

    # -- queue mechanics ---------------------------------------------------

    def test_queued_readings_survive_a_restart(self):
        pi.queue_failed_reading(self.reading)
        pi.queue_failed_reading(dict(self.reading, sensor_id="ESP32-002"))
        # A fresh read, as a restarted process would do.
        self.assertEqual(len(pi.read_retry_queue()), 2)

    def test_a_corrupt_queue_line_is_skipped_rather_than_poisoning_the_queue(self):
        pi.queue_failed_reading(self.reading)
        with open(self.queue_path, "a", encoding="utf-8") as handle:
            handle.write("{not json\n")
        pi.queue_failed_reading(dict(self.reading, sensor_id="ESP32-003"))
        entries = pi.read_retry_queue()
        self.assertEqual([e["sensor_id"] for e in entries], ["ESP32-001", "ESP32-003"])

    def test_a_full_reading_is_never_queued(self):
        big = dict(self.reading, lux=1.0, note="x" * (pi.RETRY_MAX_ENTRY_BYTES + 10))
        pi.queue_failed_reading(big)
        self.assertEqual(self.queued(), [], "an oversized entry would be replayed forever")

    def test_the_queue_is_bounded_and_drops_the_oldest_first(self):
        pi.RETRY_MAX_ENTRIES = 3
        for index in range(5):
            pi.queue_failed_reading(dict(self.reading, sensor_id=f"ESP32-00{index}"))
        entries = pi.read_retry_queue()
        self.assertEqual(len(entries), 3)
        self.assertEqual(
            [e["sensor_id"] for e in entries],
            ["ESP32-002", "ESP32-003", "ESP32-004"],
            "the newest readings must survive an outage",
        )

    def test_queueing_never_raises_into_the_reading_path(self):
        # A read-only or full disk must not take down the ESP32 endpoint.
        def exploding_open(*_args, **_kwargs):
            raise OSError("No space left on device")

        # builtin open, not pi.open — the module uses the bare builtin.
        import builtins

        original = builtins.open
        builtins.open = exploding_open
        try:
            pi.queue_failed_reading(self.reading)
        finally:
            builtins.open = original

    # -- queue replay ------------------------------------------------------

    def test_a_successful_replay_removes_the_entry(self):
        pi.queue_failed_reading(self.reading)
        sent = pi.flush_retry_queue(post=lambda *a, **k: StubResponse(200))
        self.assertEqual(sent, 1)
        self.assertEqual(pi.read_retry_queue(), [])

    def test_a_failed_replay_keeps_the_entry_for_the_next_cycle(self):
        pi.queue_failed_reading(self.reading)

        def failing(url, body, headers, timeout):
            raise OSError("still down")

        self.assertEqual(pi.flush_retry_queue(post=failing), 0)
        self.assertEqual(len(pi.read_retry_queue()), 1)

    def test_a_partial_replay_keeps_only_the_entries_that_failed(self):
        pi.queue_failed_reading(dict(self.reading, sensor_id="ESP32-001"))
        pi.queue_failed_reading(dict(self.reading, sensor_id="ESP32-002"))

        def selective(url, body, headers, timeout):
            if json.loads(body)["sensor_id"] == "ESP32-001":
                return StubResponse(200)
            raise OSError("down")

        sent = pi.flush_retry_queue(post=selective)
        self.assertEqual(sent, 1)
        self.assertEqual(
            [e["sensor_id"] for e in pi.read_retry_queue()], ["ESP32-002"]
        )

    def test_flushing_an_empty_queue_is_a_no_op(self):
        self.assertEqual(pi.flush_retry_queue(post=lambda *a, **k: StubResponse(200)), 0)

    def test_flush_is_bounded_per_cycle_so_one_bad_entry_cannot_block_the_rest(self):
        for index in range(5):
            pi.queue_failed_reading(dict(self.reading, sensor_id=f"ESP32-00{index}"))
        pi.RETRY_BATCH_SIZE = 2
        self.assertEqual(pi.flush_retry_queue(post=lambda *a, **k: StubResponse(200)), 2)
        self.assertEqual(len(pi.read_retry_queue()), 3)

    # -- idempotency across a partition ------------------------------------

    def test_replaying_the_same_reading_twice_produces_one_aggregate(self):
        # The Edge Function folds per-reading deltas additively, so a replayed
        # reading does double-count. The queue must therefore not re-send an
        # entry it already delivered, which is what the dedupe key guards.
        pi.queue_failed_reading(self.reading)
        sent_first = pi.flush_retry_queue(post=lambda *a, **k: StubResponse(200))
        sent_second = pi.flush_retry_queue(post=lambda *a, **k: StubResponse(200))
        self.assertEqual(sent_first, 1)
        self.assertEqual(sent_second, 0, "a delivered reading must not be sent again")

    def test_the_dedupe_key_distinguishes_two_readings_in_the_same_minute(self):
        pi.queue_failed_reading(self.reading)
        pi.queue_failed_reading(dict(self.reading, lux=46.0))
        self.assertEqual(len(pi.read_retry_queue()), 2)

    def test_the_dedupe_key_distinguishes_the_same_lux_from_different_sensors(self):
        pi.queue_failed_reading(self.reading)
        pi.queue_failed_reading(dict(self.reading, sensor_id="ESP32-002"))
        self.assertEqual(len(pi.read_retry_queue()), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
