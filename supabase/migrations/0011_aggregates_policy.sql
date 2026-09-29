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
-- WHAT THIS POLICY DOES *NOT* DO -- read this before assuming it
-- blocks anything.
--
-- 0002's policy was `with check (false)`: a blanket deny, satisfied
-- by no row ever. The predicate below is SATISFIABLE. For any sensor
-- that is online and assigned -- which is every working sensor in the
-- system -- a signed-in session holding INSERT privilege can satisfy
-- it and write a row directly to /rest/v1/sensor_minute_aggregates.
-- This policy is therefore NOT a frontend write block on its own; it
-- is a correctness constraint (a row may only claim a greenhouse the
-- sensor is actually mounted in), not a privilege boundary.
--
-- The privilege boundary is the table grant revoked immediately below.
-- The policy stays exactly as the design spec mandates it
-- (spec section 2.3) and is installed as defence in depth: if the
-- grant is ever widened, the policy still refuses rows for sensors
-- that are offline or unassigned. The Edge Function is unaffected --
-- it uses the service role, which bypasses RLS entirely and holds its
-- own grants.
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


-- The actual privilege boundary. RLS is a filter, not a door: a policy
-- that a client can satisfy does not stop that client writing. Removing
-- the table-level INSERT privilege from `authenticated` is what makes
-- the policy above unreachable from a signed-in session.
--
-- `service_role` is untouched: it bypasses RLS and the Edge Function
-- keeps its own grants, so the ingest path is unaffected.
revoke insert on public.sensor_minute_aggregates from authenticated;


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
-- Manager UI (plan task 7) can pass p_clear_greenhouse => true
-- instead of relying on a NULL that is indistinguishable from
-- "unchanged". Without it there would be no way to unassign at all.
--
-- READING PATH vs ASSIGNMENT PATH (p_reading)
--
-- There are two callers with different intents:
--
--   reading    -- the Edge Function, on every forwarded reading. It is
--                 authoritative about liveness: it may set status,
--                 last_reading_at and lux.
--   assignment -- the Manager/Admin screens, reassigning a sensor to a
--                 greenhouse. It knows NOTHING about liveness. Letting
--                 it stamp status='online' and last_reading_at=now()
--                 would forge liveness: a manager could keep a dead
--                 sensor looking healthy, reset its offline countdown,
--                 and -- because the section 1 policy keys on
--                 status='online' -- re-open aggregates for it.
--
-- p_reading is the switch. It DEFAULTS TO TRUE, so the spec's reading
-- call shape keeps working unchanged and a caller that forgets the flag
-- on the ingest path still behaves correctly. An assignment MUST pass
-- p_reading => false; on that path status, last_reading_at and lux are
-- left untouched, and a brand-new row is created as 'offline'.
--
-- For the same reason p_lux is no longer a required argument: an
-- assignment has no lux to report. It is required only when
-- p_reading is true, and that requirement is enforced below with a
-- clear error rather than a NOT NULL violation on the column.
--
-- TIMESTAMP SEMANTICS
--
-- last_reading_at is stamped with clock_timestamp(), not now(). now()
-- is the TRANSACTION start time, so two concurrent readings for one
-- sensor can stamp the row backwards: A begins at T1, B begins at
-- T2 > T1, B commits first and A commits second, and the row ends up
-- carrying T1 < T2. The unique index on sensor_id serialises them so
-- nothing corrupts, but "latest reading" moves backwards, and
-- check_sensor_offline() (0012) compares that stamp against the
-- offline threshold -- so an actively-reporting sensor can be marked
-- offline by a transaction that merely held the row lock across a lock
-- wait. clock_timestamp() is the actual wall clock at the moment of
-- the write, so the later writer always stamps the later time.
-- ============================================================

