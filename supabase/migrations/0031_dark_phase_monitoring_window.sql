-- Dark monitoring has its own daily window. Existing greenhouses remain all-day.
alter table public.greenhouses
    add column dark_window_start time not null default '00:00',
    add column dark_window_end time not null default '23:59';

-- Replace the seven-argument RPC with defaulted extra arguments so old clients
-- continue to work and preserve an existing dark schedule when saving.
drop function public.upsert_greenhouse(text,text,text[],date,date,time,time);
create or replace function public.upsert_greenhouse(
    p_id text,
    p_name text,
    p_sensor_ids text[],
    p_phase_start date,
    p_phase_end date,
    p_window_start time,
    p_window_end time,
    p_dark_window_start time default null,
    p_dark_window_end time default null
)
returns public.greenhouses
language plpgsql
security definer
set search_path = public
as $$
declare
    v_role text;
    v_result public.greenhouses;
begin
    select p.role::text into v_role from public.profiles p where p.id = auth.uid();

    if v_role is null or v_role not in ('admin', 'manager') then
        raise exception 'Not authorized to manage greenhouses';
    end if;

    if p_id is null or length(trim(p_id)) = 0 then
        raise exception 'Greenhouse id is required';
    end if;

    if p_name is null or length(trim(p_name)) = 0 then
        raise exception 'Greenhouse name is required';
    end if;

    if p_sensor_ids is null or array_length(p_sensor_ids, 1) is null then
        raise exception 'At least one sensor is required';
    end if;

    insert into public.greenhouses (
        id, name, phase_start, phase_end, window_start, window_end, dark_window_start, dark_window_end, is_active, updated_at, updated_by
    )
    values (
        p_id, p_name, p_phase_start, p_phase_end, p_window_start, p_window_end,
        coalesce(p_dark_window_start,(select dark_window_start from public.greenhouses where id=p_id),'00:00'::time),
        coalesce(p_dark_window_end,(select dark_window_end from public.greenhouses where id=p_id),'23:59'::time),
        true, now(), auth.uid()
    )
    on conflict (id) do update set
        name = excluded.name,
        phase_start = excluded.phase_start,
        phase_end = excluded.phase_end,
        window_start = excluded.window_start,
        window_end = excluded.window_end,
        dark_window_start = excluded.dark_window_start,
        dark_window_end = excluded.dark_window_end,
        is_active = true,
        updated_at = now(),
        updated_by = auth.uid()
    returning * into v_result;

    -- A sensor belongs to at most one greenhouse at a time.
    delete from public.greenhouse_sensors
    where sensor_id = any(p_sensor_ids) and greenhouse_id != p_id;

    delete from public.greenhouse_sensors where greenhouse_id = p_id;

    insert into public.greenhouse_sensors (greenhouse_id, sensor_id)
    select p_id, s from unnest(p_sensor_ids) as s;

    return v_result;
end;
$$;

grant execute on function public.upsert_greenhouse(text, text, text[], date, date, time, time, time, time) to authenticated;

revoke all on function public.upsert_greenhouse(text,text,text[],date,date,time,time,time,time) from public,anon;

