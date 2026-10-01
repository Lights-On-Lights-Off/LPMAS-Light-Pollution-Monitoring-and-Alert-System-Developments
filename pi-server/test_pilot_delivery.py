"""SQLite transaction, retry, incident sequence, and authorization regressions."""
import json
import uuid
from datetime import datetime, timedelta
from pathlib import Path
import pytest
import app as pi

@pytest.fixture
def system(tmp_path, monkeypatch):
    monkeypatch.setattr(pi, 'DB_PATH', tmp_path / 'test.db')
    monkeypatch.setattr(pi, 'DEVICE_KEY', 'device-key')
    monkeypatch.setattr(pi, 'RETRY_QUEUE_PATH', tmp_path / 'legacy.jsonl')
    pi.init_db()
    conn = pi.get_db()
    today = pi.today()
    conn.execute('INSERT INTO greenhouses VALUES (?,?,?,?,?,?,?,?)', ('G1','Greenhouse',str(today-timedelta(days=2)),str(today+timedelta(days=2)),'00:00:00','23:59:00',1,pi.now_iso()))
    conn.execute('INSERT INTO greenhouse_sensors VALUES (?,?)', ('G1','S1'))
    conn.commit(); conn.close()
    return pi.app.test_client()

def post(client, lux=20, reading_id=None, **kwargs):
    return client.post('/api/readings', json={'sensor_id':'S1','lux':lux,'reading_id':reading_id or str(uuid.uuid4())},headers={'X-LPMAS-Device-Key':'device-key'}, **kwargs)

def test_supabase_time_format_is_normalized():
    assert pi.parse_time('18:30:00') == pi.parse_time('18:30')
    assert pi.is_within_window('00:30','23:00:00','05:00:00')
    assert not pi.is_within_window('12:00','23:00:00','05:00:00')

@pytest.mark.parametrize('lux,illumination,dark',[(15,'violation','safe'),(15.1,'violation','warning'),(29,'violation','warning'),(29.1,'violation','violation'),(30,'violation','violation'),(30.1,'warning','violation'),(49.9,'warning','violation'),(50,'safe','violation')])
def test_decimal_thresholds(lux, illumination, dark):
    assert pi.classify_reading(lux, {'phase_type':'illumination','window_start':'00:00','window_end':'23:59'}) == illumination
    assert pi.classify_reading(lux, {'phase_type':'dark'}) == dark

def test_reading_and_outbox_commit_together(system):
    response=post(system)
    assert response.status_code == 201
    conn=pi.get_db()
    reading=conn.execute('SELECT * FROM readings').fetchone()
    queued=json.loads(conn.execute('SELECT payload FROM delivery_outbox').fetchone()[0])
    assert reading['reading_uid'] == queued['delivery_id']
    assert queued['monitoring_active'] is True
    assert queued['config_version'] == reading['config_version']
    conn.close()

def test_duplicate_device_retry_does_not_insert_twice(system):
    uid=str(uuid.uuid4())
    assert post(system,reading_id=uid).status_code == 201
    assert post(system,reading_id=uid).status_code == 200
    assert post(system,lux=21,reading_id=uid).status_code == 409
    conn=pi.get_db()
    assert conn.execute('SELECT count(*) FROM readings').fetchone()[0] == 1
    assert conn.execute('SELECT count(*) FROM delivery_outbox').fetchone()[0] == 1
    conn.close()

def test_outbox_failure_rolls_back_the_raw_write(system,monkeypatch):
    monkeypatch.setattr(pi,'enqueue_delivery',lambda *_: (_ for _ in ()).throw(RuntimeError('disk unavailable')))
    response=post(system)
    assert response.status_code == 500
    conn=pi.get_db(); assert conn.execute('SELECT count(*) FROM readings').fetchone()[0] == 0;conn.close()

def test_power_restart_keeps_pending_deliveries(system):
    post(system);pi.init_db()
    conn=pi.get_db(); assert conn.execute('SELECT count(*) FROM delivery_outbox').fetchone()[0] == 1;conn.close()

def test_reassignment_does_not_rewrite_queued_history(system):
    post(system)
    conn=pi.get_db()
    conn.execute("UPDATE greenhouse_sensors SET greenhouse_id='G2' WHERE sensor_id='S1'");conn.commit()
    queued=json.loads(conn.execute('SELECT payload FROM delivery_outbox').fetchone()[0])
    assert queued['greenhouse_id'] == 'G1';conn.close()

