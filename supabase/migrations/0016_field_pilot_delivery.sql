-- Forward-only pilot migration. Historical readings and incidents are retained.
-- Only the Pi decides whether an incident has been confirmed. Cloud aggregation
-- and the notification outbox are committed with the unique delivery receipt.
create table public.ingestion_receipts (
    delivery_id uuid primary key,
    recorded_at timestamptz not null,
    received_at timestamptz not null default now(),
    payload jsonb not null
);
alter table public.ingestion_receipts enable row level security;
revoke all on public.ingestion_receipts from public, anon, authenticated;

alter table public.sensor_list add column recorded_at timestamptz;
alter table public.sensor_list add column received_at timestamptz;
alter table public.sensor_minute_aggregates add column last_recorded_at timestamptz;
alter table public.sensor_minute_aggregates add column config_version text not null default 'legacy';
alter table public.sensor_minute_aggregates
    drop constraint sensor_minute_aggregates_sensor_bucket_unique;
alter table public.sensor_minute_aggregates add constraint sensor_aggregate_snapshot_unique
    unique(sensor_id, greenhouse_id, bucket_start, phase_type, config_version);
alter table public.monitoring_incidents drop constraint monitoring_incidents_pi_id_unique;
alter table public.monitoring_incidents add column incident_uid uuid unique;
alter table public.monitoring_incidents add column incident_version bigint not null default 0;
alter table public.monitoring_incidents add column triggering_readings jsonb not null default '[]';

create table public.notification_jobs (
    id uuid primary key default gen_random_uuid(),
    incident_uid uuid not null unique references public.monitoring_incidents(incident_uid),
    status text not null default 'pending' check(status in ('pending','processing','accepted','failed')),
    attempts integer not null default 0,
    next_attempt_at timestamptz not null default now(),
    lease_token uuid,
    lease_until timestamptz,
    recipient text,
    detail text,
    updated_at timestamptz not null default now()
);
alter table public.notification_jobs enable row level security;
revoke all on public.notification_jobs from public, anon, authenticated;
grant select on public.notification_jobs to authenticated;
create policy "Managers and admins read notification outcomes" on public.notification_jobs
    for select to authenticated using (exists (
        select 1 from public.profiles where id = auth.uid() and role::text in ('admin','manager')
    ));
create index notification_jobs_due on public.notification_jobs(next_attempt_at) where status in ('pending','processing');

-- Keep the registry and configuration mirror consistent after every assignment.
create function public.mirror_sensor_assignment() returns trigger language plpgsql
security definer set search_path = public as $$
begin
    if TG_OP = 'DELETE' then
        update public.sensor_list set greenhouse_id = null
        where sensor_id = old.sensor_id and greenhouse_id = old.greenhouse_id;
        return old;
    end if;
    insert into public.sensor_list(sensor_id, greenhouse_id, status)
    values(new.sensor_id, new.greenhouse_id, 'offline')
    on conflict(sensor_id) do update set greenhouse_id = excluded.greenhouse_id;
    return new;
end;
$$;
revoke execute on function public.mirror_sensor_assignment() from public, anon, authenticated;
create trigger mirror_sensor_assignment after insert or delete on public.greenhouse_sensors
    for each row execute function public.mirror_sensor_assignment();
update public.sensor_list sl set greenhouse_id = gs.greenhouse_id
from public.greenhouse_sensors gs where gs.sensor_id = sl.sensor_id;
update public.sensor_list sl set greenhouse_id = null
where not exists(select 1 from public.greenhouse_sensors gs where gs.sensor_id = sl.sensor_id);

-- Retire additive legacy ingestion. A signed-in browser cannot forge sensor health.
revoke execute on function public.upsert_minute_aggregate(text,text,timestamptz,text,integer,numeric,numeric,numeric,integer,integer,integer,timestamptz)
    from public, anon, authenticated, service_role;
