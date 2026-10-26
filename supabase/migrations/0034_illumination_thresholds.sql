-- Illumination: <=25 lux violation, >25 and <41 warning, >=41 safe.
-- Replace the cloud validator without changing historical classifications.
begin;

create or replace function lpmas_private.process_cloud_reading() returns trigger
language plpgsql security definer set search_path=public as $$
declare
    p jsonb := new.payload;
    sensor text := p->>'sensor_id';
    stamp timestamptz := new.recorded_at;
    ctx jsonb;
    previous lpmas_private.cloud_sensor_state%rowtype;
    uid uuid;
    class text := p->>'classification';
    consecutive boolean;
    breach integer;
    safe integer;
    threshold integer := least(15,coalesce((select value::integer from public.system_settings where key='sensor_offline_threshold_seconds'),15));
begin
    perform pg_advisory_xact_lock(190022); if public.local_sms_mode() then return new; end if;
    if p->>'kind' <> 'reading' then return new; end if;
    perform pg_advisory_xact_lock(190022);
    perform lpmas_private.reconcile_cloud_episodes();
    select * into previous from lpmas_private.cloud_sensor_state where sensor_id=sensor;
    -- Duplicate receipts do not fire this trigger. Older/equal timestamps cannot
    -- rewind cloud state; the regular ingest path still preserves their history.
    if found and stamp <= previous.last_recorded_at then return new; end if;
    ctx := lpmas_private.monitoring_context(sensor,stamp);
    if not coalesce((p->>'monitoring_active')::boolean,false)
      or ctx is distinct from lpmas_private.monitoring_context(sensor,now())
      or ctx->>'greenhouse_id' is distinct from p->>'greenhouse_id'
      or ctx->>'phase_type' is distinct from p->>'phase_type'
      or ctx->>'config_version' is distinct from p->>'config_version'
      or stamp < now()-make_interval(secs=>threshold) or stamp > now()
      or class is distinct from (case when p->>'phase_type'='dark' then
          case when (p->>'lux')::numeric <= 15 then 'safe' when (p->>'lux')::numeric <= 29 then 'warning' else 'violation' end
          else case when (p->>'lux')::numeric <= 25 then 'violation' when (p->>'lux')::numeric < 41 then 'warning' else 'safe' end end)
    then ctx := null; end if;
    consecutive := ctx is not null and ctx=previous.context and stamp-previous.last_recorded_at <= interval '15 seconds';
    breach := case when ctx is not null and class='violation' then least(3,case when consecutive then previous.violations else 0 end+1) else 0 end;
    safe := case when ctx is not null and class='safe' then least(3,case when consecutive then previous.safes else 0 end+1) else 0 end;
    insert into lpmas_private.cloud_sensor_state(sensor_id,last_recorded_at,context,violations,safes,classification)
    values(sensor,stamp,ctx,breach,safe,class)
    on conflict(sensor_id) do update set last_recorded_at=excluded.last_recorded_at,context=excluded.context,
      violations=excluded.violations,safes=excluded.safes,classification=excluded.classification;
    if ctx is null then return new; end if;
    select incident_uid into uid from public.greenhouse_alerts
    where greenhouse_id=ctx->>'greenhouse_id' and status='open' and producer='cloud';
    if breach=3 then
        if uid is null then
            uid := gen_random_uuid();
            insert into public.greenhouse_alerts(incident_uid,greenhouse_id,opened_at,status,version,producer)
            values(uid,ctx->>'greenhouse_id',stamp,'open',1,'cloud');
            insert into public.greenhouse_notification_jobs(greenhouse_alert_uid,event,channel,message)
            select uid,'opened',c,'LPMAS ALERT: Greenhouse ' || left(regexp_replace(ctx->>'greenhouse_id','[^ -~]','?','g'),24) ||
              ' has a confirmed light violation. Incident ' || left(uid::text,12) || '.' from unnest(array['sms']) c;
        end if;
        insert into lpmas_private.cloud_episode_members(episode_uid,sensor_id,context) values(uid,sensor,ctx) on conflict do nothing;
    end if;
    if uid is not null and safe=3 and exists(select 1 from lpmas_private.cloud_episode_members where episode_uid=uid and sensor_id=sensor)
      and not exists(select 1 from lpmas_private.cloud_episode_members m
        left join lpmas_private.cloud_sensor_state s on s.sensor_id=m.sensor_id
        where m.episode_uid=uid and (s.sensor_id is null or s.context is distinct from m.context or s.safes<3
          or s.last_recorded_at < now()-make_interval(secs=>threshold) or s.last_recorded_at > now()))
    then perform lpmas_private.close_cloud_episode(uid,'resolved',stamp); end if;
    return new;
end;
$$;

commit;
