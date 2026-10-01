from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from security import load_security_config
from cloud_gateway import gateway_request

BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR / ".env"
LOCAL_TARGET = "http://localhost:5000"
TUNNEL_URL_PATTERN = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")
RESTART_DELAY_SECONDS = 5


def load_env_file():
    if not ENV_PATH.exists(): return
    try:
        with ENV_PATH.open("r", encoding="utf-8") as file:
            for line in file:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line: continue
                key, value = line.split("=", 1)
                key, value = key.strip(), value.strip()
                if key not in ('SUPABASE_URL', 'LPMAS_TIMEZONE', 'LPMAS_PI_TOKEN', 'LPMAS_SECURITY_FILE'): continue
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'): value = value[1:-1]
                os.environ.setdefault(key, value)
    except Exception as error:
        print(f"[ENV ERROR] {error}")


load_env_file()
LPMAS_TIMEZONE = ZoneInfo(os.getenv("LPMAS_TIMEZONE", "Asia/Manila"))
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SECURITY = load_security_config()
PI_TOKEN = os.getenv("LPMAS_PI_TOKEN", SECURITY.get("pi_token", ""))


def now_iso(): return datetime.now(LPMAS_TIMEZONE).isoformat(timespec="seconds")
def supabase_configured(): return bool(SUPABASE_URL and PI_TOKEN)


def supabase_request(table, payload, on_conflict):
    if not supabase_configured(): raise RuntimeError("Scoped Pi cloud access is not provisioned")
    if table != 'system_settings' or len(payload) != 1 or payload[0].get('key') != 'pi_api_url':
        raise ValueError('Only tunnel publication is permitted')
    gateway_request(f'{SUPABASE_URL}/functions/v1/pi-gateway', PI_TOKEN, 'publish-tunnel', url=payload[0]['value'])
    return 200


def push_tunnel_url(url):
    try:
        status = supabase_request("system_settings", [{"key": "pi_api_url", "value": url, "updated_at": now_iso()}], "key")
        print(f"[TUNNEL SYNC] pushed pi_api_url={url} status={status}")
        return True
    except RuntimeError as error:
        print(f"[TUNNEL SYNC ERROR] {error}")
        return False


class TunnelPublisher:
    """Retry the latest discovered URL independently of cloudflared output.

    One worker serializes publications. Rotation replaces the pending URL, and
    shutdown joins the worker before another tunnel can start publishing.
    """
    def __init__(self, publish=None, clock=None):
        self.publish = publish or push_tunnel_url
        self.clock = clock or time.monotonic
        self.condition = threading.Condition()
        self.url = None
        self.next_attempt = None
        self.attempts = 0
        self.stopped = False
        self.thread = None

    def set_url(self, url):
        with self.condition:
            if url == self.url or self.stopped: return
            self.url = url
            self.attempts = 0
            self.next_attempt = self.clock()
            self.condition.notify_all()

    def publish_due(self):
        with self.condition:
            if self.stopped or self.next_attempt is None or self.clock() < self.next_attempt:
                return False
            url = self.url
        try:
            accepted = self.publish(url)
        except Exception as error:
            print(f"[TUNNEL SYNC ERROR] publication failed: {type(error).__name__}")
            accepted = False
        with self.condition:
            if self.url == url:
                self.attempts += 1
                self.next_attempt = None if accepted else self.clock() + min(60, 5 * 2 ** min(self.attempts - 1, 4))
        return True

    def run(self):
        while True:
            with self.condition:
                if self.stopped: return
                delay = None if self.next_attempt is None else max(0, self.next_attempt - self.clock())
                if delay is None or delay > 0:
                    self.condition.wait(delay)
                    continue
            self.publish_due()

    def start(self):
        self.thread = threading.Thread(target=self.run, name="tunnel-publication", daemon=True)
        self.thread.start()

    def stop(self):
        with self.condition:
            self.stopped = True
            self.condition.notify_all()
        if self.thread: self.thread.join()


def run_tunnel_once():
    """
    Launches a Cloudflare Quick Tunnel pointed at the local Flask app and
    streams its output looking for the assigned trycloudflare.com URL.
    Blocks until the cloudflared process exits (crash, network drop, etc).
    """
    process = subprocess.Popen(
        ["cloudflared", "tunnel", "--url", LOCAL_TARGET],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    publisher = TunnelPublisher()
    publisher.start()
    try:
        for line in process.stdout:
            print(line, end="")
            match = TUNNEL_URL_PATTERN.search(line)
            if match:
                url = match.group(0)
                if url != publisher.url:
                    print(f"[TUNNEL SYNC] detected new tunnel URL: {url}")
                    publisher.set_url(url)
    finally:
        publisher.stop()
        process.wait()
    return process.returncode


def main():
    print(f"[TUNNEL SYNC] starting Cloudflare Quick Tunnel for {LOCAL_TARGET}")
    while True:
        exit_code = run_tunnel_once()
        print(f"[TUNNEL SYNC] cloudflared exited (code={exit_code}), restarting in {RESTART_DELAY_SECONDS}s")
        time.sleep(RESTART_DELAY_SECONDS)


if __name__ == "__main__":
    main()
