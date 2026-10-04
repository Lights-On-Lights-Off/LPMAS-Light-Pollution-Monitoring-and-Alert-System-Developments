"""Concurrent receipt and aggregate checks; only called on our disposable DB."""
import concurrent.futures
import hashlib
import json
import subprocess
import sys
import uuid

container = sys.argv[1]
if not container.startswith('lpmas-verify-'):
    raise SystemExit('Refusing to test a container outside the disposable verification workflow')

def sql(query):
    result = subprocess.run(['docker','exec','-i',container,'psql','-U','postgres','-d','postgres','-At','-v','ON_ERROR_STOP=1'],input=query,text=True,capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip().splitlines()[-1]

sql("DELETE FROM public.sensor_minute_aggregates WHERE sensor_id='concurrent-S'; INSERT INTO public.greenhouses(id,name,phase_start,phase_end,window_start,window_end) VALUES('concurrent-G','Concurrent',current_date,current_date,'00:00','23:59') ON CONFLICT DO NOTHING; SELECT 'ready';")
def ingest(delivery_id):
    payload=json.dumps({'kind':'reading','delivery_id':str(delivery_id),'sensor_id':'concurrent-S','lux':40,'recorded_at':'2026-09-30T00:00:00Z','greenhouse_id':'concurrent-G','phase_type':'dark','classification':'violation','monitoring_active':True,'config_version':'snapshot','incident':None})
    return sql("BEGIN; SELECT set_config('request.jwt.claim.role','service_role',true); SET LOCAL ROLE service_role; SELECT public.ingest_pilot_delivery('"+payload+"'::jsonb); COMMIT;")

uid=uuid.uuid4()
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(ingest,[uid]*4))
assert sql("SELECT sample_count FROM public.sensor_minute_aggregates WHERE sensor_id='concurrent-S'") == '1', 'Concurrent replay double counted'
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(ingest,[uuid.uuid4() for _ in range(4)]))
assert sql("SELECT sample_count FROM public.sensor_minute_aggregates WHERE sensor_id='concurrent-S'") == '5', 'Concurrent deltas lost updates'
assert sql("SELECT avg_lux FROM public.sensor_minute_aggregates WHERE sensor_id='concurrent-S'") == '40.000'
print('Concurrent database delivery: repeated receipts counted once; independent samples retained.')

if sql("SELECT to_regclass('public.greenhouse_notification_jobs') IS NOT NULL") == 't':
    episode = str(uuid.uuid4())
    sql("INSERT INTO public.greenhouse_alerts(incident_uid,greenhouse_id,opened_at,status,version) VALUES('" + episode + "','concurrent-alert-G',now(),'open',1); "
        "INSERT INTO public.greenhouse_notification_jobs(greenhouse_alert_uid,event,channel,message) SELECT '" + episode + "','opened',c,'LPMAS ALERT: Concurrent greenhouse.' FROM unnest(array['sms','email']) c; "
        "UPDATE public.system_settings SET value='true' WHERE key='greenhouse_notifications_enabled'; SELECT 'ready';")
    def claim(_):
        return json.loads(sql("SELECT set_config('request.jwt.claim.role','service_role',false); SELECT public.claim_greenhouse_notifications(20);"))
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        jobs = [job for result in pool.map(claim, range(6)) for job in result]
    assert len(jobs) == 2 and len({job['id'] for job in jobs}) == 2, 'Concurrent workers consumed a notification twice'
    assert all(job['attempts'] == 1 and job['status'] == 'unknown' for job in jobs)
    assert claim(0) == [], 'Ambiguous attempts were reclaimed'
    print('Concurrent notification workers: one consumed attempt per event/channel; ambiguous attempts never reclaimed.')

if sql("SELECT to_regclass('lpmas_private.cloud_sensor_state') IS NOT NULL") == 't':
    sql("INSERT INTO public.greenhouses(id,name,phase_start,phase_end,window_start,window_end) VALUES('concurrent-cloud-G','Cloud concurrency',(now() AT TIME ZONE 'Asia/Manila')::date,(now() AT TIME ZONE 'Asia/Manila')::date+2,'00:00','23:59'); INSERT INTO public.greenhouse_sensors VALUES('concurrent-cloud-G','concurrent-cloud-A'),('concurrent-cloud-G','concurrent-cloud-B'); SELECT 'ready';")
    greenhouse = json.loads(sql("SELECT row_to_json(g) FROM public.greenhouses g WHERE id='concurrent-cloud-G'"))
    config = {key: greenhouse[key] for key in ('id','phase_start','phase_end')}
    config.update({key: greenhouse[key][:5] for key in ('window_start','window_end')})
    config['dark_phase_days'] = int(sql("SELECT coalesce((SELECT value FROM public.system_settings WHERE key='dark_phase_duration_days'),'60')"))
    expected_hash = hashlib.sha256(json.dumps(config,sort_keys=True).encode()).hexdigest()
    assert sql("SELECT lpmas_private.monitoring_context('concurrent-cloud-A',now())->>'config_version'") == expected_hash, 'Cloud fingerprint differs from unchanged Pi'
    def cloud_samples(sensor):
        for age in (3,2,1):
            sql("BEGIN; SELECT set_config('request.jwt.claim.role','service_role',true); SELECT public.ingest_pilot_delivery(jsonb_build_object('kind','reading','delivery_id',gen_random_uuid(),'sensor_id','" + sensor + "','recorded_at',now()-make_interval(secs=>" + str(age) + "),'lux',10,'greenhouse_id','concurrent-cloud-G','phase_type','illumination','classification','violation','monitoring_active',true,'config_version','" + expected_hash + "','incident',null)); COMMIT;")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(cloud_samples,['concurrent-cloud-A','concurrent-cloud-B']))
    assert sql("SELECT count(*) FROM public.greenhouse_alerts WHERE greenhouse_id='concurrent-cloud-G' AND status='open' AND producer='cloud'") == '1', 'Concurrent siblings split cloud episode'
    assert sql("SELECT count(*) FROM lpmas_private.cloud_episode_members m JOIN public.greenhouse_alerts g ON g.incident_uid=m.episode_uid WHERE g.greenhouse_id='concurrent-cloud-G'") == '2', 'Concurrent member lost'
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        jobs = [job for result in pool.map(claim, range(6)) for job in result]
    assert len(jobs) == 2 and len({job['id'] for job in jobs}) == 2, 'Cloud episode generated duplicate channel attempts'
    print('Concurrent cloud episodes: unchanged Pi fingerprint, one sibling episode, two members and one attempt per channel passed.')
