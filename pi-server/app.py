from flask import Flask, request, jsonify
from flask_cors import CORS
from datetime import datetime, date, timedelta
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

app = Flask(__name__)
CORS(app)

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
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'): value = value[1:-1]
                os.environ.setdefault(key, value)
    except Exception as error:
        print(f"[ENV ERROR] {error}")


load_env_file()
LPMAS_TIMEZONE = ZoneInfo(os.getenv("LPMAS_TIMEZONE", "Asia/Manila"))
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY", "")

# --- Pi -> Edge Function forwarding -----------------------------------------
#
# The Edge Function is the only writer of sensor_list and
# sensor_minute_aggregates. The Pi forwards each reading as it arrives rather
# than batch-aggregating, so a sensor that goes offline shows up in the cloud
# within seconds instead of up to one sync interval later.
#
# SERVICE_KEY is the service_role key: this is a server-to-server call from a
# device holding the secret, never a browser, so it bypasses RLS by design.
EDGE_FUNCTION_URL = f"{SUPABASE_URL}/functions/v1/ingest-reading" if SUPABASE_URL else ""
SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
DEVICE_KEY = os.getenv("LPMAS_DEVICE_KEY", "")
_outbox_thread = None
_outbox_wake = threading.Event()


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA synchronous=FULL")
    return conn


def table_columns(conn, table):
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def init_db():
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
            ORDER BY g.is_active DESC, g.updated_at DESC, gs.rowid DESC
        """, (duplicate["sensor_id"],)).fetchall()
        for mapping in mappings[1:]:
            conn.execute("DELETE FROM greenhouse_sensors WHERE rowid = ?", (mapping["rowid"],))

    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS readings_uid_idx ON readings(reading_uid)")
    conn.execute("CREATE INDEX IF NOT EXISTS readings_sensor_time_idx ON readings(sensor_id, recorded_at DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS readings_greenhouse_time_idx ON readings(greenhouse_id, recorded_at DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS incidents_sensor_status_idx ON incidents(sensor_id, status)")
    conn.execute("CREATE INDEX IF NOT EXISTS incidents_greenhouse_status_idx ON incidents(greenhouse_id, status)")
    registry_exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='registered_sensors'").fetchone()
    conn.execute("CREATE TABLE IF NOT EXISTS registered_sensors (sensor_id TEXT PRIMARY KEY)")
    if not registry_exists:
        # Bootstrap an existing installation during an offline upgrade. Later
        # successful cloud snapshots replace this cache, including removals.
        conn.execute("INSERT OR IGNORE INTO registered_sensors SELECT DISTINCT sensor_id FROM readings")
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
            phase_type TEXT
        )
    """)
    conn.execute("""
        INSERT INTO readings_new(id, sensor_id, greenhouse_id, lux, recorded_at, classification, phase_type)
        SELECT id, sensor_id, greenhouse_id, lux, recorded_at, classification, phase_type FROM readings
    """)
    conn.execute("DROP TABLE readings")
    conn.execute("ALTER TABLE readings_new RENAME TO readings")


def now_iso(): return datetime.now(LPMAS_TIMEZONE).isoformat(timespec="seconds")
def today(): return datetime.now(LPMAS_TIMEZONE).date()


def parse_date(value):
    try: return date.fromisoformat(value) if value else None
    except ValueError: return None


