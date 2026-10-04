"""Regression coverage for time comparisons and monitoring context transitions."""
import json
from datetime import datetime, timedelta, timezone
import pytest
import app as pi
from test_pilot_delivery import system, post


@pytest.fixture(autouse=True)
def operator_access(system, monkeypatch):
    monkeypatch.setattr(pi, 'supabase_configured', lambda: True)
    monkeypatch.setattr(pi, 'authorize_operator', lambda _: True)
    system.environ_base['HTTP_AUTHORIZATION'] = 'Bearer test-operator'


@pytest.fixture
def clock(system, monkeypatch):
    current = [datetime(2026, 10, 1, 12, tzinfo=pi.LPMAS_TIMEZONE)]
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return current[0].astimezone(tz) if tz else current[0].replace(tzinfo=None)
    monkeypatch.setattr(pi, 'datetime', Clock)
    monkeypatch.setattr(pi, 'DARK_PHASE_DAYS', 60)
    with pi.get_db() as conn:
        conn.execute("UPDATE greenhouses SET phase_start='2026-09-29',phase_end='2026-10-03'")
    return current


def capture(system, clock, lux=20):
    response = post(system, lux=lux)
    assert response.status_code == 201, response.json
    clock[0] += timedelta(seconds=10)
    return response.json


def confirmed(system, clock):
    for _ in range(3): result = capture(system, clock)
    assert result['incident_status'] == 'open'
    return result['incident_id']


def incident(incident_id):
    conn = pi.get_db()
    result = pi.incident_snapshot(conn, incident_id)
    conn.close()
    return result


@pytest.mark.parametrize('endpoint', ['/api/readings', '/api/hardware-activity'])
def test_history_compares_instants_across_offsets_and_restart(system, endpoint):
    timestamps = ['2026-10-01T18:00:00+08:00', '2026-10-01T11:00:00Z',
                  '2026-10-01T12:00:00-01:00', '2026-10-01T20:00:00']
    with pi.get_db() as conn:
        for index, stamp in enumerate(timestamps):
            conn.execute('INSERT INTO readings(sensor_id,lux,recorded_at) VALUES (?,?,?)', ('S1', index, stamp))
        pi.enqueue_delivery(conn, {'delivery_id':'historical-payload', 'recorded_at':timestamps[0]})
    pi.init_db()
    pi.init_db()
    response = system.get(endpoint, query_string={'start':'2026-10-01T10:30:00Z', 'end':'2026-10-01T20:30:00+08:00'})
    assert response.status_code == 200
    rows = response.json if isinstance(response.json, list) else response.json['readings']
    assert sorted(r['lux'] for r in rows) == [1, 3]
    with pi.get_db() as conn:
        assert json.loads(conn.execute('SELECT payload FROM delivery_outbox').fetchone()[0])['recorded_at'] == timestamps[0]
        assert conn.execute('SELECT recorded_at FROM readings ORDER BY id LIMIT 1').fetchone()[0] == timestamps[0]


@pytest.mark.parametrize('query', [
    {'start':'2026-10-01'}, {'end':'invalid'}, {'start':'2026-10-01T12:00:00'},
    {'end':''}, {'start':'2026-10-02T00:00:00Z','end':'2026-10-01T00:00:00Z'},
])
@pytest.mark.parametrize('endpoint', ['/api/readings', '/api/hardware-activity'])
def test_history_rejects_invalid_or_ambiguous_ranges(system, query, endpoint):
    assert system.get(endpoint, query_string=query).status_code == 400


def test_new_readings_use_utc_and_matching_epoch(system, clock):
    row = capture(system, clock)
    assert row['recorded_at'].endswith('+00:00')
    assert row['recorded_at_epoch'] == datetime.fromisoformat(row['recorded_at']).timestamp()
    assert row['classification'] == 'violation'  # Schedule still follows local noon.


def test_configuration_change_restarts_confirmation(system, clock):
    capture(system, clock)
    capture(system, clock)
    with pi.get_db() as conn:
        conn.execute("UPDATE greenhouses SET window_start='01:00'")
    assert capture(system, clock)['incident_status'] == 'pending'
    assert capture(system, clock)['incident_status'] == 'pending'
    result = capture(system, clock)
    confirmed_incident = incident(result['incident_id'])
    assert len({r['config_version'] for r in confirmed_incident['triggering_readings']}) == 1
    assert confirmed_incident['config_version'] == result['config_version']


