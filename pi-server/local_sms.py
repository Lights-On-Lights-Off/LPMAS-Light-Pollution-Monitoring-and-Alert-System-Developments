"""Internet-independent SMSGate worker. Never automatically resubmit a claimed job."""
import base64
import ipaddress
import json
import re
import time
import uuid
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, quote

FRESHNESS_SECONDS = 60
COPY_GAP_SECONDS = 10


def normalize_phone(raw):
    if not isinstance(raw, str):
        return None
    digits = re.sub(r"\D", "", raw)
    if raw.strip().startswith('+') and not digits.startswith('63'):
        return None
    if digits.startswith('63'):
        digits = digits[2:]
    if digits.startswith('0'):
        digits = digits[1:]
    return '+63' + digits if re.fullmatch(r'9[0-9]{9}', digits) else None


def validate_gateway(config):
    url = urlsplit(config.get('url', ''))
    try:
        host = ipaddress.ip_address(url.hostname or '')
        port = url.port
    except ValueError:
        raise ValueError('SMSGate must use a reserved private IPv4 address') from None
    private = any(host in ipaddress.ip_network(cidr) for cidr in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')) if host.version == 4 else False
    if (url.scheme not in ('http', 'https') or not private or url.username or url.password
            or url.path not in ('', '/') or url.query or url.fragment or port is None):
        raise ValueError('SMSGate URL must be a private LAN origin with an explicit port')
    if not config.get('username') or not config.get('password') or ':' in config['username']:
        raise ValueError('Local Server credentials are required')
    return config['url'].rstrip('/')


def clock_ready(config, now=None):
    # /run is cleared on boot. The service preflight establishes trust from RTC
    # or system time synchronization; plausible firmware/build time is insufficient.
    return (now if now is not None else time.time()) >= 1767225600 and Path(
        config.get('clock_ready_file', '/run/lpmas/clock-ready')).is_file()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Gateway:
    def __init__(self, config):
        self.base = validate_gateway(config)
        self.config = config
        self.auth = 'Basic ' + base64.b64encode((config['username'] + ':' + config['password']).encode()).decode()
        # LAN requests must bypass environment proxies; redirects must not carry credentials.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method, path, payload=None):
        body = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(self.base + path, data=body, method=method,
            headers={'Authorization': self.auth, 'Content-Type': 'application/json'})
        with self.opener.open(request, timeout=3) as response:
            data = response.read(65537)
            if len(data) > 65536:
                raise ValueError('Oversized gateway response')
            return json.loads(data) if data else {}

    def health(self):
        return self.request('GET', '/health')

    def send(self, job):
        payload = {'id': job['id'], 'textMessage': {'text': job['message']},
            'phoneNumbers': [job['recipient']], 'withDeliveryReport': True,
            'validUntil': datetime.fromtimestamp(job['expires_at'], timezone.utc).isoformat(timespec='seconds')}
        if self.config.get('sim_number') is not None:
            payload['simNumber'] = int(self.config['sim_number'])
        return self.request('POST', '/message', payload)

    def status(self, message_id):
        return self.request('GET', '/message/' + quote(message_id, safe=''))


def initialize(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS local_sms_config (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL, saved_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS local_sms_events (
            episode_uid TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(episode_uid,event));
        CREATE TABLE IF NOT EXISTS local_sms_jobs (
            id TEXT PRIMARY KEY, episode_uid TEXT NOT NULL, event TEXT NOT NULL,
            send_number INTEGER NOT NULL, recipient TEXT NOT NULL, message TEXT NOT NULL,
            available_at REAL NOT NULL, expires_at REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
            attempted_at REAL, gateway_id TEXT, detail TEXT, version INTEGER NOT NULL DEFAULT 1,
            next_poll_at REAL NOT NULL DEFAULT 0, created_at REAL NOT NULL,
            UNIQUE(episode_uid,event,send_number));
    """)
    # First installation baselines all old episodes. Upgrades cannot replay them.
    initialized = conn.execute("SELECT 1 FROM supabase_sync_state WHERE key='local_sms_initialized'").fetchone()
    if not initialized:
        conn.execute("INSERT OR IGNORE INTO local_sms_events SELECT incident_uid,'opened' FROM greenhouse_alerts")
        conn.execute("INSERT OR IGNORE INTO local_sms_events SELECT incident_uid,'recovered' FROM greenhouse_alerts")
        conn.execute("INSERT INTO supabase_sync_state VALUES ('local_sms_initialized','true')")


def cache_config(conn, snapshot, now=None):
    settings = snapshot.get('local_sms')
    if not isinstance(settings, dict) or settings.get('mode') not in ('cloud', 'local'):
        raise ValueError('Cloud ownership configuration missing; apply migration 0025 first')
    if not isinstance(settings.get('enabled'), bool):
        raise ValueError('Invalid notification enablement')
    phone = normalize_phone(settings.get('recipient', ''))
    if settings['enabled'] and settings['mode'] == 'local' and not phone:
        raise ValueError('A valid manager mobile number is required')
    normalized = {**settings, 'recipient': phone or '', 'timezone': snapshot.get('timezone', 'Asia/Manila')}
    if normalized['timezone'] != 'Asia/Manila':
        raise ValueError('Cloud and Pi monitoring timezone must be Asia/Manila')
    conn.execute('INSERT INTO local_sms_config VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot,saved_at=excluded.saved_at',
        (json.dumps(normalized), now if now is not None else time.time()))


def saved_config(conn):
    row = conn.execute('SELECT * FROM local_sms_config WHERE id=1').fetchone()
    return json.loads(row['snapshot']) if row else {}


def armed(conn, config):
    settings = saved_config(conn)
    return config.get('enabled') is True and settings.get('mode') == 'local' and settings.get('enabled') is True and bool(settings.get('recipient'))


def sync_events(conn, config, now=None):
    now = now if now is not None else time.time()
    settings = saved_config(conn)
    for episode in conn.execute('SELECT * FROM greenhouse_alerts').fetchall():
        if episode['status'] != 'open':
            conn.execute("UPDATE local_sms_jobs SET status='skipped',detail='Opening superseded by closure',version=version+1 WHERE episode_uid=? AND event='opened' AND status='pending'", (episode['incident_uid'],))
        event = 'opened' if episode['status'] == 'open' else 'recovered'
        inserted = conn.execute('INSERT OR IGNORE INTO local_sms_events VALUES (?,?)', (episode['incident_uid'], event)).rowcount
        if not inserted or episode['legacy'] or episode['status'] == 'closed' or not armed(conn, config):
            continue
        stamp = datetime.fromisoformat(episode['opened_at'] if event == 'opened' else episode['resolved_at']).timestamp()
        if not -0.001 <= now - stamp <= FRESHNESS_SECONDS:
            continue
        name = re.sub(r'[^ -~]', '?', episode['greenhouse_id'])[:24]
        text = ('LPMAS ALERT: Greenhouse ' + name + ' has a confirmed light violation.' if event == 'opened' else
            'LPMAS RESOLVED: Greenhouse ' + name + ' has returned to safe light levels.') + ' Incident ' + episode['incident_uid'][:12] + '.'
        enqueue(conn, episode['incident_uid'], event, 1, settings['recipient'], text, min(stamp, now), now)


def enqueue(conn, uid, event, number, recipient, message, due, now):
    conn.execute('INSERT OR IGNORE INTO local_sms_jobs(id,episode_uid,event,send_number,recipient,message,available_at,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        (str(uuid.uuid4()), uid, event, number, recipient, message, due, due+FRESHNESS_SECONDS, now))


def expire(conn, now):
    conn.execute("""UPDATE local_sms_jobs SET status='skipped',detail='Expired or superseded',version=version+1
        WHERE status='pending' AND (expires_at <= ? OR EXISTS (
            SELECT 1 FROM greenhouse_alerts g JOIN greenhouse_alerts newer ON newer.greenhouse_id=g.greenhouse_id
            WHERE g.incident_uid=local_sms_jobs.episode_uid AND newer.opened_at>g.opened_at))""", (now,))


def claim(conn, config, now):
    conn.execute('BEGIN IMMEDIATE')
    sync_events(conn, config, now)
    expire(conn, now)
    job = None
    if armed(conn, config):
        job = conn.execute("SELECT * FROM local_sms_jobs WHERE status='pending' AND available_at<=? ORDER BY available_at,id LIMIT 1", (now,)).fetchone()
    else:
        conn.execute("UPDATE local_sms_jobs SET status='skipped',detail='Local sending disabled',version=version+1 WHERE status='pending'")
    if job:
        # Consume before network I/O. A crash at any point cannot re-POST this job.
        conn.execute("UPDATE local_sms_jobs SET status='unknown',attempts=1,attempted_at=?,gateway_id=id,detail='Submission outcome unconfirmed',version=version+1,next_poll_at=? WHERE id=?", (now, now+5, job['id']))
        if job['event'] == 'opened' and job['send_number'] < 3:
            enqueue(conn, job['episode_uid'], job['event'], job['send_number']+1, job['recipient'], job['message'], now+COPY_GAP_SECONDS, now)
        job = dict(conn.execute('SELECT * FROM local_sms_jobs WHERE id=?', (job['id'],)).fetchone())
    conn.commit()
    return job


def interpret(result, job):
    if not isinstance(result, dict) or result.get('id') != job['gateway_id']:
        return 'unknown', 'Gateway did not confirm the expected message identity'
    recipients = result.get('recipients', [])
    recipient = next((r for r in recipients if isinstance(r, dict) and normalize_phone(r.get('phoneNumber')) == job['recipient']), None)
    if not recipient:
        return 'unknown', 'Gateway did not confirm the expected recipient'
    states = {'Pending': ('accepted', 'Queued by gateway; recipient delivery unconfirmed'),
        'Processed': ('accepted', 'Handed to Android; recipient delivery unconfirmed'),
        'Sent': ('sent', 'Carrier accepted SMS; recipient delivery unconfirmed'),
        'Delivered': ('delivered', 'Recipient delivery reported by gateway'),
        'Failed': ('failed', 'Gateway reported SMS failure'),
        'Cancelled': ('failed', 'Gateway cancelled SMS')}
    return states.get(recipient.get('state'), ('unknown', 'Gateway message state unconfirmed'))


def finish(conn, job, result, now):
    status, detail = result
    # Monotonic evidence: an old Pending response must not downgrade Sent/Delivered.
    current_row = conn.execute('SELECT status,detail FROM local_sms_jobs WHERE id=?', (job['id'],)).fetchone()
    current = current_row['status']
    rank = {'unknown': 0, 'accepted': 1, 'sent': 2, 'delivered': 3, 'failed': 3}
    if rank.get(status, 0) < rank.get(current, 0):
        status, detail = current, current_row['detail']
    conn.execute('UPDATE local_sms_jobs SET version=version+CASE WHEN status<>? OR detail IS NOT ? THEN 1 ELSE 0 END,status=?,detail=?,next_poll_at=? WHERE id=?',
        (status, detail, status, detail, now+(5 if status == 'unknown' else 15), job['id']))
    conn.commit()


def tick(get_db, config, gateway=None, now=None):
    now = now if now is not None else time.time()
    if config.get('enabled') is not True or not clock_ready(config, now):
        return 0
    gateway = gateway or Gateway(config)
    conn = get_db()
    try:
        # A read-only reachability check precedes consuming an attempt.
        try:
            gateway.health()
        except Exception:
            conn.execute('BEGIN IMMEDIATE')
            sync_events(conn, config, now)
            expire(conn, now)
            conn.commit()
            return 0
        job = claim(conn, config, now)
        if job:
            try:
                outcome = interpret(gateway.send(job), job)
            except urllib.error.HTTPError as error:
                outcome = ('failed', 'Gateway rejected submission') if error.code in (400,401,403,422) else ('unknown', 'Submission outcome unconfirmed')
            except Exception:
                outcome = ('unknown', 'Submission outcome unconfirmed; automatic resend disabled')
            finish(conn, job, outcome, now)
        rows = conn.execute("SELECT * FROM local_sms_jobs WHERE status IN ('unknown','accepted','sent') AND next_poll_at<=? AND attempted_at>=? ORDER BY next_poll_at LIMIT 5", (now, now-86400)).fetchall()
        for row in rows:
            try:
                outcome = interpret(gateway.status(row['gateway_id']), row)
            except Exception:
                # A 404 is not proof of non-submission; never blindly POST again.
                conn.execute('UPDATE local_sms_jobs SET next_poll_at=? WHERE id=?', (now+30, row['id']))
                conn.commit()
                continue
            finish(conn, row, outcome, now)
        return int(job is not None)
    finally:
        conn.close()


def report_pending(conn, enqueue_delivery):
    # Versions make reordered/replayed reports harmless in the cloud.
    conn.execute('CREATE TABLE IF NOT EXISTS local_sms_reported (id TEXT PRIMARY KEY, version INTEGER NOT NULL)')
    rows = conn.execute('SELECT j.* FROM local_sms_jobs j LEFT JOIN local_sms_reported r ON r.id=j.id WHERE r.version IS NULL OR j.version>r.version').fetchall()
    for row in rows:
        if row['event'] == 'test':
            continue
        payload = dict(row)
        enqueue_delivery(conn, {'kind': 'sms-outcome', 'delivery_id': str(uuid.uuid4()), 'outcome': payload})
        conn.execute('INSERT INTO local_sms_reported VALUES (?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version', (row['id'], row['version']))


def status(conn, config):
    cached = conn.execute('SELECT saved_at FROM local_sms_config WHERE id=1').fetchone()
    return {'armed': armed(conn, config), 'clock_ready': clock_ready(config),
        'configuration_age_seconds': max(0, int(time.time()-cached['saved_at'])) if cached else None,
        'cloud_ownership': saved_config(conn).get('mode', 'unprovisioned'),
        'jobs': {r['status']: r['n'] for r in conn.execute('SELECT status,count(*) AS n FROM local_sms_jobs GROUP BY status')}}
