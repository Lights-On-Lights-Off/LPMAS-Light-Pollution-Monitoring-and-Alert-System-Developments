"""Concurrent receipt and aggregate checks; only called on our disposable DB."""
import concurrent.futures
import json
import subprocess
import sys
import uuid

container = sys.argv[1]
if not container.startswith('lpmas-verify-'):
    raise SystemExit('Refusing to test a container outside the disposable verification workflow')

def sql(query):
    result = subprocess.run(['docker','exec','-i',container,'psql','-U','postgres','-d','postgres','-At','-v','ON_ERROR_STOP=1'],input=query,text=True,capture_output=True,check=True)
    return result.stdout.strip().splitlines()[-1]

sql("INSERT INTO public.greenhouses(id,name,phase_start,phase_end,window_start,window_end) VALUES('concurrent-G','Concurrent',current_date,current_date,'00:00','23:59'); SELECT 'ready';")
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
