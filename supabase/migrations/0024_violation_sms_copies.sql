-- Three bounded violation SMS sends; one resolution SMS and one email per event.
begin;
alter table public.greenhouse_notification_jobs
  add column send_number integer not null default 1,
  add column available_at timestamptz not null default now(),
  add constraint greenhouse_notification_send_number check (
    send_number between 1 and 3 and (send_number=1 or (channel='sms' and event='opened'))
  );
-- Existing jobs retain their original age so the deployment cannot replay backlog.
update public.greenhouse_notification_jobs set available_at=created_at;

do $$
declare constraint_name text;
begin
  for constraint_name in select conname from pg_constraint
    where conrelid='public.greenhouse_notification_jobs'::regclass and contype='u'
  loop
    execute format('alter table public.greenhouse_notification_jobs drop constraint %I',constraint_name);
  end loop;
end;
$$;
alter table public.greenhouse_notification_jobs add constraint greenhouse_notification_send_unique
  unique(greenhouse_alert_uid,event,channel,send_number);

-- Keep the legacy ingestion entrypoint valid under the extended unique key.
do $$
begin
  execute replace(pg_get_functiondef('public.record_greenhouse_alert(jsonb)'::regprocedure),
    'on conflict(greenhouse_alert_uid,event,channel)',
    'on conflict(greenhouse_alert_uid,event,channel,send_number)');
end;
$$;

create or replace function public.protect_consumed_notification() returns trigger
language plpgsql set search_path=public as $$
begin
  if old.attempts=1 and (new.attempts <> 1 or new.attempt_token is distinct from old.attempt_token
    or new.attempted_at is distinct from old.attempted_at or new.recipient is distinct from old.recipient
    or new.message is distinct from old.message or new.event is distinct from old.event
    or new.channel is distinct from old.channel or new.greenhouse_alert_uid is distinct from old.greenhouse_alert_uid
    or new.send_number is distinct from old.send_number or new.available_at is distinct from old.available_at
    or (old.status <> 'unknown' and new.status is distinct from old.status)) then
    raise exception 'Consumed notification attempts cannot be reset';
  end if;
  return new;
end;
$$;

-- Schedule copies only when a new violation's first SMS is actually claimed.
-- Old consumed jobs are never expanded. Each copy is consumed once, independently.
create function public.schedule_violation_sms_copies() returns trigger
language plpgsql set search_path=public as $$
begin
  insert into public.greenhouse_notification_jobs
    (greenhouse_alert_uid,event,channel,message,recipient,send_number,available_at)
  select new.greenhouse_alert_uid,new.event,new.channel,new.message,new.recipient,n,
    new.attempted_at + (n-1)*interval '10 seconds'
  from generate_series(2,3) n
  on conflict(greenhouse_alert_uid,event,channel,send_number) do nothing;
  return new;
end;
$$;
revoke all on function public.schedule_violation_sms_copies() from public,anon,authenticated;
create trigger schedule_violation_sms_copies after update on public.greenhouse_notification_jobs
for each row when (old.attempts=0 and new.attempts=1 and new.send_number=1 and new.channel='sms' and new.event='opened')
execute function public.schedule_violation_sms_copies();

create or replace function public.claim_greenhouse_notifications_unreconciled(p_limit integer default 5) returns jsonb
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
  perform lpmas_private.reconcile_cloud_episodes();
  -- Expiry is relative to the scheduled send, rather than the original incident.
  update public.greenhouse_notification_jobs j set status='skipped',detail='Cloud notification expired before sending',updated_at=now()
  from public.greenhouse_alerts g where g.incident_uid=j.greenhouse_alert_uid and g.producer='cloud'
    and j.status='pending' and j.attempts=0 and j.available_at < now()-interval '15 seconds';
  return public.claim_greenhouse_notifications_unreconciled(p_limit);
end;
$$;
revoke all on function public.claim_greenhouse_notifications_unreconciled(integer) from public,anon,authenticated,service_role;
revoke all on function public.claim_greenhouse_notifications(integer) from public,anon,authenticated;
grant execute on function public.claim_greenhouse_notifications(integer) to service_role;
commit;
