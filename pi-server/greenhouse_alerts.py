"""Persistent greenhouse episodes. Caller owns the SQLite transaction."""
import uuid
from datetime import datetime


def initialize(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS greenhouse_alerts (
        incident_uid TEXT PRIMARY KEY, greenhouse_id TEXT NOT NULL,
        opened_at TEXT NOT NULL, resolved_at TEXT, status TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, legacy INTEGER NOT NULL DEFAULT 0)""")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_open_greenhouse_alert ON greenhouse_alerts(greenhouse_id) WHERE status='open'")
    if 'greenhouse_alert_uid' not in {row[1] for row in conn.execute('PRAGMA table_info(incidents)')}:
        conn.execute('ALTER TABLE incidents ADD COLUMN greenhouse_alert_uid TEXT')
    # Suppress opening notifications for incidents that existed before cutover.
    for row in conn.execute("SELECT * FROM incidents WHERE status IN ('open','acknowledged') AND greenhouse_alert_uid IS NULL ORDER BY opened_at,id").fetchall():
        attach(conn, row['id'], row['greenhouse_id'], row['opened_at'], legacy=True)


def attach(conn, incident_id, greenhouse_id, opened_at, legacy=False):
    if not greenhouse_id:
        return
    alert = conn.execute("SELECT incident_uid FROM greenhouse_alerts WHERE greenhouse_id=? AND status='open'", (greenhouse_id,)).fetchone()
    if alert:
        uid = alert['incident_uid']
        conn.execute('UPDATE greenhouse_alerts SET version=version+1 WHERE incident_uid=?', (uid,))
    else:
        uid = str(uuid.uuid4())
        conn.execute("INSERT INTO greenhouse_alerts(incident_uid,greenhouse_id,opened_at,status,legacy) VALUES (?,?,?,'open',?)", (uid, greenhouse_id, opened_at, int(legacy)))
    conn.execute('UPDATE incidents SET greenhouse_alert_uid=? WHERE id=?', (uid, incident_id))


def finish_member(conn, incident_id, at):
    member = conn.execute('SELECT greenhouse_alert_uid FROM incidents WHERE id=?', (incident_id,)).fetchone()
    uid = member['greenhouse_alert_uid'] if member else None
    if not uid:
        return
    update_episode(conn, uid, at, member_changed=True)


def update_episode(conn, uid, at, member_changed=False, context_current=None):
    active = conn.execute("SELECT 1 FROM incidents WHERE greenhouse_alert_uid=? AND status IN ('open','acknowledged') LIMIT 1", (uid,)).fetchone()
    if active:
        if member_changed:
            conn.execute('UPDATE greenhouse_alerts SET version=version+1 WHERE incident_uid=?', (uid,))
        return False
    unsafe_closure = conn.execute("SELECT 1 FROM incidents WHERE greenhouse_alert_uid=? AND COALESCE(resolution_reason,'') <> 'safe_reading' LIMIT 1", (uid,)).fetchone()
    # Safe recovery also needs the application's current assignment/phase check.
    # Defer it to reconciliation in the same transaction as the reading.
    if member_changed and not unsafe_closure:
        conn.execute('UPDATE greenhouse_alerts SET version=version+1 WHERE incident_uid=?', (uid,))
        return False
    members = conn.execute('SELECT * FROM incidents WHERE id IN (SELECT MAX(id) FROM incidents WHERE greenhouse_alert_uid=? GROUP BY sensor_id)', (uid,)).fetchall()
    invalid_context = context_current and any(not context_current(member) for member in members)
    if not unsafe_closure and not invalid_context and not all(fresh_safe(conn, member, at) for member in members):
        if member_changed:
            conn.execute('UPDATE greenhouse_alerts SET version=version+1 WHERE incident_uid=?', (uid,))
        return False
    conn.execute('UPDATE greenhouse_alerts SET version=version+1,status=?,resolved_at=? WHERE incident_uid=? AND status=\'open\'', ('closed' if unsafe_closure else 'resolved', at, uid))
    if invalid_context:
        conn.execute("UPDATE greenhouse_alerts SET status='closed' WHERE incident_uid=?", (uid,))
    return True


def fresh_safe(conn, member, at):
    rows = conn.execute('SELECT * FROM readings WHERE sensor_id=? ORDER BY id DESC LIMIT 3', (member['sensor_id'],)).fetchall()
    if len(rows) != 3:
        return False
    current = datetime.fromisoformat(at).timestamp()
    previous = None
    for row in reversed(rows):
        stamp = row['recorded_at_epoch']
        if (row['classification'] != 'safe' or row['greenhouse_id'] != member['greenhouse_id'] or row['phase_type'] != member['phase_type']
                or row['config_version'] != rows[0]['config_version'] or stamp is None):
            return False
        if previous is not None and not 0 < stamp - previous <= 15:
            return False
        previous = stamp
    return 0 <= current - previous <= 15


def reconcile_waiting(conn, at, context_current):
    changed = []
    for episode in conn.execute("SELECT incident_uid FROM greenhouse_alerts WHERE status='open'").fetchall():
        uid = episode['incident_uid']
        if update_episode(conn, uid, at, context_current=context_current):
            member = conn.execute('SELECT id FROM incidents WHERE greenhouse_alert_uid=? ORDER BY id DESC LIMIT 1', (uid,)).fetchone()
            if member:
                changed.append(member['id'])
    return changed


def snapshot(conn, uid):
    if not uid:
        return None
    row = conn.execute('SELECT * FROM greenhouse_alerts WHERE incident_uid=?', (uid,)).fetchone()
    value = dict(row) if row else None
    if value:
        value['legacy'] = bool(value['legacy'])
    return value
