"""Publication retries run without requiring new cloudflared log lines."""
import threading
import tunnel_sync as tunnel


def test_publication_failure_retries_same_url_until_success():
    now = [0]
    calls = []
    def publish(url):
        calls.append(url)
        return len(calls) == 3
    worker = tunnel.TunnelPublisher(publish, lambda: now[0])
    worker.set_url('https://first.trycloudflare.com')
    assert worker.publish_due()
    assert not worker.publish_due()
    now[0] = 5
    assert worker.publish_due()
    now[0] = 15
    assert worker.publish_due()
    now[0] = 1000
    assert not worker.publish_due()
    assert calls == ['https://first.trycloudflare.com'] * 3


def test_rotated_url_replaces_failure_and_resets_backoff():
    calls = []
    worker = tunnel.TunnelPublisher(lambda url: calls.append(url) or False, lambda: 0)
    worker.set_url('https://old.trycloudflare.com')
    worker.publish_due()
    worker.set_url('https://new.trycloudflare.com')
    worker.publish_due()
    assert calls == ['https://old.trycloudflare.com', 'https://new.trycloudflare.com']
    assert worker.next_attempt == 5


def test_rotation_during_publication_does_not_mark_new_url_as_published():
    calls = []
    def publish(url):
        calls.append(url)
        if len(calls) == 1: worker.set_url('https://new.trycloudflare.com')
        return True
    worker = tunnel.TunnelPublisher(publish, lambda: 0)
    worker.set_url('https://old.trycloudflare.com')
    worker.publish_due()
    worker.publish_due()
    assert len(calls) == 2
    assert worker.next_attempt is None


def test_transport_exception_keeps_publication_retryable():
    worker = tunnel.TunnelPublisher(lambda _: (_ for _ in ()).throw(TimeoutError()), lambda: 0)
    worker.set_url('https://first.trycloudflare.com')
    worker.publish_due()
    assert worker.next_attempt == 5
    worker.stop()
    assert not worker.publish_due()


def test_background_worker_publishes_and_stops_cleanly():
    sent = threading.Event()
    worker = tunnel.TunnelPublisher(lambda _: sent.set() or True)
    worker.start()
    try:
        worker.set_url('https://first.trycloudflare.com')
        assert sent.wait(2)
    finally:
        worker.stop()
    assert not worker.thread.is_alive()