create or replace function public.update_sensor_list(
    p_sensor_id text,
    p_lux numeric default null,
    p_greenhouse_id text default null,
    p_clear_greenhouse boolean default false,
    p_reading boolean default true
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

    if p_reading and (p_lux is null or p_lux < 0) then
        raise exception 'lux must be a non-negative number on the reading path (p_reading => true)';
    end if;

    -- Contradictory input. Without this, "assign gh-001 AND clear the
    -- assignment" is silently resolved by the CASE precedence below,
    -- AFTER the greenhouse existence check has already run, so the
    -- caller gets no signal that the two halves disagreed.
    if p_greenhouse_id is not null and p_clear_greenhouse then
        raise exception 'p_greenhouse_id and p_clear_greenhouse cannot both be set: pass a greenhouse to assign, or p_clear_greenhouse => true to unassign';
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
        -- An assignment creates the row as 'offline' with the column
        -- default lux, never as a healthy sensor.
        case when p_reading then p_lux else 0 end,
        case when p_reading then 'online' else 'offline' end,
        clock_timestamp(),
        p_greenhouse_id
    )
    on conflict (sensor_id) do update set
        -- Liveness and lux are written ONLY by the reading path.
        -- An assignment leaves them exactly as they were, so it can
        -- never resurrect a dead sensor or reset its offline countdown.
        lux = case when p_reading then excluded.lux else sl.lux end,
        status = case when p_reading then 'online' else sl.status end,
        last_reading_at = case
            when p_reading then excluded.last_reading_at
            else sl.last_reading_at
        end,
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
revoke execute on function public.update_sensor_list(text, numeric, text, boolean, boolean)
    from public;

grant execute on function public.update_sensor_list(text, numeric, text, boolean, boolean)
    to authenticated, service_role;

