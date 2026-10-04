-- Deploy with greenhouse_notifications_enabled=false. Enable only after all
-- workers and the Pi have been upgraded. No credentials are placed in settings.
insert into public.system_settings(key,value) values ('greenhouse_notifications_enabled','false') on conflict do nothing;

create table public.greenhouse_alerts (
    incident_uid uuid primary key,
    greenhouse_id text not null,
    opened_at timestamptz not null,
    resolved_at timestamptz,
    status text not null check (status in ('open','resolved','closed')),
    version bigint not null check(version > 0),
    legacy boolean not null default false,
    check ((status='open' and resolved_at is null) or (status <> 'open' and resolved_at >= opened_at))
);
alter table public.monitoring_incidents add column greenhouse_alert_uid uuid references public.greenhouse_alerts(incident_uid);
create table public.greenhouse_notification_jobs (
    id uuid primary key default gen_random_uuid(),
    greenhouse_alert_uid uuid not null references public.greenhouse_alerts(incident_uid),
    event text not null check(event in ('opened','recovered')),
    channel text not null check(channel in ('sms','email')),
    status text not null default 'pending' check(status in ('pending','unknown','accepted','failed','skipped')),
    attempts integer not null default 0 check(attempts between 0 and 1),
    attempt_token uuid,
    recipient text,
    message text not null,
    attempted_at timestamptz,
    detail text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(greenhouse_alert_uid,event,channel)
);
alter table public.greenhouse_alerts enable row level security;
alter table public.greenhouse_notification_jobs enable row level security;
revoke all on public.greenhouse_alerts,public.greenhouse_notification_jobs from public,anon,authenticated;
grant all on public.greenhouse_alerts,public.greenhouse_notification_jobs to service_role;
grant select on public.greenhouse_alerts,public.greenhouse_notification_jobs to authenticated;
create policy "Operators read greenhouse alerts" on public.greenhouse_alerts for select to authenticated
using(exists(select 1 from public.profiles where id=auth.uid() and role::text in ('admin','manager')));
create policy "Operators read greenhouse delivery outcomes" on public.greenhouse_notification_jobs for select to authenticated
using(exists(select 1 from public.profiles where id=auth.uid() and role::text in ('admin','manager')));

create function public.protect_consumed_notification() returns trigger
language plpgsql set search_path=public as $$
begin
    if old.attempts=1 and (new.attempts <> 1 or new.attempt_token is distinct from old.attempt_token
      or new.attempted_at is distinct from old.attempted_at or new.recipient is distinct from old.recipient
      or new.message is distinct from old.message or new.event is distinct from old.event
      or new.channel is distinct from old.channel or new.greenhouse_alert_uid is distinct from old.greenhouse_alert_uid
      or (old.status <> 'unknown' and new.status is distinct from old.status)) then
      raise exception 'Consumed notification attempts cannot be reset';
    end if;
    return new;
end;
$$;
revoke all on function public.protect_consumed_notification() from public,anon,authenticated;
create trigger protect_consumed_notification before update on public.greenhouse_notification_jobs
for each row execute function public.protect_consumed_notification();

