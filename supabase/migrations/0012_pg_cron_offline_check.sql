-- ============================================================
-- LPMAS - SENSOR OFFLINE CHECK (pg_cron)
-- Migration 0012
--
-- sensor_list.status is set to 'online' by update_sensor_list() on
-- every reading (0011). Nothing ever set it back to 'offline', so a
-- sensor that died would stay "online" on the Monitor page forever.
-- This migration adds the reaper:
--
--   pg_cron (every 30s) -> public.check_sensor_offline()
--                            -> update sensor_list
--                               set status = 'offline'
--                              where now() - last_reading_at
--                                    > threshold
--
-- Only rows already marked 'online' are considered, so the job is a
-- no-op for healthy sensors and does not rewrite last_reading_at (and
-- therefore does not churn updated_at) every 30 seconds.
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
-- SECURITY DEFINER with no role check: this is a maintenance job run
-- by the database itself (pg_cron connects as the migration role), and
-- the only thing it can do is mark rows offline, which is strictly
-- more conservative than the state the reading path already creates.
-- It is not granted to anon.
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
-- reach it: service_role for the Edge Function / on-call diagnostics,
-- authenticated so an admin can force a check from the Admin panel.
revoke execute on function public.check_sensor_offline(integer)
    from public;

grant execute on function public.check_sensor_offline(integer)
    to service_role, authenticated;


-- ============================================================
-- 2. pg_cron EXTENSION
-- ============================================================
-- Supabase supports pg_cron on hosted projects (enable it under
-- Database > Extensions if it is not already on). It must exist
-- before the job can be scheduled below.
-- ============================================================

create extension if not exists pg_cron;


-- ============================================================
-- 3. SCHEDULE THE JOB
-- ============================================================
-- DOLLAR QUOTING
--
-- The command string handed to cron.schedule() is itself a dollar
-- quoted SQL string, so it CANNOT use `$$` -- that would terminate
-- the statement early and the migration would fail to parse. It uses
-- $cron$ instead. A literal `$$` is only safe here if this whole
-- statement is itself inside a differently tagged block (for example
-- inside a DO ... $outer$), which it is not.
--
-- The job is named, and any previous job with that name is removed
-- first, so re-applying this migration reschedules rather than
-- stacking a second copy of a 30-second job on top of the first.
--
-- The literal 15 in the call is the fallback threshold described in
-- section 1; the effective value comes from system_settings.
-- ============================================================

do $schedule$
begin
    if exists (
        select 1 from cron.job where jobname = 'lpmas-sensor-offline-check'
    ) then
        perform cron.unschedule('lpmas-sensor-offline-check');
    end if;

    perform cron.schedule(
        'lpmas-sensor-offline-check',
        '30s',
        $cron$select public.check_sensor_offline(15)$cron$
    );
end;
$schedule$;


-- ============================================================
-- 4. VERIFICATION
-- ============================================================

select jobid, jobname, schedule, command, active
from cron.job
where jobname = 'lpmas-sensor-offline-check';

-- Manual run (returns the number of sensors just marked offline):
--
-- select public.check_sensor_offline(15);


-- ============================================================
-- END OF OFFLINE CHECK
-- ============================================================
