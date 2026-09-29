-- ============================================================
-- LPMAS - SENSOR OFFLINE CHECK (RPC)
-- Migration 0012
--
-- sensor_list.status is set to 'online' by update_sensor_list() on
-- every reading (0011). Nothing ever set it back to 'offline', so a
-- sensor that died would stay "online" on the Monitor page forever.
-- This migration provides the reaper itself:
--
--   public.check_sensor_offline()
--       -> update sensor_list set status = 'offline'
--          where now() - last_reading_at > threshold
--
-- Only rows already marked 'online' are considered, so the job is a
-- no-op for healthy sensors and does not rewrite last_reading_at (and
-- therefore does not churn updated_at) on every run.
--
-- WHY THE pg_cron PARTS ARE NOT IN THIS FILE
--
-- Scheduling this job needs `create extension pg_cron`, and
-- `create extension` is not guaranteed to succeed on every project:
-- on a project where the extension is unavailable or not permitted,
-- it raises. Supabase applies each migration file in a single
-- transaction, so an unguarded create extension sharing a file with
-- this function would roll the whole file back -- taking
-- check_sensor_offline() and its grants with it, and leaving the
-- offline reaper that the entire sensor_list.status design depends on
-- uncreated.
--
-- The scheduling DDL therefore lives in its own file,
-- 0013_pg_cron_schedule.sql. That way a project without pg_cron still
-- gets the function (callable by hand, or schedulable by other means)
-- and only the convenience schedule is lost, rather than the entire
-- offline-detection mechanism.
-- ============================================================


-- ============================================================
-- 1. RPC: check_sensor_offline
-- ============================================================
-- Returns the number of sensors it flipped to 'offline', so the cron
-- log line and any manual invocation are both observable.
--
-- THRESHOLD SOURCE: system_settings wins.
--
-- p_threshold_seconds exists to match the design spec's signature and
-- to give the function a sane fallback, but the effective threshold is
-- read from system_settings.sensor_offline_threshold_seconds (seeded to
-- '15' in 0010) every time the job runs. Scheduling the job as
-- `check_sensor_offline(15)` and then honouring that literal would
-- make the Admin panel's "Sensor Offline Threshold" setting a no-op --
-- the exact silent-defeat of a configurable setting the plan warns
-- about. So the argument is only a fallback for the case where the
-- setting is missing, empty, or not a number.
--
-- SECURITY DEFINER + ROLE CHECK
--
-- The function is SECURITY DEFINER because it is invoked by pg_cron,
-- which connects as the database role that owns the job rather than as
-- any API role, and because marking rows offline is a write that
-- should not depend on the caller's table grants.
--
-- It IS granted to `authenticated` (for a manual "check now" from the
-- Admin panel), and that grant is why the role check below exists: a
-- SECURITY DEFINER function reachable by any signed-in user would let
-- any user flip sensors offline on demand. The check is the same
-- profiles/role test update_sensor_list() applies, so only admin and
-- manager can call it. The pg_cron path is unaffected -- cron runs
-- with auth.uid() null, so the check is skipped exactly as it is in
-- update_sensor_list().
-- ============================================================

create or replace function public.check_sensor_offline(
    p_threshold_seconds integer default 15
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_threshold integer;
    v_setting text;
    v_count integer;
begin
    -- pg_cron connects with no auth.uid() and is trusted (it can only
    -- ever mark sensors offline, which is the conservative direction).
    -- A signed-in caller must be admin or manager.
    if auth.uid() is not null then
        if not exists (
            select 1
            from public.profiles p
            where p.id = auth.uid()
              and p.role::text in ('admin', 'manager')
        ) then
            raise exception 'Not authorized to run the sensor offline check';
        end if;
    end if;

    v_threshold := p_threshold_seconds;

    select s.value into v_setting
    from public.system_settings s
    where s.key = 'sensor_offline_threshold_seconds';

    if v_setting is not null and length(trim(v_setting)) > 0 then
        -- Guarded cast: a non-numeric value must fall back to the
        -- default rather than abort the whole cron run.
        if v_setting ~ '^[0-9]{1,9}$' then
            v_threshold := v_setting::integer;
        end if;
    end if;

    -- Backstop only. The 5..86400 range the Admin panel exposes is
    -- enforced at write time by the validator in 0010, so a stored
    -- value outside it cannot exist; this clamp exists solely so a
    -- null or non-positive ARGUMENT cannot produce a nonsense
    -- interval. It deliberately does not clamp to 5: silently
    -- rewriting an explicit check_sensor_offline(1) that an operator
    -- passed on purpose would be a confusing thing to debug.
    if v_threshold is null or v_threshold <= 0 then
        v_threshold := 15;
    end if;

    update public.sensor_list
    set status = 'offline'
    where status = 'online'
      and last_reading_at < now() - make_interval(secs => v_threshold);

    get diagnostics v_count = row_count;

    return v_count;
end;
$$;

-- Every role is a member of PUBLIC and new functions get EXECUTE for
-- PUBLIC by default, so revoking from anon alone would leave the door
-- open. Revoke from PUBLIC, then grant only the roles that should
-- reach it.
revoke execute on function public.check_sensor_offline(integer)
    from public;

grant execute on function public.check_sensor_offline(integer)
    to service_role, authenticated;


-- ============================================================
-- 2. VERIFICATION
-- ============================================================
-- The function is registered and callable:
--
-- select public.check_sensor_offline(15);
--
-- ...but the scheduled job lives in 0013_pg_cron_schedule.sql, which
-- is the file to check for the cron entry itself.
-- ============================================================