create function public.record_greenhouse_alert(p_incident jsonb) returns void
language plpgsql security definer set search_path=public as $$
declare
    a jsonb := p_incident->'greenhouse_alert';
    uid uuid := (a->>'incident_uid')::uuid;
    event_name text;
    message_body text;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
    if a->>'greenhouse_id' is distinct from p_incident->>'greenhouse_id' then raise exception 'Greenhouse context mismatch'; end if;
    if not exists(select 1 from public.monitoring_incidents where incident_uid=(p_incident->>'incident_uid')::uuid
      and greenhouse_id=a->>'greenhouse_id' and (greenhouse_alert_uid is null or greenhouse_alert_uid=uid)) then
      raise exception 'Incident episode identity collision';
    end if;
    insert into public.greenhouse_alerts as g(incident_uid,greenhouse_id,opened_at,resolved_at,status,version,legacy)
    values(uid,a->>'greenhouse_id',(a->>'opened_at')::timestamptz,(a->>'resolved_at')::timestamptz,a->>'status',(a->>'version')::bigint,coalesce((a->>'legacy')::boolean,false))
    on conflict(incident_uid) do update set resolved_at=excluded.resolved_at,status=excluded.status,version=excluded.version
    where excluded.version > g.version and g.status='open'
      and g.greenhouse_id=excluded.greenhouse_id and g.opened_at=excluded.opened_at and g.legacy=excluded.legacy;
    if exists(select 1 from public.greenhouse_alerts where incident_uid=uid and
      (greenhouse_id is distinct from a->>'greenhouse_id' or opened_at is distinct from (a->>'opened_at')::timestamptz
       or legacy is distinct from coalesce((a->>'legacy')::boolean,false))) then raise exception 'Episode identity collision'; end if;
    -- A stale sensor snapshot must not downgrade a newer greenhouse episode.
    update public.monitoring_incidents set greenhouse_alert_uid=uid
    where incident_uid=(p_incident->>'incident_uid')::uuid and (greenhouse_alert_uid is null or greenhouse_alert_uid=uid);
    if not exists(select 1 from public.greenhouse_alerts where incident_uid=uid and version=(a->>'version')::bigint and status=a->>'status') then return; end if;
    if a->>'status' <> 'open' then
        update public.greenhouse_notification_jobs set status='skipped',detail='Opening superseded by greenhouse closure',updated_at=now()
        where greenhouse_alert_uid=uid and event='opened' and status='pending' and attempts=0;
    end if;
    if a->>'status'='open' and not coalesce((a->>'legacy')::boolean,false) then event_name := 'opened';
    elsif a->>'status'='resolved' then event_name := 'recovered';
    else return; end if;
    message_body := 'LPMAS ' || case when event_name='opened' then 'ALERT' else 'RESOLVED' end || ': Greenhouse ' || left(regexp_replace(a->>'greenhouse_id','[^ -~]','?','g'),24) ||
      case when event_name='opened' then ' has a confirmed light violation.' else ' has returned to safe light levels.' end || ' Incident ' || left(uid::text,12) || '.';
    insert into public.greenhouse_notification_jobs(greenhouse_alert_uid,event,channel,message)
    select uid,event_name,c,message_body from unnest(array['sms','email']) c
    on conflict(greenhouse_alert_uid,event,channel) do nothing;
end;
$$;
revoke all on function public.record_greenhouse_alert(jsonb) from public,anon,authenticated;
grant execute on function public.record_greenhouse_alert(jsonb) to service_role;

create function public.claim_greenhouse_notifications(p_limit integer default 5) returns jsonb
language plpgsql security definer set search_path=public as $$
declare jobs jsonb;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
    if coalesce((select value from public.system_settings where key='greenhouse_notifications_enabled'),'false') <> 'true' then return '[]'::jsonb; end if;
    -- Serialize closure with claiming so stale openings cannot be selected.
    perform 1 from public.greenhouse_alerts g where exists(select 1 from public.greenhouse_notification_jobs j where j.greenhouse_alert_uid=g.incident_uid and j.status='pending') order by g.incident_uid for update;
    update public.greenhouse_notification_jobs j set status='skipped',detail='Opening superseded by greenhouse closure',updated_at=now()
    from public.greenhouse_alerts g where g.incident_uid=j.greenhouse_alert_uid and g.status <> 'open' and j.event='opened' and j.status='pending';
    -- Offline queues can deliver a new episode before an old episode's closure.
    update public.greenhouse_notification_jobs j set status='skipped',detail='Superseded by a newer greenhouse episode',updated_at=now()
    from public.greenhouse_alerts g where g.incident_uid=j.greenhouse_alert_uid and j.status='pending'
      and exists(select 1 from public.greenhouse_alerts newer where newer.greenhouse_id=g.greenhouse_id and newer.opened_at > g.opened_at);
    with due as (
        select id from public.greenhouse_notification_jobs where status='pending' and attempts=0 order by created_at,id for update skip locked limit least(greatest(p_limit,1),20)
    ), consumed as (
        update public.greenhouse_notification_jobs j set status='unknown',attempts=1,attempt_token=gen_random_uuid(),attempted_at=now(),updated_at=now(),
          detail='Attempt consumed; provider acceptance unconfirmed',
          recipient=case when channel='sms' then (select value from public.system_settings where key='manager_phone')
            else (select u.email from auth.users u join public.profiles p on p.id=u.id
              where p.role::text='manager' and u.email_confirmed_at is not null
              and u.id::text=(select value from public.system_settings where key='manager_user_id')) end
        from due where j.id=due.id returning j.*
    ) select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) into jobs from consumed c;
    return jobs;
