from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

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
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'): value = value[1:-1]
                os.environ.setdefault(key, value)
    except Exception as error:
        print(f"[ENV ERROR] {error}")


load_env_file()
LPMAS_TIMEZONE = ZoneInfo(os.getenv("LPMAS_TIMEZONE", "Asia/Manila"))
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY", "")


def now_iso(): return datetime.now(LPMAS_TIMEZONE).isoformat(timespec="seconds")
def supabase_configured(): return bool(SUPABASE_URL and SUPABASE_SECRET_KEY)


def supabase_request(table, payload, on_conflict):
    if not supabase_configured(): raise RuntimeError("Supabase environment variables are not configured")
    query = urllib.parse.urlencode({"on_conflict": on_conflict}); url = f"{SUPABASE_URL}/rest/v1/{table}?{query}"; body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST"); req.add_header("apikey", SUPABASE_SECRET_KEY); req.add_header("Authorization", f"Bearer {SUPABASE_SECRET_KEY}"); req.add_header("Content-Type", "application/json"); req.add_header("Prefer", "resolution=merge-duplicates,return=minimal")
    try:
        with urllib.request.urlopen(req, timeout=20) as response: return response.status
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace"); raise RuntimeError(f"Supabase HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error: raise RuntimeError(f"Supabase connection failed: {error.reason}") from error


def push_tunnel_url(url):
    try:
        status = supabase_request("system_settings", [{"key": "pi_api_url", "value": url, "updated_at": now_iso()}], "key")
        print(f"[TUNNEL SYNC] pushed pi_api_url={url} status={status}")
    except RuntimeError as error:
        print(f"[TUNNEL SYNC ERROR] {error}")


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
    last_url = None
    try:
        for line in process.stdout:
            print(line, end="")
            match = TUNNEL_URL_PATTERN.search(line)
            if match:
                url = match.group(0)
                if url != last_url:
                    last_url = url
                    print(f"[TUNNEL SYNC] detected new tunnel URL: {url}")
                    if supabase_configured(): push_tunnel_url(url)
                    else: print("[TUNNEL SYNC ERROR] SUPABASE_URL/SUPABASE_SECRET_KEY missing, cannot publish URL")
    finally:
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