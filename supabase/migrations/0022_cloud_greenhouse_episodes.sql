-- Supabase owns greenhouse alert episodes. Existing Pi deliveries stay unchanged.
-- Keep sending disabled until contacts, OAuth consent and delivery QA are ready.
update public.system_settings set value='false' where key='greenhouse_notifications_enabled';
alter table public.greenhouse_alerts add column producer text not null default 'pi';
create unique index one_open_cloud_greenhouse_episode on public.greenhouse_alerts(greenhouse_id)
where status='open' and producer='cloud';

create table lpmas_private.cloud_sensor_state (
    sensor_id text primary key,
    last_recorded_at timestamptz not null,
    context jsonb,
    violations integer not null default 0,
    safes integer not null default 0,
    classification text
);
create table lpmas_private.cloud_episode_members (
    episode_uid uuid not null references public.greenhouse_alerts(incident_uid),
    sensor_id text not null,
    context jsonb not null,
    primary key(episode_uid,sensor_id)
);
revoke all on lpmas_private.cloud_sensor_state,lpmas_private.cloud_episode_members from public,anon,authenticated,service_role;
-- Do not replay historical readings into new opening alerts at cutover.
insert into lpmas_private.cloud_sensor_state(sensor_id,last_recorded_at)
select sensor_id,coalesce(recorded_at,'-infinity') from public.sensor_list;

create function lpmas_private.monitoring_context(p_sensor text,p_at timestamptz) returns jsonb
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
begin
    select h.* into g from public.greenhouses h join public.greenhouse_sensors s on s.greenhouse_id=h.id
    where s.sensor_id=p_sensor and h.is_active;
    if not found then return null; end if;
    if local_day between g.phase_start and g.phase_end then
        phase := 'illumination';
        if not (case when g.window_start <= g.window_end then minute_time between g.window_start and g.window_end
                    else minute_time >= g.window_start or minute_time <= g.window_end end) then return null; end if;
        session := case when g.window_start='00:00'::time and g.window_end='23:59'::time then 'continuous'
                   else (local_day - case when g.window_start > g.window_end and minute_time <= g.window_end then 1 else 0 end)::text end;
    elsif local_day > g.phase_end and local_day <= g.phase_end+days then
        phase := 'dark'; session := 'dark';
    else return null; end if;
    -- Match the unchanged Pi's hashlib.sha256(json.dumps(config,sort_keys=True)).
    -- Greenhouse identifiers are ASCII UUIDs; JSON text retains Python's spaces.
    fingerprint := encode(digest(convert_to(format('{"dark_phase_days": %s, "id": %s, "phase_end": %s, "phase_start": %s, "window_end": %s, "window_start": %s}',
        days,to_json(g.id)::text,to_json(g.phase_end::text)::text,to_json(g.phase_start::text)::text,
        to_json(to_char(g.window_end,'HH24:MI'))::text,to_json(to_char(g.window_start,'HH24:MI'))::text),'UTF8'),'sha256'),'hex');
    return jsonb_build_object('greenhouse_id',g.id,'phase_type',phase,'config_version',fingerprint,'session',session);
end;
$$;

create function lpmas_private.close_cloud_episode(p_uid uuid,p_status text,p_at timestamptz) returns void
language plpgsql set search_path=public as $$
declare g public.greenhouse_alerts%rowtype;
begin
    update public.greenhouse_alerts set status=p_status,resolved_at=greatest(p_at,opened_at),version=version+1
    where incident_uid=p_uid and status='open' and producer='cloud' returning * into g;
    if not found then return; end if;
    update public.greenhouse_notification_jobs set status='skipped',detail='Opening superseded by greenhouse closure',updated_at=now()
    where greenhouse_alert_uid=p_uid and event='opened' and attempts=0 and status='pending';
    if p_status='resolved' then
        insert into public.greenhouse_notification_jobs(greenhouse_alert_uid,event,channel,message)
        select p_uid,'recovered',c,'LPMAS RESOLVED: Greenhouse ' || left(regexp_replace(g.greenhouse_id,'[^ -~]','?','g'),24) ||
          ' has returned to safe light levels. Incident ' || left(p_uid::text,12) || '.'
        from unnest(array['sms','email']) c on conflict do nothing;
    end if;
end;
$$;

create function lpmas_private.reconcile_cloud_episodes() returns void
language plpgsql set search_path=public as $$
declare uid uuid;
begin
    perform pg_advisory_xact_lock(190022);
    for uid in select g.incident_uid from public.greenhouse_alerts g
      where g.status='open' and g.producer='cloud' and exists(
        select 1 from lpmas_private.cloud_episode_members m where m.episode_uid=g.incident_uid
        and lpmas_private.monitoring_context(m.sensor_id,now()) is distinct from m.context)
    loop perform lpmas_private.close_cloud_episode(uid,'closed',now()); end loop;
