from flask import Flask, request, jsonify
from flask_cors import CORS
from datetime import datetime, date, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
import sqlite3
import os
import json
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


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def table_columns(conn, table):
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def init_db():
    conn = get_db()
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
    migrate_legacy_schema(conn)
    migrate_readings_nullable_metadata(conn)
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

    conn.execute("CREATE INDEX IF NOT EXISTS readings_sensor_time_idx ON readings(sensor_id, recorded_at DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS readings_greenhouse_time_idx ON readings(greenhouse_id, recorded_at DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS incidents_sensor_status_idx ON incidents(sensor_id, status)")
    conn.execute("CREATE INDEX IF NOT EXISTS incidents_greenhouse_status_idx ON incidents(greenhouse_id, status)")
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
    try: return datetime.strptime(value, "%H:%M").time()
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
    if not is_within_window(datetime.now(LPMAS_TIMEZONE).strftime("%H:%M"), phase["window_start"], phase["window_end"]): return "safe"
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


def get_open_incident(conn, sensor_id, phase_type):
    return conn.execute("""
        SELECT * FROM incidents
        WHERE sensor_id = ? AND phase_type = ? AND status IN ('open', 'acknowledged')
        ORDER BY id DESC LIMIT 1
    """, (sensor_id, phase_type)).fetchone()


def update_incident_values(conn, incident, lux):
    peak = max(float(incident["peak_lux"]) if incident["peak_lux"] is not None else lux, lux)
    lowest = min(float(incident["lowest_lux"]) if incident["lowest_lux"] is not None else lux, lux)
    conn.execute("UPDATE incidents SET peak_lux = ?, lowest_lux = ? WHERE id = ?", (peak, lowest, incident["id"]))


def open_incident(conn, sensor_id, greenhouse_id, phase_type, lux, triggering_rows=None):
    existing = get_open_incident(conn, sensor_id, phase_type)
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
    return cursor.lastrowid, True


def resolve_incident(conn, incident):
    conn.execute("UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?", (now_iso(), incident["id"]))


def manager_phone():
    if supabase_configured():
        url = f"{SUPABASE_URL}/rest/v1/system_settings?key=eq.manager_phone&select=value&limit=1"
        req = urllib.request.Request(url, method="GET")
        req.add_header("apikey", SUPABASE_SECRET_KEY)
        req.add_header("Authorization", f"Bearer {SUPABASE_SECRET_KEY}")
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                rows = json.loads(response.read().decode("utf-8"))
                value = str(rows[0].get("value", "")).strip() if rows else ""
                if value: return value
        except Exception as error:
            print(f"[SMS SETTINGS ERROR] {error}")
    return ""


def fire_sms(sensor_id, greenhouse_id, phase_type, lux):
    phone = manager_phone()
    if not phone:
        print(f"[SMS NOT CONFIGURED] sensor={sensor_id} greenhouse={greenhouse_id} phase={phase_type} lux={lux}")
        return False
    print(f"[SMS NOT SENT - PROVIDER NOT CONFIGURED] manager={phone} sensor={sensor_id} greenhouse={greenhouse_id} phase={phase_type} lux={lux}")
    return False


def handle_incident(conn, sensor_id, greenhouse_id, lux, classification, phase_type):
    incident = get_open_incident(conn, sensor_id, phase_type)
    if classification == "violation":
        sequence = violation_sequence(conn, sensor_id, greenhouse_id, phase_type)
        if sequence:
            incident_id, created = open_incident(
                conn, sensor_id, greenhouse_id, phase_type, lux, triggering_rows=sequence
            )
            if created: fire_sms(sensor_id, greenhouse_id, phase_type, lux)
            return incident_id, "open"
        return incident["id"] if incident else None, "pending"
    if incident and classification == "safe":
        resolve_incident(conn, incident)
        return incident["id"], "resolved"
    if incident: update_incident_values(conn, incident, lux); return incident["id"], incident["status"]
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
def create_greenhouse():
    payload = request.get_json(silent=True) or {}
    greenhouse_id = str(payload.get("id", "")).strip()
    name = str(payload.get("name", "")).strip()
    sensor_ids = [str(value).strip() for value in payload.get("sensor_ids", []) if str(value).strip()]
    phase_start = str(payload.get("phase_start", "")).strip()
    phase_end = str(payload.get("phase_end", "")).strip()
    window_start = str(payload.get("window_start", "")).strip()
    window_end = str(payload.get("window_end", "")).strip()
    if not greenhouse_id or not name or not sensor_ids or not phase_start or not phase_end or not window_start or not window_end: return jsonify({"error": "id, name, sensor_ids, phase_start, phase_end, window_start and window_end are required"}), 400
    start, end = parse_date(phase_start), parse_date(phase_end)
    if not start or not end or end < start: return jsonify({"error": "Invalid phase dates"}), 400
    if not parse_time(window_start) or not parse_time(window_end): return jsonify({"error": "Invalid monitoring time window"}), 400
    conn = get_db()
    try:
        conn.execute("UPDATE greenhouses SET is_active = 0 WHERE id = ?", (greenhouse_id,))
        conn.execute("""INSERT INTO greenhouses(id, name, phase_start, phase_end, window_start, window_end, is_active, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, phase_start=excluded.phase_start, phase_end=excluded.phase_end, window_start=excluded.window_start, window_end=excluded.window_end, is_active=1, updated_at=excluded.updated_at""", (greenhouse_id, name, phase_start, phase_end, window_start, window_end, now_iso()))
        conn.execute(
            f"DELETE FROM greenhouse_sensors WHERE sensor_id IN ({','.join('?' for _ in sensor_ids)}) AND greenhouse_id != ?",
            (*sensor_ids, greenhouse_id)
        )
        conn.execute("DELETE FROM greenhouse_sensors WHERE greenhouse_id = ?", (greenhouse_id,))
        for sensor_id in sensor_ids:
            conn.execute("INSERT OR IGNORE INTO greenhouse_sensors(greenhouse_id, sensor_id) VALUES (?, ?)", (greenhouse_id, sensor_id))
        conn.commit()
        row = conn.execute("SELECT * FROM greenhouses WHERE id = ?", (greenhouse_id,)).fetchone()
        result = dict(row); result["sensor_ids"] = sensor_ids
        return jsonify(result), 201
    finally:
        conn.close()


