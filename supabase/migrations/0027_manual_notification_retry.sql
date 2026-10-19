-- Share the connected Gmail application's credentials with both sending runtimes.
-- Secrets remain encrypted in Vault and readable only by the backend RPC.
begin;
create table lpmas_private.gmail_client_configuration (
  singleton boolean primary key default true check(singleton),
  client_id text not null, secret_id uuid not null, updated_at timestamptz not null default now()
);
revoke all on lpmas_private.gmail_client_configuration from public,anon,authenticated,service_role;
create function public.set_gmail_client_configuration(p_client_id text,p_client_secret text) returns void
language plpgsql security definer set search_path=public as $$
declare secret uuid; previous text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
  if p_client_id is null or length(p_client_id) not between 10 and 1024 or p_client_secret is null or length(p_client_secret) not between 10 and 8192 then raise exception 'Invalid Gmail client configuration'; end if;
  perform pg_advisory_xact_lock(190020);
  select c.secret_id,s.decrypted_secret into secret,previous from lpmas_private.gmail_client_configuration c join vault.decrypted_secrets s on s.id=c.secret_id where c.singleton;
  if secret is null then select vault.create_secret(p_client_secret,'lpmas_gmail_client_secret') into secret;
  elsif previous is distinct from p_client_secret then perform vault.update_secret(secret,p_client_secret); end if;
  insert into lpmas_private.gmail_client_configuration(singleton,client_id,secret_id) values(true,p_client_id,secret)
  on conflict(singleton) do update set client_id=excluded.client_id,secret_id=excluded.secret_id,updated_at=now();
end;
$$;
create or replace function public.get_gmail_authorization() returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
  return (select jsonb_build_object('sender_email',a.sender_email,'refresh_token',s.decrypted_secret,
    'client_id',c.client_id,'client_secret',cs.decrypted_secret)
    from lpmas_private.gmail_authorization a join vault.decrypted_secrets s on s.id=a.refresh_secret_id
    join auth.users u on u.id=a.admin_user_id join public.profiles p on p.id=u.id
    left join lpmas_private.gmail_client_configuration c on c.singleton
    left join vault.decrypted_secrets cs on cs.id=c.secret_id
    where p.role::text='admin' and u.email_confirmed_at is not null and lower(u.email)=a.sender_email);
end;
$$;
revoke all on function public.set_gmail_client_configuration(text,text),public.get_gmail_authorization() from public,anon,authenticated;
grant execute on function public.set_gmail_client_configuration(text,text),public.get_gmail_authorization() to service_role;

-- Save an authorization and its matching OAuth application atomically.
create function public.set_gmail_authorization(p_admin_user_id uuid,p_sender_email text,p_refresh_token text,p_client_id text,p_client_secret text) returns void
language plpgsql security definer set search_path=public as $$
begin
  perform public.set_gmail_client_configuration(p_client_id,p_client_secret);
  perform public.set_gmail_authorization(p_admin_user_id,p_sender_email,p_refresh_token);
