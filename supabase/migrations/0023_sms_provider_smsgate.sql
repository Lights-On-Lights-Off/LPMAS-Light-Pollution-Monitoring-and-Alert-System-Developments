-- Add SMSGate without removing TextBee or overwriting existing credentials.
begin;

create or replace function public.validate_sms_provider_name()
returns trigger
language plpgsql
as $$
begin
    if new.key = 'sms_provider' and new.value is not null and new.value <> '' then
        if new.value not in ('textbee', 'smsgate') then
            raise exception 'sms_provider must be empty or one of: textbee, smsgate (got: %)', new.value;
        end if;
    end if;
    return new;
end;
$$;
revoke execute on function public.validate_sms_provider_name() from public, anon, authenticated;

insert into public.system_settings (key, value, updated_at)
values ('smsgate_username', '', now()), ('smsgate_password', '', now()),
       ('sms_provider', 'smsgate', now())
on conflict (key) do nothing;

-- Prefer SMSGate for setups with no working TextBee key. Keep a configured
-- TextBee selection until the admin saves SMSGate credentials and selects it.
update public.system_settings
set value = 'smsgate', updated_at = now()
where key = 'sms_provider'
  and (coalesce(value, '') = '' or
       (value = 'textbee' and not exists (
           select 1 from public.system_settings
           where key = 'textbee_api_key' and length(trim(coalesce(value, ''))) > 0
       )));

commit;