@app.route("/api/greenhouses/<greenhouse_id>", methods=["DELETE"])
def delete_greenhouse(greenhouse_id):
    greenhouse_id = str(greenhouse_id).strip()

    if not greenhouse_id:
        return jsonify({"error": "Greenhouse ID is required"}), 400

    conn = get_db()

    try:
        greenhouse = conn.execute(
            "SELECT * FROM greenhouses WHERE id = ? AND is_active = 1",
            (greenhouse_id,)
        ).fetchone()

        if not greenhouse:
            return jsonify({"error": "Greenhouse not found"}), 404

        # Remove the current configuration and sensor assignments only.
        # Historical readings/incidents keep their greenhouse_id for reporting.
        conn.execute(
            "DELETE FROM greenhouse_sensors WHERE greenhouse_id = ?",
            (greenhouse_id,)
        )
        conn.execute(
            "DELETE FROM greenhouses WHERE id = ?",
            (greenhouse_id,)
        )
        conn.commit()

        return jsonify({"ok": True, "id": greenhouse_id})

    except Exception as error:
        conn.rollback()
        return jsonify({"error": str(error)}), 500

    finally:
        conn.close()

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
    payload = request.get_json(silent=True) or {}; sensor_id = str(payload.get("sensor_id", "")).strip()
    try: lux = float(payload.get("lux"))
    except (TypeError, ValueError): return jsonify({"error": "Invalid lux value"}), 400
    if not sensor_id: return jsonify({"error": "sensor_id is required"}), 400
    if lux < 0: return jsonify({"error": "lux cannot be negative"}), 400
    conn = get_db(); greenhouse = get_sensor_greenhouse(conn, sensor_id); phase = get_phase_for_sensor(conn, sensor_id)
    classification = classify_reading(lux, phase) or "unclassified"
    phase_type = phase["phase_type"] if phase else "unconfigured"
    greenhouse_id = greenhouse["id"] if greenhouse else None
    recorded_at = now_iso()
    cursor = conn.execute("INSERT INTO readings(sensor_id, greenhouse_id, lux, recorded_at, classification, phase_type) VALUES (?, ?, ?, ?, ?, ?)", (sensor_id, greenhouse_id, lux, recorded_at, classification, phase_type))
    incident_id, incident_status = (None, "waiting")
    if phase:
        incident_id, incident_status = handle_incident(conn, sensor_id, greenhouse_id, lux, classification, phase_type)
    conn.commit(); reading_id = cursor.lastrowid; conn.close()
    return jsonify({"id": reading_id, "sensor_id": sensor_id, "greenhouse_id": greenhouse_id, "lux": lux, "recorded_at": recorded_at, "classification": classification, "phase_type": phase_type, "incident_id": incident_id, "incident_status": incident_status}), 201


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
def acknowledge_incident(incident_id):
    conn = get_db(); row = conn.execute("SELECT * FROM incidents WHERE id = ?", (incident_id,)).fetchone()
    if not row: conn.close(); return jsonify({"error": "Incident not found"}), 404
    conn.execute("UPDATE incidents SET status = 'acknowledged' WHERE id = ? AND status = 'open'", (incident_id,)); conn.commit(); conn.close(); return jsonify({"status": "acknowledged"})


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
    return jsonify({"phase": phase, "readings": [dict(row) for row in reversed(rows)], "incidents": [dict(row) for row in incidents], "generatedAt": now_iso()})


def get_sync_state(conn, key):
    row = conn.execute("SELECT value FROM supabase_sync_state WHERE key = ?", (key,)).fetchone(); return row["value"] if row else None