create or replace function public.delete_greenhouse(p_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_role text;
    v_row public.greenhouses;
    v_sensor_ids text[];
begin
    select p.role::text into v_role from public.profiles p where p.id = auth.uid();

    if v_role is null or v_role not in ('admin', 'manager') then
        raise exception 'Not authorized to manage greenhouses';
    end if;

    select * into v_row from public.greenhouses where id = p_id;

    if not found then
        raise exception 'Greenhouse not found';
    end if;

    select coalesce(array_agg(sensor_id), '{}') into v_sensor_ids
    from public.greenhouse_sensors where greenhouse_id = p_id;

    insert into public.greenhouse_recycle_bin (greenhouse_id, name, config, deleted_by)
    values (
        v_row.id,
        v_row.name,
        jsonb_build_object(
            'phase_start', v_row.phase_start,
            'phase_end', v_row.phase_end,
            'window_start', v_row.window_start,
            'window_end', v_row.window_end,
            'dark_window_start', v_row.dark_window_start,
            'dark_window_end', v_row.dark_window_end,
            'sensor_ids', to_jsonb(v_sensor_ids)
        ),
        auth.uid()
    );

    delete from public.greenhouse_sensors where greenhouse_id = p_id;
    delete from public.greenhouses where id = p_id;
end;
$$;

create or replace function public.restore_greenhouse(p_recycle_id bigint) returns public.greenhouses
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
        (v_entry.config->>'window_start')::time,(v_entry.config->>'window_end')::time,
        coalesce((v_entry.config->>'dark_window_start')::time,'00:00'::time),
        coalesce((v_entry.config->>'dark_window_end')::time,'23:59'::time));
    delete from public.greenhouse_recycle_bin where id=p_recycle_id;
    return v_result;
end;
$$;
revoke execute on function public.restore_greenhouse(bigint) from public,anon;
grant execute on function public.restore_greenhouse(bigint) to authenticated;


create or replace function public.pi_configuration_without_sms() returns jsonb
language sql stable security definer set search_path=public as $$
select jsonb_build_object(
    'greenhouses', coalesce((select jsonb_agg(jsonb_build_object(
        'id',id,'name',name,'phase_start',phase_start,'phase_end',phase_end,
        'window_start',window_start,'window_end',window_end,
        'dark_window_start',dark_window_start,'dark_window_end',dark_window_end,'is_active',is_active,'updated_at',updated_at
    )) from public.greenhouses where is_active),'[]'::jsonb),
    'greenhouse_sensors', coalesce((select jsonb_agg(jsonb_build_object('greenhouse_id',s.greenhouse_id,'sensor_id',s.sensor_id))
        from public.greenhouse_sensors s join public.greenhouses g on g.id=s.greenhouse_id where g.is_active),'[]'::jsonb),
    'sensor_list', coalesce((select jsonb_agg(jsonb_build_object('sensor_id',sensor_id)) from public.sensor_list),'[]'::jsonb),
    'dark_phase_days',coalesce((select value::integer from public.system_settings where key='dark_phase_duration_days'),60)
);
$$;
revoke execute on function public.pi_configuration_without_sms() from public,anon,authenticated;
revoke all on function public.pi_configuration_without_sms() from service_role;


create or replace function lpmas_private.monitoring_context(p_sensor text,p_at timestamptz) returns jsonb
language plpgsql stable set search_path=public,extensions as $$
declare
    g public.greenhouses%rowtype;
    local_at timestamp := p_at at time zone 'Asia/Manila';
    local_day date := local_at::date;
    minute_time time := date_trunc('minute',local_at)::time;
    phase text;
    session text;
    days integer := coalesce((select value::integer from public.system_settings where key='dark_phase_duration_days'),60);
    fingerprint text;
    start_time time;
    end_time time;
