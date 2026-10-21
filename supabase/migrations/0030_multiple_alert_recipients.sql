-- Per-account channel assignments; each destination has its own durable attempt.
begin;
insert into public.system_settings(key,value)
select 'notification_recipients',coalesce(jsonb_agg(jsonb_build_object(
  'user_id',u.id,'phone',case when s.phone ~ '^\+639[0-9]{9}$' then s.phone else '' end,
  'email_enabled',true,'sms_enabled',coalesce(s.phone ~ '^\+639[0-9]{9}$',false)))::text,'[]')
from auth.users u join public.profiles p on p.id=u.id
cross join (select (select value from public.system_settings where key='manager_phone') as phone) s
where u.id::text=(select value from public.system_settings where key='manager_user_id')
  and p.role::text in ('admin','manager') and u.email_confirmed_at is not null
on conflict(key) do nothing;

create function lpmas_private.alert_recipients()
returns table(user_id uuid,email text,phone text,email_enabled boolean,sms_enabled boolean)
language sql stable security definer set search_path=public as $$
  select u.id,lower(u.email),r.phone,r.email_enabled,r.sms_enabled
  from jsonb_to_recordset(coalesce((select value::jsonb from public.system_settings where key='notification_recipients'),'[]'::jsonb))
    as r(user_id uuid,phone text,email_enabled boolean,sms_enabled boolean)
  join auth.users u on u.id=r.user_id join public.profiles p on p.id=u.id
  where p.role::text in ('admin','manager') and u.email_confirmed_at is not null
    and u.email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';
$$;
revoke all on function lpmas_private.alert_recipients() from public,anon,authenticated,service_role;

