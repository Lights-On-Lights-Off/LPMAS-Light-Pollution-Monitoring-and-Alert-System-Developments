-- Opt-in local SMS ownership. Default preserves existing cloud behavior.
begin;
insert into public.system_settings(key,value) values ('sms_dispatch_mode','cloud') on conflict do nothing;
create function public.local_sms_mode() returns boolean
language sql stable security definer set search_path=public as $$
select coalesce((select value from public.system_settings where key='sms_dispatch_mode'),'cloud')='local';
$$;
revoke all on function public.local_sms_mode() from public,anon,authenticated;
grant execute on function public.local_sms_mode() to service_role;

create function lpmas_private.sms_ownership_changed() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.key <> 'sms_dispatch_mode' then return new; end if;
  if new.value not in ('cloud','local') then raise exception 'Choose cloud or local SMS dispatch'; end if;
  perform pg_advisory_xact_lock(190022);
  if tg_op='UPDATE' and new.value=old.value then return new; end if;
  if new.value='local' then
    -- No recovery notification for ownership cutover, and no historical replay.
    update public.greenhouse_alerts set status='closed',resolved_at=greatest(now(),opened_at),version=version+1
      where producer='cloud' and status='open';
    update public.greenhouse_notification_jobs set status='skipped',detail='Retired at local SMS cutover',updated_at=now()
      where attempts=0 and status='pending';
    update lpmas_private.cloud_sensor_state set context=null,violations=0,safes=0;
  end if;
  return new;
end;
$$;
create trigger sms_ownership_changed before insert or update on public.system_settings
for each row execute function lpmas_private.sms_ownership_changed();

