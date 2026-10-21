-- Content only: apply to newly queued cloud notices. Existing attempts and Pi SMS stay intact.
create function lpmas_private.format_notification_message() returns trigger
language plpgsql security definer set search_path=public as $$
declare
  episode public.greenhouse_alerts%rowtype;
  label text;
  sms_label text;
  event_at timestamptz;
  event_time text;
  reference text;
  heading text;
  explanation text;
  action text;
begin
  select * into episode from public.greenhouse_alerts where incident_uid=new.greenhouse_alert_uid;
  if not found then return new; end if;
  select coalesce(nullif(btrim(name),''),episode.greenhouse_id) into label
    from public.greenhouses where id=episode.greenhouse_id;
  label := regexp_replace(coalesce(label,episode.greenhouse_id),'[[:cntrl:]]',' ','g');
  sms_label := left(regexp_replace(label,'[^A-Za-z0-9 .,_()/:-]','?','g'),24);
  reference := left(episode.incident_uid::text,12);
  event_at := case when new.event='opened' then episode.opened_at else coalesce(episode.resolved_at,episode.opened_at) end;
  event_time := to_char(event_at at time zone 'Asia/Manila','YYYY-MM-DD HH24:MI');
  if new.channel='sms' then
    new.message := case new.event
      when 'opened' then 'LPMAS ALERT: ' || sms_label || ' light violation. Check lighting; review and acknowledge in dashboard. '
      when 'recovered' then 'LPMAS RESOLVED: ' || sms_label || ' safe light levels restored. Review incident history. '
      else 'LPMAS CLOSED: ' || sms_label || ' monitoring ended or changed; safe recovery unconfirmed. Review dashboard. '
    end || event_time || ' PHT. Ref ' || reference || '.';
  elsif new.channel='email' then
    heading := case new.event when 'opened' then 'LPMAS ALERT: Light violation recorded'
      when 'recovered' then 'LPMAS RESOLVED: Safe light levels restored'
      else 'LPMAS CLOSED: Safe recovery not confirmed' end;
    explanation := case new.event when 'opened' then 'Monitoring confirmed a light-level violation in this greenhouse. Inspect the site to determine the cause.'
      when 'recovered' then 'Monitoring recorded a return to safe light levels. This notice records the recovery of the incident below.'
      else 'The incident closed without confirmed safe recovery after monitoring ended or its configuration changed. Closure does not confirm that light levels returned to a safe range.' end;
    action := case when new.event='opened' and episode.status='open' then
      E'1. Check light sources against the greenhouse phase settings.\n2. Open the dashboard, review the incident, and acknowledge it after inspection.'
      when new.event='opened' then 'This incident has already ended. Open the dashboard to review its opening and closure history.'
      when new.event='recovered' then 'Review the incident history and any follow-up needed before the next monitoring period.'
      else 'Review why monitoring ended or changed, and check the greenhouse before assuming conditions are safe.' end;
    new.message := heading || E'\n\nGreenhouse: ' || label || E'\nEvent time: ' ||
      to_char(event_at at time zone 'Asia/Manila','YYYY-MM-DD HH24:MI:SS') || ' PHT (UTC+08:00)' ||
      E'\nIncident reference: ' || episode.incident_uid::text || E'\n\nWhat happened\n' || explanation ||
      E'\n\nNext steps\n' || action || E'\n\nLPMAS - Light Pollution Monitoring and Alert System\n' ||
      'This notice records an event at the time above. Check the dashboard for the latest status.';
  end if;
  return new;
end;
$$;
revoke all on function lpmas_private.format_notification_message() from public,anon,authenticated,service_role;
create trigger format_notification_message before insert on public.greenhouse_notification_jobs
for each row execute function lpmas_private.format_notification_message();