def test_backend_auth_fails_closed(system):
    assert system.post('/api/readings',json={'sensor_id':'S1','lux':20}).status_code == 401
    assert system.post('/api/incidents/1/acknowledge').status_code == 401
    assert system.post('/api/greenhouses',json={}).status_code == 410
    assert system.delete('/api/greenhouses/G1').status_code == 410

@pytest.mark.parametrize('lux',[True,-1,float('inf'),float('nan'),65536])
def test_invalid_measurements_do_not_enter_sqlite(system,lux):
    assert post(system,lux=lux).status_code == 400

def seed_sequence(conn, times, classes=None, greenhouse='G1',phase='dark'):
    for index,timestamp in enumerate(times):
        conn.execute('INSERT INTO readings(sensor_id,greenhouse_id,lux,recorded_at,classification,phase_type) VALUES (?,?,?,?,?,?)',('S1',greenhouse,40,timestamp,(classes or ['violation']*3)[index],phase))

def test_confirmation_crosses_minute_and_day_boundary(system):
    conn=pi.get_db()
    seed_sequence(conn,['2026-09-30T23:59:50+08:00','2026-10-01T00:00:00+08:00','2026-10-01T00:00:10+08:00'])
    assert pi.violation_ready(conn,'S1','G1','dark')
    uid,status=pi.handle_incident(conn,'S1','G1',40,'violation','dark')
    first=pi.incident_snapshot(conn,uid)
    assert len(first['triggering_readings']) == 3
    assert first['incident_uid']
    pi.handle_incident(conn,'S1','G1',41,'violation','dark')
    assert conn.execute('SELECT count(*) FROM incidents').fetchone()[0] == 1
    pi.handle_incident(conn,'S1','G1',0,'safe','dark')
    assert pi.incident_snapshot(conn,uid)['status'] == 'resolved'
    conn.close()

@pytest.mark.parametrize('times,classes',[
    (['2026-10-01T00:00:00+08:00','2026-10-01T00:00:20+08:00','2026-10-01T00:00:30+08:00'],None),
    (['2026-10-01T00:00:00+08:00','2026-10-01T00:00:10+08:00','2026-10-01T00:00:20+08:00'],['violation','safe','violation']),
])
def test_interrupted_sequences_do_not_confirm(system,times,classes):
    conn=pi.get_db();seed_sequence(conn,times,classes);assert not pi.violation_ready(conn,'S1','G1','dark');conn.close()

def test_dark_monitoring_is_continuous_and_illumination_outside_window_unclassified(system):
    assert pi.classify_reading(40,{'phase_type':'dark'}) == 'violation'
    current=datetime.now(pi.LPMAS_TIMEZONE)
    outside=(current+timedelta(hours=2)).strftime('%H:%M')
    assert pi.classify_reading(0,{'phase_type':'illumination','window_start':outside,'window_end':outside}) == 'unclassified'

@pytest.mark.parametrize('role',['manager','admin'])
def test_verified_operator_acknowledges_uuid_once(system,monkeypatch,role):
    monkeypatch.setattr(pi,'supabase_configured',lambda:True)
    monkeypatch.setattr(pi,'SUPABASE_URL','https://example.invalid')
    monkeypatch.setattr(pi,'SUPABASE_SECRET_KEY','test-only-key')
    class AuthResponse:
        def __enter__(self): return self
        def __exit__(self,*_): pass
        def read(self): return b'{"id":"test-operator"}'
    monkeypatch.setattr(pi.urllib.request,'urlopen',lambda *_args,**_kwargs:AuthResponse())
    monkeypatch.setattr(pi,'supabase_select',lambda *_:[{'role':role}])
    conn=pi.get_db()
    seed_sequence(conn,['2026-10-01T00:00:00+08:00','2026-10-01T00:00:10+08:00','2026-10-01T00:00:20+08:00'])
    incident_id,_=pi.handle_incident(conn,'S1','G1',40,'violation','dark')
    snapshot=pi.incident_snapshot(conn,incident_id)
    conn.commit();conn.close()
    endpoint=f'/api/incidents/{incident_id}/acknowledge'
    headers={'Authorization':'Bearer test-user-jwt'}
    assert system.post(endpoint,json={'incident_uid':str(uuid.uuid4())},headers=headers).status_code == 409
    for _ in range(2):
        assert system.post(endpoint,json={'incident_uid':snapshot['incident_uid']},headers=headers).status_code == 200
    conn=pi.get_db()
    queued=conn.execute('SELECT payload FROM delivery_outbox').fetchall()
    assert len(queued) == 1
    acknowledged=json.loads(queued[0][0])['incident']
    assert acknowledged['status'] == 'acknowledged'
    assert acknowledged['version'] == snapshot['version']+1
    conn.execute("UPDATE incidents SET status='resolved' WHERE id=?",(incident_id,));conn.commit();conn.close()
    assert system.post(endpoint,json={'incident_uid':snapshot['incident_uid']},headers=headers).status_code == 409


