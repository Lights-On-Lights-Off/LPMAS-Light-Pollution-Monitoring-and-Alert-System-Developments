-- Manager observations are distinct from the automatically detected reason.
-- Optional for historical deliveries; version checks prevent stale replays from changing notes.
alter table public.monitoring_incidents add column description text
    check (description is null or char_length(btrim(description)) between 1 and 2000);
comment on column public.monitoring_incidents.description is
    'Manager-provided explanation captured when acknowledging a sensor incident.';

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
        if v_incident->'description' is not null and v_incident->'description' <> 'null'::jsonb and (
            jsonb_typeof(v_incident->'description') <> 'string' or
            char_length(btrim(v_incident->>'description')) not between 1 and 2000
        ) then raise exception 'Invalid incident description'; end if;
        -- Attach a UUID to an existing legacy incident without creating a second
        -- historical row. Modern identities never depend on SQLite's integer ID.
        update public.monitoring_incidents set incident_uid=(v_incident->>'incident_uid')::uuid
        where pi_incident_id=(v_incident->>'id')::bigint and incident_uid is null;
        insert into public.monitoring_incidents as i(
            pi_incident_id,incident_uid,incident_version,sensor_id,greenhouse_id,phase_type,
            opened_at,resolved_at,status,peak_lux,lowest_lux,reason,description,triggering_readings,config_version,resolution_reason,updated_at
        ) values((v_incident->>'id')::bigint,(v_incident->>'incident_uid')::uuid,(v_incident->>'version')::bigint,
            v_incident->>'sensor_id',v_incident->>'greenhouse_id',v_incident->>'phase_type',
            (v_incident->>'opened_at')::timestamptz,(v_incident->>'resolved_at')::timestamptz,v_incident->>'status',
            (v_incident->>'peak_lux')::numeric,(v_incident->>'lowest_lux')::numeric,v_incident->>'reason',nullif(btrim(v_incident->>'description'),''),
            coalesce(v_incident->'triggering_readings','[]'::jsonb),v_incident->>'config_version',v_incident->>'resolution_reason',v_recorded)
        on conflict(incident_uid) do update set
            incident_uid=excluded.incident_uid,incident_version=excluded.incident_version,status=excluded.status,
            resolved_at=excluded.resolved_at,peak_lux=excluded.peak_lux,lowest_lux=excluded.lowest_lux,
            triggering_readings=excluded.triggering_readings,config_version=coalesce(excluded.config_version,i.config_version),
            description=coalesce(excluded.description,i.description),
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
