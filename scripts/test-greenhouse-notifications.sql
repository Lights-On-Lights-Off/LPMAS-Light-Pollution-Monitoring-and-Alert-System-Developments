-- Disposable database only. No provider or Gmail network calls.
\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','manager@gmail.com',now(),'{}'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','admin@gmail.com',now(),'{}');
update public.profiles set role='admin' where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
insert into public.greenhouses(id,name,phase_start,phase_end,window_start,window_end)
values('alert-G','Notification greenhouse',current_date,current_date+2,'00:00','23:59');
insert into public.system_settings(key,value) values
 ('manager_user_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),('manager_phone','+639171234567')
on conflict(key) do update set value=excluded.value;
select set_config('request.jwt.claim.role','service_role',true);
set local role service_role;
do $$
declare
  p jsonb; q jsonb; g jsonb; jobs jsonb; j jsonb; n integer;
  opened timestamptz := now()-interval '1 minute';
begin
  g := jsonb_build_object('incident_uid','11111111-1111-4111-8111-111111111111','greenhouse_id','alert-G',
    'opened_at',opened,'resolved_at',null,'status','open','version',1,'legacy',false);
  p := jsonb_build_object('kind','incident','delivery_id',gen_random_uuid(),'recorded_at',now(),
    'incident',jsonb_build_object('id',987655,'incident_uid','22222222-2222-4222-8222-222222222222',
      'version',1,'sensor_id','alert-S1','greenhouse_id','alert-G','phase_type','dark',
      'opened_at',opened,'resolved_at',null,'status','open','peak_lux',40,'lowest_lux',40,
      'reason','Confirmed breach','config_version','original','triggering_readings','[{},{},{}]'::jsonb,'greenhouse_alert',g));
  perform public.ingest_pilot_delivery(p);
  perform public.ingest_pilot_delivery(p);
  q := jsonb_set(p,'{delivery_id}',to_jsonb(gen_random_uuid()));
  q := jsonb_set(q,'{incident,id}','987656');
  q := jsonb_set(q,'{incident,sensor_id}','"alert-S2"');
  q := jsonb_set(q,'{incident,incident_uid}','"33333333-3333-4333-8333-333333333333"');
  q := jsonb_set(q,'{incident,greenhouse_alert,version}','2');
  perform public.ingest_pilot_delivery(q);
  if (select count(*) from public.greenhouse_notification_jobs) <> 2 then raise exception 'Sibling or replay created duplicate alerts'; end if;
  if jsonb_array_length(public.claim_greenhouse_notifications(20)) <> 0 then raise exception 'Disabled feature sent alerts'; end if;
  update public.system_settings set value='true' where key='greenhouse_notifications_enabled';
  jobs := public.claim_greenhouse_notifications(20);
  if jsonb_array_length(jobs) <> 2 then raise exception 'Missing channel'; end if;
  for j in select value from jsonb_array_elements(jobs) loop
    if (j->>'attempts')::integer <> 1 or j->>'status' <> 'unknown' then raise exception 'Attempt not consumed before send'; end if;
    if j->>'channel'='email' and j->>'recipient' <> 'manager@gmail.com' then raise exception 'Wrong verified email'; end if;
    if length(j->>'message') > 160 then raise exception 'SMS split into segments'; end if;
    -- Simulate loss of an outcome for SMS; finish only email.
    if j->>'channel'='email' then perform public.finish_greenhouse_notification((j->>'id')::uuid,(j->>'attempt_token')::uuid,'accepted','Provider accepted; delivery unconfirmed'); end if;
  end loop;
  if jsonb_array_length(public.claim_greenhouse_notifications(20)) <> 0 then raise exception 'Unknown attempt reclaimed'; end if;
  if jsonb_array_length(public.claim_notification_jobs(20)) <> 0 then raise exception 'Legacy sender active'; end if;
  begin
    update public.greenhouse_notification_jobs set attempts=0,status='pending';
    raise exception 'Attempt reset succeeded';
  exception when raise_exception then if SQLERRM='Attempt reset succeeded' then raise; end if; end;
  -- One member recovered; greenhouse remains open, so no recovery alert yet.
  p := jsonb_set(p,'{delivery_id}',to_jsonb(gen_random_uuid()));
  p := jsonb_set(p,'{incident,version}','2');
  p := jsonb_set(p,'{incident,status}','"resolved"');
  p := jsonb_set(p,'{incident,resolved_at}',to_jsonb(now()));
  p := jsonb_set(p,'{incident,resolution_reason}','"safe_reading"');
  p := jsonb_set(p,'{incident,greenhouse_alert,version}','3');
  perform public.ingest_pilot_delivery(p);
  if (select count(*) from public.greenhouse_notification_jobs) <> 2 then raise exception 'Premature recovery'; end if;
  q := jsonb_set(q,'{delivery_id}',to_jsonb(gen_random_uuid()));
  q := jsonb_set(q,'{incident,version}','2');
  q := jsonb_set(q,'{incident,status}','"resolved"');
  q := jsonb_set(q,'{incident,resolved_at}',to_jsonb(now()));
  q := jsonb_set(q,'{incident,resolution_reason}','"safe_reading"');
  q := jsonb_set(q,'{incident,greenhouse_alert,version}','4');
  q := jsonb_set(q,'{incident,greenhouse_alert,status}','"resolved"');
  q := jsonb_set(q,'{incident,greenhouse_alert,resolved_at}',to_jsonb(now()));
  perform public.ingest_pilot_delivery(q);
  perform public.ingest_pilot_delivery(q);
  if (select count(*) from public.greenhouse_notification_jobs where event='recovered') <> 2 then raise exception 'Recovery not unique per channel'; end if;
  if exists(select 1 from public.greenhouse_notification_jobs where event='recovered' and message not like 'LPMAS RESOLVED:%') then raise exception 'Wrong recovery message'; end if;
  jobs := public.claim_greenhouse_notifications(20);
  if jsonb_array_length(jobs) <> 2 then raise exception 'Recovery cannot send'; end if;
  if jsonb_array_length(public.claim_greenhouse_notifications(20)) <> 0 then raise exception 'Recovery retried'; end if;
  -- A newer resolved snapshot arrives before its opening snapshot.
  g := jsonb_set(g,'{incident_uid}','"44444444-4444-4444-8444-444444444444"');
  g := g || jsonb_build_object('opened_at',now()-interval '30 seconds','status','resolved','resolved_at',now(),'version',2);
  q := jsonb_set(q,'{delivery_id}',to_jsonb(gen_random_uuid()));
  q := jsonb_set(q,'{incident,id}','987657');
  q := jsonb_set(q,'{incident,incident_uid}','"55555555-5555-4555-8555-555555555555"');
  q := jsonb_set(q,'{incident,opened_at}',g->'opened_at');
  q := jsonb_set(q,'{incident,greenhouse_alert}',g);
  perform public.ingest_pilot_delivery(q);
  q := jsonb_set(q,'{delivery_id}',to_jsonb(gen_random_uuid()));
  q := jsonb_set(q,'{incident,version}','1');
  q := jsonb_set(q,'{incident,status}','"open"');
  q := jsonb_set(q,'{incident,resolved_at}','null');
  q := jsonb_set(q,'{incident,resolution_reason}','null');
  g := g || '{"status":"open","resolved_at":null,"version":1}'::jsonb;
  q := jsonb_set(q,'{incident,greenhouse_alert}',g);
  perform public.ingest_pilot_delivery(q);
  if exists(select 1 from public.greenhouse_notification_jobs where greenhouse_alert_uid='44444444-4444-4444-8444-444444444444' and event='opened') then raise exception 'Stale opening alerted after recovery'; end if;
  -- Existing legacy delivery payloads still replay, without new notifications.
  p := jsonb_set(p,'{delivery_id}',to_jsonb(gen_random_uuid()));
  p := p #- '{incident,greenhouse_alert}';
  perform public.ingest_pilot_delivery(p);
  -- Gmail uses the verified admin mailbox and an encrypted Vault credential.
  perform public.set_gmail_authorization('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','admin@gmail.com','fake-refresh-token-for-disposable-test');
  if public.get_gmail_authorization()->>'sender_email' <> 'admin@gmail.com' then raise exception 'Gmail sender missing'; end if;
  if public.get_gmail_authorization_status() ? 'refresh_token' then raise exception 'Status exposes refresh token'; end if;
  begin
    perform public.set_gmail_authorization('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','other@gmail.com','fake-refresh-token-for-disposable-test');
    raise exception 'Foreign mailbox authorized';
  exception when raise_exception then if SQLERRM='Foreign mailbox authorized' then raise; end if; end;
end;
$$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
do $$
begin
  if has_function_privilege('public.get_gmail_authorization()','execute') or
     has_function_privilege('public.set_gmail_authorization(uuid,text,text)','execute') or
     has_function_privilege('public.get_gmail_authorization_status()','execute') or
     has_function_privilege('public.claim_greenhouse_notifications(integer)','execute') or
     has_function_privilege('public.retry_notification(uuid)','execute') then raise exception 'Operator can send or read credentials'; end if;
  if has_schema_privilege('lpmas_private','usage') then raise exception 'Private credential schema exposed'; end if;
  if has_schema_privilege('vault','usage') then
    if has_table_privilege('vault.decrypted_secrets','select') then raise exception 'Vault plaintext exposed'; end if;
  end if;
  if (select count(*) from public.greenhouse_notification_jobs) <> 6 then raise exception 'Operator outcome read failed'; end if;
end;
$$;
reset role;
set local role anon;
do $$
begin
  if has_table_privilege('public.greenhouse_notification_jobs','select') or
     has_table_privilege('public.greenhouse_alerts','select') then raise exception 'Public sees recipient data'; end if;
end;
$$;
rollback;
\echo 'Greenhouse no-retry, recovery, Vault, and access-boundary checks passed.'