def test_valid_session_without_operator_role_cannot_acknowledge(system,monkeypatch):
    monkeypatch.setattr(pi,'supabase_configured',lambda:True)
    monkeypatch.setattr(pi,'SUPABASE_URL','https://example.invalid')
    monkeypatch.setattr(pi,'SUPABASE_SECRET_KEY','test-only-key')
    class AuthResponse:
        def __enter__(self): return self
        def __exit__(self,*_): pass
        def read(self): return b'{"id":"test-user"}'
    monkeypatch.setattr(pi.urllib.request,'urlopen',lambda *_args,**_kwargs:AuthResponse())
    monkeypatch.setattr(pi,'supabase_select',lambda *_:[])
    assert system.post('/api/incidents/1/acknowledge',json={},headers={'Authorization':'Bearer test-user-jwt'}).status_code == 403

@pytest.mark.parametrize('patch',[
    {'sensor_id':' S1 '},
    {'reading_id':'00000000-0000-0000-0000-000000000000'},
])
def test_device_validation_matches_cloud_contract(system,patch):
    payload={'sensor_id':'S1','lux':20,'reading_id':str(uuid.uuid4()),**patch}
    assert system.post('/api/readings',json=payload,headers={'X-LPMAS-Device-Key':'device-key'}).status_code == 400
    conn=pi.get_db()
    assert conn.execute('SELECT count(*) FROM readings').fetchone()[0] == 0
    conn.close()


def test_existing_firmware_uses_durable_pi_generated_identity(system,monkeypatch):
    monkeypatch.setattr(pi,'DEVICE_KEY','')
    payload={'sensor_id':'S1','lux':20}
    first=system.post('/api/readings',json=payload)
    second=system.post('/api/readings',json=payload)
    assert first.status_code == second.status_code == 201
    assert first.json['reading_uid'] != second.json['reading_uid']
    conn=pi.get_db()
    queued=[json.loads(row[0]) for row in conn.execute('SELECT payload FROM delivery_outbox')]
    assert {row['delivery_id'] for row in queued} == {first.json['reading_uid'],second.json['reading_uid']}
    conn.close()


def test_legacy_firmware_cannot_register_an_unknown_sensor(system,monkeypatch):
    monkeypatch.setattr(pi,'DEVICE_KEY','')
    assert system.post('/api/readings',json={'sensor_id':'unknown','lux':20}).status_code == 403
    conn=pi.get_db()
    assert conn.execute('SELECT count(*) FROM readings').fetchone()[0] == 0
    conn.close()


def test_legacy_registry_revocations_survive_restart(system,monkeypatch):
    monkeypatch.setattr(pi,'DEVICE_KEY','')
    monkeypatch.setattr(pi,'supabase_configured',lambda:True)
    monkeypatch.setattr(pi,'supabase_select',lambda table,_: [{'sensor_id':'S2'}] if table=='sensor_list' else [])
    pi.sync_greenhouses_from_supabase()
    assert system.post('/api/readings',json={'sensor_id':'S1','lux':20}).status_code == 403
    accepted=system.post('/api/readings',json={'sensor_id':'S2','lux':20})
    assert accepted.status_code == 201
    assert accepted.json['classification'] == 'unclassified'
    pi.init_db()
    assert system.post('/api/readings',json={'sensor_id':'S1','lux':20}).status_code == 403
    assert system.post('/api/readings',json={'sensor_id':'S2','lux':20}).status_code == 201
