"""
LPMAS Pi Server
----------------
Runs on the Raspberry Pi. Receives raw sensor readings from the ESP32,
classifies them against the currently active phase (illumination range
check OR dark-phase ceiling check), stores everything in SQLite, and
serves the API the Next.js dashboard reads from.

This is the single source of truth for sensor data. Supabase is used
ONLY for user accounts/auth on the frontend — it never touches this data.
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import sqlite3
from datetime import datetime, time as dtime

app = Flask(__name__)
CORS(app)  # allow the Next.js dev server / dashboard to call this API

DB_PATH = "lpmas.db"


# ---------------------------------------------------------------------------
# Database setup
# ---------------------------------------------------------------------------
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    c = conn.cursor()

    c.execute("""
        CREATE TABLE IF NOT EXISTS readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sensor_id TEXT NOT NULL,
            lux REAL NOT NULL,
            recorded_at TEXT NOT NULL,
            classification TEXT NOT NULL,      -- 'safe' | 'warning' | 'violation'
            phase_type TEXT NOT NULL           -- 'illumination' | 'dark'
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS phases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phase_type TEXT NOT NULL,          -- 'illumination' | 'dark'
            starts_on TEXT NOT NULL,           -- 'YYYY-MM-DD'
            ends_on TEXT NOT NULL,
            window_start TEXT,                 -- 'HH:MM' e.g. '18:30' (illumination only)
            window_end TEXT,                   -- 'HH:MM' e.g. '23:00' (illumination only)
            lux_min REAL,                      -- illumination phase only
            lux_max REAL,                      -- illumination phase only
            lux_ceiling REAL,                  -- dark phase only (breach if exceeded)
            is_active INTEGER NOT NULL DEFAULT 1
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sensor_id TEXT NOT NULL,
            phase_type TEXT NOT NULL,
            opened_at TEXT NOT NULL,
            resolved_at TEXT,
            status TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'acknowledged' | 'resolved'
            peak_lux REAL,
            lowest_lux REAL,
            reason TEXT NOT NULL                    -- 'below_minimum' | 'above_maximum' | 'ceiling_exceeded'
        )
    """)

    # Seed a default illumination phase config if none exists yet, based on
    # confirmed field data: 70-100 lux target, 6:30 PM - 11:00 PM window.
    existing = c.execute("SELECT COUNT(*) as n FROM phases").fetchone()
    if existing["n"] == 0:
        c.execute("""
            INSERT INTO phases (phase_type, starts_on, ends_on, window_start, window_end, lux_min, lux_max, lux_ceiling, is_active)
            VALUES ('illumination', date('now'), date('now', '+30 days'), '18:30', '23:00', 70, 100, NULL, 1)
        """)

    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Phase-aware detection logic
# ---------------------------------------------------------------------------
def get_active_phase(conn, at_time=None):
    """Return the currently active phase config, or None if outside any phase."""
    at_time = at_time or datetime.now()
    today = at_time.strftime("%Y-%m-%d")
    row = conn.execute(
        "SELECT * FROM phases WHERE is_active = 1 AND starts_on <= ? AND ends_on >= ? ORDER BY id DESC LIMIT 1",
        (today, today)
    ).fetchone()
    return row


def is_within_window(at_time, window_start, window_end):
    """Check if at_time's clock time falls within HH:MM window_start-window_end."""
    if not window_start or not window_end:
        return True  # no window restriction (e.g. dark phase runs all night)
    ws = dtime.fromisoformat(window_start)
    we = dtime.fromisoformat(window_end)
    now_t = at_time.time()
    if ws <= we:
        return ws <= now_t <= we
    return now_t >= ws or now_t <= we  # handles overnight windows


def classify_reading(lux, phase, at_time):
    """
    Returns (classification, reason) where classification is one of
    'safe' | 'warning' | 'violation'.
    """
    if phase is None:
        return "safe", None  # no active phase configured — don't flag anything

    if phase["phase_type"] == "illumination":
        if not is_within_window(at_time, phase["window_start"], phase["window_end"]):
            return "safe", None  # outside operating hours, lights expected off

        lux_min, lux_max = phase["lux_min"], phase["lux_max"]
        if lux < lux_min:
            # early-warning band: within 15% of minimum counts as 'warning'
            if lux >= lux_min * 0.85:
                return "warning", "below_minimum"
            return "violation", "below_minimum"
        if lux > lux_max:
            return "violation", "above_maximum"
        return "safe", None

    if phase["phase_type"] == "dark":
        ceiling = phase["lux_ceiling"]
        if ceiling is None:
            return "safe", None
        if lux > ceiling:
            return "violation", "ceiling_exceeded"
        if lux > ceiling * 0.8:
            return "warning", "ceiling_exceeded"
        return "safe", None

    return "safe", None