end;
$$;

create function lpmas_private.process_cloud_reading() returns trigger
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
          else case when (p->>'lux')::numeric <= 30 then 'violation' when (p->>'lux')::numeric < 50 then 'warning' else 'safe' end end)
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
              ' has a confirmed light violation. Incident ' || left(uid::text,12) || '.' from unnest(array['sms','email']) c;
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
create trigger cloud_episode_reading after insert on public.ingestion_receipts
for each row execute function lpmas_private.process_cloud_reading();

-- Configuration/assignment changes invalidate candidates immediately, even if
-- a sensor is removed and then re-added before its next sample.
create function lpmas_private.cloud_context_changed() returns trigger
language plpgsql security definer set search_path=public as $$
begin
    perform pg_advisory_xact_lock(190022);
    if tg_table_name='greenhouse_sensors' then
        update lpmas_private.cloud_sensor_state set context=null,violations=0,safes=0
        where sensor_id in (case when tg_op <> 'DELETE' then new.sensor_id end,case when tg_op <> 'INSERT' then old.sensor_id end);
    elsif tg_table_name='greenhouses' then
        if tg_op='UPDATE' and (new.phase_start,new.phase_end,new.window_start,new.window_end,new.is_active)
          is not distinct from (old.phase_start,old.phase_end,old.window_start,old.window_end,old.is_active) then return null; end if;
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
create trigger cloud_assignment_changed after insert or update or delete on public.greenhouse_sensors for each row execute function lpmas_private.cloud_context_changed();
create trigger cloud_greenhouse_changed after insert or update or delete on public.greenhouses for each row execute function lpmas_private.cloud_context_changed();
create trigger cloud_policy_changed after insert or update or delete on public.system_settings for each row execute function lpmas_private.cloud_context_changed();

-- Preserve old incident history but ignore Pi episode snapshots: the cloud is
-- the only episode producer from this release onward.
create or replace function public.record_greenhouse_alert(p_incident jsonb) returns void
language plpgsql security definer set search_path=public as $$
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
end;
$$;

-- Existing open sensor reports become legacy members, without opening alerts.
do $$
declare member record; ctx jsonb; uid uuid;
begin
    for member in select * from public.monitoring_incidents where status in ('open','acknowledged') order by opened_at loop
        ctx := lpmas_private.monitoring_context(member.sensor_id,now());
        if ctx is null or ctx->>'greenhouse_id' <> member.greenhouse_id or ctx->>'phase_type' <> member.phase_type then continue; end if;
        select incident_uid into uid from public.greenhouse_alerts where greenhouse_id=member.greenhouse_id and status='open' and producer='cloud';
        if uid is null then
            uid := gen_random_uuid();
            insert into public.greenhouse_alerts(incident_uid,greenhouse_id,opened_at,status,version,legacy,producer)
            values(uid,member.greenhouse_id,now(),'open',1,true,'cloud');
        end if;
        insert into lpmas_private.cloud_episode_members(episode_uid,sensor_id,context) values(uid,member.sensor_id,ctx) on conflict do nothing;
        update lpmas_private.cloud_sensor_state set context=ctx where sensor_id=member.sensor_id;
    end loop;
end;
$$;

-- Reconcile expired windows during the unchanged Pi worker tick, before claims.
alter function public.claim_greenhouse_notifications(integer) rename to claim_greenhouse_notifications_unreconciled;
revoke all on function public.claim_greenhouse_notifications_unreconciled(integer) from public,anon,authenticated,service_role;
create function public.claim_greenhouse_notifications(p_limit integer default 5) returns jsonb
language plpgsql security definer set search_path=public as $$
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
    perform lpmas_private.reconcile_cloud_episodes();
    -- Do not send an opening/recovery backlog when sending is later enabled.
    update public.greenhouse_notification_jobs j set status='skipped',detail='Cloud notification expired before sending',updated_at=now()
    from public.greenhouse_alerts g where g.incident_uid=j.greenhouse_alert_uid and g.producer='cloud'
      and j.status='pending' and j.attempts=0 and j.created_at < now()-interval '15 seconds';
    return public.claim_greenhouse_notifications_unreconciled(p_limit);
end;
$$;
revoke all on function public.claim_greenhouse_notifications(integer) from public,anon,authenticated;
grant execute on function public.claim_greenhouse_notifications(integer) to service_role;
revoke all on all functions in schema lpmas_private from public,anon,authenticated,service_role;
