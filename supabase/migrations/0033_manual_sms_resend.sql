-- Deliberate SMS resends are separate from failure-only email retries.
-- Keep original jobs immutable; each confirmed send has one durable identity.
create function public.claim_manual_sms_resend(p_id uuid,p_source text,p_job_id uuid,p_actor_id uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare original record; attempt public.notification_manual_retries;
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
  if original.channel <> 'sms' then raise exception 'This action only resends SMS'; end if;
  select * into attempt from public.notification_manual_retries where id=p_id;
  if found then
    if attempt.original_job_id<>p_job_id or attempt.source<>p_source or attempt.requested_by<>p_actor_id then raise exception 'Resend identity collision'; end if;
    return jsonb_build_object('existing',true,'id',attempt.id,'status',attempt.status,'detail',attempt.detail);
  end if;
  if ((p_source='local') is distinct from public.local_sms_mode()) then raise exception 'SMS sending ownership changed; resend from the current SMS system'; end if;
  if not exists(select 1 from lpmas_private.alert_recipients() r where r.sms_enabled and r.phone=original.recipient) then raise exception 'Original SMS recipient is no longer assigned'; end if;
  if exists(select 1 from public.notification_manual_retries where source=p_source and original_job_id=p_job_id
    and finished_at is null and created_at>now()-interval '60 seconds') then
    raise exception 'The previous submission is still in progress; refresh its outcome before resending';
  end if;
  insert into public.notification_manual_retries(id,original_job_id,source,requested_by,greenhouse_alert_uid,event,channel,recipient,message)
  values(p_id,p_job_id,p_source,p_actor_id,original.greenhouse_alert_uid,original.event,'sms',original.recipient,original.message) returning * into attempt;
  return to_jsonb(attempt)||jsonb_build_object('existing',false,'manual_sms',true);
end;
$$;
revoke all on function public.claim_manual_sms_resend(uuid,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_manual_sms_resend(uuid,text,uuid,uuid) to service_role;