def parse_datetime(value):
    if not value: return None
    try:
        parsed = datetime.fromisoformat(value)
        return parsed.replace(tzinfo=LPMAS_TIMEZONE) if parsed.tzinfo is None else parsed
    except ValueError: return None


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
        ORDER BY g.updated_at DESC LIMIT 1
    """, (sensor_id,)).fetchone()


def get_illumination_phase(conn, greenhouse):
    if not greenhouse: return None
    start = parse_date(greenhouse["phase_start"])
    end = parse_date(greenhouse["phase_end"])
    if not start or not end or not (start <= today() <= end): return None
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


def get_dark_phase(conn, greenhouse):
    if not greenhouse: return None
    illumination_end = parse_date(greenhouse["phase_end"])
    if not illumination_end: return None
    dark_start = illumination_end + timedelta(days=1)
    dark_end = dark_start + timedelta(days=DARK_PHASE_DAYS - 1)
    if not (dark_start <= today() <= dark_end): return None
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


def get_phase_for_sensor(conn, sensor_id):
    greenhouse = get_sensor_greenhouse(conn, sensor_id)
    if not greenhouse: return None
    return get_illumination_phase(conn, greenhouse) or get_dark_phase(conn, greenhouse)


def get_active_phase(conn):
    rows = conn.execute("SELECT * FROM greenhouses WHERE is_active = 1 ORDER BY updated_at DESC").fetchall()
    for greenhouse in rows:
        phase = get_illumination_phase(conn, greenhouse) or get_dark_phase(conn, greenhouse)
        if phase: return phase
    return None


def classify_reading(lux, phase):
    if not phase: return None
    if phase["phase_type"] == "dark":
        if lux <= DARK_SAFE_MAX: return "safe"
        if lux <= DARK_WARNING_MAX: return "warning"
        return "violation"
    if not is_within_window(datetime.now(LPMAS_TIMEZONE).strftime("%H:%M"), phase["window_start"], phase["window_end"]): return "unclassified"
    if lux <= ILLUMINATION_VIOLATION_MAX: return "violation"
    if lux < ILLUMINATION_WARNING_MAX: return "warning"
    return "safe"


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
    for row in rows:
        if (row["classification"] != "violation" or
                row["phase_type"] != phase_type or
                row["greenhouse_id"] != greenhouse_id):
            return None

    timestamps = [parse_datetime(row["recorded_at"]) for row in rows]
    if any(ts is None for ts in timestamps):
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
    return cursor.lastrowid, True


def resolve_incident(conn, incident):
    conn.execute("UPDATE incidents SET status = 'resolved', resolved_at = ?, version = version + 1 WHERE id = ?", (now_iso(), incident["id"]))


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
    if incident and classification == "safe":
        resolve_incident(conn, incident)
        return incident["id"], "resolved"
    if incident and classification != "unclassified": update_incident_values(conn, incident, lux); return incident["id"], incident["status"]
    return None, classification


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
            req = urllib.request.Request(f"{SUPABASE_URL}/auth/v1/user", headers={"apikey": SUPABASE_SECRET_KEY, "Authorization": token})
            with urllib.request.urlopen(req, timeout=5) as response:
                user = json.loads(response.read())
            rows = supabase_select("profiles", {"select": "role", "id": f"eq.{user['id']}"})
            if not rows or rows[0]["role"] not in ("admin", "manager"):
                return jsonify({"error": "Manager or admin access required"}), 403
        except Exception:
            return jsonify({"error": "Unable to verify authentication"}), 401
        return handler(*args, **kwargs)
    return checked


@app.route("/api/readings", methods=["GET"])
def get_readings():
    conn = get_db(); sensor_id = request.args.get("sensor_id"); greenhouse_id = request.args.get("greenhouse_id"); start = request.args.get("start"); end = request.args.get("end")
    try: limit = max(1, min(int(request.args.get("limit", 100)), 100000))
    except ValueError: limit = 100
    query = "SELECT * FROM readings WHERE 1=1"; params = []
    if sensor_id: query += " AND sensor_id = ?"; params.append(sensor_id)
    if greenhouse_id: query += " AND greenhouse_id = ?"; params.append(greenhouse_id)
    if start: query += " AND recorded_at >= ?"; params.append(start)
    if end: query += " AND recorded_at <= ?"; params.append(end)
    query += " ORDER BY recorded_at ASC LIMIT ?"; params.append(limit)
    rows = conn.execute(query, params).fetchall(); conn.close()
    return jsonify([dict(row) for row in rows])


@app.route("/api/readings", methods=["POST"])
def create_reading():
    supplied = request.headers.get("X-LPMAS-Device-Key", "")
    if DEVICE_KEY and not hmac.compare_digest(supplied.encode(), DEVICE_KEY.encode()):
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
    if reading_uid is None and not DEVICE_KEY:
        # Existing firmware sends only sensor_id/lux. Persist a Pi-generated
        # identity once so cloud retries remain idempotent. Sensor-side retries
        # cannot be distinguished from new captures without a device UUID.
        reading_uid = str(uuid.uuid4())
    try:
        parsed_uid = uuid.UUID(reading_uid)
        if parsed_uid.variant != uuid.RFC_4122 or not 1 <= parsed_uid.version <= 8:
            raise ValueError("Unsupported UUID")
        reading_uid = str(parsed_uid)
    except (ValueError, TypeError, AttributeError): return jsonify({"error": "UUID reading_id required"}), 400
    conn = get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        if not DEVICE_KEY and not conn.execute(
            "SELECT sensor_id FROM registered_sensors WHERE sensor_id=? UNION SELECT sensor_id FROM greenhouse_sensors WHERE sensor_id=?",
            (sensor_id, sensor_id),
        ).fetchone():
            return jsonify({"error": "Sensor is not registered; wait for configuration sync or assign it in the dashboard"}), 403
        existing = conn.execute("SELECT * FROM readings WHERE reading_uid=?", (reading_uid,)).fetchone()
        if existing:
            if existing["sensor_id"] != sensor_id or existing["lux"] != lux:
                return jsonify({"error": "reading_id reused with different content"}), 409
            return jsonify(dict(existing)), 200
        greenhouse = get_sensor_greenhouse(conn, sensor_id)
        phase = get_phase_for_sensor(conn, sensor_id)
        classification = classify_reading(lux, phase) or "unclassified"
        phase_type = phase["phase_type"] if phase else "unconfigured"
        greenhouse_id = greenhouse["id"] if greenhouse else None
        recorded_at = now_iso()
        config = dict(greenhouse) if greenhouse else {}
        config["dark_phase_days"] = DARK_PHASE_DAYS
        config_version = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
        cursor = conn.execute("INSERT INTO readings(sensor_id,greenhouse_id,lux,recorded_at,classification,phase_type,reading_uid,config_version) VALUES (?,?,?,?,?,?,?,?)",
            (sensor_id,greenhouse_id,lux,recorded_at,classification,phase_type,reading_uid,config_version))
        incident_id, incident_status = (None, "waiting")
        if phase:
            incident_id, incident_status = handle_incident(conn,sensor_id,greenhouse_id,lux,classification,phase_type)
        reading = dict(conn.execute("SELECT * FROM readings WHERE id=?", (cursor.lastrowid,)).fetchone())
        delivery = reading_delivery(reading, incident_snapshot(conn, incident_id))
        enqueue_delivery(conn, delivery)
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
        ok = _deliver(json.loads(entry["payload"]),post)
        conn = get_db()
        if ok:
            conn.execute("DELETE FROM delivery_outbox WHERE delivery_id=?", (entry["delivery_id"],))
            delivered += 1
        else:
            conn.execute("UPDATE delivery_outbox SET attempts=attempts+1,next_attempt_at=?,last_error=? WHERE delivery_id=?",
                (time.time()+min(3600,2**min(entry["attempts"]+1,12)),"Cloud delivery failed",entry["delivery_id"]))
        conn.commit(); conn.close()
    # Durable SMS retries must also run while no sensors are posting.
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
        try: flush_outbox()
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


def edge_function_configured(): return bool(EDGE_FUNCTION_URL and SERVICE_KEY)


def _deliver(payload, post):
    try:
        with post(EDGE_FUNCTION_URL,json.dumps(payload,allow_nan=False),{
            "apikey":SERVICE_KEY,"Authorization":f"Bearer {SERVICE_KEY}","Content-Type":"application/json"
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
    query += " ORDER BY opened_at DESC"; rows = conn.execute(query, params).fetchall(); conn.close(); return jsonify([dict(row) for row in rows])


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
def hardware_activity():
    conn = get_db(); greenhouse_id = request.args.get("greenhouse_id"); sensor_ids = request.args.getlist("sensor_id"); start = request.args.get("start"); end = request.args.get("end")
    query = "SELECT * FROM readings WHERE 1=1"; params = []
    if greenhouse_id: query += " AND greenhouse_id = ?"; params.append(greenhouse_id)
    if sensor_ids:
        query += f" AND sensor_id IN ({','.join('?' for _ in sensor_ids)})"; params.extend(sensor_ids)
    if start: query += " AND recorded_at >= ?"; params.append(start)
    if end: query += " AND recorded_at <= ?"; params.append(end)
    query += " ORDER BY recorded_at ASC"; rows = conn.execute(query, params).fetchall(); conn.close()
    return jsonify({"readings": [dict(row) for row in rows], "count": len(rows)})


@app.route("/api/dashboard", methods=["GET"])
def dashboard():
    conn = get_db(); phase = get_active_phase(conn)
    rows = conn.execute("SELECT * FROM readings ORDER BY recorded_at DESC LIMIT 300").fetchall()
    incidents = conn.execute("SELECT * FROM incidents ORDER BY opened_at DESC LIMIT 100").fetchall(); conn.close()
    health = get_db()
    pending = health.execute("SELECT count(*) AS n, min(created_at) AS oldest FROM delivery_outbox").fetchone()
    failures = health.execute("SELECT count(*) FROM delivery_outbox WHERE attempts > 0").fetchone()[0]
    health.close()
    return jsonify({"phase":phase,"readings":[dict(row) for row in reversed(rows)],"incidents":[dict(row) for row in incidents],"generatedAt":now_iso(),
        "deliveryHealth":{"pending":pending["n"],"oldestPendingAt":pending["oldest"],"failedAttempts":failures,"configured":edge_function_configured()}})


def get_sync_state(conn, key):
    row = conn.execute("SELECT value FROM supabase_sync_state WHERE key = ?", (key,)).fetchone(); return row["value"] if row else None


def set_sync_state(conn, key, value):
    conn.execute("INSERT INTO supabase_sync_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value)); conn.commit()


def supabase_configured(): return bool(SUPABASE_URL and SUPABASE_SECRET_KEY)


def supabase_select(table, params):
    if not supabase_configured(): raise RuntimeError("Supabase environment variables are not configured")
    query = urllib.parse.urlencode(params); url = f"{SUPABASE_URL}/rest/v1/{table}?{query}"
    req = urllib.request.Request(url, method="GET"); req.add_header("apikey", SUPABASE_SECRET_KEY); req.add_header("Authorization", f"Bearer {SUPABASE_SECRET_KEY}")
    try:
        with urllib.request.urlopen(req, timeout=20) as response: return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace"); raise RuntimeError(f"Supabase HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error: raise RuntimeError(f"Supabase connection failed: {error.reason}") from error


def sync_dark_phase_duration_from_supabase():
    # Admin-configurable via AdminView.tsx -> web/app/api/admin/settings ->
    # system_settings.dark_phase_duration_days. Falls back to the original
    # fixed default if unset, invalid, or Supabase is unreachable.
    global DARK_PHASE_DAYS
    if not supabase_configured(): return DARK_PHASE_DAYS
    rows = supabase_select("system_settings", {"key": "eq.dark_phase_duration_days", "select": "value", "limit": 1})
    if not rows:
        DARK_PHASE_DAYS = DARK_PHASE_DAYS_DEFAULT
        return DARK_PHASE_DAYS
    try:
        parsed = int(str(rows[0].get("value", "")).strip())
        DARK_PHASE_DAYS = parsed if parsed >= 1 else DARK_PHASE_DAYS_DEFAULT
    except (TypeError, ValueError):
        DARK_PHASE_DAYS = DARK_PHASE_DAYS_DEFAULT
    return DARK_PHASE_DAYS


def sync_greenhouses_from_supabase():
    # Supabase is now the source of truth for greenhouse configuration
    # (see 0006_greenhouse_config.sql). This mirrors it into local SQLite
    # so classify_reading()/get_phase_for_sensor() keep working without a
    # live Supabase round-trip on every 10-second ESP32 reading. If the
    # fetch fails, local data is left untouched rather than wiped.
    if not supabase_configured(): return 0
    greenhouses = supabase_select("greenhouses", {
        "select": "id,name,phase_start,phase_end,window_start,window_end,is_active,updated_at",
        "is_active": "eq.true"
    })
    sensors = supabase_select("greenhouse_sensors", {"select": "greenhouse_id,sensor_id"})
    registry = supabase_select("sensor_list", {"select": "sensor_id"})

    conn = get_db()
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
    conn.commit(); conn.close()
    return len(greenhouses)


def run_supabase_sync():
    # Each piece is isolated: a failure in one shouldn't block the others
    # from still syncing this cycle.
    try:
        greenhouse_count = sync_greenhouses_from_supabase()
    except Exception as error:
        print(f"[SUPABASE SYNC ERROR] greenhouses: {error}")
        greenhouse_count = None
    try:
        dark_phase_days = sync_dark_phase_duration_from_supabase()
    except Exception as error:
        print(f"[SUPABASE SYNC ERROR] dark phase duration: {error}")
        dark_phase_days = DARK_PHASE_DAYS
    # NOTE: aggregates are intentionally absent. The Edge Function writes
    # sensor_minute_aggregates per reading; the Pi must not also batch them.
    # Incident snapshots travel through the transactional delivery outbox.
    print(f"[SUPABASE SYNC] greenhouses={greenhouse_count} dark_phase_days={dark_phase_days}")


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


if __name__ == "__main__":
    if not DEVICE_KEY:
        print("[DEVICE INPUT] Legacy registered-sensor compatibility enabled; device requests are not authenticated. Set LPMAS_DEVICE_KEY only after upgrading the firmware.")
    init_db(); start_supabase_sync(); start_outbox(); app.run(host="0.0.0.0", port=5000, debug=False)