def test_safe_recovery_records_its_reason(system, clock):
    uid = confirmed(system, clock)
    capture(system, clock, 50)
    assert incident(uid)['resolution_reason'] == 'safe_reading'


@pytest.mark.parametrize('change,reason', [
    ("DELETE FROM greenhouse_sensors", 'assignment_changed'),
    ("UPDATE greenhouses SET phase_end='2026-09-30'", 'phase_ended'),
    ("UPDATE greenhouses SET window_start='01:00'", 'configuration_changed'),
])
def test_context_changes_close_once_without_new_readings(system, clock, change, reason):
    uid = confirmed(system, clock)
    with pi.get_db() as conn:
        conn.execute("UPDATE incidents SET status='acknowledged' WHERE id=?", (uid,))
        conn.execute(change)
    pi.reconcile_incident_lifecycle()
    pi.reconcile_incident_lifecycle()
    result = incident(uid)
    assert result['status'] == 'resolved'
    assert result['resolution_reason'] == reason
    with pi.get_db() as conn:
        payloads = [json.loads(r[0]) for r in conn.execute('SELECT payload FROM delivery_outbox')]
    closures = [p for p in payloads if p['kind'] == 'incident']
    assert len(closures) == 1
    assert closures[0]['incident'] == result


def test_closure_and_delivery_roll_back_together(system, clock, monkeypatch):
    uid = confirmed(system, clock)
    with pi.get_db() as conn: conn.execute('DELETE FROM greenhouse_sensors')
    monkeypatch.setattr(pi, 'enqueue_delivery', lambda *_: (_ for _ in ()).throw(RuntimeError('disk full')))
    with pytest.raises(RuntimeError): pi.reconcile_incident_lifecycle()
    assert incident(uid)['status'] == 'open'


def test_daily_window_closes_then_requires_a_new_confirmation(system, clock):
    with pi.get_db() as conn: conn.execute("UPDATE greenhouses SET window_start='11:00',window_end='13:00'")
    uid = confirmed(system, clock)
    clock[0] = clock[0].replace(hour=14)
    pi.reconcile_incident_lifecycle()
    assert incident(uid)['resolution_reason'] == 'monitoring_window_ended'
    clock[0] = (clock[0] + timedelta(days=1)).replace(hour=12)
    new_uid = confirmed(system, clock)
    assert new_uid != uid


def test_restart_after_missed_window_closes_old_incident(system, clock):
    with pi.get_db() as conn: conn.execute("UPDATE greenhouses SET window_start='11:00',window_end='13:00'")
    uid = confirmed(system, clock)
    clock[0] += timedelta(days=1)
    pi.init_db()
    pi.reconcile_incident_lifecycle()
    assert incident(uid)['resolution_reason'] == 'monitoring_window_ended'


def test_overnight_window_keeps_one_incident_across_midnight(system, clock):
    with pi.get_db() as conn: conn.execute("UPDATE greenhouses SET window_start='23:00',window_end='05:00'")
    clock[0] = clock[0].replace(hour=23, minute=59, second=40)
    uid = confirmed(system, clock)
    clock[0] += timedelta(minutes=1)
    pi.reconcile_incident_lifecycle()
    assert incident(uid)['status'] == 'open'


def test_renaming_greenhouse_does_not_restart_monitoring(system, clock):
    uid = confirmed(system, clock)
    with pi.get_db() as conn:
        conn.execute("UPDATE greenhouses SET name='Renamed',updated_at='2026-10-01T04:00:00Z'")
    pi.reconcile_incident_lifecycle()
    assert incident(uid)['status'] == 'open'
    assert capture(system, clock)['incident_id'] == uid


def test_dark_policy_change_closes_context_and_survives_offline_restart(system, clock, monkeypatch):
    uid = confirmed(system, clock)
    monkeypatch.setattr(pi, 'supabase_configured', lambda: True)
    monkeypatch.setattr(pi, 'supabase_select', lambda *_: [{'value':'30'}])
    pi.sync_dark_phase_duration_from_supabase()
    assert incident(uid)['resolution_reason'] == 'configuration_changed'
    monkeypatch.setattr(pi, 'DARK_PHASE_DAYS', 60)
    pi.init_db()
    assert pi.DARK_PHASE_DAYS == 30


