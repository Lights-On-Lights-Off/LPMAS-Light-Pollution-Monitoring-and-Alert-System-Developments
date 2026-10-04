-- Run after all migrations in an ISOLATED database. Never use production.
-- The fixture and every probe roll back; no SMS transport is called.
\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','pilot-manager@example.invalid','{}'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','pilot-admin@example.invalid','{}');
update public.profiles set role='manager' where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
update public.profiles set role='admin' where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
insert into public.greenhouses(id,name,phase_start,phase_end,window_start,window_end)
values('pilot-G1','Pilot one',current_date-2,current_date+2,'23:00','05:00'),
      ('pilot-G2','Pilot two',current_date-2,current_date+2,'23:00','05:00');
insert into public.greenhouse_sensors values('pilot-G1','pilot-S1');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.role','service_role',true);
set local role service_role;
do $$
declare
  p jsonb; r jsonb; n integer; j jsonb; v_stamp timestamptz;
begin
  if public.pi_configuration() ? 'textbee_api_key' or public.pi_configuration() ? 'profiles' then raise exception 'Pi configuration leaked private data'; end if;
  if not (public.pi_configuration() ?& array['greenhouses','greenhouse_sensors','sensor_list','dark_phase_days']) then raise exception 'Pi configuration incomplete'; end if;
  p := jsonb_build_object('kind','reading','delivery_id','11111111-1111-4111-8111-111111111111',
    'sensor_id','pilot-S1','lux',40,'recorded_at',now()-interval '1 day',
    'greenhouse_id','pilot-G1','phase_type','dark','classification','violation',
    'monitoring_active',true,'config_version','original','incident',null);
  r := public.ingest_pilot_delivery(p);
  if not (r->>'aggregate_updated')::boolean then raise exception 'Dark phase dropped'; end if;
  r := public.ingest_pilot_delivery(p);
  if not (r->>'duplicate')::boolean then raise exception 'Replay not deduplicated'; end if;
  select sample_count into n from public.sensor_minute_aggregates where sensor_id='pilot-S1';
  if n <> 1 then raise exception 'Duplicate counted twice'; end if;
  begin
    perform public.ingest_pilot_delivery(p || '{"lux":41}'::jsonb);
    raise exception 'Changed payload accepted';
  exception when raise_exception then
    if SQLERRM = 'Changed payload accepted' then raise; end if;
  end;
  if (select status from public.sensor_list where sensor_id='pilot-S1') <> 'offline' then raise exception 'Replay resurrected offline sensor'; end if;
  -- Fresh measurement precedes an older replay. Lux and recorded time cannot regress.
  p := p || jsonb_build_object('delivery_id','22222222-2222-4222-8222-222222222222','recorded_at',now(),'lux',45);
  perform public.ingest_pilot_delivery(p);
  select recorded_at into v_stamp from public.sensor_list where sensor_id='pilot-S1';
  p := p || jsonb_build_object('delivery_id','33333333-3333-4333-8333-333333333333','recorded_at',now()-interval '2 hours','lux',60,'classification','violation');
  perform public.ingest_pilot_delivery(p);
  if (select lux from public.sensor_list where sensor_id='pilot-S1') <> 45 or
     (select recorded_at from public.sensor_list where sensor_id='pilot-S1') <> v_stamp then raise exception 'Late replay regressed measurement'; end if;
  -- Move device, then replay data with its original context. History is not relabelled.
  perform public.update_sensor_list('pilot-S1',null,'pilot-G2',false,false);
  p := p || jsonb_build_object('delivery_id','44444444-4444-4444-8444-444444444444','recorded_at',now()-interval '3 hours');
  perform public.ingest_pilot_delivery(p);
  if (select greenhouse_id from public.sensor_list where sensor_id='pilot-S1') <> 'pilot-G2' then raise exception 'Replay overwrote assignment'; end if;
  if exists(select 1 from public.sensor_minute_aggregates where sensor_id='pilot-S1' and greenhouse_id <> 'pilot-G1') then raise exception 'Historical aggregate relabelled'; end if;
  -- Outside illumination window: receipt and registry are stored, aggregate is not.
  p := p || jsonb_build_object('delivery_id','55555555-5555-4555-8555-555555555555','phase_type','illumination','classification','unclassified','monitoring_active',false);
  r := public.ingest_pilot_delivery(p);
  if (r->>'aggregate_updated')::boolean then raise exception 'Unmonitored sample aggregated'; end if;
  -- One incident job through initial confirmation, acknowledgement, and resolution.
  p := jsonb_build_object('kind','incident','delivery_id','66666666-6666-4666-8666-666666666666','recorded_at',now(),
    'incident',jsonb_build_object('id',987654,'incident_uid','77777777-7777-4777-8777-777777777777','version',1,
      'sensor_id','pilot-S1','greenhouse_id','pilot-G1','phase_type','dark','opened_at',now(),
      'resolved_at',null,'status','open','peak_lux',40,'lowest_lux',40,'reason','Confirmed breach','config_version','original','triggering_readings','[{},{},{}]'::jsonb));
  perform public.ingest_pilot_delivery(p);
  perform public.ingest_pilot_delivery(p);
  p := jsonb_set(p,'{delivery_id}','"88888888-8888-4888-8888-888888888888"');
  p := jsonb_set(p,'{incident,version}','3');
  p := jsonb_set(p,'{incident,status}','"resolved"');
  p := jsonb_set(p,'{incident,resolved_at}',to_jsonb(now()));
  p := jsonb_set(p,'{incident,resolution_reason}','"configuration_changed"');
  perform public.ingest_pilot_delivery(p);
  -- Out-of-order acknowledgement cannot reopen a resolved incident.
  p := jsonb_set(p,'{delivery_id}','"99999999-9999-4999-8999-999999999999"');
  p := jsonb_set(p,'{incident,version}','2');
  p := jsonb_set(p,'{incident,status}','"acknowledged"');
  p := jsonb_set(p,'{incident,resolved_at}','null');
  p := p #- '{incident,resolution_reason}';
  perform public.ingest_pilot_delivery(p);
  if (select status from public.monitoring_incidents where incident_uid='77777777-7777-4777-8777-777777777777') <> 'resolved' then raise exception 'Stale snapshot reopened incident'; end if;
  if (select resolution_reason from public.monitoring_incidents where incident_uid='77777777-7777-4777-8777-777777777777') <> 'configuration_changed' then raise exception 'Closure reason lost on stale replay'; end if;
  if (select config_version from public.monitoring_incidents where incident_uid='77777777-7777-4777-8777-777777777777') <> 'original' then raise exception 'Confirmation configuration lost'; end if;
  if (select count(*) from public.notification_jobs where incident_uid='77777777-7777-4777-8777-777777777777') <> 1 then raise exception 'Duplicate job'; end if;
  j := public.claim_notification_jobs(5)->0;
  if j is null then raise exception 'Notification not claimed'; end if;
  if jsonb_array_length(public.claim_notification_jobs(5)) <> 0 then raise exception 'Active lease claimed twice'; end if;
  perform public.finish_notification_job((j->>'id')::uuid,(j->>'lease_token')::uuid,false,'provider unavailable','+639171234567');
  if (select status from public.notification_jobs where id=(j->>'id')::uuid) <> 'pending' then raise exception 'Failure not retryable'; end if;
  update public.notification_jobs set next_attempt_at=now()-interval '1 minute' where id=(j->>'id')::uuid;
  j := public.claim_notification_jobs(5)->0;
  perform public.finish_notification_job((j->>'id')::uuid,(j->>'lease_token')::uuid,true,'Accepted, delivery unconfirmed','+639171234567');
  if (select status from public.notification_jobs where id=(j->>'id')::uuid) <> 'accepted' then raise exception 'Acceptance not recorded'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