create or replace function public.update_sensor_list(
    p_sensor_id text, p_lux numeric default null, p_greenhouse_id text default null,
    p_clear_greenhouse boolean default false, p_reading boolean default true
) returns public.sensor_list language plpgsql security definer set search_path = public as $$
declare v_result public.sensor_list;
begin
    if p_reading then raise exception 'Use the idempotent ingestion RPC for readings'; end if;
    if auth.role() is distinct from 'service_role' and not exists(
        select 1 from public.profiles where id = auth.uid() and role::text in ('admin','manager')
    ) then raise exception 'Not authorized'; end if;
    if p_sensor_id is null or trim(p_sensor_id) = '' or
       (p_clear_greenhouse and p_greenhouse_id is not null) then raise exception 'Invalid assignment'; end if;
    if p_greenhouse_id is not null and not exists(
        select 1 from public.greenhouses where id = p_greenhouse_id and is_active
    ) then raise exception 'Active greenhouse required'; end if;
    if p_clear_greenhouse or p_greenhouse_id is not null then
        delete from public.greenhouse_sensors where sensor_id = p_sensor_id;
        if not p_clear_greenhouse then
            insert into public.greenhouse_sensors(greenhouse_id,sensor_id) values(p_greenhouse_id,p_sensor_id);
        end if;
    end if;
    select * into v_result from public.sensor_list where sensor_id = p_sensor_id;
    return v_result;
end;
$$;
revoke execute on function public.update_sensor_list(text,numeric,text,boolean,boolean) from public, anon;

create function public.ingest_pilot_delivery(p_payload jsonb) returns jsonb
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
            opened_at,resolved_at,status,peak_lux,lowest_lux,reason,triggering_readings,updated_at
        ) values((v_incident->>'id')::bigint,(v_incident->>'incident_uid')::uuid,(v_incident->>'version')::bigint,
            v_incident->>'sensor_id',v_incident->>'greenhouse_id',v_incident->>'phase_type',
            (v_incident->>'opened_at')::timestamptz,(v_incident->>'resolved_at')::timestamptz,v_incident->>'status',
            (v_incident->>'peak_lux')::numeric,(v_incident->>'lowest_lux')::numeric,v_incident->>'reason',
            coalesce(v_incident->'triggering_readings','[]'::jsonb),v_recorded)
        on conflict(incident_uid) do update set
            incident_uid=excluded.incident_uid,incident_version=excluded.incident_version,status=excluded.status,
            resolved_at=excluded.resolved_at,peak_lux=excluded.peak_lux,lowest_lux=excluded.lowest_lux,
            triggering_readings=excluded.triggering_readings,updated_at=excluded.updated_at
        where excluded.incident_version > i.incident_version;
        -- Unique per confirmed incident, regardless of retries, phase boundaries,
        -- isolate restarts, acknowledgement, or safe resolution before replay.
        if jsonb_array_length(coalesce(v_incident->'triggering_readings','[]'::jsonb))=3 then
            insert into public.notification_jobs(incident_uid)
            values((v_incident->>'incident_uid')::uuid) on conflict(incident_uid) do nothing;
        end if;
    end if;
    return jsonb_build_object('ok',true,'duplicate',false,'aggregate_updated',v_written);
end;
$$;
revoke execute on function public.ingest_pilot_delivery(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_pilot_delivery(jsonb) to service_role;

create function public.claim_notification_jobs(p_limit integer default 5) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_jobs jsonb;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
    with due as (
        select id from public.notification_jobs
        where attempts < 5 and ((status='pending' and next_attempt_at <= now())
          or (status='processing' and lease_until <= now()))
        order by next_attempt_at for update skip locked limit least(greatest(p_limit,1),20)
    ), claimed as (
        update public.notification_jobs j set status='processing',attempts=attempts+1,
            lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',updated_at=now()
        from due where j.id=due.id returning j.*
    ) select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object('incident',to_jsonb(i))),'[]'::jsonb)
      into v_jobs from claimed c join public.monitoring_incidents i on i.incident_uid=c.incident_uid;
    update public.notification_jobs set status='failed',detail='Delivery lease expired after final attempt',updated_at=now()
    where status='processing' and attempts >= 5 and lease_until <= now();
    return v_jobs;
end;
$$;
create function public.finish_notification_job(p_id uuid,p_lease_token uuid,p_accepted boolean,p_detail text,p_recipient text)
returns void language plpgsql security definer set search_path = public as $$
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
    update public.notification_jobs set
        status=case when p_accepted then 'accepted' when attempts >= 5 then 'failed' else 'pending' end,
        next_attempt_at=now()+make_interval(secs => least(3600,30*power(2,attempts)::integer)),
        detail=left(p_detail,500),recipient=p_recipient,lease_until=null,lease_token=null,updated_at=now()
    where id=p_id and lease_token=p_lease_token and status='processing';
