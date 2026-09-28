-- ============================================================
-- LPMAS - SYSTEM SETTINGS FOR SENSOR OFFLINE + SEMAPHORE SMS
-- Migration 0010
--
-- public.system_settings already exists (0002_monitoring_data.sql)
-- as a plain key/value table with a unique key and no public read
-- policy, because it holds secrets like manager_phone. This migration
-- only seeds the three new keys the Admin settings screen and the
-- pg_cron offline check need. It does not change the table shape and
-- it does not relax the existing deny-all RLS on system_settings.
--
--   sensor_offline_threshold_seconds
--       How many seconds may pass without a reading before
--       check_sensor_offline() (0012) flips a sensor to 'offline'.
--       15s is roughly one and a half ESP32 reading cycles, so a
--       single dropped packet does not flap the Monitor page.
--
--   semaphore_api_key
--       Semaphore.co API key. Empty by default: SMS stays disabled
--       until an admin pastes a key.
--
--   semaphore_sender_name
--       Registered Semaphore sender ID, max 11 alphanumeric
--       characters. Empty by default, same reason.
-- ============================================================


-- ============================================================
-- 1. SEED THE NEW SETTINGS
-- ============================================================
-- ON CONFLICT ... DO NOTHING, deliberately.
--
-- 0002's commented example for manager_phone uses
-- "on conflict (key) do update", which is right for a value an admin
-- types once by hand. These three keys are all admin-configurable at
-- runtime (Admin panel writes them through the service role), so
-- re-running this migration must never stomp a configured value back
-- to a default. do nothing is idempotent AND non-destructive.
-- ============================================================

insert into public.system_settings (key, value, updated_at)
values
    ('sensor_offline_threshold_seconds', '15', now()),
    ('semaphore_api_key', '', now()),
    ('semaphore_sender_name', '', now())
on conflict (key) do nothing;


-- ============================================================
-- 2. VALUE VALIDATION FOR THE NEW KEYS
-- ============================================================
-- system_settings is generic key/value storage, so a table CHECK
-- cannot express "if key = 'semaphore_sender_name' then ...". A
-- BEFORE INSERT OR UPDATE trigger can, and it is scoped to only the
-- three keys this migration introduces so it cannot break any
-- pre-existing or future key.
--
-- The empty string MUST stay valid: it is the default that disables
-- SMS, so a naive "value ~ '^[a-zA-Z0-9]{1,11}$'" would reject the
-- seeded default and make this migration fail on a fresh database.
-- Each rule is therefore written as an explicit allow-list that
-- includes the empty string.
--
-- The Admin UI is expected to validate first, but the database is
-- the last line of defence: a bad sender name would otherwise be
-- accepted here and silently dropped by the Semaphore API later, and
-- a non-numeric threshold would be caught only by the silent fallback
-- inside check_sensor_offline().
-- ============================================================

create or replace function public.validate_system_settings_value()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.key = 'semaphore_sender_name' then
        -- Semaphore sender IDs are up to 11 alphanumeric characters.
        -- '' is the "SMS not configured" default and is allowed.
        if not (
            new.value is null
            or new.value = ''
            or new.value ~ '^[a-zA-Z0-9]{1,11}$'
        ) then
            raise exception
                'semaphore_sender_name must be empty or 1-11 alphanumeric characters (got: %)', new.value;
        end if;
    end if;

    if new.key = 'sensor_offline_threshold_seconds' and new.value is not null and new.value <> '' then
        -- Shape and range are two separate tests on purpose. SQL does
        -- not promise short-circuit evaluation of AND/OR operands, so
        -- folding them into one condition would evaluate ::bigint on
        -- input like 'abc' and raise an unhelpful integer-cast error
        -- instead of the message below.
        if new.value !~ '^[0-9]{1,9}$' then
            raise exception
                'sensor_offline_threshold_seconds must be a whole number of seconds between 1 and 86400 (got: %)', new.value;
        end if;

        -- Upper bound is one day so a typo cannot silently disable the
        -- offline check for every sensor.
        if new.value::bigint not between 1 and 86400 then
            raise exception
                'sensor_offline_threshold_seconds must be a whole number of seconds between 1 and 86400 (got: %)', new.value;
        end if;
    end if;

    return new;
end;
$$;


drop trigger if exists trg_system_settings_value_validation
    on public.system_settings;

create trigger trg_system_settings_value_validation
before insert or update on public.system_settings
for each row
execute function public.validate_system_settings_value();


-- The trigger function is only ever run by the table's own triggers,
-- never called directly, so it is not exposed to API roles.
revoke execute on function public.validate_system_settings_value() from public, anon, authenticated;


-- ============================================================
-- 3. VERIFICATION
-- ============================================================

select key, value, updated_at
from public.system_settings
where key in (
    'sensor_offline_threshold_seconds',
    'semaphore_api_key',
    'semaphore_sender_name'
)
order by key;


-- ============================================================
-- END OF SYSTEM SETTINGS
-- ============================================================
