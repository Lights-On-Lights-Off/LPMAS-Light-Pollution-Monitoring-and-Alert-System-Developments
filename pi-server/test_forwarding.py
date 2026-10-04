"""Network delivery tests exercise the production SQLite outbox."""
import json
import uuid
from unittest.mock import patch
import app as pi
from test_pilot_delivery import system,post

class Response:
    def __init__(self,status=200): self.status=status
    def __enter__(self): return self
    def __exit__(self,*args): return False

def configured():
    return patch.multiple(pi,EDGE_FUNCTION_URL='https://example/functions/v1/ingest-reading',PI_TOKEN='backend')

def test_success_removes_committed_outbox_entry(system):
    post(system)
    calls=[]
    def transport(url,body,headers,timeout):
        calls.append(json.loads(body)['delivery']);assert headers['Authorization']=='Bearer backend';return Response()
    with configured(): assert pi.flush_outbox(transport) == 1
    conn=pi.get_db();assert conn.execute('SELECT count(*) FROM delivery_outbox').fetchone()[0]==0;conn.close()
    assert calls[-1]=={'retry_notifications':True}

def test_timeout_retains_same_identifier_and_configuration(system):
    post(system)
    attempts=[]
    def transport(url,body,headers,timeout):
        attempts.append(json.loads(body)['delivery']);raise TimeoutError()
    with configured(): assert pi.flush_outbox(transport)==0
    conn=pi.get_db();row=conn.execute('SELECT * FROM delivery_outbox').fetchone()
    assert row['attempts']==1 and row['next_attempt_at']>0
    stored=json.loads(row['payload']);assert stored==attempts[0]
    conn.execute('UPDATE delivery_outbox SET next_attempt_at=0');conn.commit();conn.close()
    def accepted(url,body,*_):
        if 'delivery_id' in json.loads(body)['delivery']: assert json.loads(body)['delivery']==stored
        return Response()
    with configured(): assert pi.flush_outbox(accepted)==1

def test_unconfigured_cloud_preserves_data_for_later(system):
    post(system)
    with patch.object(pi,'PI_TOKEN',''): assert pi.flush_outbox()==0
    conn=pi.get_db();assert conn.execute('SELECT count(*) FROM delivery_outbox').fetchone()[0]==1;conn.close()

def test_legacy_retry_import_is_repeatable_and_keeps_original_file(system):
    post(system)
    conn=pi.get_db();reading=dict(conn.execute('SELECT * FROM readings').fetchone());conn.close()
    pi.RETRY_QUEUE_PATH.write_text(json.dumps(reading)+'\n')
    pi.import_legacy_retry_queue();pi.import_legacy_retry_queue()
    conn=pi.get_db();assert conn.execute('SELECT count(*) FROM delivery_outbox').fetchone()[0]==1;conn.close()
    assert pi.RETRY_QUEUE_PATH.exists()