def handle_incident(conn, sensor_id, phase_type, classification, reason, lux, at_time):
    """Open, update, or resolve an incident based on the latest classification."""
    open_incident = conn.execute(
        "SELECT * FROM incidents WHERE sensor_id = ? AND status != 'resolved' ORDER BY id DESC LIMIT 1",
        (sensor_id,)
    ).fetchone()

    if classification == "violation":
        if open_incident:
            peak = max(open_incident["peak_lux"] or lux, lux)
            lowest = min(open_incident["lowest_lux"] or lux, lux)
            conn.execute(
                "UPDATE incidents SET peak_lux = ?, lowest_lux = ? WHERE id = ?",
                (peak, lowest, open_incident["id"])
            )
        else:
            conn.execute(
                """INSERT INTO incidents (sensor_id, phase_type, opened_at, status, peak_lux, lowest_lux, reason)
                   VALUES (?, ?, ?, 'open', ?, ?, ?)""",
                (sensor_id, phase_type, at_time.isoformat(), lux, lux, reason)
            )
    elif classification == "safe" and open_incident and open_incident["status"] != "resolved":
        conn.execute(
            "UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?",
            (at_time.isoformat(), open_incident["id"])
        )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/api/readings", methods=["POST"])
def upload_reading():
    """ESP32 posts raw readings here. This is the ONLY write path for sensor data."""
    data = request.get_json(silent=True) or {}
    sensor_id = data.get("sensor_id")
    lux = data.get("lux")

    if sensor_id is None or lux is None:
        return jsonify({"error": "missing sensor_id or lux"}), 400

    at_time = datetime.now()
    conn = get_db()

    phase = get_active_phase(conn, at_time)
    classification, reason = classify_reading(float(lux), phase, at_time)
    phase_type = phase["phase_type"] if phase else "none"

    conn.execute(
        "INSERT INTO readings (sensor_id, lux, recorded_at, classification, phase_type) VALUES (?, ?, ?, ?, ?)",
        (sensor_id, lux, at_time.isoformat(), classification, phase_type)
    )

    if phase is not None:
        handle_incident(conn, sensor_id, phase_type, classification, reason, float(lux), at_time)

    conn.commit()
    conn.close()

    return jsonify({"status": "ok", "classification": classification, "phase": phase_type}), 200


@app.route("/api/readings", methods=["GET"])
def list_readings():
    limit = request.args.get("limit", 100, type=int)
    sensor_id = request.args.get("sensor_id")

    conn = get_db()
    if sensor_id:
        rows = conn.execute(
            "SELECT * FROM readings WHERE sensor_id = ? ORDER BY id DESC LIMIT ?",
            (sensor_id, limit)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM readings ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    conn.close()

    return jsonify([dict(r) for r in rows])


@app.route("/api/phase/active", methods=["GET"])
def active_phase():
    conn = get_db()
    phase = get_active_phase(conn)
    conn.close()
    if phase is None:
        return jsonify(None)
    return jsonify(dict(phase))


@app.route("/api/phases", methods=["GET"])
def list_phases():
    conn = get_db()
    rows = conn.execute("SELECT * FROM phases ORDER BY starts_on DESC").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/phases", methods=["POST"])
def create_phase():
    """Create/configure a phase (illumination or dark). Used when starting a new batch."""
    data = request.get_json(silent=True) or {}
    required = ["phase_type", "starts_on", "ends_on"]
    if not all(k in data for k in required):
        return jsonify({"error": f"missing required fields: {required}"}), 400

    conn = get_db()
    conn.execute(
        """INSERT INTO phases (phase_type, starts_on, ends_on, window_start, window_end, lux_min, lux_max, lux_ceiling, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)""",
        (
            data["phase_type"], data["starts_on"], data["ends_on"],
            data.get("window_start"), data.get("window_end"),
            data.get("lux_min"), data.get("lux_max"), data.get("lux_ceiling")
        )
    )
    conn.commit()
    conn.close()
    return jsonify({"status": "created"}), 201


@app.route("/api/incidents", methods=["GET"])
def list_incidents():
    status = request.args.get("status")  # optional filter: open | acknowledged | resolved
    conn = get_db()
    if status:
        rows = conn.execute(
            "SELECT * FROM incidents WHERE status = ? ORDER BY id DESC", (status,)
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM incidents ORDER BY id DESC").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/incidents/<int:incident_id>/acknowledge", methods=["POST"])
def acknowledge_incident(incident_id):
    conn = get_db()
    conn.execute("UPDATE incidents SET status = 'acknowledged' WHERE id = ?", (incident_id,))
    conn.commit()
    conn.close()
    return jsonify({"status": "acknowledged"})


@app.route("/api/dashboard", methods=["GET"])
def dashboard_summary():
    """Single endpoint bundling everything the dashboard's main view needs."""
    conn = get_db()
    phase = get_active_phase(conn)
    readings = conn.execute("SELECT * FROM readings ORDER BY id DESC LIMIT 200").fetchall()
    incidents = conn.execute("SELECT * FROM incidents ORDER BY id DESC LIMIT 50").fetchall()
    conn.close()

    return jsonify({
        "phase": dict(phase) if phase else None,
        "readings": [dict(r) for r in readings],
        "incidents": [dict(i) for i in incidents],
        "generatedAt": datetime.now().isoformat()
    })


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=5000)
