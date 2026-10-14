"""Establish per-boot clock trust from a synchronized system clock or kernel RTC."""
from pathlib import Path
import json
import os
import sqlite3
import re
import shutil
import subprocess
import time


def clock_source_ready():
    rtc = Path('/sys/class/rtc/rtc0/hctosys')
    trusted = Path('/run/systemd/timesync/synchronized').exists() or (rtc.exists() and rtc.read_text().strip() == '1')
    if not trusted and shutil.which('chronyc'):
        try:
            tracking = subprocess.run(['chronyc', 'tracking'], capture_output=True, text=True, timeout=2,
                env={**os.environ, 'LC_ALL':'C'}).stdout
            stratum = re.search(r'^Stratum\s*:\s*(\d+)', tracking, re.MULTILINE)
            trusted = bool(stratum and 0 < int(stratum.group(1)) < 10 and re.search(r'^Leap status\s*:\s*Normal', tracking, re.MULTILINE))
        except (OSError, subprocess.TimeoutExpired):
            pass
    return trusted


def boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def establish(config, database):
    if config.get('enabled') is not True:
        return False
    marker = Path(config.get('clock_ready_file', '/run/lpmas/clock-ready'))
    now = time.time()
    trusted = clock_source_ready()
    monotonic = time.monotonic()
    boot = boot_id()
    if not trusted and marker.exists():
        # A verified clock remains useful during WAN loss while the same Pi stays
        # powered. Reboots and wall-clock jumps cannot inherit this trust.
        try:
            previous = json.loads(marker.read_text())
            trusted = (previous['boot_id'] == boot and monotonic >= previous['monotonic'] and
                abs(now-(previous['wall_time']+monotonic-previous['monotonic'])) <= 5)
        except (ValueError, KeyError, TypeError):
            pass
    floor = 1767225600
    if database.exists():
        with sqlite3.connect(database) as conn:
            try:
                last = conn.execute('SELECT MAX(recorded_at_epoch) FROM readings').fetchone()[0]
                floor = max(floor, (last or 0)-5)
            except sqlite3.OperationalError:
                pass
    if not trusted or now < floor:
        if marker.exists():
            marker.unlink()
        return False
    marker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    pending = marker.with_suffix('.tmp')
    pending.write_text(json.dumps({'boot_id':boot,'wall_time':now,'monotonic':monotonic}))
    pending.chmod(0o600)
    pending.replace(marker)
    return True


if __name__ == '__main__':
    from security import load_security_config
    config = load_security_config().get('local_sms', {})
    ok = establish(config, Path(__file__).parent/'lpmas.db')
    print('Local clock trusted' if ok else 'Local clock not ready; local readings and SMS will wait for RTC/time sync')
