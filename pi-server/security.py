"""Local credential loading and bounded request admission."""
from collections import OrderedDict
from pathlib import Path
import json
import os
import threading
import time


def load_security_config():
    # Provision outside the checkout; this file must never enter source control.
    path = Path(os.getenv('LPMAS_SECURITY_FILE', str(Path.home() / '.config/lpmas/security.json')))
    if not path.exists(): return {}
    if path.stat().st_mode & 0o077:
        raise RuntimeError('Security configuration must be readable only by its owner (chmod 600)')
    value = json.loads(path.read_text())
    if not isinstance(value, dict): raise RuntimeError('Invalid security configuration')
    return value


class RequestLimiter:
    """Token buckets with a fixed memory bound; no attacker-controlled growth."""
    def __init__(self, capacity=4096, clock=None):
        self.capacity = capacity
        self.clock = clock or time.monotonic
        self.buckets = OrderedDict()
        self.lock = threading.Lock()

    def allow(self, key, per_minute):
        with self.lock:
            now = self.clock()
            tokens, updated = self.buckets.pop(key, (float(per_minute), now))
            tokens = min(per_minute, tokens + max(0, now-updated) * per_minute / 60)
            accepted = tokens >= 1
            self.buckets[key] = (tokens-1 if accepted else tokens, now)
            while len(self.buckets) > self.capacity: self.buckets.popitem(last=False)
            return accepted
