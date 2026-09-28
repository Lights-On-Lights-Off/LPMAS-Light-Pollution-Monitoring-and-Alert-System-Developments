-- ============================================================
-- LPMAS - AGGREGATE WRITE PATH + SENSOR LIST RPCs
-- Migration 0011
--
-- This is the only sanctioned way sensor state and cloud aggregates
-- get written, on both sides of the new pipeline:
--
--   ESP32 -> Pi (SQLite) -> Edge Function (service role)
--                                      |-- update_sensor_list()
--                                      `-- upsert_minute_aggregate()
--
-- Both functions are SECURITY DEFINER because the caller is the
-- service role / Edge Function, and the reading path must not depend
-- on any frontend RLS policy. Role checks are still performed for
-- authenticated callers, because the Manager screens also call
-- update_sensor_list() to assign or unassign a sensor.
--
-- Ordering note: this file depends on public.sensor_list, created in
-- 0009_sensor_list.sql, and on the sensor_minute_aggregates unique
-- constraint sensor_minute_aggregates_sensor_bucket_unique
-- (sensor_id, bucket_start) from 0002_monitoring_data.sql.
-- ============================================================


-- ============================================================
-- 1. AGGREGATE INSERT POLICY
-- ============================================================
-- 0002_monitoring_data.sql installed a flat
-- "Authenticated users cannot insert sensor aggregates" policy
-- (with check (false)), because the Raspberry Pi wrote aggregates
-- straight to PostgREST with the service key. The Pi no longer does
-- that (the Edge Function owns the write now), so the blanket denial
-- is replaced by a narrow, self-describing rule:
--
--   a row may only be inserted for a sensor that
--     - exists in sensor_list,
--     - is currently 'online', and
--     - is assigned to the very greenhouse the row claims.
--
-- That is what keeps unassigned and dead sensors out of the cloud
-- history: a sensor that stopped reporting, or that a manager has
-- not mounted yet, contributes no chart data.
--
-- Scope: `to authenticated` is intentional. The Edge Function runs
-- on the service role, which bypasses RLS entirely, so this policy
-- only ever constrains a signed-in frontend session -- i.e. its job
-- is exactly to block frontend writes, per the design spec.
--
-- The UPDATE and DELETE denials from 0002 are left in place: the
-- aggregate row itself is immutable history, and the "upsert"
-- half of the pipeline goes through the RPC below (service role),
-- not through a client UPDATE.
-- ============================================================

drop policy if exists "Authenticated users cannot insert sensor aggregates"
    on public.sensor_minute_aggregates;

drop policy if exists "Edge function can insert aggregates for online assigned sensors"
    on public.sensor_minute_aggregates;

create policy "Edge function can insert aggregates for online assigned sensors"
on public.sensor_minute_aggregates
for insert
to authenticated
with check (
    exists (
        select 1
        from public.sensor_list sl
        where sl.sensor_id = sensor_minute_aggregates.sensor_id
          and sl.status = 'online'
          and sl.greenhouse_id is not null
          and sl.greenhouse_id = sensor_minute_aggregates.greenhouse_id
    )
);


-- ============================================================
-- 2. RPC: update_sensor_list
-- ============================================================
-- Called by the Edge Function on every accepted reading, and by the
-- Manager screens to assign/unassign a sensor to a greenhouse.
--
-- NULL-SEMANTICS WARNING (deliberate, and different from a naive
-- implementation)
--
-- The signature is fixed by the design spec as
--   p_greenhouse_id text default null
-- which makes "caller did not mention a greenhouse" and "caller
-- wants the greenhouse cleared" the same NULL on the wire. A naive
-- upsert that writes greenhouse_id = excluded.greenhouse_id would
-- therefore wipe a manager's assignment the first time a reading
-- arrived without a greenhouse_id -- silently undoing the Manager UI
-- and corrupting the aggregate policy in section 1.
--
-- So this function PRESERVES the existing greenhouse_id whenever
-- p_greenhouse_id is null, and only ever assigns a non-null value.
-- Assignment is therefore sticky and can only be changed by a call
-- that actually names a greenhouse.
--
-- Explicit unassignment is available through p_clear_greenhouse,
-- a trailing parameter that defaults to false. Adding it does not
-- change the spec's call shape: update_sensor_list('ESP32-001', 12.3)
-- and update_sensor_list('ESP32-001', 12.3, 'gh-001') both still
-- resolve to the same function, and the unassign button in the
-- Manager UI (plan task 6) can pass p_clear_greenhouse => true
-- instead of relying on a NULL that is indistinguishable from
-- "unchanged". Without it there would be no way to unassign at all.
--
-- Note: p_clear_greenhouse requires the caller's p_lux to be a real
-- number, which is fine because every caller of this function is
-- either forwarding a live reading or acting on one.
-- ============================================================

create or replace function public.update_sensor_list(
    p_sensor_id text,
    p_lux numeric,
    p_greenhouse_id text default null,
    p_clear_greenhouse boolean default false
)
returns public.sensor_list
language plpgsql
security definer
set search_path = public
as $$
declare
    v_role text;
    v_result public.sensor_list;
begin
    -- Authorization.
    --
    -- The Edge Function authenticates with the service role JWT, which
    -- carries no auth.uid(), so a null uid is treated as the trusted
    -- backend path. Any signed-in user must be admin or manager, which
    -- is the same profile/role check upsert_greenhouse() performs in
    -- 0006_greenhouse_config.sql.
    if auth.uid() is not null then
        select p.role::text into v_role
        from public.profiles p
        where p.id = auth.uid();

        if v_role is null or v_role not in ('admin', 'manager') then
            raise exception 'Not authorized to update the sensor list';
        end if;
    end if;

    if p_sensor_id is null or length(trim(p_sensor_id)) = 0 then
        raise exception 'sensor_id is required';
    end if;

    if p_lux is null or p_lux < 0 then
        raise exception 'lux must be a non-negative number';
    end if;

    if p_greenhouse_id is not null and length(trim(p_greenhouse_id)) = 0 then
        raise exception 'greenhouse_id must be a real greenhouse id, or null to leave the assignment unchanged';
    end if;

    if p_greenhouse_id is not null
       and not exists (select 1 from public.greenhouses g where g.id = p_greenhouse_id) then
        raise exception 'Greenhouse % does not exist', p_greenhouse_id;
    end if;

    insert into public.sensor_list as sl (
        sensor_id, lux, status, last_reading_at, greenhouse_id
    )
    values (
        p_sensor_id,
        p_lux,
        'online',
        now(),
        p_greenhouse_id
    )
    on conflict (sensor_id) do update set
        lux = excluded.lux,
        status = 'online',
        last_reading_at = now(),
        -- p_greenhouse_id null  => keep whatever the manager assigned.
        -- p_greenhouse_id given => assign it.
        -- p_clear_greenhouse   => unassign (explicit, never implicit).
        greenhouse_id = case
            when p_clear_greenhouse then null
            when p_greenhouse_id is not null then p_greenhouse_id
            else sl.greenhouse_id
        end
    returning * into v_result;

    return v_result;
end;
$$;

-- New functions get EXECUTE for PUBLIC by default, and every role is a
-- member of PUBLIC, so a bare "revoke from anon" would not actually
-- lock anon out. Revoke from PUBLIC first, then grant only the two
-- roles that are supposed to call this -- the same order 0004 uses for
-- log_activity().
revoke execute on function public.update_sensor_list(text, numeric, text, boolean)
    from public;

grant execute on function public.update_sensor_list(text, numeric, text, boolean)
    to authenticated, service_role;

-- There is deliberately NO separate three-argument overload of this
-- function. Both overloads would carry a default on p_greenhouse_id,
-- so a two-argument call would match both and PostgreSQL would fail
-- with "function public.update_sensor_list(text, numeric) is
-- ambiguous". One function with defaulted trailing parameters is
-- call-compatible with the design spec's
-- update_sensor_list(p_sensor_id text, p_lux numeric, p_greenhouse_id text default null)
-- -- PostgREST named arguments (p_sensor_id / p_lux / p_greenhouse_id)
-- and positional calls with two or three arguments all resolve here.


-- ============================================================
-- 3. RPC: upsert_minute_aggregate
-- ============================================================
-- Replaces the Pi's direct PostgREST write
-- (app.py: aggregate_readings_to_supabase, pi-server/app.py lines
-- 679-706) with a single idempotent RPC. The Pi builds one object
-- per (sensor_id, greenhouse_id, minute, phase_type) group and
-- upserts it on ("sensor_id", "bucket_start"); the parameter list
-- below is exactly that object's keys, in the same order:
--
--   sensor_id, greenhouse_id, bucket_start, phase_type,
--   sample_count, avg_lux, min_lux, max_lux,
--   safe_count, warning_count, violation_count, updated_at
--
-- on conflict (sensor_id, bucket_start) do update is what makes this
-- safe to re-run: the minute bucket is recomputed and re-sent
-- whenever the Pi restarts mid-minute, and a duplicate or concurrent
-- delivery collapses onto the same row instead of double-counting
-- samples. The Edge Function's minute-level accounting is not
-- additive, so "last writer wins" is correct here.
--
-- Guard: the sensor must be 'online' in sensor_list and assigned to
-- a greenhouse, mirroring the INSERT RLS policy in section 1 so the
-- two paths can never disagree about what is allowed into history.
-- ============================================================

create or replace function public.upsert_minute_aggregate(
    p_sensor_id text,
    p_greenhouse_id text,
    p_bucket_start timestamptz,
    p_phase_type text,
    p_sample_count integer,
    p_avg_lux numeric,
    p_min_lux numeric,
    p_max_lux numeric,
    p_safe_count integer,
    p_warning_count integer,
    p_violation_count integer,
    p_updated_at timestamptz default null
)
returns public.sensor_minute_aggregates
language plpgsql
security definer
set search_path = public
as $$
declare
    v_greenhouse_id text;
    v_status text;
    v_result public.sensor_minute_aggregates;
begin
    if p_sensor_id is null or length(trim(p_sensor_id)) = 0 then
        raise exception 'sensor_id is required';
    end if;

    if p_bucket_start is null then
        raise exception 'bucket_start is required';
    end if;

    if p_phase_type is null or p_phase_type not in ('illumination', 'dark') then
        raise exception 'phase_type must be illumination or dark';
    end if;

    -- sensor_list is the authority on liveness and assignment. Reading
    -- the greenhouse_id from it (instead of trusting the caller's copy)
    -- means a stale or spoofed greenhouse_id in the payload cannot put
    -- a row in the wrong greenhouse's history.
    select sl.greenhouse_id, sl.status
    into v_greenhouse_id, v_status
    from public.sensor_list sl
    where sl.sensor_id = p_sensor_id;

    if not found then
        raise exception 'Sensor % is not present in the sensor list', p_sensor_id;
    end if;

    -- is distinct from, not <>, so a null status fails closed instead
    -- of evaluating to null and skipping the guard.
    if v_status is distinct from 'online' then
        raise exception 'Sensor % is not online; aggregate not stored', p_sensor_id;
    end if;

    if v_greenhouse_id is null then
        raise exception 'Sensor % is not assigned to a greenhouse; aggregate not stored', p_sensor_id;
    end if;

    if p_greenhouse_id is not null and p_greenhouse_id <> v_greenhouse_id then
        raise exception
            'Sensor % is assigned to greenhouse %, not %',
            p_sensor_id, v_greenhouse_id, p_greenhouse_id;
    end if;

    insert into public.sensor_minute_aggregates (
        sensor_id,
        greenhouse_id,
        bucket_start,
        phase_type,
        sample_count,
        avg_lux,
        min_lux,
        max_lux,
        safe_count,
        warning_count,
        violation_count,
        updated_at
    )
    values (
        p_sensor_id,
        v_greenhouse_id,
        p_bucket_start,
        p_phase_type,
        coalesce(p_sample_count, 0),
        p_avg_lux,
        p_min_lux,
        p_max_lux,
        coalesce(p_safe_count, 0),
        coalesce(p_warning_count, 0),
        coalesce(p_violation_count, 0),
        coalesce(p_updated_at, now())
    )
    on conflict (sensor_id, bucket_start) do update set
        greenhouse_id = excluded.greenhouse_id,
        phase_type = excluded.phase_type,
        sample_count = excluded.sample_count,
        avg_lux = excluded.avg_lux,
        min_lux = excluded.min_lux,
        max_lux = excluded.max_lux,
        safe_count = excluded.safe_count,
        warning_count = excluded.warning_count,
        violation_count = excluded.violation_count,
        updated_at = excluded.updated_at
    returning * into v_result;

    return v_result;
end;
$$;

revoke execute on function public.upsert_minute_aggregate(
    text, text, timestamptz, text, integer, numeric, numeric, numeric,
    integer, integer, integer, timestamptz
) from public;

grant execute on function public.upsert_minute_aggregate(
    text, text, timestamptz, text, integer, numeric, numeric, numeric,
    integer, integer, integer, timestamptz
) to service_role, authenticated;


-- ============================================================
-- 4. VERIFICATION
-- ============================================================

select
    n.nspname as schema_name,
    p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
      'update_sensor_list',
      'upsert_minute_aggregate',
      'check_sensor_offline'
  )
order by p.proname, arguments;

select policyname, cmd, roles::text
from pg_policies
where schemaname = 'public'
  and tablename = 'sensor_minute_aggregates'
order by cmd, policyname;


-- ============================================================
-- END OF AGGREGATE WRITE PATH
-- ============================================================