def set_sync_state(conn, key, value):
    conn.execute("INSERT INTO supabase_sync_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value)); conn.commit()


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

    conn = get_db()
    conn.execute("DELETE FROM greenhouse_sensors")
    conn.execute("DELETE FROM greenhouses")
    for row in greenhouses:
        conn.execute(
            "INSERT INTO greenhouses (id, name, phase_start, phase_end, window_start, window_end, is_active, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (row["id"], row["name"], row["phase_start"], row["phase_end"], row["window_start"], row["window_end"], 1 if row["is_active"] else 0, row["updated_at"])
        )
    for row in sensors:
        conn.execute(
            "INSERT INTO greenhouse_sensors (greenhouse_id, sensor_id) VALUES (?,?)",
            (row["greenhouse_id"], row["sensor_id"])
        )
    conn.commit(); conn.close()
    return len(greenhouses)


def get_first_reading_bucket(conn):
    row = conn.execute("SELECT MIN(recorded_at) AS first_reading FROM readings").fetchone()
    parsed = parse_datetime(row["first_reading"]) if row and row["first_reading"] else None
    return parsed.astimezone(LPMAS_TIMEZONE).replace(second=0, microsecond=0) if parsed else None


def current_bucket(): return datetime.now(LPMAS_TIMEZONE).replace(second=0, microsecond=0)


def aggregate_readings_to_supabase():
    if not supabase_configured(): return 0
    conn = get_db(); state = get_sync_state(conn, "last_aggregate_bucket")
    if state:
        try: start = datetime.fromisoformat(state) + timedelta(minutes=1)
        except ValueError: start = get_first_reading_bucket(conn)
    else: start = get_first_reading_bucket(conn)
    cutoff = current_bucket()
    if not start or start >= cutoff: conn.close(); return 0
    rows = conn.execute("""
        SELECT sensor_id, greenhouse_id, substr(recorded_at, 1, 16) AS bucket_key, phase_type, COUNT(*) AS sample_count,
               AVG(lux) AS avg_lux, MIN(lux) AS min_lux, MAX(lux) AS max_lux,
               SUM(CASE WHEN classification='safe' THEN 1 ELSE 0 END) AS safe_count,
               SUM(CASE WHEN classification='warning' THEN 1 ELSE 0 END) AS warning_count,
               SUM(CASE WHEN classification='violation' THEN 1 ELSE 0 END) AS violation_count
        FROM readings WHERE recorded_at >= ? AND recorded_at < ?
          AND greenhouse_id IS NOT NULL
          AND phase_type IS NOT NULL
          AND phase_type != 'unconfigured'
        GROUP BY sensor_id, greenhouse_id, bucket_key, phase_type ORDER BY bucket_key ASC
    """, (start.isoformat(timespec="seconds"), cutoff.isoformat(timespec="seconds"))).fetchall()
    payload = []
    for row in rows:
        bucket = datetime.strptime(row["bucket_key"], "%Y-%m-%dT%H:%M").replace(tzinfo=LPMAS_TIMEZONE)
        payload.append({"sensor_id": row["sensor_id"], "greenhouse_id": row["greenhouse_id"], "bucket_start": bucket.isoformat(), "phase_type": row["phase_type"], "sample_count": int(row["sample_count"]), "avg_lux": round(float(row["avg_lux"]), 3), "min_lux": round(float(row["min_lux"]), 3), "max_lux": round(float(row["max_lux"]), 3), "safe_count": int(row["safe_count"]), "warning_count": int(row["warning_count"]), "violation_count": int(row["violation_count"]), "updated_at": now_iso()})
    if payload: supabase_request("sensor_minute_aggregates", payload, "sensor_id,bucket_start")
    set_sync_state(conn, "last_aggregate_bucket", (cutoff - timedelta(minutes=1)).isoformat(timespec="seconds")); conn.close(); return len(payload)


def sync_incidents_to_supabase():
    if not supabase_configured(): return 0
    conn = get_db(); rows = conn.execute("SELECT * FROM incidents ORDER BY id ASC").fetchall(); payload = []
    for row in rows:
        payload.append({"pi_incident_id": int(row["id"]), "sensor_id": row["sensor_id"], "greenhouse_id": row["greenhouse_id"], "phase_type": row["phase_type"], "opened_at": row["opened_at"], "resolved_at": row["resolved_at"], "status": row["status"], "peak_lux": row["peak_lux"], "lowest_lux": row["lowest_lux"], "reason": row["reason"], "updated_at": now_iso()})
    if payload: supabase_request("monitoring_incidents", payload, "pi_incident_id")
    conn.close(); return len(payload)


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
    print(f"[SUPABASE SYNC] greenhouses={greenhouse_count} dark_phase_days={dark_phase_days} aggregates={aggregate_readings_to_supabase()} incidents={sync_incidents_to_supabase()}")


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
    init_db(); start_supabase_sync(); app.run(host="0.0.0.0", port=5000, debug=False)