end;
$$;
create function public.finish_greenhouse_notification(p_id uuid,p_attempt_token uuid,p_outcome text,p_detail text) returns void
language plpgsql security definer set search_path=public as $$
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
    if p_outcome not in ('accepted','failed','unknown') then raise exception 'Invalid outcome'; end if;
    update public.greenhouse_notification_jobs set status=p_outcome,detail=left(p_detail,500),updated_at=now()
    where id=p_id and attempt_token=p_attempt_token and status='unknown' and attempts=1;
end;
$$;
revoke all on function public.claim_greenhouse_notifications(integer),public.finish_greenhouse_notification(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.claim_greenhouse_notifications(integer),public.finish_greenhouse_notification(uuid,uuid,text,text) to service_role;

-- Retire the old retrying sender, including during a mixed-version deployment.
create or replace function public.claim_notification_jobs(p_limit integer default 5) returns jsonb
language plpgsql security definer set search_path=public as $$
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
    return '[]'::jsonb;
end;
$$;
create or replace function public.retry_notification(p_incident_uid uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
    raise exception 'Incident notification retries are disabled';
end;
$$;
revoke all on function public.retry_notification(uuid) from public,anon,authenticated;
update public.notification_jobs set status='failed',detail='Retired during no-retry cutover',updated_at=now() where status='pending';
create or replace function public.ingest_pilot_delivery(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
    v_id uuid := (p_payload->>'delivery_id')::uuid;
    v_recorded timestamptz := (p_payload->>'recorded_at')::timestamptz;
    v_sensor text := p_payload->>'sensor_id';
    v_greenhouse text := nullif(p_payload->>'greenhouse_id','');
    v_phase text := p_payload->>'phase_type';
    v_class text := p_payload->>'classification';
    v_config text := p_payload->>'config_version';
    v_lux numeric := (p_payload->>'lux')::numeric;
    v_bucket timestamptz;
    v_incident jsonb := p_payload->'incident';
    v_written boolean := false;
    v_existing jsonb;
    v_threshold integer := coalesce((select value::integer from public.system_settings where key='sensor_offline_threshold_seconds'),15);
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
    if v_id is null or v_recorded is null or v_recorded > now() + interval '2 minutes' then
        raise exception 'Invalid delivery timestamp or identifier';
    end if;
    -- Concurrent duplicate deliveries serialize on this primary key. All later
    -- writes roll back together if any part of the delivery fails.
    insert into public.ingestion_receipts(delivery_id,recorded_at,payload)
    values(v_id,v_recorded,p_payload) on conflict do nothing;
    if not found then
        select payload into v_existing from public.ingestion_receipts where delivery_id = v_id;
        if v_existing <> p_payload then raise exception 'Delivery identifier reused with different content'; end if;
        return jsonb_build_object('ok',true,'duplicate',true,'aggregate_updated',false);
    end if;
    if p_payload->>'kind' = 'reading' then
        if v_sensor is null or trim(v_sensor) = '' or v_lux is null or v_lux < 0
           or v_lux::text in ('NaN','Infinity','-Infinity') or v_config is null then
            raise exception 'Invalid reading';
        end if;
        -- Replay records history but cannot resurrect an offline sensor, overwrite
        -- a newer measurement, or overwrite the manager's current assignment.
        insert into public.sensor_list(sensor_id,lux,status,last_reading_at,recorded_at,received_at,greenhouse_id)
        values(v_sensor,v_lux,case when v_recorded >= now()-make_interval(secs => v_threshold) then 'online' else 'offline' end,
            v_recorded,v_recorded,now(),(select greenhouse_id from public.greenhouse_sensors where sensor_id=v_sensor))
        on conflict(sensor_id) do update set
            lux = case when excluded.recorded_at >= coalesce(sensor_list.recorded_at,'-infinity') then excluded.lux else sensor_list.lux end,
            status = case when excluded.recorded_at >= coalesce(sensor_list.recorded_at,'-infinity') then
                case when excluded.recorded_at >= now() - make_interval(secs => coalesce((select value::integer from public.system_settings where key='sensor_offline_threshold_seconds'),15)) then 'online' else 'offline' end
                else sensor_list.status end,
            last_reading_at = greatest(sensor_list.recorded_at,excluded.recorded_at),
            recorded_at = greatest(sensor_list.recorded_at,excluded.recorded_at),
            received_at = now();
        if coalesce((p_payload->>'monitoring_active')::boolean,false) then
            if v_greenhouse is null or v_phase not in ('illumination','dark') or v_class not in ('safe','warning','violation') then
                raise exception 'Invalid monitoring context';
            end if;
            v_bucket := date_trunc('minute',v_recorded);
            insert into public.sensor_minute_aggregates as a(
                sensor_id,greenhouse_id,bucket_start,phase_type,config_version,sample_count,
                avg_lux,min_lux,max_lux,safe_count,warning_count,violation_count,updated_at,last_recorded_at
            ) values(v_sensor,v_greenhouse,v_bucket,v_phase,v_config,1,v_lux,v_lux,v_lux,
                (v_class='safe')::integer,(v_class='warning')::integer,(v_class='violation')::integer,v_recorded,v_recorded)
            on conflict(sensor_id,greenhouse_id,bucket_start,phase_type,config_version) do update set
                avg_lux=round((a.avg_lux*a.sample_count+excluded.avg_lux)/(a.sample_count+1),3),
                sample_count=a.sample_count+1,min_lux=least(a.min_lux,excluded.min_lux),max_lux=greatest(a.max_lux,excluded.max_lux),
                safe_count=a.safe_count+excluded.safe_count,warning_count=a.warning_count+excluded.warning_count,
                violation_count=a.violation_count+excluded.violation_count,updated_at=greatest(a.updated_at,excluded.updated_at),last_recorded_at=greatest(a.last_recorded_at,excluded.last_recorded_at);
            v_written := true;
        end if;
    elsif p_payload->>'kind' is distinct from 'incident' then
        raise exception 'Unknown delivery kind';
    end if;
    if v_incident is not null and v_incident <> 'null'::jsonb then
        -- Attach a UUID to an existing legacy incident without creating a second
        -- historical row. Modern identities never depend on SQLite's integer ID.
        update public.monitoring_incidents set incident_uid=(v_incident->>'incident_uid')::uuid
        where pi_incident_id=(v_incident->>'id')::bigint and incident_uid is null;
        insert into public.monitoring_incidents as i(
            pi_incident_id,incident_uid,incident_version,sensor_id,greenhouse_id,phase_type,
            opened_at,resolved_at,status,peak_lux,lowest_lux,reason,triggering_readings,config_version,resolution_reason,updated_at
        ) values((v_incident->>'id')::bigint,(v_incident->>'incident_uid')::uuid,(v_incident->>'version')::bigint,
            v_incident->>'sensor_id',v_incident->>'greenhouse_id',v_incident->>'phase_type',
            (v_incident->>'opened_at')::timestamptz,(v_incident->>'resolved_at')::timestamptz,v_incident->>'status',
            (v_incident->>'peak_lux')::numeric,(v_incident->>'lowest_lux')::numeric,v_incident->>'reason',
            coalesce(v_incident->'triggering_readings','[]'::jsonb),v_incident->>'config_version',v_incident->>'resolution_reason',v_recorded)
        on conflict(incident_uid) do update set
            incident_uid=excluded.incident_uid,incident_version=excluded.incident_version,status=excluded.status,
            resolved_at=excluded.resolved_at,peak_lux=excluded.peak_lux,lowest_lux=excluded.lowest_lux,
            triggering_readings=excluded.triggering_readings,config_version=coalesce(excluded.config_version,i.config_version),
            resolution_reason=excluded.resolution_reason,updated_at=excluded.updated_at
        where excluded.incident_version > i.incident_version;
        if v_incident->'greenhouse_alert' is not null and v_incident->'greenhouse_alert' <> 'null'::jsonb then
            perform public.record_greenhouse_alert(v_incident);
        end if;
    end if;
    return jsonb_build_object('ok',true,'duplicate',false,'aggregate_updated',v_written);
end;
$$;
revoke execute on function public.ingest_pilot_delivery(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_pilot_delivery(jsonb) to service_role;