end;
$$;
revoke execute on function public.claim_notification_jobs(integer) from public, anon, authenticated;
revoke execute on function public.finish_notification_job(uuid,uuid,boolean,text,text) from public, anon, authenticated;
grant execute on function public.claim_notification_jobs(integer) to service_role;
grant execute on function public.finish_notification_job(uuid,uuid,boolean,text,text) to service_role;

grant all on public.ingestion_receipts, public.notification_jobs to service_role;

-- Restoring a snapshot must never silently steal a sensor from another site.
create function public.restore_greenhouse(p_recycle_id bigint) returns public.greenhouses
language plpgsql security definer set search_path = public as $$
declare v_entry public.greenhouse_recycle_bin; v_sensors text[]; v_result public.greenhouses;
begin
    if not exists(select 1 from public.profiles where id=auth.uid() and role::text in ('admin','manager')) then raise exception 'Not authorized'; end if;
    -- Serialize configuration/assignment operations while checking collisions.
    lock table public.greenhouse_sensors in share row exclusive mode;
    select * into v_entry from public.greenhouse_recycle_bin where id=p_recycle_id for update;
    if not found then raise exception 'Recycle bin entry not found'; end if;
    if exists(select 1 from public.greenhouses where id=v_entry.greenhouse_id) then raise exception 'Greenhouse already exists'; end if;
    select array_agg(value) into v_sensors from jsonb_array_elements_text(v_entry.config->'sensor_ids');
    if exists(select 1 from public.greenhouse_sensors where sensor_id=any(v_sensors)) then
        raise exception 'A saved sensor is assigned elsewhere; release it before restoring';
    end if;
    v_result := public.upsert_greenhouse(v_entry.greenhouse_id,v_entry.name,v_sensors,
        (v_entry.config->>'phase_start')::date,(v_entry.config->>'phase_end')::date,
        (v_entry.config->>'window_start')::time,(v_entry.config->>'window_end')::time);
    delete from public.greenhouse_recycle_bin where id=p_recycle_id;
    return v_result;
end;
$$;
revoke execute on function public.restore_greenhouse(bigint) from public,anon;
grant execute on function public.restore_greenhouse(bigint) to authenticated;

-- Public operational policy contains no credentials or personal information.
create function public.monitoring_policy() returns jsonb language sql stable
security definer set search_path = public as $$
    select jsonb_build_object('dark_phase_days',coalesce((select value::integer from public.system_settings where key='dark_phase_duration_days'),60),
        'offline_threshold_seconds',coalesce((select value::integer from public.system_settings where key='sensor_offline_threshold_seconds'),15));
$$;
revoke execute on function public.monitoring_policy() from public;
grant execute on function public.monitoring_policy() to anon,authenticated,service_role;

-- Role changes are backend-admin operations. The legacy own-profile policy
-- must never allow a manager to promote themselves with a direct table update.
revoke update on public.profiles from authenticated;
grant update(full_name) on public.profiles to authenticated;
revoke insert,update,delete on public.sensor_list from authenticated;

grant select on public.sensor_minute_aggregates,public.monitoring_incidents to anon;
create policy "Public monitor reads aggregate history" on public.sensor_minute_aggregates for select to anon using(true);
create policy "Public monitor reads incident history" on public.monitoring_incidents for select to anon using(true);

create function public.retry_notification(p_incident_uid uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
    if not exists(select 1 from public.profiles where id=auth.uid() and role::text in ('admin','manager')) then raise exception 'Not authorized'; end if;
    update public.notification_jobs set status='pending',attempts=0,next_attempt_at=now(),detail='Retry requested by operator',updated_at=now()
    where incident_uid=p_incident_uid and status='failed';
    if not found then raise exception 'Only failed notifications may be retried'; end if;
end;
$$;
revoke execute on function public.retry_notification(uuid) from public,anon;
grant execute on function public.retry_notification(uuid) to authenticated;
