-- Gate minute aggregates on the greenhouse monitoring time window.
--
-- The window was stored and displayed but never enforced: the Pi used it only
-- to relabel illumination-phase classifications, forwarded every reading
-- regardless of the hour, and this function never read it. So aggregates
-- accumulated 24 hours a day -- polluting the tables, the trend charts, and
-- the violation_count >= 3 SMS trigger.
--
-- The check lives here rather than in the Edge Function because this is the
-- only choke point that creates aggregate rows, so no caller can bypass it.
--
-- The window bounds BOTH phases. Out-of-window skips rather than raises: an
-- out-of-window reading is normal for most of the day, and raising would make
-- the Pi retry it as a contract violation. With no greenhouse row there is no
-- window to enforce, so the aggregate is stored unfiltered.
--
-- The comparison branches on start <= end because a 23:00 -> 05:00 window
-- wraps midnight, and the naive range test is empty for that entire range.
-- Times are read in Asia/Manila to match the Pi; a UTC comparison would shift
-- every boundary by eight hours.

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
    v_window_start time;
    v_window_end time;
    v_bucket_local time;
    v_within_window boolean;
    v_existing public.sensor_minute_aggregates;
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

    -- Lux is validated, not defaulted; see 0011 for the full reasoning. A
    -- silent 0 would be indistinguishable from a real reading of zero lux and
    -- would corrupt the chart data this pipeline exists to produce.
    if p_avg_lux is null or p_min_lux is null or p_max_lux is null then
        raise exception 'avg_lux, min_lux and max_lux are all required and must not be null';
    end if;

    if p_avg_lux < 0 or p_min_lux < 0 or p_max_lux < 0 then
        raise exception 'avg_lux, min_lux and max_lux must all be non-negative';
    end if;

    if p_min_lux > p_max_lux then
        raise exception 'min_lux (%) must not be greater than max_lux (%)', p_min_lux, p_max_lux;
    end if;

    -- sensor_list is the authority on liveness and assignment; see 0011.
    select sl.greenhouse_id, sl.status
    into v_greenhouse_id, v_status
    from public.sensor_list sl
    where sl.sensor_id = p_sensor_id;

    if not found then
        raise exception 'Sensor % is not present in the sensor list', p_sensor_id;
    end if;

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

    -- The window belongs to the greenhouse the sensor is actually assigned to,
    -- not the one the caller claimed, for the same reason as above.
    select g.window_start, g.window_end
    into v_window_start, v_window_end
    from public.greenhouses g
    where g.id = v_greenhouse_id;

    if found and v_window_start is not null and v_window_end is not null then
        v_bucket_local := (p_bucket_start at time zone 'Asia/Manila')::time;

        -- The wrap branch is what makes an overnight window work: for
        -- 23:00 -> 05:00 the simple range test is always false, so without
        -- this the post-midnight half of the window would be dropped.
        if v_window_start <= v_window_end then
            v_within_window := v_bucket_local between v_window_start and v_window_end;
        else
            v_within_window := v_bucket_local >= v_window_start or v_bucket_local <= v_window_end;
        end if;

        if not v_within_window then
            -- Return the existing row so the caller gets a well-formed result,
            -- and without merging: an out-of-window reading must not add to a
            -- bucket an earlier in-window reading created.
            select sma.*
            into v_existing
            from public.sensor_minute_aggregates sma
            where sma.sensor_id = p_sensor_id
              and sma.bucket_start = p_bucket_start;

            if found then
                return v_existing;
            end if;

            -- Nothing to return and nothing to write. A null result is not an
            -- error: ingest-reading treats it as "nothing was stored", which is
            -- true, and still records the raw reading.
            return null;
        end if;
    end if;

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
        sample_count = sma.sample_count + excluded.sample_count,
        safe_count = sma.safe_count + excluded.safe_count,
        warning_count = sma.warning_count + excluded.warning_count,
        violation_count = sma.violation_count + excluded.violation_count,
        min_lux = least(sma.min_lux, excluded.min_lux),
        max_lux = greatest(sma.max_lux, excluded.max_lux),
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
        updated_at = excluded.updated_at
    returning * into v_result;

    return v_result;
end;
$$;


-- ============================================================
-- VERIFICATION
-- ============================================================

-- Existing out-of-window rows are NOT removed by this migration: it changes
-- what is written from now on. To see how much history sits outside the
-- configured windows before deciding whether to clean it:
--
--    select g.id, g.window_start, g.window_end, count(*)
--    from public.sensor_minute_aggregates a
--    join public.greenhouses g on g.id = a.greenhouse_id
--    where not (
--        (g.window_start <= g.window_end
--         and (a.bucket_start at time zone 'Asia/Manila')::time
--             between g.window_start and g.window_end)
--        or
--        (g.window_start > g.window_end
--         and ((a.bucket_start at time zone 'Asia/Manila')::time >= g.window_start
--              or (a.bucket_start at time zone 'Asia/Manila')::time <= g.window_end))
--    )
--    group by 1, 2, 3;