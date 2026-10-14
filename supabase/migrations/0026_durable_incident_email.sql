-- Email is a durable lifecycle record, independent of SMS freshness/ownership.
-- Applies to future episode writes; do not resend previously consumed attempts.
begin;
alter table public.greenhouse_notification_jobs drop constraint greenhouse_notification_jobs_event_check;
alter table public.greenhouse_notification_jobs add constraint greenhouse_notification_jobs_event_check
  check(event in ('opened','recovered','closed'));

create function lpmas_private.queue_episode_email() returns trigger
language plpgsql security definer set search_path=public as $$
declare event_name text; label text;
begin
  label := left(regexp_replace(new.greenhouse_id,'[^ -~]','?','g'),24);
  -- A terminal snapshot may be the first one received after an outage.
  -- Preserve the opening as history as well as its eventual ending.
  if not new.legacy then
    insert into public.greenhouse_notification_jobs(greenhouse_alert_uid,event,channel,message)
    values(new.incident_uid,'opened','email','LPMAS ALERT: Greenhouse ' || label ||
      ' recorded a confirmed light violation at ' || new.opened_at::text ||
      '. Incident ' || new.incident_uid::text || '. This notice may arrive after the incident has ended.')
    on conflict(greenhouse_alert_uid,event,channel,send_number) do nothing;
  end if;
  if new.status in ('resolved','closed') then
    event_name := case when new.status='resolved' then 'recovered' else 'closed' end;
    insert into public.greenhouse_notification_jobs(greenhouse_alert_uid,event,channel,message)
    values(new.incident_uid,event_name,'email','LPMAS ' || case when new.status='resolved' then 'RESOLVED' else 'CLOSED' end ||
      ': Greenhouse ' || label || case when new.status='resolved' then ' returned to safe light levels at '
        else ' monitoring incident closed without confirmed safe recovery at ' end || new.resolved_at::text ||
      '. Incident ' || new.incident_uid::text || '.')
    on conflict(greenhouse_alert_uid,event,channel,send_number) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function lpmas_private.queue_episode_email() from public,anon,authenticated,service_role;
create trigger queue_episode_email after insert or update on public.greenhouse_alerts
for each row execute function lpmas_private.queue_episode_email();


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

create or replace function lpmas_private.close_cloud_episode(p_uid uuid,p_status text,p_at timestamptz) returns void
language plpgsql set search_path=public as $$
declare g public.greenhouse_alerts%rowtype;
begin
    update public.greenhouse_alerts set status=p_status,resolved_at=greatest(p_at,opened_at),version=version+1
    where incident_uid=p_uid and status='open' and producer='cloud' returning * into g;
    if not found then return; end if;
    update public.greenhouse_notification_jobs set status='skipped',detail='Opening superseded by greenhouse closure',updated_at=now()
    where channel='sms' and greenhouse_alert_uid=p_uid and event='opened' and attempts=0 and status='pending';
    if p_status='resolved' then
        insert into public.greenhouse_notification_jobs(greenhouse_alert_uid,event,channel,message)
        select p_uid,'recovered',c,'LPMAS RESOLVED: Greenhouse ' || left(regexp_replace(g.greenhouse_id,'[^ -~]','?','g'),24) ||
          ' has returned to safe light levels. Incident ' || left(p_uid::text,12) || '.'
        from unnest(array['sms']) c on conflict do nothing;
    end if;
end;
$$;

create or replace function lpmas_private.sms_ownership_changed() returns trigger
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
      where channel='sms' and attempts=0 and status='pending';
    update lpmas_private.cloud_sensor_state set context=null,violations=0,safes=0;
  end if;
  return new;
end;
$$;

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
        where channel='sms' and greenhouse_alert_uid=uid and event='opened' and status='pending' and attempts=0;
    end if;
end;
$$;

create or replace function public.claim_greenhouse_notifications_unreconciled(p_limit integer default 5) returns jsonb
language plpgsql security definer set search_path=public as $$
declare jobs jsonb;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
    if coalesce((select value from public.system_settings where key='greenhouse_notifications_enabled'),'false') <> 'true' then return '[]'::jsonb; end if;
    -- Serialize closure with claiming so stale openings cannot be selected.
    perform 1 from public.greenhouse_alerts g where exists(select 1 from public.greenhouse_notification_jobs j where j.greenhouse_alert_uid=g.incident_uid and j.status='pending') order by g.incident_uid for update;
    update public.greenhouse_notification_jobs j set status='skipped',detail='Opening superseded by greenhouse closure',updated_at=now()
    from public.greenhouse_alerts g where j.channel='sms' and g.incident_uid=j.greenhouse_alert_uid and g.status <> 'open' and j.event='opened' and j.status='pending';
    -- Offline queues can deliver a new episode before an old episode's closure.
    update public.greenhouse_notification_jobs j set status='skipped',detail='Superseded by a newer greenhouse episode',updated_at=now()
    from public.greenhouse_alerts g where j.channel='sms' and g.incident_uid=j.greenhouse_alert_uid and j.status='pending'
      and exists(select 1 from public.greenhouse_alerts newer where newer.greenhouse_id=g.greenhouse_id and newer.opened_at > g.opened_at);
    with due as (
        select id from public.greenhouse_notification_jobs where status='pending' and attempts=0 and available_at <= now()
          and (send_number=1 or exists (
            select 1 from public.greenhouse_notification_jobs previous
            where previous.greenhouse_alert_uid=greenhouse_notification_jobs.greenhouse_alert_uid
              and previous.event=greenhouse_notification_jobs.event and previous.channel='sms'
              and previous.send_number=greenhouse_notification_jobs.send_number-1
              and previous.attempts=1 and previous.attempted_at <= now()-interval '10 seconds'
          )) order by available_at,send_number,id for update skip locked limit least(greatest(p_limit,1),20)
    ), consumed as (
        update public.greenhouse_notification_jobs j set status='unknown',attempts=1,attempt_token=gen_random_uuid(),attempted_at=now(),updated_at=now(),
          detail='Attempt consumed; provider acceptance unconfirmed',
          recipient=case when channel='sms' and send_number>1 then j.recipient
            when channel='sms' then (select value from public.system_settings where key='manager_phone')
            else (select u.email from auth.users u join public.profiles p on p.id=u.id
              where p.role::text='manager' and u.email_confirmed_at is not null
              and u.id::text=(select value from public.system_settings where key='manager_user_id')) end
        from due where j.id=due.id returning j.*
    ) select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) into jobs from consumed c;
    return jobs;
end;
$$;

create or replace function public.claim_greenhouse_notifications(p_limit integer default 5) returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
  perform pg_advisory_xact_lock(190022);
  perform lpmas_private.reconcile_cloud_episodes();
  update public.greenhouse_notification_jobs set status='skipped',detail='SMS is owned by the local Pi',updated_at=now()
    where public.local_sms_mode() and channel='sms' and status='pending' and attempts=0;
  update public.greenhouse_notification_jobs j set status='skipped',detail='Notification expired before sending',updated_at=now()
    from public.greenhouse_alerts g where j.channel='sms' and g.incident_uid=j.greenhouse_alert_uid and j.status='pending' and j.attempts=0
    and j.available_at < now()-case when g.producer='cloud' then interval '15 seconds' else interval '60 seconds' end;
  return public.claim_greenhouse_notifications_unreconciled(p_limit);
end;
$$;

commit;
