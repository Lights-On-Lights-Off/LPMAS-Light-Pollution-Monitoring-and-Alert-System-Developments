-- Disposable/rollback-only: unchanged Pi payloads, no provider calls.
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claim.role','service_role',true);
-- Fixture timestamps span 13 seconds. Set this only in the rollback transaction;
-- the live project's configured freshness threshold is restored by rollback.
insert into public.system_settings(key,value) values('sensor_offline_threshold_seconds','15')
on conflict(key) do update set value=excluded.value;
create function pg_temp.capture(sensor text,at_time timestamptz,lux numeric) returns jsonb
language plpgsql as $$
declare ctx jsonb := lpmas_private.monitoring_context(sensor,at_time); p jsonb;
begin
    p := jsonb_build_object('kind','reading','delivery_id',gen_random_uuid(),'recorded_at',at_time,
      'sensor_id',sensor,'lux',lux,'greenhouse_id',ctx->>'greenhouse_id','phase_type',ctx->>'phase_type',
      'config_version',ctx->>'config_version','monitoring_active',true,'incident',null,
      'classification',case when ctx->>'phase_type'='dark' then
         case when lux<=15 then 'safe' when lux<=29 then 'warning' else 'violation' end
         else case when lux<=30 then 'violation' when lux<50 then 'warning' else 'safe' end end);
    perform public.ingest_pilot_delivery(p);
    return p;
end;
$$;
insert into public.greenhouses(id,name,phase_start,phase_end,window_start,window_end)
select 'cloud-'||n,'Cloud fixture',(now() at time zone 'Asia/Manila')::date,
  (now() at time zone 'Asia/Manila')::date+2,'00:00','23:59' from generate_series(1,7) n;
insert into public.greenhouse_sensors(greenhouse_id,sensor_id) values
 ('cloud-1','cloud-A'),('cloud-1','cloud-B'),('cloud-2','cloud-C'),('cloud-3','cloud-D'),
 ('cloud-4','cloud-E'),('cloud-4','cloud-F'),('cloud-5','cloud-H'),('cloud-5','cloud-L'),('cloud-6','cloud-I'),('cloud-7','cloud-J');
insert into public.greenhouses(id,name,phase_start,phase_end,window_start,window_end)
values('cloud-dark','Dark phase',(now() at time zone 'Asia/Manila')::date-2,
  (now() at time zone 'Asia/Manila')::date-1,'09:00','10:00');