begin
    select h.* into g from public.greenhouses h join public.greenhouse_sensors s on s.greenhouse_id=h.id
    where s.sensor_id=p_sensor and h.is_active;
    if not found then return null; end if;
    if local_day between g.phase_start and g.phase_end then
        phase := 'illumination'; start_time := g.window_start; end_time := g.window_end;
    elsif local_day > g.phase_end and local_day <= g.phase_end+days then
        phase := 'dark'; start_time := g.dark_window_start; end_time := g.dark_window_end;
    else return null; end if;
    if not (case when start_time <= end_time then minute_time between start_time and end_time
                else minute_time >= start_time or minute_time <= end_time end) then return null; end if;
    session := case when start_time='00:00'::time and end_time='23:59'::time
                    then case when phase='dark' then 'dark' else 'continuous' end
                else (local_day - case when start_time > end_time and minute_time <= end_time then 1 else 0 end)::text end;
    -- Match the unchanged Pi's hashlib.sha256(json.dumps(config,sort_keys=True)).
    -- Greenhouse identifiers are ASCII UUIDs; JSON text retains Python's spaces.
    fingerprint := encode(digest(convert_to(format('{"dark_phase_days": %s, "id": %s, "phase_end": %s, "phase_start": %s, "window_end": %s, "window_start": %s}',
        days,to_json(g.id)::text,to_json(g.phase_end::text)::text,to_json(g.phase_start::text)::text,
        to_json(to_char(g.window_end,'HH24:MI'))::text,to_json(to_char(g.window_start,'HH24:MI'))::text),'UTF8'),'sha256'),'hex');
    -- Preserve the legacy fingerprint for unchanged all-day dark monitoring.
    if g.dark_window_start <> '00:00'::time or g.dark_window_end <> '23:59'::time then
        fingerprint := encode(digest(convert_to(format('{"dark_phase_days": %s, "dark_window_end": %s, "dark_window_start": %s, "id": %s, "phase_end": %s, "phase_start": %s, "window_end": %s, "window_start": %s}',
            days,to_json(to_char(g.dark_window_end,'HH24:MI'))::text,to_json(to_char(g.dark_window_start,'HH24:MI'))::text,
            to_json(g.id)::text,to_json(g.phase_end::text)::text,to_json(g.phase_start::text)::text,
            to_json(to_char(g.window_end,'HH24:MI'))::text,to_json(to_char(g.window_start,'HH24:MI'))::text),'UTF8'),'sha256'),'hex');
    end if;
    return jsonb_build_object('greenhouse_id',g.id,'phase_type',phase,'config_version',fingerprint,'session',session);
end;
$$;

create or replace function lpmas_private.cloud_context_changed() returns trigger
language plpgsql security definer set search_path=public as $$
begin
    perform pg_advisory_xact_lock(190022);
    if tg_table_name='greenhouse_sensors' then
        update lpmas_private.cloud_sensor_state set context=null,violations=0,safes=0
        where sensor_id in (case when tg_op <> 'DELETE' then new.sensor_id end,case when tg_op <> 'INSERT' then old.sensor_id end);
    elsif tg_table_name='greenhouses' then
        if tg_op='UPDATE' and (new.phase_start,new.phase_end,new.window_start,new.window_end,new.dark_window_start,new.dark_window_end,new.is_active)
          is not distinct from (old.phase_start,old.phase_end,old.window_start,old.window_end,old.dark_window_start,old.dark_window_end,old.is_active) then return null; end if;
        update lpmas_private.cloud_sensor_state set context=null,violations=0,safes=0
        where context->>'greenhouse_id'=case when tg_op='DELETE' then old.id else new.id end;
    elsif tg_table_name='system_settings' then
        if (case when tg_op='DELETE' then old.key else new.key end) <> 'dark_phase_duration_days' then return null; end if;
        if tg_op='UPDATE' and new.value=old.value then return null; end if;
        update lpmas_private.cloud_sensor_state set context=null,violations=0,safes=0 where context is not null;
    end if;
    -- Close all affected episodes when any member's candidates were reset.
    perform lpmas_private.close_cloud_episode(g.incident_uid,'closed',now())
    from public.greenhouse_alerts g where g.producer='cloud' and g.status='open' and exists(
      select 1 from lpmas_private.cloud_episode_members m join lpmas_private.cloud_sensor_state s on s.sensor_id=m.sensor_id
      where m.episode_uid=g.incident_uid and s.context is null);
    perform lpmas_private.reconcile_cloud_episodes();
    return null;
end;
$$;
-- Configuration RPC defaults do not grant access to internal episode functions.
revoke all on function lpmas_private.monitoring_context(text,timestamptz),
    lpmas_private.cloud_context_changed() from public,anon,authenticated,service_role;
notify pgrst, 'reload schema';
