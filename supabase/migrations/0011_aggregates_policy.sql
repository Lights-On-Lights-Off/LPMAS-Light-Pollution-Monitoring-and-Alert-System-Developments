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
-- The goal is that last_reading_at only ever moves FORWARD, because
-- check_sensor_offline() (0012) reads it as "when did this sensor last
-- report?" and flips the sensor offline when it falls behind the
-- threshold. A stamp that moves backwards reports a live sensor as
-- stale.
--
-- now() is unusable for this: it is the TRANSACTION start time, so a
-- transaction that begins early and then blocks on a lock can commit a
-- stamp arbitrarily older than the one it replaced.
--
-- clock_timestamp() in the VALUES list is better but NOT sufficient on
-- its own. INSERT ... ON CONFLICT DO UPDATE forms the proposed
-- (`excluded`) tuple BEFORE it attempts the speculative insertion and
-- waits on the blocking transaction. So the VALUES-list stamp is
-- captured before the lock wait, and the interleaving still lands
-- backwards:
--
--     A forms its tuple at T1, is descheduled
--     B forms at T2 > T1, takes the lock, commits (row now = T2)
--     A resumes, DO UPDATE fires with excluded.last_reading_at = T1
--     -> the row ends stamped T1 < T2.  Backwards.
--
-- The conflict clause therefore does NOT reuse excluded.last_reading_at.
-- It computes greatest(sl.last_reading_at, clock_timestamp()):
--
--   * clock_timestamp() in the SET list is evaluated after the lock has
--     been acquired, so it is a genuine "now" for the writer that
--     actually wins the row;
--   * greatest() then makes the result monotonic in the stored value
--     regardless of when the tuple was formed. If the winner's clock
--     reads earlier than what is already stored -- clock skew between
--     the writer's clock and whatever stamped the row, or a stale value
--     left by an older code path -- the existing stamp is kept instead
--     of regressing.
--
-- The guarantee this actually provides, stated precisely: a call on the
-- reading path never lowers last_reading_at. It does NOT guarantee the
-- stamp equals the moment the reading arrived; it guarantees it is
-- monotonic and never regresses. On the INSERT path there is no
-- existing row, so the VALUES-list clock_timestamp() is used directly
-- and the greatest() expression is never evaluated.
--
-- The trade-off that buys monotonicity: because the stamp can only
-- move forward, a value that is ever set in the future -- by clock skew
-- or a bad writer -- cannot be corrected downwards by later readings.
-- Until the wall clock catches up, check_sensor_offline() (0012) will
-- not consider that sensor stale, so a dead sensor can stay "online"
-- for that period. This is inherent to preferring a false negative
-- (a live sensor briefly shown stale) over a false positive (a dead
-- sensor shown healthy); the skew would have to be large, not
-- marginal, for the outage to be noticeable.
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
        -- INSERT path only. There is no existing row to compare
        -- against here, so the conflict clause below (which is what
        -- guarantees monotonicity) never runs. On a conflict this
        -- value becomes excluded.last_reading_at and is deliberately
        -- ignored in favour of greatest(sl.last_reading_at,
        -- clock_timestamp()) -- see TIMESTAMP SEMANTICS above.
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
            -- Deliberately NOT excluded.last_reading_at. That value is
            -- captured when the proposed tuple is formed, which happens
            -- BEFORE this statement waits on the blocking transaction,
            -- so reusing it can stamp the row backwards. See
            -- TIMESTAMP SEMANTICS in the header for the interleaving.
            --
            -- clock_timestamp() here is evaluated after the lock is
            -- acquired, and greatest() makes the stored stamp
            -- monotonic in the existing value, so the last writer can
            -- never regress "when did this sensor last report?".
            --
            -- Reachable only on the conflict path, so `sl` (the
            -- existing row) is guaranteed non-null here.
            when p_reading then greatest(sl.last_reading_at, clock_timestamp())
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

    -- Lux is validated, not defaulted.
    --
    -- The three count parameters below are coalesce()d to 0, and it is
    -- tempting to treat the lux arguments the same way. That would be
    -- wrong here: 0002 declares avg_lux/min_lux/max_lux NOT NULL, and
    -- a silent 0 would be indistinguishable from a real reading of zero
    -- lux. A caller that forgot to send the lux values would write a
    -- plausible-looking row that drags the bucket's minimum to zero and
    -- its average toward zero -- corrupting the chart data this whole
    -- pipeline exists to produce, with no error anywhere.
    --
    -- Rejecting the null explicitly is also the only way to keep the
    -- conflict clause's avg_lux zero-denominator fallback sound: that
    -- CASE returns excluded.avg_lux, which would itself be NULL for a
    -- null-lux caller and violate the NOT NULL constraint from inside
    -- the SET list.
    if p_avg_lux is null or p_min_lux is null or p_max_lux is null then
        raise exception 'avg_lux, min_lux and max_lux are all required and must not be null';
    end if;

    -- 0002's sensor_minute_aggregates_lux_check also enforces
    -- avg/min/max >= 0 and min <= max. Repeating the range and ordering
    -- check here rejects the input before the sensor_list lookup and
    -- names the actual problem, rather than surfacing a bare constraint
    -- violation after the work has been done.
    if p_avg_lux < 0 or p_min_lux < 0 or p_max_lux < 0 then
        raise exception 'avg_lux, min_lux and max_lux must all be non-negative';
    end if;

    if p_min_lux > p_max_lux then
        raise exception 'min_lux (%) must not be greater than max_lux (%)', p_min_lux, p_max_lux;
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
        --
        -- NOT NULL on both sides is guaranteed by the explicit null
        -- rejection near the top of this function, so neither operand
        -- can be null here. (PostgreSQL's least()/greatest() ignore
        -- nulls rather than propagating them, so a null would silently
        -- degrade to the other side instead of erroring -- which is
        -- exactly why the input is rejected up front.)
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