set local role authenticated;
do $$
begin
  if has_column_privilege('public.profiles','role','update') then raise exception 'User can self-promote'; end if;
  if has_function_privilege('public.ingest_pilot_delivery(jsonb)','execute') then raise exception 'User can ingest'; end if;
  if has_function_privilege('public.claim_notification_jobs(integer)','execute') then raise exception 'User can send notifications'; end if;
  if has_table_privilege('public.sensor_minute_aggregates','insert') then raise exception 'User can forge aggregates'; end if;
  if has_function_privilege('public.upsert_minute_aggregate(text,text,timestamptz,text,integer,numeric,numeric,numeric,integer,integer,integer,timestamptz)','execute') then raise exception 'Legacy additive path exposed'; end if;
  begin
    perform public.update_sensor_list('pilot-S1',42,null,false,true);
    raise exception 'User forged health';
  exception when raise_exception then if SQLERRM='User forged health' then raise; end if; end;
  perform public.update_sensor_list('pilot-S1',null,'pilot-G1',false,false);
  if (select greenhouse_id from public.greenhouse_sensors where sensor_id='pilot-S1') <> 'pilot-G1' then raise exception 'Assignment mirror inconsistent'; end if;
  if (select count(*) from public.notification_jobs) <> 1 then raise exception 'Manager cannot see outcomes'; end if;
  begin
    perform public.retry_notification('77777777-7777-4777-8777-777777777777');
    raise exception 'Accepted notification retried';
  exception when raise_exception then if SQLERRM='Accepted notification retried' then raise; end if; end;
  perform public.delete_greenhouse('pilot-G1');
  perform public.update_sensor_list('pilot-S1',null,'pilot-G2',false,false);
  begin
    perform public.restore_greenhouse((select id from public.greenhouse_recycle_bin where greenhouse_id='pilot-G1'));
    raise exception 'Restore stole an assigned sensor';
  exception when raise_exception then if SQLERRM='Restore stole an assigned sensor' then raise; end if; end;
  if (select greenhouse_id from public.greenhouse_sensors where sensor_id='pilot-S1') <> 'pilot-G2' then raise exception 'Failed restore changed assignment'; end if;
  perform public.update_sensor_list('pilot-S1',null,null,true,false);
  perform public.restore_greenhouse((select id from public.greenhouse_recycle_bin where greenhouse_id='pilot-G1'));
  if not exists(select 1 from public.greenhouses where id='pilot-G1') then raise exception 'Restore failed'; end if;