insert into public.greenhouse_sensors values('cloud-dark','cloud-K');
do $$
declare uid uuid; p jsonb; jobs jsonb; j jsonb; ctx jsonb; n integer;
begin
    -- No Pi incident/episode snapshots are required to open a greenhouse alert.
    perform pg_temp.capture('cloud-A',now()-interval '13 seconds',10);
    p := pg_temp.capture('cloud-A',now()-interval '12 seconds',10);
    perform public.ingest_pilot_delivery(p);
    if exists(select 1 from public.greenhouse_alerts where greenhouse_id='cloud-1') then raise exception 'Replay confirmed an episode early'; end if;
    perform pg_temp.capture('cloud-A',now()-interval '11 seconds',10);
    select incident_uid into uid from public.greenhouse_alerts where greenhouse_id='cloud-1' and status='open';
    if uid is null then raise exception 'Unchanged Pi readings cannot open cloud episode'; end if;
    for n in 10..12 loop perform pg_temp.capture('cloud-B',now()-make_interval(secs=>n),10); end loop;
    -- Out-of-order samples cannot rewind state or count as a fresh sequence.
    perform pg_temp.capture('cloud-B',now()-interval '9 seconds',10);
    perform pg_temp.capture('cloud-B',now()-interval '8 seconds',10);
    if (select count(*) from public.greenhouse_alerts where greenhouse_id='cloud-1') <> 1 then raise exception 'Sibling split the greenhouse episode'; end if;
    if (select count(*) from public.greenhouse_notification_jobs where greenhouse_alert_uid=uid) <> 2 then raise exception 'Sibling duplicated opening channels'; end if;
    if jsonb_array_length(public.claim_greenhouse_notifications(20)) <> 0 then raise exception 'Disabled sending consumed jobs'; end if;
    update public.system_settings set value='true' where key='greenhouse_notifications_enabled';
    jobs := public.claim_greenhouse_notifications(20);
    if jsonb_array_length(jobs) <> 2 then raise exception 'Opening missing a channel'; end if;
    for j in select value from jsonb_array_elements(jobs) loop
      if (j->>'attempts')::int <> 1 then raise exception 'Attempt not consumed'; end if;
    end loop;
    if jsonb_array_length(public.claim_greenhouse_notifications(20)) <> 0 then raise exception 'Lost outcome was retried'; end if;
    perform pg_temp.capture('cloud-A',now()-interval '7 seconds',60);
    if (select status from public.greenhouse_alerts where incident_uid=uid) <> 'open' then raise exception 'One safe reading recovered'; end if;
    perform pg_temp.capture('cloud-A',now()-interval '6 seconds',60);
    perform pg_temp.capture('cloud-A',now()-interval '5 seconds',60);
    if (select status from public.greenhouse_alerts where incident_uid=uid) <> 'open' then raise exception 'Unrecovered sibling ignored'; end if;
    perform pg_temp.capture('cloud-B',now()-interval '4 seconds',60);
    perform pg_temp.capture('cloud-B',now()-interval '3 seconds',40);
    perform pg_temp.capture('cloud-B',now()-interval '2 seconds',60);
    perform pg_temp.capture('cloud-B',now()-interval '1 second',60);
    if (select status from public.greenhouse_alerts where incident_uid=uid) <> 'open' then raise exception 'Warning did not interrupt recovery'; end if;
    perform pg_temp.capture('cloud-B',now(),60);
    if (select status from public.greenhouse_alerts where incident_uid=uid) <> 'resolved' then raise exception 'All-member recovery missing'; end if;
    if (select count(*) from public.greenhouse_notification_jobs where greenhouse_alert_uid=uid and event='recovered') <> 2 then raise exception 'Recovery missing mirrored channels'; end if;

    -- Changing context closes without claiming safe recovery; reassigning the
    -- same sensor cannot resume its old consecutive candidate run.
    for n in reverse 5..3 loop perform pg_temp.capture('cloud-C',now()-make_interval(secs=>n),10); end loop;
    select incident_uid into uid from public.greenhouse_alerts where greenhouse_id='cloud-2' and status='open';
    update public.greenhouses set window_end='23:58' where id='cloud-2';
    if (select status from public.greenhouse_alerts where incident_uid=uid) <> 'closed' then raise exception 'Configuration change left episode open'; end if;
    if exists(select 1 from public.greenhouse_notification_jobs where greenhouse_alert_uid=uid and event='recovered') then raise exception 'Configuration change claimed safe recovery'; end if;
    if exists(select 1 from public.greenhouse_notification_jobs where greenhouse_alert_uid=uid and status='pending') then raise exception 'Closed opening was not suppressed'; end if;
    perform pg_temp.capture('cloud-D',now()-interval '4 seconds',10);
    perform pg_temp.capture('cloud-D',now()-interval '3 seconds',10);
    delete from public.greenhouse_sensors where sensor_id='cloud-D';
    insert into public.greenhouse_sensors values('cloud-3','cloud-D');
    perform pg_temp.capture('cloud-D',now()-interval '2 seconds',10);
    if exists(select 1 from public.greenhouse_alerts where greenhouse_id='cloud-3') then raise exception 'Reassignment retained confirmation candidates'; end if;

    -- An offline affected member cannot be declared recovered by its sibling.
    for n in reverse 12..10 loop
      perform pg_temp.capture('cloud-E',now()-make_interval(secs=>n),10);
      perform pg_temp.capture('cloud-F',now()-make_interval(secs=>n),10);
    end loop;
    update lpmas_private.cloud_sensor_state set last_recorded_at=now()-interval '30 seconds',safes=3 where sensor_id='cloud-F';
    for n in reverse 3..1 loop perform pg_temp.capture('cloud-E',now()-make_interval(secs=>n),60); end loop;
    if not exists(select 1 from public.greenhouse_alerts where greenhouse_id='cloud-4' and status='open') then raise exception 'Offline member recovered'; end if;

    -- Backlogged/future/configuration-mismatched samples preserve history but
    -- cannot create a current notification episode.
    perform pg_temp.capture('cloud-H',now()-interval '60 seconds',10);
    perform pg_temp.capture('cloud-H',now()-interval '59 seconds',10);
    perform pg_temp.capture('cloud-H',now()-interval '58 seconds',10);
    if exists(select 1 from public.greenhouse_alerts where greenhouse_id='cloud-5') then raise exception 'Historical backlog sent an opening'; end if;
    ctx := lpmas_private.monitoring_context('cloud-H',now());
    p := jsonb_build_object('kind','reading','delivery_id',gen_random_uuid(),'recorded_at',now(),
      'sensor_id','cloud-H','lux',10,'greenhouse_id','cloud-5','phase_type','illumination',
      'config_version','outdated-pi-config','monitoring_active',true,'classification','violation','incident',null);
    perform public.ingest_pilot_delivery(p);
    if (select violations from lpmas_private.cloud_sensor_state where sensor_id='cloud-H') <> 0 then raise exception 'Old Pi configuration confirmed a candidate'; end if;
    perform pg_temp.capture('cloud-I',now()+interval '1 second',10);
    if (select violations from lpmas_private.cloud_sensor_state where sensor_id='cloud-I') <> 0 then raise exception 'Future sample confirmed a candidate'; end if;

    -- A terminal episode remains terminal on old deliveries. A new confirmed
    -- violation after closure gets a new identity and one pair of openings.
    for n in reverse 8..6 loop perform pg_temp.capture('cloud-J',now()-make_interval(secs=>n),10); end loop;
    select incident_uid into uid from public.greenhouse_alerts where greenhouse_id='cloud-7' and status='open';
    for n in reverse 5..3 loop perform pg_temp.capture('cloud-J',now()-make_interval(secs=>n),60); end loop;
    perform pg_temp.capture('cloud-J',now()-interval '7 seconds',10);
    if (select status from public.greenhouse_alerts where incident_uid=uid) <> 'resolved' then raise exception 'Old delivery reopened terminal episode'; end if;
    for n in reverse 2..0 loop perform pg_temp.capture('cloud-J',now()-make_interval(secs=>n),10); end loop;
    if (select count(*) from public.greenhouse_alerts where greenhouse_id='cloud-7') <> 2 then raise exception 'New episode missing after recovery'; end if;
    -- Dark-phase classification is independent of the illumination window.
    if lpmas_private.monitoring_context('cloud-K',now())->>'phase_type' <> 'dark' then raise exception 'Dark context missing outside daily window'; end if;
    for n in reverse 8..6 loop perform pg_temp.capture('cloud-K',now()-make_interval(secs=>n),40); end loop;
    for n in reverse 5..3 loop perform pg_temp.capture('cloud-K',now()-make_interval(secs=>n),15); end loop;
    if not exists(select 1 from public.greenhouse_alerts where greenhouse_id='cloud-dark' and status='resolved') then raise exception 'Dark recovery threshold failed'; end if;
    -- Expired jobs are not delivered when configuration/consent arrives later.
    update public.greenhouse_notification_jobs set created_at=now()-interval '60 seconds'
    where status='pending' and greenhouse_alert_uid in (select incident_uid from public.greenhouse_alerts where greenhouse_id='cloud-7');
    perform public.claim_greenhouse_notifications(20);
    if exists(select 1 from public.greenhouse_notification_jobs j join public.greenhouse_alerts g on g.incident_uid=j.greenhouse_alert_uid
      where g.greenhouse_id='cloud-7' and j.status='pending') then raise exception 'Expired backlog retained for sending'; end if;
    -- Honor a deployment's stricter offline threshold, not just the 15s cap.
    update public.system_settings set value='11' where key='sensor_offline_threshold_seconds';
    for n in reverse 14..12 loop perform pg_temp.capture('cloud-L',now()-make_interval(secs=>n),10); end loop;
    if (select violations from lpmas_private.cloud_sensor_state where sensor_id='cloud-L') <> 0 then raise exception 'Configured freshness threshold ignored'; end if;
    perform pg_temp.capture('cloud-L',now()-interval '1 second',10);
    if (select violations from lpmas_private.cloud_sensor_state where sensor_id='cloud-L') <> 1 then raise exception 'Stale candidates joined a fresh reading'; end if;
end;
$$;
set local role service_role;
do $$ begin
    if has_schema_privilege('lpmas_private','usage') then raise exception 'Cloud internal schema exposed'; end if;
    if has_function_privilege('public.claim_greenhouse_notifications_unreconciled(integer)','execute') then raise exception 'Backend bypasses reconciliation'; end if;
end; $$;
reset role;
rollback;
\echo 'Cloud episodes: unchanged Pi payloads, replay, siblings, recovery, offline members, context changes, and access passed.'
