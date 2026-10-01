"""Security boundaries: authentication, resource limits, pagination and secrets."""
import json
import os
import pytest
import app as pi
from security import RequestLimiter, load_security_config
from test_pilot_delivery import system, post


def operator(system, monkeypatch):
    monkeypatch.setattr(pi,'supabase_configured',lambda:True)
    monkeypatch.setattr(pi,'authorize_operator',lambda _:True)
    system.environ_base['HTTP_AUTHORIZATION']='Bearer operator'


@pytest.mark.parametrize('endpoint',['/api/readings','/api/hardware-activity'])
def test_raw_history_requires_a_verified_operator(system,monkeypatch,endpoint):
    assert system.get(endpoint).status_code == 401
    monkeypatch.setattr(pi,'supabase_configured',lambda:True)
    monkeypatch.setattr(pi,'authorize_operator',lambda _:False)
    assert system.get(endpoint,headers={'Authorization':'Bearer visitor'}).status_code == 403


def test_unknown_device_cannot_register_even_with_shared_device_key(system):
    response=system.post('/api/readings',json={'sensor_id':'not-registered','lux':1,'reading_id':'11111111-1111-4111-8111-111111111111'},headers={'X-LPMAS-Device-Key':'d'*40})
    assert response.status_code == 403


def test_uuid_is_mandatory_for_device_replay_protection(system):
    assert system.post('/api/readings',json={'sensor_id':'S1','lux':1},headers={'X-LPMAS-Device-Key':'d'*40}).status_code == 400


def test_payload_size_and_untrusted_origin_are_rejected(system):
    assert system.post('/api/readings',data='x'*32769,content_type='application/json',headers={'X-LPMAS-Device-Key':'d'*40}).status_code == 413
    assert system.get('/api/dashboard',headers={'Origin':'https://attacker.invalid'}).status_code == 403
    assert system.get('/api/dashboard').headers['Cache-Control']=='no-store'


def test_rate_limits_have_bounded_memory_and_refill():
    now=[0]
    limiter=RequestLimiter(capacity=2,clock=lambda:now[0])
    assert limiter.allow('one',2) and limiter.allow('one',2)
    assert not limiter.allow('one',2)
    now[0]=30
    assert limiter.allow('one',2)
    limiter.allow('two',2);limiter.allow('three',2)
    assert len(limiter.buckets)==2


def test_ingestion_rate_limit_returns_retry_header_before_writes(system):
    for _ in range(120):
        assert system.post('/api/readings',json={}).status_code==401
    response=system.post('/api/readings',json={})
    assert response.status_code==429 and response.headers['Retry-After']=='5'


def test_history_paginates_without_omitting_or_duplicating_rows(system,monkeypatch):
    operator(system,monkeypatch)
    with pi.get_db() as conn:
        conn.executemany('INSERT INTO readings(sensor_id,lux,recorded_at,recorded_at_epoch) VALUES (?,?,?,?)',
            [('S1',1,'2026-10-01T00:00:00Z',1790812800)]*1005)
    params={'start':'2026-10-01T00:00:00Z','end':'2026-10-02T00:00:00Z'}
    first=system.get('/api/hardware-activity',query_string=params).json
    assert len(first['readings'])==1000
    second=system.get('/api/hardware-activity',query_string={**params,'after_id':first['next_after_id']}).json
    assert len(second['readings'])==5 and second['next_after_id'] is None
    assert len({r['id'] for r in first['readings']+second['readings']})==1005


def test_unbounded_history_ranges_are_rejected(system,monkeypatch):
    operator(system,monkeypatch)
    assert system.get('/api/hardware-activity').status_code==400
    assert system.get('/api/hardware-activity',query_string={'start':'2026-01-01T00:00:00Z','end':'2026-10-01T00:00:00Z'}).status_code==400


def test_credentials_require_private_file_permissions(tmp_path,monkeypatch):
    path=tmp_path/'security.json';path.write_text(json.dumps({'device_key':'private'}))
    monkeypatch.setenv('LPMAS_SECURITY_FILE',str(path));path.chmod(0o644)
    with pytest.raises(RuntimeError): load_security_config()
    path.chmod(0o600)
    assert load_security_config()=={'device_key':'private'}


def test_tunnel_uses_scoped_gateway_without_database_credentials(monkeypatch):
    import tunnel_sync as tunnel
    calls=[]
    monkeypatch.setattr(tunnel,'PI_TOKEN','scoped-pi-token')
    monkeypatch.setattr(tunnel,'SUPABASE_URL','https://cloud.invalid')
    monkeypatch.setattr(tunnel,'gateway_request',lambda *args,**kwargs:calls.append((args,kwargs)))
    assert tunnel.push_tunnel_url('https://current.trycloudflare.com')
    assert calls[0][0]==('https://cloud.invalid/functions/v1/pi-gateway','scoped-pi-token','publish-tunnel')
    assert calls[0][1]=={'url':'https://current.trycloudflare.com'}


@pytest.mark.parametrize('module_name',['app','tunnel_sync'])
def test_local_settings_loader_never_imports_administrator_credentials(tmp_path,monkeypatch,module_name):
    import importlib
    module=importlib.import_module(module_name)
    path=tmp_path/'settings.txt'
    path.write_text('SUPABASE_URL=https://example.invalid\nSUPABASE_SERVICE_ROLE_KEY=privileged\nSUPABASE_SECRET_KEY=privileged\n')
    monkeypatch.setattr(module,'ENV_PATH',path)
    for name in ('SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_SECRET_KEY'):monkeypatch.delenv(name,raising=False)
    module.load_env_file()
    assert os.environ['SUPABASE_URL']=='https://example.invalid'
    assert 'SUPABASE_SERVICE_ROLE_KEY' not in os.environ
    assert 'SUPABASE_SECRET_KEY' not in os.environ