-- Gate the cloud trigger at entry. The advisory lock serializes ownership cutover.
do $$
declare definition text;
begin
  definition := pg_get_functiondef('lpmas_private.process_cloud_reading()'::regprocedure);
  if position('    if p->>''kind'' <> ''reading'' then return new; end if;' in definition)=0 then
    raise exception 'Cloud trigger contract changed; review local cutover';
  end if;
  definition := replace(definition, '    if p->>''kind'' <> ''reading'' then return new; end if;',
    '    perform pg_advisory_xact_lock(190022); if public.local_sms_mode() then return new; end if;
    if p->>''kind'' <> ''reading'' then return new; end if;');
  execute definition;
end;
$$;

-- Gate new SMS jobs in addition to gating claims (defense against other producers).
create function lpmas_private.local_sms_job_guard() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  perform pg_advisory_xact_lock(190022);
  if public.local_sms_mode() and new.channel='sms' then
    new.status:='skipped'; new.detail:='SMS is owned by the local Pi';
  end if;
  return new;
end;
$$;
create trigger local_sms_job_guard before insert on public.greenhouse_notification_jobs
for each row execute function lpmas_private.local_sms_job_guard();

-- Keep the trusted Pi configuration scoped; phone credentials remain on the Pi.
alter function public.pi_configuration() rename to pi_configuration_without_sms;
revoke all on function public.pi_configuration_without_sms() from public,anon,authenticated,service_role;
create function public.pi_configuration() returns jsonb
language sql stable security definer set search_path=public as $$
select public.pi_configuration_without_sms() || jsonb_build_object('timezone','Asia/Manila',
  'local_sms',jsonb_build_object('mode',coalesce((select value from public.system_settings where key='sms_dispatch_mode'),'cloud'),
    'enabled',coalesce((select value from public.system_settings where key='greenhouse_notifications_enabled'),'false')='true',
    'recipient',coalesce((select value from public.system_settings where key='manager_phone'),'')));
$$;
revoke all on function public.pi_configuration() from public,anon,authenticated;
grant execute on function public.pi_configuration() to service_role;
create or replace function public.record_greenhouse_alert(p_incident jsonb) returns void
language plpgsql security definer set search_path=public as $$
declare
    a jsonb := p_incident->'greenhouse_alert';
    uid uuid := (a->>'incident_uid')::uuid;
    event_name text;
    message_body text;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
    perform pg_advisory_xact_lock(190022);
    if not public.local_sms_mode() then return; end if;
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
    if (case when a->>'status'='open' then (a->>'opened_at')::timestamptz else (a->>'resolved_at')::timestamptz end) < now()-interval '60 seconds' then return; end if;
    if a->>'status'='open' and not coalesce((a->>'legacy')::boolean,false) then event_name := 'opened';
    elsif a->>'status'='resolved' then event_name := 'recovered';
    else return; end if;
    message_body := 'LPMAS ' || case when event_name='opened' then 'ALERT' else 'RESOLVED' end || ': Greenhouse ' || left(regexp_replace(a->>'greenhouse_id','[^ -~]','?','g'),24) ||
      case when event_name='opened' then ' has a confirmed light violation.' else ' has returned to safe light levels.' end || ' Incident ' || left(uid::text,12) || '.';
    insert into public.greenhouse_notification_jobs(greenhouse_alert_uid,event,channel,message)
    select uid,event_name,c,message_body from unnest(array['email']) c
    on conflict(greenhouse_alert_uid,event,channel,send_number) do nothing;
end;
$$;
revoke all on function public.record_greenhouse_alert(jsonb) from public,anon,authenticated;
grant execute on function public.record_greenhouse_alert(jsonb) to service_role;


create or replace function public.claim_greenhouse_notifications(p_limit integer default 5) returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
  perform pg_advisory_xact_lock(190022);
  perform lpmas_private.reconcile_cloud_episodes();
  update public.greenhouse_notification_jobs set status='skipped',detail='SMS is owned by the local Pi',updated_at=now()
    where public.local_sms_mode() and channel='sms' and status='pending' and attempts=0;
  update public.greenhouse_notification_jobs j set status='skipped',detail='Notification expired before sending',updated_at=now()
    from public.greenhouse_alerts g where g.incident_uid=j.greenhouse_alert_uid and j.status='pending' and j.attempts=0
    and j.available_at < now()-case when g.producer='cloud' then interval '15 seconds' else interval '60 seconds' end;
  return public.claim_greenhouse_notifications_unreconciled(p_limit);
end;
$$;

create table public.local_sms_outcomes (
  id uuid primary key, greenhouse_alert_uid uuid not null references public.greenhouse_alerts(incident_uid),
  event text not null check(event in ('opened','recovered')), send_number integer not null check(send_number between 1 and 3),
  recipient text not null, message text not null, status text not null check(status in ('pending','unknown','accepted','sent','delivered','failed','skipped')),
  attempts integer not null check(attempts between 0 and 1), attempted_at timestamptz, detail text,
  version bigint not null check(version>0), created_at timestamptz not null,
  unique(greenhouse_alert_uid,event,send_number)
);
alter table public.local_sms_outcomes enable row level security;
revoke all on public.local_sms_outcomes from public,anon,authenticated;
grant all on public.local_sms_outcomes to service_role;
grant select on public.local_sms_outcomes to authenticated;
create policy "Operators read local SMS outcomes" on public.local_sms_outcomes for select to authenticated
using(exists(select 1 from public.profiles where id=auth.uid() and role::text in ('admin','manager')));
create function public.record_local_sms_outcome(p_outcome jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
  if not exists(select 1 from public.greenhouse_alerts where incident_uid=(p_outcome->>'episode_uid')::uuid and producer='pi') then
    raise exception 'Local episode must arrive before its outcomes';
  end if;
  if p_outcome->>'recipient' !~ '^\+639[0-9]{9}$' or length(p_outcome->>'message')>160
    or (p_outcome->>'event'='recovered' and (p_outcome->>'send_number')::integer<>1) then raise exception 'Invalid local SMS outcome'; end if;
  insert into public.local_sms_outcomes as o(id,greenhouse_alert_uid,event,send_number,recipient,message,status,attempts,attempted_at,detail,version,created_at)
  values((p_outcome->>'id')::uuid,(p_outcome->>'episode_uid')::uuid,p_outcome->>'event',(p_outcome->>'send_number')::integer,
    p_outcome->>'recipient',p_outcome->>'message',p_outcome->>'status',(p_outcome->>'attempts')::integer,
    to_timestamp((p_outcome->>'attempted_at')::double precision),left(p_outcome->>'detail',500),(p_outcome->>'version')::bigint,
    to_timestamp((p_outcome->>'created_at')::double precision))
  on conflict(id) do update set status=excluded.status,attempts=excluded.attempts,attempted_at=excluded.attempted_at,detail=excluded.detail,version=excluded.version
  where excluded.version>o.version and excluded.greenhouse_alert_uid=o.greenhouse_alert_uid and excluded.event=o.event
    and excluded.send_number=o.send_number and excluded.recipient=o.recipient and excluded.message=o.message;
  return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.record_local_sms_outcome(jsonb) from public,anon,authenticated;
grant execute on function public.record_local_sms_outcome(jsonb) to service_role;
revoke all on all functions in schema lpmas_private from public,anon,authenticated,service_role;
commit;
