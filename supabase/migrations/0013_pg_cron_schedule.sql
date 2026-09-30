-- ============================================================
-- LPMAS - SCHEDULE THE SENSOR OFFLINE CHECK (pg_cron)
-- Migration 0013
--
-- Runs public.check_sensor_offline() -- defined in
-- 0012_pg_cron_offline_check.sql -- on a fixed interval, so a sensor
-- that stops reporting is eventually marked 'offline' in sensor_list
-- and disappears from the Monitor page's "Available Sensors" panel.
--
-- WHY THIS IS A SEPARATE FILE
--
-- `create extension pg_cron` is the only statement in this project's
-- migration set that can legitimately fail on an otherwise healthy
-- project: the extension has to be available and permitted on the
-- target instance. Supabase applies each migration file in a single
-- transaction, so anything sharing a file with an unguarded
-- `create extension` is rolled back along with it when it fails.
--
-- check_sensor_offline() was moved out into 0012 for exactly that
-- reason: on a project where pg_cron is unavailable, the function and
-- its grants must still be created, because they are the offline
-- detection mechanism itself, not a convenience. Only the schedule is
-- lost, and the loss is visible and recoverable (run the function by
-- hand, or enable the extension and re-apply).
-- ============================================================


-- ============================================================
-- 1. pg_cron EXTENSION
-- ============================================================
-- On Supabase this is available under Database > Extensions. If it is
-- not already enabled there, this migration fails and 0013 can be
-- retried after enabling it. 0012 is unaffected either way.
-- ============================================================

create extension if not exists pg_cron;


-- ============================================================
-- 2. SCHEDULE THE JOB
-- ============================================================
-- INTERVAL FORMAT
--
-- '30 seconds', not '30s'. pg_cron's interval parser does not accept
-- a bare "s" suffix: it scans for the literal word "second" (or
-- "seconds"), and anything it cannot read as an interval falls
-- through to the five-field cron parser, which also rejects "30s".
-- The call raises `invalid schedule: 30s`, and because this file runs
-- as one transaction the failure rolls back the whole migration. The
-- spelled-out unit is the only form that is unambiguously correct.
--
-- DOLLAR QUOTING
--
-- The command string is a dollar-quoted literal tagged $cron$. The
-- rule is simply that a dollar-quote tag must differ from the tag of
-- any ENCLOSING dollar-quoted block. Here the enclosing block is this
-- file's own `do $schedule$ ... $schedule$`, so $cron$ is safe where
-- $$ would not be -- $$ would close the $schedule$ literal early and
-- the file would fail to parse. (Had this call sat at top level with
-- no enclosing block, plain $$ would have been fine; the tags exist to
-- disambiguate nesting, not because $$ is inherently unsafe.)
--
-- IDEMPOTENCY
--
-- No exists/unschedule dance. The three-argument
-- cron.schedule(job_name, schedule, command) overload upserts on the
-- job name, so re-running this migration updates the existing job in
-- place instead of stacking a second 30-second job. The explicit
-- alternative -- `if exists (select 1 from cron.job where jobname =
-- ...) then perform cron.unschedule(...)` -- is both longer and
-- fragile: cron.unschedule(text) matches on jobname AND username, so
-- the exists check (which filters jobname only) can disagree with it
-- and raise "could not find valid entry" when run as a different role.
--
-- The literal 15 is the fallback threshold described in 0012; the
-- effective value is read from system_settings on every run.
-- ============================================================

do $schedule$
begin
    perform cron.schedule(
        'lpmas-sensor-offline-check',
        '30 seconds',
        $cron$select public.check_sensor_offline(15)$cron$
    );
end;
$schedule$;


-- ============================================================
-- 3. VERIFICATION
-- ============================================================

select jobid, jobname, schedule, command, active
from cron.job
where jobname = 'lpmas-sensor-offline-check';

-- Expected: schedule = '30 seconds'. If the column shows '0/30s' or
-- the row is missing, pg_cron parsed the interval differently than
-- intended -- check the extension is real (not a stub) and re-apply.