-- There is deliberately NO separate three-argument overload of this
-- function. Both overloads would carry defaults on p_greenhouse_id,
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
-- on conflict (sensor_id, bucket_start) -- the 0002 constraint
-- sensor_minute_aggregates_sensor_bucket_unique -- is what makes two
-- readings for the same sensor in the same minute collapse onto one
-- row instead of creating a second one.
--
-- CALLER CONTRACT (the merge is ADDITIVE; the caller must send a DELTA)
--
-- The conflict clause below merges, it does not overwrite:
--
--   sample_count, safe_count, warning_count, violation_count
--       summed
--   min_lux  -> least(existing, incoming)
--   max_lux  -> greatest(existing, incoming)
--   avg_lux  -> recomputed as the sample-count-weighted mean
--
-- That is the only merge that is correct for the concurrency this
-- column pair exists to absorb (plan Review Focus #1: two readings
-- for one sensor in one minute). An overwrite would let the second
-- writer silently discard the first writer's samples, and because the
-- unique constraint then makes the discarded samples unrecoverable,
-- the loss is permanent. Under the merge, both readings survive no
-- matter which one commits last.
--
-- THE CALLER THEREFORE MUST SEND THE DELTA -- the counts and lux
-- contributed by THIS batch of readings, not a running total for the
-- whole minute. Sending a running total is the one way to get this
-- wrong, and it double-counts: two calls of sample_count=6 for the
-- same minute yield 12, not 6. This is a genuine change of contract
-- versus the Pi's old direct PostgREST write, which sent a full
-- per-minute recomputation and relied on overwrite semantics. Task 2
-- (the Edge Function) must therefore accumulate its own running
-- totals and send the increment, or send exactly one call per
-- completed minute. Both are safe; sending a running total is not.
--
-- greenhouse_id is deliberately NOT rewritten on conflict. An
-- aggregate row is immutable history: if a manager reassigns a sensor
-- mid-minute (Review Focus #3), the row already written for that
-- minute describes readings physically taken in the OLD greenhouse
-- and must keep saying so. Relabelling it would retroactively move
-- history between greenhouses. New rows pick up the current
-- assignment from sensor_list.
--
-- phase_type is likewise not rewritten, for the same reason: the
-- phase in force when the minute's readings were taken is a fact
-- about the past, not a current setting.
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
        -- This duplicates the table's own sensor_minute_aggregates_phase_check
        -- constraint (0002) on purpose. The constraint would reject the row
        -- anyway, but only after the sensor_list lookup below has already
        -- run; checking here fails the bad input before any work is done
        -- and produces a message naming the actual problem.
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

    -- Aliased as `sma` so the conflict clause below can read the
    -- EXISTING row's values. Without an alias the target table's name
    -- would shadow the reference and Postgres would reject it.
    insert into public.sensor_minute_aggregates as sma (
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
        -- Merge, do not overwrite. See the CALLER CONTRACT note above:
        -- these are deltas contributed by this batch of readings.
        --
        -- `sma` is the existing row, `excluded` is the incoming delta.
        --
        -- Counts sum. The classification counts and the sample count
        -- are all "how many readings in this bucket were X", so two
        -- batches of 3 safe readings correctly yield 6, and two
        -- batches of 2 violation readings correctly yield 4.
        sample_count = sma.sample_count + excluded.sample_count,
        safe_count = sma.safe_count + excluded.safe_count,
        warning_count = sma.warning_count + excluded.warning_count,
        violation_count = sma.violation_count + excluded.violation_count,

        -- min/max fold: the bucket minimum is the smaller of the two
        -- minima, the maximum the larger. This is associative and
        -- commutative, so it is correct regardless of commit order.
        min_lux = least(sma.min_lux, excluded.min_lux),
        max_lux = greatest(sma.max_lux, excluded.max_lux),

        -- The average is NOT the average of the averages. It is
        -- rebuilt from the running total of (sum of lux) implied by
        -- each side's own average and sample count:
        --
        --   (sma.avg_lux * sma.sample_count + excluded.avg_lux * excluded.sample_count)
        --   -----------------------------------------------------------------------
        --                     sma.sample_count + excluded.sample_count
        --
        -- which is the correct weighted mean. A naive
        -- (sma.avg_lux + excluded.avg_lux) / 2 would be wrong the
        -- moment the two batches differ in size, which is the common
        -- case (e.g. 2 readings at 10 lux then 6 readings at 20 lux
        -- gives 17.5, not 15).
        --
        -- The CASE guards a zero denominator. It is unreachable via
        -- the normal path (0002 requires sample_count >= 0, and this
        -- function's own guard chain means the first insert of a
        -- bucket already carries at least one sample when callers
        -- honour the delta contract), but a caller that posts
        -- sample_count = 0 twice would otherwise raise "division by
        -- zero" from inside the conflict clause. Falling back to the
        -- incoming average keeps the NOT NULL constraint satisfied.
        -- A CASE is used rather than nullif(...) coalesce(...) so the
        -- division is never evaluated at all on that path -- SQL does
        -- not promise short-circuiting inside an expression tree.
        avg_lux = case
            when (sma.sample_count + excluded.sample_count) = 0
                then excluded.avg_lux
            else round(
                (
                    (sma.avg_lux * sma.sample_count)
                    + (excluded.avg_lux * excluded.sample_count)
                ) / (sma.sample_count + excluded.sample_count),
                3
            )
        end,

        -- greenhouse_id and phase_type are intentionally absent from
        -- this SET list: on conflict they keep their existing values.
        -- An aggregate row is immutable history of where those
        -- readings were physically taken and under which phase; a
        -- mid-minute reassignment must not retroactively relabel it.
        -- (Minor 14, plan Review Focus #3.)

        -- updated_at: kept in step with the other columns, but note
        -- it is effectively write-only. trg_sensor_minute_aggregates_updated_at
        -- (0002) is a BEFORE UPDATE trigger that sets new.updated_at =
        -- now() on every update, so whatever value is assigned here is
        -- overwritten a moment later. p_updated_at is still accepted
        -- because the Pi's payload carries it and dropping the
        -- parameter would break that payload shape.
        updated_at = excluded.updated_at
    returning * into v_result;

    return v_result;
end;
$$;

-- Grant narrowed to service_role only. The plan states Edge Functions
-- authenticate with the service role, and no frontend caller needs
-- this: a signed-in user writing aggregate history is not a use case
-- this project has. `revoke ... from public` first, because every role
-- is a member of PUBLIC and new functions get EXECUTE for PUBLIC by
-- default.
revoke execute on function public.upsert_minute_aggregate(
    text, text, timestamptz, text, integer, numeric, numeric, numeric,
    integer, integer, integer, timestamptz
) from public;

grant execute on function public.upsert_minute_aggregate(
    text, text, timestamptz, text, integer, numeric, numeric, numeric,
    integer, integer, integer, timestamptz
) to service_role;


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