end;
$$;
reset role;
update public.notification_jobs set status='failed',attempts=5 where incident_uid='77777777-7777-4777-8777-777777777777';
set local role authenticated;
do $$
begin
  perform public.retry_notification('77777777-7777-4777-8777-777777777777');
  if (select status from public.notification_jobs where incident_uid='77777777-7777-4777-8777-777777777777') <> 'pending' then raise exception 'Operator retry not queued'; end if;
  if (select attempts from public.notification_jobs where incident_uid='77777777-7777-4777-8777-777777777777') <> 0 then raise exception 'Operator retry budget not reset'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select set_config('request.jwt.claim.role','anon',true);
select set_config('request.jwt.claim.sub','',true);
set local role anon;
do $$
begin
  if has_function_privilege('public.ingest_pilot_delivery(jsonb)','execute') then raise exception 'Anon can ingest'; end if;
  if has_function_privilege('public.pi_configuration()','execute') then raise exception 'Anon can read private Pi configuration'; end if;
  if exists(select 1 from public.sensor_minute_aggregates where bucket_start < now()-interval '24 hours') then raise exception 'Anonymous archive access remains'; end if;
  if has_function_privilege('public.update_sensor_list(text,numeric,text,boolean,boolean)','execute') then raise exception 'Anon can assign'; end if;
  if has_table_privilege('public.notification_jobs','select') then raise exception 'Public can read notification recipients'; end if;
  if not has_table_privilege('public.sensor_minute_aggregates','select') then raise exception 'Public cloud history unavailable'; end if;
  perform public.monitoring_policy();
end;
$$;
reset role;
rollback;
\echo 'Pilot database: ingestion, replay, history, leases, restore, and role checks passed.'