def test_legacy_incident_configuration_baseline_closes_on_sync_change(system, clock, monkeypatch):
    uid = confirmed(system, clock)
    with pi.get_db() as conn:
        conn.execute('UPDATE incidents SET config_version=NULL,context_version=NULL')
        greenhouse = dict(conn.execute('SELECT * FROM greenhouses').fetchone())
    greenhouse['window_start'] = '01:00'
    monkeypatch.setattr(pi, 'supabase_configured', lambda: True)
    monkeypatch.setattr(pi, 'supabase_select', lambda table, _: {
        'greenhouses':[greenhouse], 'greenhouse_sensors':[{'greenhouse_id':'G1','sensor_id':'S1'}],
        'sensor_list':[{'sensor_id':'S1'}],
    }[table])
    pi.sync_greenhouses_from_supabase()
    assert incident(uid)['resolution_reason'] == 'configuration_changed'


def test_return_to_same_assignment_requires_three_new_samples(system, clock):
    uid = confirmed(system, clock)
    # A brief reassignment closes the context even if no reading was captured
    # in the intervening assignment. Previous samples cannot confirm the return.
    with pi.get_db() as conn: conn.execute('DELETE FROM greenhouse_sensors')
    pi.reconcile_incident_lifecycle()
    with pi.get_db() as conn: conn.execute("INSERT INTO greenhouse_sensors VALUES ('G1','S1')")
    assert capture(system, clock)['incident_status'] == 'pending'
    assert capture(system, clock)['incident_status'] == 'pending'
    result = capture(system, clock)
    assert result['incident_status'] == 'open'
    assert result['incident_id'] != uid


def test_legacy_nullable_upgrade_preserves_delivery_identity(system):
    import uuid
    reading_uid = str(uuid.uuid4())
    with pi.get_db() as conn:
        conn.execute('DROP TABLE readings')
        conn.execute('CREATE TABLE readings (id INTEGER PRIMARY KEY, sensor_id TEXT NOT NULL, greenhouse_id TEXT, lux REAL NOT NULL, recorded_at TEXT NOT NULL, classification TEXT NOT NULL, phase_type TEXT NOT NULL, reading_uid TEXT, config_version TEXT)')
        conn.execute('INSERT INTO readings VALUES (1,?,?,?,?,?,?,?,?)', ('S1','G1',20,'2026-10-01T12:00:00+08:00','violation','illumination',reading_uid,'original'))
    pi.init_db()
    with pi.get_db() as conn:
        reading = conn.execute('SELECT * FROM readings').fetchone()
        assert reading['reading_uid'] == reading_uid
        assert reading['config_version'] == 'original'
        assert reading['recorded_at_epoch'] == datetime(2026,10,1,4,tzinfo=timezone.utc).timestamp()


def test_dark_phase_expiry_closes_without_safe_reading(system, clock, monkeypatch):
    monkeypatch.setattr(pi, 'DARK_PHASE_DAYS', 1)
    with pi.get_db() as conn: conn.execute("UPDATE greenhouses SET phase_end='2026-09-30'")
    for _ in range(3): result = capture(system, clock, 40)
    clock[0] += timedelta(days=1)
    pi.reconcile_incident_lifecycle()
    assert incident(result['incident_id'])['resolution_reason'] == 'phase_ended'


def test_incident_metadata_normalization_preserves_chronological_sort(system):
    with pi.get_db() as conn:
        for stamp in ['2026-10-01T18:00:00+08:00', '2026-10-01T11:00:00Z']:
            conn.execute("INSERT INTO incidents(sensor_id,greenhouse_id,phase_type,opened_at,status) VALUES ('S1','G1','dark',?,'open')", (stamp,))
    pi.init_db()
    rows = system.get('/api/incidents').json
    assert [r['opened_at'] for r in rows] == ['2026-10-01T11:00:00.000000+00:00', '2026-10-01T10:00:00.000000+00:00']