end;
$$;
revoke all on function public.set_gmail_authorization(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.set_gmail_authorization(uuid,text,text,text,text) to service_role;

-- Keep original notification attempts immutable. Each deliberate manual send has
-- its own durable identity and is consumed before any network submission.
create table public.notification_manual_retries (
  id uuid primary key, original_job_id uuid not null,
  source text not null check(source in ('cloud','local')),
  requested_by uuid not null references auth.users(id),
  greenhouse_alert_uid uuid not null references public.greenhouse_alerts(incident_uid),
  event text not null check(event in ('opened','recovered','closed')),
  channel text not null check(channel in ('email','sms')),
  recipient text not null, message text not null,
  attempt_token uuid not null default gen_random_uuid(),
  status text not null default 'unknown' check(status in ('unknown','accepted','sent','delivered','failed')),
  detail text not null default 'Manual resend claimed; acceptance unconfirmed.',
  created_at timestamptz not null default now(), finished_at timestamptz
);
create index notification_manual_retry_origin on public.notification_manual_retries(source,original_job_id,created_at desc);
alter table public.notification_manual_retries enable row level security;
revoke all on public.notification_manual_retries from public,anon,authenticated;
grant all on public.notification_manual_retries to service_role;
grant select(id,original_job_id,source,requested_by,greenhouse_alert_uid,event,channel,recipient,status,detail,created_at,finished_at) on public.notification_manual_retries to authenticated;
create policy "Operators read manual notification retries" on public.notification_manual_retries for select to authenticated
using(exists(select 1 from public.profiles where id=auth.uid() and role::text in ('admin','manager')));
create function public.claim_manual_notification_retry(p_id uuid,p_source text,p_job_id uuid,p_actor_id uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare original record; attempt public.notification_manual_retries; previous public.notification_manual_retries; recipient_email text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
  if not exists(select 1 from auth.users u join public.profiles p on p.id=u.id where u.id=p_actor_id and u.email_confirmed_at is not null and p.role::text in ('admin','manager')) then raise exception 'Verified operator required'; end if;
  if coalesce((select value from public.system_settings where key='greenhouse_notifications_enabled'),'false') <> 'true' then raise exception 'Notifications are disabled in administrator settings'; end if;
  if p_source='cloud' then
    select id,greenhouse_alert_uid,event,channel,recipient,message,status into original from public.greenhouse_notification_jobs where id=p_job_id for update;
  elsif p_source='local' then
    select id,greenhouse_alert_uid,event,'sms'::text as channel,recipient,message,status into original from public.local_sms_outcomes where id=p_job_id for update;
  else raise exception 'Invalid notification source'; end if;
  if not found then raise exception 'Notification not found'; end if;
  select * into attempt from public.notification_manual_retries where id=p_id;
  if found then
    if attempt.original_job_id<>p_job_id or attempt.source<>p_source or attempt.requested_by<>p_actor_id then raise exception 'Retry identity collision'; end if;
    -- Returning no new claim prevents repeat submissions after a lost response.
    return jsonb_build_object('existing',true,'id',attempt.id,'status',attempt.status,'detail',attempt.detail);
  end if;
  if original.status <> 'failed' then raise exception 'Only failed notifications can be retried'; end if;
  select * into previous from public.notification_manual_retries where source=p_source and original_job_id=p_job_id order by created_at desc,id desc limit 1;
  if found then
    if previous.status <> 'failed' then raise exception 'A resend is already accepted or its delivery is unconfirmed'; end if;
    if previous.created_at>now()-interval '30 seconds' then raise exception 'Wait 30 seconds before retrying again'; end if;
  end if;
  if original.channel='sms' and ((p_source='local') is distinct from public.local_sms_mode()) then raise exception 'SMS sending ownership changed; retry from the current SMS system'; end if;
  if original.channel='email' then
    select u.email into recipient_email from auth.users u join public.profiles p on p.id=u.id where p.role::text='manager' and u.email_confirmed_at is not null and u.id::text=(select value from public.system_settings where key='manager_user_id');
    if recipient_email is null then raise exception 'Save a verified manager recipient in administrator settings'; end if;
  else recipient_email:=original.recipient; end if;
  if coalesce(recipient_email,'')='' then raise exception 'Notification recipient is missing'; end if;
  insert into public.notification_manual_retries(id,original_job_id,source,requested_by,greenhouse_alert_uid,event,channel,recipient,message)
  values(p_id,p_job_id,p_source,p_actor_id,original.greenhouse_alert_uid,original.event,original.channel,recipient_email,original.message) returning * into attempt;
  return to_jsonb(attempt)||jsonb_build_object('existing',false);
end;
$$;
create function public.finish_manual_notification_retry(p_id uuid,p_attempt_token uuid,p_outcome text,p_detail text) returns void
language plpgsql security definer set search_path=public as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
  if p_outcome not in ('unknown','accepted','sent','delivered','failed') or p_detail is null then raise exception 'Invalid retry outcome'; end if;
  update public.notification_manual_retries set status=p_outcome,detail=left(p_detail,500),finished_at=now()
    where id=p_id and attempt_token=p_attempt_token and status='unknown' and finished_at is null;
end;
$$;
revoke all on function public.claim_manual_notification_retry(uuid,text,uuid,uuid),public.finish_manual_notification_retry(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.claim_manual_notification_retry(uuid,text,uuid,uuid),public.finish_manual_notification_retry(uuid,uuid,text,text) to service_role;
commit;
