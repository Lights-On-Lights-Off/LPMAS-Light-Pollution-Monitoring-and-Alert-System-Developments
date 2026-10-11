from flask import Flask, request, jsonify
from flask_cors import CORS
from datetime import datetime, date, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
import sqlite3
import os
import json
import math
import uuid
import hashlib
import hmac
from functools import wraps
import threading
import time
import urllib.request
import urllib.error
import urllib.parse
import ipaddress
from security import load_security_config, RequestLimiter
from cloud_gateway import gateway_request
import greenhouse_alerts
import local_sms
import local_sms_clock

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 32_768

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "lpmas.db"
ENV_PATH = BASE_DIR / ".env"
ILLUMINATION_SAFE_MIN = 50
ILLUMINATION_WARNING_MIN = 30
ILLUMINATION_WARNING_MAX = 50
ILLUMINATION_VIOLATION_MAX = 30
DARK_SAFE_MAX = 15
DARK_WARNING_MAX = 29
DARK_VIOLATION_MIN = 30
DARK_PHASE_DAYS_DEFAULT = 60
DARK_PHASE_DAYS = DARK_PHASE_DAYS_DEFAULT
CONSECUTIVE_READINGS_REQUIRED = 3
# ESP32 readings are expected at roughly 10-second intervals. A larger gap
# means the violation sequence was interrupted and must restart.
MAX_CONSECUTIVE_GAP_SECONDS = 15
ONLINE_WINDOW_SECONDS = 60
SUPABASE_SYNC_INTERVAL_SECONDS = 30
_supabase_sync_thread = None
_supabase_sync_running = False

FORWARD_TIMEOUT_SECONDS = 5
RETRY_QUEUE_PATH = BASE_DIR / "failed_readings.jsonl"  # read-only upgrade source


def load_env_file():
    if not ENV_PATH.exists(): return
    try:
        with ENV_PATH.open("r", encoding="utf-8") as file:
            for line in file:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line: continue
                key, value = line.split("=", 1)
                key, value = key.strip(), value.strip()
                if key not in ('SUPABASE_URL', 'LPMAS_TIMEZONE', 'LPMAS_DEVICE_KEY', 'LPMAS_PI_TOKEN', 'LPMAS_SECURITY_FILE'): continue
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'): value = value[1:-1]
                os.environ.setdefault(key, value)
    except Exception as error:
        print(f"[ENV ERROR] {error}")


load_env_file()
LPMAS_TIMEZONE = ZoneInfo(os.getenv("LPMAS_TIMEZONE", "Asia/Manila"))
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SECURITY = load_security_config()
PI_TOKEN = os.getenv("LPMAS_PI_TOKEN", SECURITY.get("pi_token", ""))
DEVICE_KEY = os.getenv("LPMAS_DEVICE_KEY", SECURITY.get("device_key", ""))
LOCAL_SMS = SECURITY.get("local_sms", {})
ALLOWED_ORIGINS = SECURITY.get("allowed_origins", [])
CORS(app, origins=ALLOWED_ORIGINS, methods=['GET', 'POST', 'OPTIONS'],
     allow_headers=['Authorization', 'Content-Type', 'X-LPMAS-Device-Key'])
limiter = RequestLimiter()

# --- Pi -> Edge Function forwarding -----------------------------------------
#
# The Edge Function is the only writer of sensor_list and
# sensor_minute_aggregates. The Pi forwards each reading as it arrives rather
# than batch-aggregating, so a sensor that goes offline shows up in the cloud
# within seconds instead of up to one sync interval later.
#
# The gateway accepts a dedicated Pi credential with a fixed operation allowlist.
# Existing Supabase administrator credentials are never used or sent by the Pi.
EDGE_FUNCTION_URL = f"{SUPABASE_URL}/functions/v1/pi-gateway" if SUPABASE_URL else ""
_outbox_thread = None
_outbox_wake = threading.Event()


@app.before_request
def admit_request():
    if request.method == 'OPTIONS': return None
    category = 'ingest' if request.path == '/api/readings' and request.method == 'POST' else 'api'
    peer = request.remote_addr or 'unknown'
    # The listener binds loopback; only the local tunnel can supply this header.
    if peer in ('127.0.0.1', '::1'):
        try: peer = str(ipaddress.ip_address(request.headers.get('CF-Connecting-IP', peer)))
        except ValueError: pass
    rate = 120 if category == 'ingest' else 240
    if not limiter.allow(('global', category), 1200) or not limiter.allow((peer, category), rate):
        return jsonify({'error':'Too many requests; retry shortly'}), 429, {'Retry-After':'5'}
    origin = request.headers.get('Origin')
    if origin and origin not in ALLOWED_ORIGINS:
        return jsonify({'error':'Origin not permitted'}), 403