create function public.set_alert_recipients(p_recipients jsonb) returns void
language plpgsql security definer set search_path=public as $$
declare r jsonb; uid uuid; primary_sms jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
  if jsonb_typeof(p_recipients) is distinct from 'array' then raise exception 'Recipients must be an array'; end if;
  if jsonb_array_length(p_recipients)>20 then raise exception 'Choose up to 20 alert recipients'; end if;
  perform pg_advisory_xact_lock(190022);
  for r in select * from jsonb_array_elements(p_recipients) loop
    if jsonb_typeof(r->'user_id') is distinct from 'string' or jsonb_typeof(r->'phone') is distinct from 'string'
      or jsonb_typeof(r->'email_enabled') is distinct from 'boolean' or jsonb_typeof(r->'sms_enabled') is distinct from 'boolean'
      or not ((r->>'email_enabled')::boolean or (r->>'sms_enabled')::boolean) then raise exception 'Invalid recipient channels'; end if;
    uid:=(r->>'user_id')::uuid;
    if not exists(select 1 from auth.users u join public.profiles p on p.id=u.id
      where u.id=uid and p.role::text in ('admin','manager') and u.email_confirmed_at is not null
      and u.email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then raise exception 'Choose verified administrator or manager accounts'; end if;
    if (r->>'sms_enabled')::boolean and r->>'phone' !~ '^\+639[0-9]{9}$' then raise exception 'Invalid Philippine mobile number'; end if;
  end loop;
  if (select count(*)<>count(distinct (v->>'user_id')::uuid) from jsonb_array_elements(p_recipients) v) then raise exception 'Duplicate recipient account'; end if;
  insert into public.system_settings(key,value,updated_at) values('notification_recipients',p_recipients::text,now())
    on conflict(key) do update set value=excluded.value,updated_at=excluded.updated_at;
  -- Compatibility for an older Pi during rollout. The upgraded Pi uses the array.
  select v into primary_sms from jsonb_array_elements(p_recipients) v where (v->>'sms_enabled')::boolean limit 1;
  insert into public.system_settings(key,value,updated_at) values
    ('manager_user_id',coalesce(primary_sms->>'user_id',''),now()),('manager_phone',coalesce(primary_sms->>'phone',''),now())
    on conflict(key) do update set value=excluded.value,updated_at=excluded.updated_at;
end;
$$;
revoke all on function public.set_alert_recipients(jsonb) from public,anon,authenticated;
grant execute on function public.set_alert_recipients(jsonb) to service_role;

create or replace function public.pi_configuration() returns jsonb
language sql stable security definer set search_path=public as $$
select public.pi_configuration_without_sms() || jsonb_build_object('timezone','Asia/Manila',
  'local_sms',jsonb_build_object('mode',coalesce((select value from public.system_settings where key='sms_dispatch_mode'),'cloud'),
    'enabled',coalesce((select value from public.system_settings where key='greenhouse_notifications_enabled'),'false')='true',
    'recipient',coalesce((select min(phone) from lpmas_private.alert_recipients() where sms_enabled),''),
    'recipients',coalesce((select jsonb_agg(distinct phone) from lpmas_private.alert_recipients() where sms_enabled),'[]'::jsonb)));
$$;

alter table public.greenhouse_notification_jobs add column recipient_key text not null default '';
alter table public.greenhouse_notification_jobs drop constraint greenhouse_notification_send_unique;
alter table public.greenhouse_notification_jobs add constraint greenhouse_notification_send_unique
  unique(greenhouse_alert_uid,event,channel,send_number,recipient_key);
-- All producer conflict targets must keep a single root job per lifecycle event.
do $$
declare f text;
begin
  foreach f in array array['lpmas_private.queue_episode_email()','public.schedule_violation_sms_copies()'] loop
    execute replace(pg_get_functiondef(f::regprocedure),
      'on conflict(greenhouse_alert_uid,event,channel,send_number)',
      'on conflict(greenhouse_alert_uid,event,channel,send_number,recipient_key)');
  end loop;
end;
$$;

create function lpmas_private.assign_notification_recipients() returns trigger
language plpgsql security definer set search_path=public as $$
declare destination text; first_destination boolean:=true;
begin
  -- Explicit destinations include fan-out children and scheduled SMS copies.
  if new.recipient is not null or new.send_number<>1 or new.status<>'pending' then return new; end if;
  perform pg_advisory_xact_lock(190022);
  if exists(select 1 from public.greenhouse_notification_jobs where greenhouse_alert_uid=new.greenhouse_alert_uid
    and event=new.event and channel=new.channel and send_number=1 and recipient_key='') then return new; end if;
  for destination in select distinct case when new.channel='email' then r.email else r.phone end
    from lpmas_private.alert_recipients() r
    where (new.channel='email' and r.email_enabled) or (new.channel='sms' and r.sms_enabled)
    order by 1
  loop
    if first_destination then new.recipient:=destination; first_destination:=false;
    else
      insert into public.greenhouse_notification_jobs(greenhouse_alert_uid,event,channel,message,recipient,recipient_key,available_at)
      values(new.greenhouse_alert_uid,new.event,new.channel,new.message,destination,destination,new.available_at)
      on conflict do nothing;
    end if;
  end loop;
  if first_destination then new.status:='skipped'; new.detail:='No eligible recipients assigned to this channel'; end if;
  return new;
end;
$$;
revoke all on function lpmas_private.assign_notification_recipients() from public,anon,authenticated,service_role;
-- Runs after formatting and local SMS ownership guards.
create trigger zz_assign_notification_recipients before insert on public.greenhouse_notification_jobs
for each row execute function lpmas_private.assign_notification_recipients();

create or replace function public.schedule_violation_sms_copies() returns trigger
language plpgsql set search_path=public as $$
begin
  insert into public.greenhouse_notification_jobs
    (greenhouse_alert_uid,event,channel,message,recipient,recipient_key,send_number,available_at)
  select new.greenhouse_alert_uid,new.event,new.channel,new.message,new.recipient,new.recipient_key,n,
    new.attempted_at+(n-1)*interval '10 seconds'
  from generate_series(2,3) n on conflict do nothing;
  return new;
end;
$$;
-- Freeze each claimed copy's recipient and require that same recipient's prior copy.
do $$
declare definition text;
begin
  definition:=pg_get_functiondef('public.claim_greenhouse_notifications_unreconciled(integer)'::regprocedure);
  definition:=replace(definition,'and previous.send_number=greenhouse_notification_jobs.send_number-1',
    'and previous.recipient_key=greenhouse_notification_jobs.recipient_key
              and previous.recipient is not distinct from greenhouse_notification_jobs.recipient
              and previous.send_number=greenhouse_notification_jobs.send_number-1');
  definition:=replace(definition,'recipient=case when channel=', 'recipient=coalesce(j.recipient,case when channel=');
  definition:=replace(definition, 'where key=''manager_user_id'')) end', 'where key=''manager_user_id'')) end)');
  execute definition;
end;
$$;
do $$ declare definition text; begin
  definition:=pg_get_functiondef('public.protect_consumed_notification()'::regprocedure);
  definition:=replace(definition,'or new.send_number is distinct from old.send_number',
    'or new.recipient_key is distinct from old.recipient_key or new.send_number is distinct from old.send_number');
  execute definition;
end $$;
-- Per-recipient Pi outcomes must coexist for the same event and copy number.
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid='public.local_sms_outcomes'::regclass and contype='u' loop
    execute format('alter table public.local_sms_outcomes drop constraint %I',c);
  end loop;
end $$;
alter table public.local_sms_outcomes add constraint local_sms_recipient_send_unique unique(greenhouse_alert_uid,event,send_number,recipient);

-- Manual retry keeps the failed destination, never redirects to another manager.
do $$ declare definition text; begin
  definition:=pg_get_functiondef('public.claim_manual_notification_retry(uuid,text,uuid,uuid)'::regprocedure);
  definition:=regexp_replace(definition,
    'if original.channel=''email'' then.*?else recipient_email:=original.recipient; end if;',
    'recipient_email:=original.recipient;
  if original.channel=''email'' and not exists(select 1 from lpmas_private.alert_recipients() r where r.email_enabled and r.email=recipient_email) then
    raise exception ''Original email recipient is no longer assigned; update recipients before retrying'';
  end if;', 's');
  execute definition;
end $$;
commit;
