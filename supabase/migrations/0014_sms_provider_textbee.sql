-- SMS provider: textbee (Android SMS gateway)
--
-- Replaces Semaphore. Semaphore meters every message against a credit
-- balance and refuses to send without a registered sender name, so a free
-- account could not deliver a single alert: status Pending, balance 0. That
-- is not a configuration mistake, it is a paywall, and it left the project
-- with no working alerting path.
--
-- textbee relays through the project's own prepaid SIM, so a message costs
-- nothing per send and there is no sender name to register or pay for. The
-- cost moved to hardware and attention — a phone that stays plugged in — and
-- that trade is deliberate.
--
-- The semaphore_* keys are left in place rather than deleted. They hold no
-- usable value, but dropping rows is a destructive act on a key/value table
-- that other code may still read, and nothing depends on their absence. They
-- are simply no longer consulted: resolveProvider refuses any provider name
-- it does not recognise, so a stale semaphore_* value cannot accidentally
-- route a credential anywhere.

insert into public.system_settings (key, value, updated_at)
values
    ('sms_provider', 'textbee', now()),
    ('textbee_api_key', '', now())
on conflict (key) do update
    set value = excluded.value,
        updated_at = now();

-- The provider name is a closed set, not free text. A typo here would
-- otherwise be stored happily and then silently stop every alert, so it is
-- refused at the database rather than discovered at 3am. An empty value stays
-- valid and simply means "SMS not configured".
create or replace function public.validate_sms_provider_name()
returns trigger
language plpgsql
as $$
begin
    if new.key = 'sms_provider' and new.value is not null and new.value <> '' then
        if new.value not in ('textbee') then
            raise exception
                'sms_provider must be empty or one of: textbee (got: %)', new.value;
        end if;
    end if;

    return new;
end;
$$;

drop trigger if exists trg_system_settings_sms_provider
    on public.system_settings;

create trigger trg_system_settings_sms_provider
    before insert or update on public.system_settings
    for each row
    execute function public.validate_sms_provider_name();

-- Only ever run by the table's own trigger, never called directly.
revoke execute on function public.validate_sms_provider_name() from public, anon, authenticated;


-- ============================================================
-- VERIFICATION
-- ============================================================

select key, value, updated_at
from public.system_settings
where key in ('sms_provider', 'textbee_api_key')
order by key;

-- Expected: sms_provider = 'textbee', textbee_api_key = '' (until an admin
-- pastes one in Configure system).