@app.after_request
def response_security(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Cache-Control'] = 'no-store'
    response.headers['Referrer-Policy'] = 'no-referrer'
    return response


def cloud_request(action, **values):
    return gateway_request(EDGE_FUNCTION_URL, PI_TOKEN, action, **values)


def authorize_operator(token):
    result = cloud_request('authorize-operator', access_token=token)
    return result.get('role') in ('manager', 'admin')


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA synchronous=FULL")
    return conn


def table_columns(conn, table):
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def init_db():
    global DARK_PHASE_DAYS
    conn = get_db()
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS greenhouses (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            phase_start TEXT NOT NULL,
            phase_end TEXT NOT NULL,
            window_start TEXT NOT NULL,
            window_end TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS greenhouse_sensors (
            greenhouse_id TEXT NOT NULL,
            sensor_id TEXT NOT NULL,
            PRIMARY KEY (greenhouse_id, sensor_id),
            FOREIGN KEY (greenhouse_id) REFERENCES greenhouses(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sensor_id TEXT NOT NULL,
            greenhouse_id TEXT,
            lux REAL NOT NULL,
            recorded_at TEXT NOT NULL,
            classification TEXT,
            phase_type TEXT
        );
        CREATE TABLE IF NOT EXISTS phases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            greenhouse_id TEXT,
            phase_type TEXT NOT NULL,
            starts_on TEXT NOT NULL,
            ends_on TEXT NOT NULL,
            window_start TEXT,
            window_end TEXT,
            is_active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sensor_id TEXT NOT NULL,
            greenhouse_id TEXT,
            phase_type TEXT NOT NULL,
            opened_at TEXT NOT NULL,
            resolved_at TEXT,
            status TEXT NOT NULL,
            peak_lux REAL,
            lowest_lux REAL,
            reason TEXT
        );
        CREATE TABLE IF NOT EXISTS supabase_sync_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    """)
    conn.execute("CREATE TABLE IF NOT EXISTS delivery_outbox (delivery_id TEXT PRIMARY KEY, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at REAL NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL)")
    for table, column, declaration in (
        ("readings", "reading_uid", "TEXT"),
        ("readings", "config_version", "TEXT NOT NULL DEFAULT 'legacy'"),
        ("incidents", "incident_uid", "TEXT"),
        ("incidents", "version", "INTEGER NOT NULL DEFAULT 1"),
        ("incidents", "triggering_readings", "TEXT NOT NULL DEFAULT '[]'"),
        ("incidents", "config_version", "TEXT"),
        ("incidents", "context_version", "TEXT"),
        ("incidents", "resolution_reason", "TEXT"),
    ):
        if column not in table_columns(conn, table):
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")
    for row in conn.execute("SELECT id FROM incidents WHERE incident_uid IS NULL").fetchall():
        conn.execute("UPDATE incidents SET incident_uid=? WHERE id=?", (str(uuid.uuid4()), row["id"]))
    migrate_legacy_schema(conn)
    migrate_readings_nullable_metadata(conn)
    for column, declaration in (("reading_uid", "TEXT"), ("config_version", "TEXT NOT NULL DEFAULT 'legacy'")):
        if column not in table_columns(conn, "readings"):
            conn.execute(f"ALTER TABLE readings ADD COLUMN {column} {declaration}")
    if "recorded_at_epoch" not in table_columns(conn, "readings"):
        conn.execute("ALTER TABLE readings ADD COLUMN recorded_at_epoch REAL")
    # Preserve original timestamps and queued payloads: receipts compare exact
    # payloads on replay. A numeric index normalizes old offsets without changing
    # historical delivery identities. Naive legacy dates use the site's timezone.
    last_id = 0
    while True:
        batch = conn.execute("SELECT id, recorded_at FROM readings WHERE recorded_at_epoch IS NULL AND id>? ORDER BY id LIMIT 1000", (last_id,)).fetchall()
        if not batch: break
        for row in batch:
            stamp = parse_datetime(row["recorded_at"])
            if stamp is not None:
                conn.execute("UPDATE readings SET recorded_at_epoch=? WHERE id=?", (stamp.timestamp(), row["id"]))
        last_id = batch[-1]["id"]
    # Incident metadata is not an immutable receipt. Canonicalize it once so
    # old local offsets and new UTC values sort identically in every endpoint.
    for row in conn.execute("SELECT id, opened_at, resolved_at FROM incidents").fetchall():
        for field in ("opened_at", "resolved_at"):
            stamp = parse_datetime(row[field])
            if stamp:
                normalized = stamp.astimezone(timezone.utc).isoformat(timespec="microseconds")
                if normalized != row[field]:
                    conn.execute(f"UPDATE incidents SET {field}=? WHERE id=?", (normalized, row["id"]))
    # A real sensor belongs to only one greenhouse assignment at a time.
    # Clean up legacy duplicates before enforcing the rule at the DB level.
    duplicate_sensors = conn.execute("""
        SELECT sensor_id FROM greenhouse_sensors
        GROUP BY sensor_id HAVING COUNT(*) > 1
    """).fetchall()
    for duplicate in duplicate_sensors:
        mappings = conn.execute("""
            SELECT gs.rowid, g.is_active, g.updated_at
            FROM greenhouse_sensors gs
            JOIN greenhouses g ON g.id = gs.greenhouse_id
            WHERE gs.sensor_id = ?
            ORDER BY g.is_active DESC, julianday(g.updated_at) DESC, gs.rowid DESC
        """, (duplicate["sensor_id"],)).fetchall()
        for mapping in mappings[1:]:
            conn.execute("DELETE FROM greenhouse_sensors WHERE rowid = ?", (mapping["rowid"],))

    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS readings_uid_idx ON readings(reading_uid)")
    conn.execute("CREATE INDEX IF NOT EXISTS readings_sensor_time_idx ON readings(sensor_id, recorded_at DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS readings_greenhouse_time_idx ON readings(greenhouse_id, recorded_at DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS readings_epoch_idx ON readings(recorded_at_epoch, id)")
    conn.execute("CREATE INDEX IF NOT EXISTS readings_sensor_epoch_idx ON readings(sensor_id, recorded_at_epoch)")
    conn.execute("CREATE INDEX IF NOT EXISTS readings_greenhouse_epoch_idx ON readings(greenhouse_id, recorded_at_epoch)")
    conn.execute("CREATE INDEX IF NOT EXISTS incidents_sensor_status_idx ON incidents(sensor_id, status)")
    conn.execute("CREATE INDEX IF NOT EXISTS incidents_greenhouse_status_idx ON incidents(greenhouse_id, status)")
    registry_exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='registered_sensors'").fetchone()
    conn.execute("CREATE TABLE IF NOT EXISTS registered_sensors (sensor_id TEXT PRIMARY KEY)")
    if not registry_exists:
        # Bootstrap an existing installation during an offline upgrade. Later
        # successful cloud snapshots replace this cache, including removals.
        conn.execute("INSERT OR IGNORE INTO registered_sensors SELECT DISTINCT sensor_id FROM readings")
    cached_days = conn.execute("SELECT value FROM supabase_sync_state WHERE key='dark_phase_days'").fetchone()
    if cached_days:
        DARK_PHASE_DAYS = int(cached_days[0])
    greenhouse_alerts.initialize(conn)
    local_sms.initialize(conn)
    conn.commit()
    conn.close()


def migrate_legacy_schema(conn):
    columns = table_columns(conn, "readings")
    if "greenhouse_id" not in columns: conn.execute("ALTER TABLE readings ADD COLUMN greenhouse_id TEXT")
    phase_columns = table_columns(conn, "phases")
    if "greenhouse_id" not in phase_columns: conn.execute("ALTER TABLE phases ADD COLUMN greenhouse_id TEXT")
    for column in ("lux_min", "lux_max", "lux_ceiling"):
        if column in phase_columns:
            try: conn.execute(f"ALTER TABLE phases DROP COLUMN {column}")
            except sqlite3.OperationalError: pass
    incident_columns = table_columns(conn, "incidents")
    if "greenhouse_id" not in incident_columns: conn.execute("ALTER TABLE incidents ADD COLUMN greenhouse_id TEXT")


def migrate_readings_nullable_metadata(conn):
    columns = {row[1]: row for row in conn.execute("PRAGMA table_info(readings)").fetchall()}
    classification_notnull = bool(columns.get("classification", [None, None, None, 0])[3])
    phase_type_notnull = bool(columns.get("phase_type", [None, None, None, 0])[3])
    if not (classification_notnull or phase_type_notnull): return
    conn.execute("""
        CREATE TABLE readings_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sensor_id TEXT NOT NULL,
            greenhouse_id TEXT,
            lux REAL NOT NULL,
            recorded_at TEXT NOT NULL,
            classification TEXT,
            phase_type TEXT,
            reading_uid TEXT,
            config_version TEXT NOT NULL DEFAULT 'legacy'
        )
    """)
    conn.execute("""
        INSERT INTO readings_new(id, sensor_id, greenhouse_id, lux, recorded_at, classification, phase_type, reading_uid, config_version)
        SELECT id, sensor_id, greenhouse_id, lux, recorded_at, classification, phase_type, reading_uid, config_version FROM readings
    """)
    conn.execute("DROP TABLE readings")
    conn.execute("ALTER TABLE readings_new RENAME TO readings")


def now_iso(): return datetime.now(timezone.utc).isoformat(timespec="microseconds")
def today(): return datetime.now(LPMAS_TIMEZONE).date()


def parse_date(value):
    try: return date.fromisoformat(value) if value else None
    except ValueError: return None


def parse_datetime(value):
    if not value: return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=LPMAS_TIMEZONE) if parsed.tzinfo is None else parsed
    except (ValueError, TypeError, AttributeError): return None


def history_bounds():
    """Validate API bounds and compare instants, never offset-bearing text."""
    bounds = []
    for name in ("start", "end"):
        raw = request.args.get(name)
        stamp = None
        if raw is not None:
            try:
                stamp = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                if "T" not in raw or stamp.tzinfo is None: raise ValueError()
            except ValueError:
                raise ValueError(f"{name} must be an ISO timestamp with timezone") from None
        bounds.append(stamp.timestamp() if stamp else None)
    if all(value is not None for value in bounds) and bounds[0] > bounds[1]:
        raise ValueError("start must be before or equal to end")
    return bounds


def parse_time(value):
    if not value: return None
    try: return datetime.strptime(value, "%H:%M:%S" if len(value) == 8 else "%H:%M").time() if len(value) in (5, 8) else None
    except ValueError: return None


def is_within_window(current_time, start_time, end_time):
    start, end = parse_time(start_time), parse_time(end_time)
    if not start or not end: return False
    current = parse_time(current_time)
    if not current: return False
    if start <= end: return start <= current <= end
    return current >= start or current <= end


def get_greenhouse(conn, greenhouse_id):
    return conn.execute("SELECT * FROM greenhouses WHERE id = ? AND is_active = 1", (greenhouse_id,)).fetchone()


def get_sensor_greenhouse(conn, sensor_id):
    return conn.execute("""
        SELECT g.* FROM greenhouses g
        JOIN greenhouse_sensors gs ON gs.greenhouse_id = g.id
        WHERE gs.sensor_id = ? AND g.is_active = 1
        ORDER BY julianday(g.updated_at) DESC LIMIT 1
    """, (sensor_id,)).fetchone()


def get_illumination_phase(conn, greenhouse, at=None):
    if not greenhouse: return None
    start = parse_date(greenhouse["phase_start"])
    end = parse_date(greenhouse["phase_end"])
    local_day = at.astimezone(LPMAS_TIMEZONE).date() if at else today()
    if not start or not end or not (start <= local_day <= end): return None
    return {
        "id": None,
        "greenhouse_id": greenhouse["id"],
        "phase_type": "illumination",
        "starts_on": greenhouse["phase_start"],
        "ends_on": greenhouse["phase_end"],
        "window_start": greenhouse["window_start"],
        "window_end": greenhouse["window_end"],
        "is_active": 1
    }


def get_dark_phase(conn, greenhouse, at=None):
    if not greenhouse: return None
    illumination_end = parse_date(greenhouse["phase_end"])
    if not illumination_end: return None
    dark_start = illumination_end + timedelta(days=1)
    dark_end = dark_start + timedelta(days=DARK_PHASE_DAYS - 1)
    local_day = at.astimezone(LPMAS_TIMEZONE).date() if at else today()
    if not (dark_start <= local_day <= dark_end): return None
    return {
        "id": None,
        "greenhouse_id": greenhouse["id"],
        "phase_type": "dark",
        "starts_on": dark_start.isoformat(),
        "ends_on": dark_end.isoformat(),
        "window_start": None,
        "window_end": None,
        "is_active": 1
    }


def get_phase_for_sensor(conn, sensor_id, at=None):
    greenhouse = get_sensor_greenhouse(conn, sensor_id)
    if not greenhouse: return None
    return get_illumination_phase(conn, greenhouse, at) or get_dark_phase(conn, greenhouse, at)


def get_active_phase(conn):
    rows = conn.execute("SELECT * FROM greenhouses WHERE is_active = 1 ORDER BY julianday(updated_at) DESC").fetchall()
    for greenhouse in rows:
        phase = get_illumination_phase(conn, greenhouse) or get_dark_phase(conn, greenhouse)
        if phase: return phase
    return None


def classify_reading(lux, phase, at=None):
    if not phase: return None
    if phase["phase_type"] == "dark":
        if lux <= DARK_SAFE_MAX: return "safe"
        if lux <= DARK_WARNING_MAX: return "warning"
        return "violation"
    local_time = (at or datetime.now(LPMAS_TIMEZONE)).astimezone(LPMAS_TIMEZONE)
    if not is_within_window(local_time.strftime("%H:%M"), phase["window_start"], phase["window_end"]): return "unclassified"
    if lux <= ILLUMINATION_VIOLATION_MAX: return "violation"
    if lux < ILLUMINATION_WARNING_MAX: return "warning"
    return "safe"


def configuration_version(greenhouse):
    # Names and update timestamps do not alter monitoring. Canonicalize time
    # strings so a cloud refresh of HH:MM:SS versus HH:MM cannot split a run.
    config = {key: greenhouse[key] for key in ("id", "phase_start", "phase_end")} if greenhouse else {}
    if greenhouse:
        config.update({key: greenhouse[key][:5] for key in ("window_start", "window_end")})
    config["dark_phase_days"] = DARK_PHASE_DAYS
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()


def illumination_session(phase, at):
    """Identify a daily window, including its after-midnight continuation."""
    start, end = phase["window_start"][:5], phase["window_end"][:5]
    if start == "00:00" and end == "23:59": return "continuous"
    local = at.astimezone(LPMAS_TIMEZONE)
    day = local.date()
    if start > end and local.strftime("%H:%M") <= end: day -= timedelta(days=1)
    return day.isoformat()


def recent_readings(conn, sensor_id, limit=CONSECUTIVE_READINGS_REQUIRED):
    return conn.execute("""
        SELECT * FROM readings WHERE sensor_id = ?
        ORDER BY id DESC LIMIT ?
    """, (sensor_id, limit)).fetchall()


def violation_sequence(conn, sensor_id, greenhouse_id, phase_type):
    """Return the latest valid consecutive violation sequence, or None.

    The sequence must contain exactly the required number of readings, all from
    the same sensor/greenhouse/phase, with no timestamp gap larger than the
    allowed ESP32 sampling interval. This prevents old, widely separated
    violations from being treated as a continuous violation.
    """
    rows = recent_readings(conn, sensor_id)
    if len(rows) != CONSECUTIVE_READINGS_REQUIRED:
        return None

    # recent_readings() is newest-first; evaluate chronologically.
    rows = list(reversed(rows))
    config_version = rows[-1]["config_version"]
    for row in rows:
        if (row["classification"] != "violation" or
                row["phase_type"] != phase_type or
                row["greenhouse_id"] != greenhouse_id or
                row["config_version"] != config_version):
            return None

    timestamps = [parse_datetime(row["recorded_at"]) for row in rows]
    if any(ts is None for ts in timestamps):
        return None
    # A sensor can leave and return to the same assignment between captures.
    # Even an identical configuration must start a new confirmation after closure.
    latest_closed = conn.execute("SELECT resolved_at FROM incidents WHERE sensor_id=? AND status='resolved' ORDER BY resolved_at DESC, id DESC LIMIT 1", (sensor_id,)).fetchone()
    boundary = parse_datetime(latest_closed["resolved_at"]) if latest_closed else None
    if boundary and timestamps[0] < boundary:
        return None
    for previous, current in zip(timestamps, timestamps[1:]):
        gap = (current - previous).total_seconds()
        if gap <= 0 or gap > MAX_CONSECUTIVE_GAP_SECONDS:
            return None

    return rows


def violation_ready(conn, sensor_id, greenhouse_id, phase_type):
    return violation_sequence(conn, sensor_id, greenhouse_id, phase_type) is not None


def get_open_incident(conn, sensor_id, phase_type, greenhouse_id=None):
    return conn.execute("""
        SELECT * FROM incidents
        WHERE sensor_id = ? AND phase_type = ? AND greenhouse_id IS ? AND status IN ('open', 'acknowledged')
        ORDER BY id DESC LIMIT 1
    """, (sensor_id, phase_type, greenhouse_id)).fetchone()


def update_incident_values(conn, incident, lux):
    peak = max(float(incident["peak_lux"]) if incident["peak_lux"] is not None else lux, lux)
    lowest = min(float(incident["lowest_lux"]) if incident["lowest_lux"] is not None else lux, lux)
    conn.execute("UPDATE incidents SET peak_lux = ?, lowest_lux = ?, version = version + 1 WHERE id = ?", (peak, lowest, incident["id"]))


def open_incident(conn, sensor_id, greenhouse_id, phase_type, lux, triggering_rows=None):
    existing = get_open_incident(conn, sensor_id, phase_type, greenhouse_id)
    if existing:
        update_incident_values(conn, existing, lux)
        return existing["id"], False

    values = [float(row["lux"]) for row in (triggering_rows or [])]
    values.append(float(lux))
    peak_lux = max(values)
    lowest_lux = min(values)
    cursor = conn.execute("""
        INSERT INTO incidents(sensor_id, greenhouse_id, phase_type, opened_at, status, peak_lux, lowest_lux, reason)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?)
    """, (sensor_id, greenhouse_id, phase_type, now_iso(), peak_lux, lowest_lux, f"{phase_type.title()} phase light violation"))
    conn.execute("UPDATE incidents SET incident_uid=?, triggering_readings=? WHERE id=?", (
        str(uuid.uuid4()), json.dumps([dict(row) for row in (triggering_rows or [])]), cursor.lastrowid))
    if triggering_rows:
        conn.execute("UPDATE incidents SET config_version=? WHERE id=?", (triggering_rows[-1]["config_version"], cursor.lastrowid))
    row = conn.execute('SELECT greenhouse_id,opened_at FROM incidents WHERE id=?', (cursor.lastrowid,)).fetchone()
    greenhouse_alerts.attach(conn, cursor.lastrowid, row['greenhouse_id'], row['opened_at'])
    return cursor.lastrowid, True


def resolve_incident(conn, incident, reason="safe_reading", at=None):
    stamp = at.astimezone(timezone.utc).isoformat(timespec="microseconds") if at else now_iso()
    conn.execute("UPDATE incidents SET status='resolved', resolved_at=?, resolution_reason=?, version=version+1 WHERE id=?", (stamp, reason, incident["id"]))
    greenhouse_alerts.finish_member(conn, incident['id'], stamp)


def reconcile_incidents(conn, at=None, sensor_id=None):
    """Close obsolete monitoring contexts atomically with their cloud delivery.

    A context closure does not claim the light returned to a safe level. The
    reason travels with the versioned incident, and the next context starts fresh.
    """
    at = at or datetime.now(timezone.utc)
    query = "SELECT * FROM incidents WHERE status IN ('open','acknowledged')"
    rows = conn.execute(query + (" AND sensor_id=?" if sensor_id else ""), (sensor_id,) if sensor_id else ()).fetchall()
    for incident in rows:
        greenhouse = get_sensor_greenhouse(conn, incident["sensor_id"])
        phase = get_phase_for_sensor(conn, incident["sensor_id"], at)
        reason = None
        version = configuration_version(greenhouse)
        if not greenhouse or greenhouse["id"] != incident["greenhouse_id"]:
            reason = "assignment_changed"
        elif not phase or phase["phase_type"] != incident["phase_type"]:
            reason = "phase_ended"
        elif (incident["context_version"] or incident["config_version"]) and (incident["context_version"] or incident["config_version"]) != version:
            reason = "configuration_changed"
        elif phase["phase_type"] == "illumination":
            opened = parse_datetime(incident["opened_at"])
            if classify_reading(0, phase, at) == "unclassified" or (opened and illumination_session(phase, opened) != illumination_session(phase, at)):
                reason = "monitoring_window_ended"
        if reason:
            resolve_incident(conn, incident, reason, at)
        else:
            if not incident["context_version"]:
                # Legacy confirmations have no fingerprint. Establish a local
                # lifecycle baseline without rewriting their triggering evidence.
                conn.execute("UPDATE incidents SET context_version=? WHERE id=?", (version, incident["id"]))
            continue
        enqueue_delivery(conn, {"kind": "incident", "delivery_id": str(uuid.uuid4()),
            "recorded_at": at.astimezone(timezone.utc).isoformat(timespec="microseconds"),
            "incident": incident_snapshot(conn, incident["id"])})
    reconcile_greenhouse_alerts(conn, at)


def reconcile_greenhouse_alerts(conn, at):
    stamp = at.astimezone(timezone.utc).isoformat(timespec='microseconds')
    def context_current(member):
        greenhouse = get_sensor_greenhouse(conn, member['sensor_id'])
        phase = get_phase_for_sensor(conn, member['sensor_id'], at)
        if not greenhouse or greenhouse['id'] != member['greenhouse_id'] or not phase or phase['phase_type'] != member['phase_type']:
            return False
        version = member['context_version'] or member['config_version']
        if version and version != configuration_version(greenhouse):
            return False
        return phase['phase_type'] != 'illumination' or classify_reading(0, phase, at) != 'unclassified'
    for member_id in greenhouse_alerts.reconcile_waiting(conn, stamp, context_current):
        enqueue_delivery(conn, {'kind': 'incident', 'delivery_id': str(uuid.uuid4()), 'recorded_at': stamp,
                              'incident': incident_snapshot(conn, member_id)})


def reconcile_incident_lifecycle():
    conn = get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        if not LOCAL_SMS.get("enabled") or local_sms.clock_ready(LOCAL_SMS):
            reconcile_incidents(conn)
            local_sms.sync_events(conn, LOCAL_SMS)
        conn.commit()
    finally:
        conn.close()


def handle_incident(conn, sensor_id, greenhouse_id, lux, classification, phase_type):
    incident = get_open_incident(conn, sensor_id, phase_type, greenhouse_id)
    if classification == "violation":
        if incident:
            update_incident_values(conn,incident,lux)
            return incident["id"], incident["status"]
        sequence = violation_sequence(conn, sensor_id, greenhouse_id, phase_type)
        if sequence:
            incident_id, created = open_incident(
                conn, sensor_id, greenhouse_id, phase_type, lux, triggering_rows=sequence
            )
            return incident_id, "open"
        return incident["id"] if incident else None, "pending"
    if incident and classification == "safe" and recovery_ready(conn, incident):
        resolve_incident(conn, incident)
        return incident["id"], "resolved"
    if incident and classification != "unclassified": update_incident_values(conn, incident, lux); return incident["id"], incident["status"]
    return None, classification


def recovery_ready(conn, incident):
    rows = list(reversed(recent_readings(conn, incident['sensor_id'])))
    if len(rows) != CONSECUTIVE_READINGS_REQUIRED:
        return False
    previous = None
    opened = parse_datetime(incident['opened_at'])
    for row in rows:
        stamp = parse_datetime(row['recorded_at'])
        if (row['classification'] != 'safe' or row['greenhouse_id'] != incident['greenhouse_id']
                or row['phase_type'] != incident['phase_type'] or row['config_version'] != rows[-1]['config_version']
                or stamp is None or opened is None or stamp <= opened):
            return False
        if previous and not 0 < (stamp - previous).total_seconds() <= MAX_CONSECUTIVE_GAP_SECONDS:
            return False
        previous = stamp
    return True


@app.route("/api/greenhouses", methods=["GET"])
def list_greenhouses():
    conn = get_db()
    rows = conn.execute("SELECT * FROM greenhouses WHERE is_active = 1 ORDER BY name COLLATE NOCASE").fetchall()
    result = []
    for row in rows:
        sensors = conn.execute("SELECT sensor_id FROM greenhouse_sensors WHERE greenhouse_id = ? ORDER BY sensor_id", (row["id"],)).fetchall()
        item = dict(row); item["sensor_ids"] = [sensor["sensor_id"] for sensor in sensors]
        result.append(item)
    conn.close()
    return jsonify(result)


@app.route("/api/greenhouses", methods=["POST"])
@app.route("/api/greenhouses/<greenhouse_id>", methods=["DELETE"])
def retired_configuration(greenhouse_id=None):
    return jsonify({"error": "Configure greenhouses through the authenticated cloud dashboard."}), 410


def require_manager(handler):
    @wraps(handler)
    def checked(*args, **kwargs):
        token = request.headers.get("Authorization", "")
        if not token.startswith("Bearer ") or not supabase_configured():
            return jsonify({"error": "Authentication required"}), 401
        try:
            if not authorize_operator(token[7:]):
                return jsonify({"error": "Manager or admin access required"}), 403
        except Exception:
            return jsonify({"error": "Unable to verify authentication"}), 401
        return handler(*args, **kwargs)
    return checked


@app.route("/api/readings", methods=["GET"])
@require_manager
def get_readings():
    try: start, end = history_bounds()
    except ValueError as error: return jsonify({"error": str(error)}), 400
    conn = get_db(); sensor_id = request.args.get("sensor_id"); greenhouse_id = request.args.get("greenhouse_id")
    try: limit = max(1, min(int(request.args.get("limit", 100)), 1000))
    except ValueError: limit = 100
    query = "SELECT * FROM readings WHERE 1=1"; params = []
    if sensor_id: query += " AND sensor_id = ?"; params.append(sensor_id)
    if greenhouse_id: query += " AND greenhouse_id = ?"; params.append(greenhouse_id)
    if start is not None: query += " AND recorded_at_epoch >= ?"; params.append(start)
    if end is not None: query += " AND recorded_at_epoch <= ?"; params.append(end)
    query += " ORDER BY recorded_at_epoch ASC, id ASC LIMIT ?"; params.append(limit)
    rows = conn.execute(query, params).fetchall(); conn.close()
    return jsonify([dict(row) for row in rows])


@app.route("/api/readings", methods=["POST"])
def create_reading():
    supplied = request.headers.get("X-LPMAS-Device-Key", "")
    if len(DEVICE_KEY) < 32:
        return jsonify({"error": "Device authentication is not provisioned"}), 503
    if not hmac.compare_digest(supplied.encode(), DEVICE_KEY.encode()):
        return jsonify({"error": "Device authentication required"}), 401
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict): return jsonify({"error": "JSON object required"}), 400
    sensor_id = payload.get("sensor_id")
    if not isinstance(sensor_id, str) or not sensor_id.strip() or sensor_id != sensor_id.strip() or len(sensor_id) > 100:
        return jsonify({"error": "Valid sensor_id required"}), 400
    try: lux = float(payload.get("lux"))
    except (TypeError, ValueError): return jsonify({"error": "Invalid lux value"}), 400
    if isinstance(payload.get("lux"), bool) or not math.isfinite(lux) or lux < 0 or lux > 65535:
        return jsonify({"error": "lux must be finite and between 0 and 65535"}), 400
    reading_uid = payload.get("reading_id")
    try:
        parsed_uid = uuid.UUID(reading_uid)
        if parsed_uid.variant != uuid.RFC_4122 or not 1 <= parsed_uid.version <= 8:
            raise ValueError("Unsupported UUID")
        reading_uid = str(parsed_uid)
    except (ValueError, TypeError, AttributeError): return jsonify({"error": "UUID reading_id required"}), 400
    conn = get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        if not conn.execute(
            "SELECT sensor_id FROM registered_sensors WHERE sensor_id=? UNION SELECT sensor_id FROM greenhouse_sensors WHERE sensor_id=?",
            (sensor_id, sensor_id),
        ).fetchone():
            return jsonify({"error": "Sensor is not registered; wait for configuration sync or assign it in the dashboard"}), 403
        existing = conn.execute("SELECT * FROM readings WHERE reading_uid=?", (reading_uid,)).fetchone()
        if existing:
            if existing["sensor_id"] != sensor_id or existing["lux"] != lux:
                return jsonify({"error": "reading_id reused with different content"}), 409
            return jsonify(dict(existing)), 200
        if LOCAL_SMS.get("enabled") and not local_sms.clock_ready(LOCAL_SMS):
            return jsonify({"error": "Local clock is not trusted; restore RTC or synchronize Pi time"}), 503
        recorded_at = now_iso()
        captured_at = parse_datetime(recorded_at)
        reconcile_incidents(conn, captured_at, sensor_id)
        greenhouse = get_sensor_greenhouse(conn, sensor_id)
        phase = get_phase_for_sensor(conn, sensor_id, captured_at)
        classification = classify_reading(lux, phase, captured_at) or "unclassified"
        phase_type = phase["phase_type"] if phase else "unconfigured"
        greenhouse_id = greenhouse["id"] if greenhouse else None
        config_version = configuration_version(greenhouse)
        cursor = conn.execute("INSERT INTO readings(sensor_id,greenhouse_id,lux,recorded_at,classification,phase_type,reading_uid,config_version,recorded_at_epoch) VALUES (?,?,?,?,?,?,?,?,?)",
            (sensor_id,greenhouse_id,lux,recorded_at,classification,phase_type,reading_uid,config_version,captured_at.timestamp()))
        incident_id, incident_status = (None, "waiting")
        if phase:
            incident_id, incident_status = handle_incident(conn,sensor_id,greenhouse_id,lux,classification,phase_type)
        reconcile_greenhouse_alerts(conn, captured_at)
        reading = dict(conn.execute("SELECT * FROM readings WHERE id=?", (cursor.lastrowid,)).fetchone())
        delivery = reading_delivery(reading, incident_snapshot(conn, incident_id))
        enqueue_delivery(conn, delivery)
        local_sms.sync_events(conn, LOCAL_SMS)
        conn.commit()
        _outbox_wake.set()
        return jsonify({**reading,"incident_id":incident_id,"incident_status":incident_status}), 201
    finally:
        conn.close()


def incident_snapshot(conn, incident_id):
    if incident_id is None: return None
    row = conn.execute("SELECT * FROM incidents WHERE id=?", (incident_id,)).fetchone()
    if not row: return None
    value = dict(row)
    value['greenhouse_alert'] = greenhouse_alerts.snapshot(conn, value.pop('greenhouse_alert_uid', None))
    value.pop("context_version", None)
    value["triggering_readings"] = json.loads(value["triggering_readings"])
    if not value["triggering_readings"]: value["legacy"] = True
    return value


def reading_delivery(reading, incident=None):
    return {
        "kind": "reading", "delivery_id": reading["reading_uid"],
        "sensor_id": reading["sensor_id"], "lux": reading["lux"],
        "recorded_at": reading["recorded_at"], "greenhouse_id": reading["greenhouse_id"],
        "phase_type": reading["phase_type"], "classification": reading["classification"],
        "monitoring_active": reading["classification"] in ("safe","warning","violation"),
        "config_version": reading["config_version"], "incident": incident,
    }


def enqueue_delivery(conn, payload):
    conn.execute("INSERT OR IGNORE INTO delivery_outbox(delivery_id,payload,created_at) VALUES (?,?,?)",
        (payload["delivery_id"],json.dumps(payload,allow_nan=False),now_iso()))


def flush_outbox(post=None):
    if not edge_function_configured(): return 0
    post = post or default_post
    conn = get_db()
    entries = conn.execute("SELECT * FROM delivery_outbox WHERE next_attempt_at <= ? ORDER BY rowid LIMIT 100", (time.time(),)).fetchall()
    conn.close()
    delivered = 0
    for entry in entries:
        # A long offline backlog must not delay time-based incident closure.
        reconcile_incident_lifecycle()
        payload = json.loads(entry["payload"])
        if payload.get('kind') == 'sms-outcome':
            try:
                ok = cloud_request('sms-outcome', outcome=payload['outcome']).get('ok') is True
            except Exception:
                ok = False
        else:
            ok = _deliver(payload,post)
        conn = get_db()
        if ok:
            conn.execute("DELETE FROM delivery_outbox WHERE delivery_id=?", (entry["delivery_id"],))
            delivered += 1
        else:
            conn.execute("UPDATE delivery_outbox SET attempts=attempts+1,next_attempt_at=?,last_error=? WHERE delivery_id=?",
                (time.time()+min(3600,2**min(entry["attempts"]+1,12)),"Cloud delivery failed",entry["delivery_id"]))
        conn.commit(); conn.close()
    # Consume new notification jobs while no sensors are posting. The cloud
    # never retries an already consumed SMS or email attempt.
    _deliver({"retry_notifications":True},post)
    return delivered


def import_legacy_retry_queue():
    # Upgrade only queued measurements that can be matched to durable local raw
    # readings. Never invent a historical configuration for an unmatched entry.
    entries = read_retry_queue()
    conn = get_db()
    for entry in entries:
        row = conn.execute("SELECT * FROM readings WHERE sensor_id=? AND recorded_at=? AND lux=? ORDER BY id LIMIT 1",
            (entry.get("sensor_id"),entry.get("recorded_at"),entry.get("lux"))).fetchone()
        if not row: continue
        reading = dict(row)
        if not reading["reading_uid"]:
            reading["reading_uid"] = str(uuid.uuid4())
            conn.execute("UPDATE readings SET reading_uid=? WHERE id=?", (reading["reading_uid"],reading["id"]))
        enqueue_delivery(conn,reading_delivery(reading))
    conn.commit(); conn.close()
    # Retain the original file for audit; imports are idempotent by reading_uid.


def outbox_loop():
    while True:
        try:
            reconcile_incident_lifecycle()
            flush_outbox()
        except Exception as error: print(f"[OUTBOX ERROR] {error}")
        _outbox_wake.wait(15)
        _outbox_wake.clear()


def start_outbox():
    global _outbox_thread
    if _outbox_thread and _outbox_thread.is_alive(): return
    import_legacy_retry_queue()
    _outbox_thread = threading.Thread(target=outbox_loop,name="delivery-outbox",daemon=True)
    _outbox_thread.start()


# Delivery transport. The durable SQLite outbox is the only production sender.
def default_post(url, body, headers, timeout):
    request = urllib.request.Request(url,data=body.encode("utf-8"),method="POST",headers=headers)
    return urllib.request.urlopen(request,timeout=timeout)


def edge_function_configured(): return bool(EDGE_FUNCTION_URL and PI_TOKEN)


def _deliver(payload, post):
    try:
        with post(EDGE_FUNCTION_URL,json.dumps({"action":"ingest","delivery":payload},allow_nan=False),{
            "Authorization":f"Bearer {PI_TOKEN}","Content-Type":"application/json"
        },FORWARD_TIMEOUT_SECONDS) as response:
            return 200 <= response.status < 300
    except Exception as error:
        print(f"[DELIVERY FAILED] {type(error).__name__}")
        return False


def read_retry_queue():
    # Read-only upgrade support for pre-pilot JSONL queues.
    if not RETRY_QUEUE_PATH.exists(): return []
    entries=[]
    with RETRY_QUEUE_PATH.open(encoding="utf-8") as source:
        for line in source:
            try:
                entry=json.loads(line)
                if isinstance(entry,dict): entries.append(entry)
            except (ValueError,TypeError): pass
    return entries


@app.route("/api/phase/active", methods=["GET"])
def active_phase():
    conn = get_db(); phase = get_active_phase(conn); conn.close(); return jsonify(phase)


@app.route("/api/phases", methods=["GET"])
def get_phases():
    conn = get_db(); rows = conn.execute("SELECT * FROM phases ORDER BY starts_on ASC, id ASC").fetchall(); conn.close(); return jsonify([dict(row) for row in rows])


@app.route("/api/phases", methods=["POST"])
def create_phase():
    return jsonify({"error": "Phases are created from greenhouse configuration; direct phase creation is disabled"}), 400


@app.route("/api/incidents", methods=["GET"])
def get_incidents():
    conn = get_db(); status = request.args.get("status"); greenhouse_id = request.args.get("greenhouse_id")
    query = "SELECT * FROM incidents WHERE 1=1"; params = []
    if status: query += " AND status = ?"; params.append(status)
    if greenhouse_id: query += " AND greenhouse_id = ?"; params.append(greenhouse_id)
    query += " ORDER BY opened_at DESC LIMIT 100"; rows = conn.execute(query, params).fetchall(); conn.close(); return jsonify([dict(row) for row in rows])


@app.route("/api/incidents/<int:incident_id>/acknowledge", methods=["POST"])
@require_manager
def acknowledge_incident(incident_id):
    conn = get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM incidents WHERE id=?", (incident_id,)).fetchone()
        if not row: return jsonify({"error":"Incident not found"}),404
        supplied = (request.get_json(silent=True) or {}).get("incident_uid")
        if supplied != row["incident_uid"]: return jsonify({"error":"Incident identity changed; refresh before acknowledging"}),409
        if row["status"] == "resolved": return jsonify({"error":"Incident already resolved"}),409
        if row["status"] == "open":
            conn.execute("UPDATE incidents SET status='acknowledged',version=version+1 WHERE id=?",(incident_id,))
            enqueue_delivery(conn,{"kind":"incident","delivery_id":str(uuid.uuid4()),"recorded_at":now_iso(),"incident":incident_snapshot(conn,incident_id)})
        conn.commit(); _outbox_wake.set()
        return jsonify({"status":"acknowledged"})
    finally: conn.close()


@app.route("/api/hardware-activity", methods=["GET"])
@require_manager
def hardware_activity():
    try: start, end = history_bounds()
    except ValueError as error: return jsonify({"error": str(error)}), 400
    if start is None or end is None or end-start > 31*86400:
        return jsonify({"error":"Choose a history range of at most 31 days"}), 400
    try:
        after_id = int(request.args.get('after_id', '0'))
        if after_id < 0: raise ValueError()
    except ValueError: return jsonify({'error':'Invalid history cursor'}), 400
    conn = get_db(); greenhouse_id = request.args.get("greenhouse_id"); sensor_ids = request.args.getlist("sensor_id")
    if len(sensor_ids) > 100:
        conn.close()
        return jsonify({'error':'Too many sensor filters'}), 400
    query = "SELECT * FROM readings WHERE 1=1"; params = []
    if greenhouse_id: query += " AND greenhouse_id = ?"; params.append(greenhouse_id)
    if sensor_ids:
        query += f" AND sensor_id IN ({','.join('?' for _ in sensor_ids)})"; params.extend(sensor_ids)
    if start is not None: query += " AND recorded_at_epoch >= ?"; params.append(start)
    if end is not None: query += " AND recorded_at_epoch <= ?"; params.append(end)
    query += " AND id > ? ORDER BY id ASC LIMIT 1001"; params.append(after_id)
    rows = conn.execute(query, params).fetchall(); conn.close()
    page = rows[:1000]
    return jsonify({"readings": [dict(row) for row in page], "count": len(page),
        "next_after_id": page[-1]['id'] if len(rows) > 1000 else None})


@app.route("/api/dashboard", methods=["GET"])
def dashboard():
    conn = get_db(); phase = get_active_phase(conn)
    rows = conn.execute("SELECT * FROM readings ORDER BY recorded_at_epoch DESC, id DESC LIMIT 300").fetchall()
    incidents = conn.execute("SELECT * FROM incidents ORDER BY opened_at DESC LIMIT 100").fetchall(); conn.close()
    health = get_db()
    pending = health.execute("SELECT count(*) AS n, (SELECT created_at FROM delivery_outbox ORDER BY julianday(created_at) LIMIT 1) AS oldest FROM delivery_outbox").fetchone()
    failures = health.execute("SELECT count(*) FROM delivery_outbox WHERE attempts > 0").fetchone()[0]
    health.close()
    return jsonify({"phase":phase,"readings":[dict(row) for row in reversed(rows)],"incidents":[dict(row) for row in incidents],"generatedAt":now_iso(),
        "deliveryHealth":{"pending":pending["n"],"oldestPendingAt":pending["oldest"],"failedAttempts":failures,"configured":edge_function_configured()}})


def get_sync_state(conn, key):
    row = conn.execute("SELECT value FROM supabase_sync_state WHERE key = ?", (key,)).fetchone(); return row["value"] if row else None


def set_sync_state(conn, key, value):
    conn.execute("INSERT INTO supabase_sync_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value)); conn.commit()


def supabase_configured(): return bool(SUPABASE_URL and PI_TOKEN)


def supabase_select(table, params):
    # Compatibility adapter for callers/tests; no arbitrary table or setting access.
    snapshot = cloud_request('configuration')
    if table == 'system_settings': return [{'value': snapshot['dark_phase_days']}]
    if table not in ('greenhouses', 'greenhouse_sensors', 'sensor_list'):
        raise ValueError('Table is not available to the Pi')
    return snapshot[table]


def sync_dark_phase_duration_from_supabase(snapshot=None):
    # Admin-configurable via AdminView.tsx -> web/app/api/admin/settings ->
    # system_settings.dark_phase_duration_days. Falls back to the original
    # fixed default if unset, invalid, or Supabase is unreachable.
    global DARK_PHASE_DAYS
    if not supabase_configured(): return DARK_PHASE_DAYS
    rows = [{'value':snapshot['dark_phase_days']}] if snapshot else supabase_select("system_settings", {"key": "eq.dark_phase_duration_days", "select": "value", "limit": 1})
    try:
        parsed = int(str(rows[0].get("value", "")).strip()) if rows else DARK_PHASE_DAYS_DEFAULT
        new_days = parsed if parsed >= 1 else DARK_PHASE_DAYS_DEFAULT
    except (TypeError, ValueError):
        new_days = DARK_PHASE_DAYS_DEFAULT
    conn = get_db()
    previous = DARK_PHASE_DAYS
    try:
        conn.execute("BEGIN IMMEDIATE")
        reconcile_incidents(conn)
        DARK_PHASE_DAYS = new_days
        conn.execute("INSERT INTO supabase_sync_state(key,value) VALUES ('dark_phase_days',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(new_days),))
        reconcile_incidents(conn)
        conn.commit()
    except Exception:
        DARK_PHASE_DAYS = previous
        raise
    finally:
        conn.close()
    _outbox_wake.set()
    return DARK_PHASE_DAYS


def sync_greenhouses_from_supabase(snapshot=None):
    # Supabase is now the source of truth for greenhouse configuration
    # (see 0006_greenhouse_config.sql). This mirrors it into local SQLite
    # so classify_reading()/get_phase_for_sensor() keep working without a
    # live Supabase round-trip on every 10-second ESP32 reading. If the
    # fetch fails, local data is left untouched rather than wiped.
    if not supabase_configured(): return 0
    greenhouses = snapshot['greenhouses'] if snapshot else supabase_select("greenhouses", {
        "select": "id,name,phase_start,phase_end,window_start,window_end,is_active,updated_at",
        "is_active": "eq.true"
    })
    sensors = snapshot['greenhouse_sensors'] if snapshot else supabase_select("greenhouse_sensors", {"select": "greenhouse_id,sensor_id"})
    registry = snapshot['sensor_list'] if snapshot else supabase_select("sensor_list", {"select": "sensor_id"})

    conn = get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        reconcile_incidents(conn)
        conn.execute("DELETE FROM greenhouse_sensors")
        conn.execute("DELETE FROM greenhouses")
        conn.execute("DELETE FROM registered_sensors")
        conn.executemany("INSERT OR IGNORE INTO registered_sensors(sensor_id) VALUES (?)", [(row["sensor_id"],) for row in registry])
        for row in greenhouses:
            conn.execute(
                "INSERT INTO greenhouses (id, name, phase_start, phase_end, window_start, window_end, is_active, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (row["id"], row["name"], row["phase_start"], row["phase_end"], row["window_start"][:5], row["window_end"][:5], 1 if row["is_active"] else 0, row["updated_at"])
            )
        for row in sensors:
            conn.execute(
                "INSERT INTO greenhouse_sensors (greenhouse_id, sensor_id) VALUES (?,?)",
                (row["greenhouse_id"], row["sensor_id"])
            )
        reconcile_incidents(conn)
        conn.commit()
    finally:
        conn.close()
    _outbox_wake.set()
    return len(greenhouses)


def apply_configuration_snapshot(snapshot):
    """Publish assignments, phase settings and SMS ownership in one SQLite commit."""
    global DARK_PHASE_DAYS
    days = int(snapshot['dark_phase_days'])
    if not 1 <= days <= 36500:
        raise ValueError('Invalid dark phase duration')
    for row in snapshot['greenhouses']:
        if date.fromisoformat(row['phase_end']) < date.fromisoformat(row['phase_start']):
            raise ValueError('Invalid phase dates')
        if not parse_time(row['window_start']) or not parse_time(row['window_end']):
            raise ValueError('Invalid monitoring window')
    ids = {r['id'] for r in snapshot['greenhouses']}
    assignments = snapshot['greenhouse_sensors']
    if len({r['sensor_id'] for r in assignments}) != len(assignments) or any(r['greenhouse_id'] not in ids for r in assignments):
        raise ValueError('Invalid sensor assignments')
    conn = get_db()
    previous = DARK_PHASE_DAYS
    try:
        conn.execute('BEGIN IMMEDIATE')
        if LOCAL_SMS.get('enabled') or snapshot.get('local_sms') is not None:
            local_sms.cache_config(conn, snapshot)
        conn.execute('DELETE FROM greenhouse_sensors')
        conn.execute('DELETE FROM greenhouses')
        conn.execute('DELETE FROM registered_sensors')
        conn.executemany('INSERT OR IGNORE INTO registered_sensors(sensor_id) VALUES (?)', [(r['sensor_id'],) for r in snapshot['sensor_list']])
        for row in snapshot['greenhouses']:
            conn.execute('INSERT INTO greenhouses(id,name,phase_start,phase_end,window_start,window_end,is_active,updated_at) VALUES (?,?,?,?,?,?,?,?)',
                (row['id'],row['name'],row['phase_start'],row['phase_end'],row['window_start'][:5],row['window_end'][:5],int(row['is_active']),row['updated_at']))
        for row in snapshot['greenhouse_sensors']:
            conn.execute('INSERT INTO greenhouse_sensors(greenhouse_id,sensor_id) VALUES (?,?)', (row['greenhouse_id'],row['sensor_id']))
        DARK_PHASE_DAYS = days
        conn.execute("INSERT INTO supabase_sync_state VALUES ('dark_phase_days',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(days),))
        if not LOCAL_SMS.get('enabled') or local_sms.clock_ready(LOCAL_SMS):
            reconcile_incidents(conn)
            local_sms.sync_events(conn, LOCAL_SMS)
        conn.commit()
    except Exception:
        DARK_PHASE_DAYS = previous
        raise
    finally:
        conn.close()
    _outbox_wake.set()


def run_supabase_sync():
    snapshot = cloud_request('configuration')
    apply_configuration_snapshot(snapshot)
    print(f"[SUPABASE SYNC] greenhouses={len(snapshot['greenhouses'])} dark_phase_days={DARK_PHASE_DAYS}")


def supabase_sync_loop():
    global _supabase_sync_running
    if _supabase_sync_running: return
    _supabase_sync_running = True
    while _supabase_sync_running:
        try:
            if supabase_configured(): run_supabase_sync()
        except Exception as error: print(f"[SUPABASE SYNC ERROR] {error}")
        time.sleep(SUPABASE_SYNC_INTERVAL_SECONDS)


def start_supabase_sync():
    global _supabase_sync_thread
    if _supabase_sync_thread and _supabase_sync_thread.is_alive(): return
    _supabase_sync_thread = threading.Thread(target=supabase_sync_loop, name="supabase-sync", daemon=True); _supabase_sync_thread.start()


def local_sms_loop():
    # Separate from the cloud outbox: internet timeouts never delay local SMS.
    while True:
        try:
            local_sms_clock.establish(LOCAL_SMS, Path(DB_PATH))
            reconcile_incident_lifecycle()
            local_sms.tick(get_db, LOCAL_SMS)
            conn = get_db()
            try:
                conn.execute('BEGIN IMMEDIATE')
                local_sms.report_pending(conn, enqueue_delivery)
                conn.commit()
            finally:
                conn.close()
        except Exception:
            print('[LOCAL SMS] Worker unavailable; inspect local status/configuration')
        time.sleep(1)


def start_local_sms():
    if LOCAL_SMS.get('enabled'):
        threading.Thread(target=local_sms_loop, name='local-sms', daemon=True).start()


def lan_ingestion(environ, start_response):
    # This listener cannot expose cloud-authenticated manager endpoints.
    if environ.get('PATH_INFO') != '/api/readings' or environ.get('REQUEST_METHOD') != 'POST':
        start_response('404 Not Found', [('Content-Type', 'application/json')])
        return [b'{"error":"Local listener accepts sensor readings only"}']
    environ.pop('HTTP_CF_CONNECTING_IP', None)
    return app(environ, start_response)


def start_lan_ingestion():
    address = SECURITY.get('lan_bind')
    if not address:
        return
    lan_ip = ipaddress.ip_address(address)
    if lan_ip.version != 4 or not any(lan_ip in ipaddress.ip_network(n) for n in ('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16')):
        raise SystemExit('lan_bind must be the Pi reserved private IPv4 address')
    from waitress import create_server
    # Bind synchronously so address conflicts cannot silently disable ingestion.
    server = create_server(lan_ingestion, host=address, port=5001, threads=4,
        max_request_body_size=32768, expose_tracebacks=False, clear_untrusted_proxy_headers=True)
    threading.Thread(target=server.run, name='lan-ingestion', daemon=True).start()


if __name__ == "__main__":
    if len(DEVICE_KEY) < 32 or len(PI_TOKEN) < 32 or not ALLOWED_ORIGINS:
        raise SystemExit('Provision device authentication, scoped cloud access, and allowed web origins before starting the service.')
    from waitress import serve
    if LOCAL_SMS.get('enabled'):
        if str(LPMAS_TIMEZONE) != 'Asia/Manila':
            raise SystemExit('Local monitoring must use Asia/Manila to match cloud schedules.')
        local_sms.validate_gateway(LOCAL_SMS)
    init_db(); start_lan_ingestion(); start_supabase_sync(); start_outbox(); start_local_sms()
    serve(app, host='127.0.0.1', port=5000, threads=8, connection_limit=64,
          channel_timeout=30, max_request_body_size=32768, max_request_header_size=16384,
          expose_tracebacks=False, clear_untrusted_proxy_headers=True, ident='')
