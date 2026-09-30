-- ============================================================
-- LPMAS - SENSOR LIST (CLOUD SOURCE OF TRUTH FOR SENSOR STATE)
-- Migration 0009
--
-- WHY THIS TABLE
--
-- Until now sensor state lived in three disconnected places:
--
--   1. Raspberry Pi SQLite        raw 10-second readings
--   2. public.greenhouse_sensors which sensor is *assigned* where
--   3. public.sensor_minute_aggregates completed minute summaries
--
-- Nothing on the cloud said whether a sensor was actually reachable
-- right now, and nothing linked "sensor is online" to "sensor is
-- assigned to a greenhouse". sensor_list is that missing link: one
-- row per physical sensor, written on every reading by the
-- ingest-reading Edge Function (see supabase/functions/ingest-reading).
--
-- It is deliberately small and deliberately NOT the reading history:
-- history stays in sensor_minute_aggregates. sensor_list answers only
-- "is this sensor alive, how bright is it, and where is it mounted".
--
-- WRITE PATH
--
-- As with greenhouses (0006) and sensor_minute_aggregates (0002),
-- direct anon/authenticated writes are blocked. The only supported
-- write is the security-definer RPC public.update_sensor_list(),
-- created in 0011_aggregates_policy.sql because it is only meaningful
-- together with the aggregate write it feeds.
--
-- READ PATH
--
-- The public, unauthenticated /monitor page needs the sensor list to
-- render "Available Sensors", so SELECT is open to anon exactly like
-- greenhouses/greenhouse_sensors in 0006.
-- ============================================================


-- ============================================================
-- 1. SENSOR LIST TABLE
-- ============================================================
-- lux          latest lux value the Pi forwarded for this sensor
-- status       'online' once a reading lands, flipped back to
--              'offline' by public.check_sensor_offline() (0012)
-- last_reading_at
--              drives that offline decision, so it is indexed
--              descending for "freshest sensors" style queries
-- greenhouse_id
--              the manager's assignment. References greenhouses(id),
--              which is text, so the FK is text -> text. A sensor may
--              be known without being assigned (greenhouse_id null);
--              only assigned sensors produce cloud aggregates.
-- ============================================================

create table if not exists public.sensor_list (
    sensor_id text primary key,

    lux numeric(12,3) not null default 0,

    status text not null default 'offline',

    last_reading_at timestamptz not null default now(),

    -- on delete set null is a deliberate addition to the design spec's
    -- bare "references public.greenhouses(id)". delete_greenhouse() in
    -- 0006_greenhouse_config.sql deletes the greenhouse row; with a
    -- plain FK, the first manager to delete a greenhouse that has an
    -- assigned sensor would get a foreign-key violation instead of a
    -- successful delete. Nulling the assignment keeps the sensor in
    -- sensor_list (it is still a real device that reports readings) and
    -- correctly stops it producing aggregates, because both the INSERT
    -- policy and upsert_minute_aggregate() require a non-null
    -- greenhouse_id.
    greenhouse_id text references public.greenhouses(id) on delete set null,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint sensor_list_status_check
        check (status in ('online', 'offline')),

    constraint sensor_list_sensor_id_check
        check (length(trim(sensor_id)) > 0),

    -- Negative lux is a sensor/calibration fault, never a real value,
    -- and the same rule is already enforced on the aggregate lux
    -- columns in 0002.
    constraint sensor_list_lux_check
        check (lux >= 0)
);


-- ============================================================
-- 2. INDEXES
-- ============================================================

-- Manager/Admin assignment views filter by greenhouse.
create index if not exists idx_sensor_list_greenhouse
    on public.sensor_list (greenhouse_id);

-- The offline cron job and the Monitor page filter by status.
create index if not exists idx_sensor_list_status
    on public.sensor_list (status);

-- "Freshest readings" ordering, and the supporting index shape for
-- the last_reading_at < cutoff scan that check_sensor_offline() runs
-- every 30 seconds.
create index if not exists idx_sensor_list_last_reading
    on public.sensor_list (last_reading_at desc);


-- ============================================================
-- 3. ROW LEVEL SECURITY
-- ============================================================

alter table public.sensor_list
    enable row level security;


-- ------------------------------------------------------------
-- SENSOR LIST POLICIES
-- ------------------------------------------------------------
-- SELECT is public: the unauthenticated /monitor page renders live
-- sensor availability, same rationale as 0006.
--
-- Everything else is explicitly denied to authenticated users. RLS
-- would deny it anyway (no permissive policy = no rows), but stating
-- it means a future accidental "grant all" or a copy-pasted policy
-- from another table cannot quietly open the write path. The
-- Edge Function uses the service role, which bypasses RLS entirely.
-- ------------------------------------------------------------

drop policy if exists "Anyone can view sensor list" on public.sensor_list;

create policy "Anyone can view sensor list"
on public.sensor_list
for select
to anon, authenticated
using (true);


drop policy if exists "Authenticated users cannot write sensor list directly"
    on public.sensor_list;

create policy "Authenticated users cannot write sensor list directly"
on public.sensor_list
for all
to authenticated
using (false)
with check (false);


-- ============================================================
-- 4. EXPLICIT POSTGREST GRANTS
-- ============================================================
-- Same reasoning as section 5 of 0006_greenhouse_config.sql: Supabase
-- is rolling out a requirement for explicit grants on new tables for
-- PostgREST to see them at all. RLS above still governs row access.
--
-- insert/update are granted because the brief asks for it and 0006
-- sets the same convention for the tables its RPCs write. They are
-- NOT what makes update_sensor_list() work: that function is SECURITY
-- DEFINER and runs as its owner, so it never depends on the caller's
-- table grants. The grants exist so PostgREST exposes the columns to
-- the roles at all, while the deny-all policy above -- not the grant --
-- is what actually blocks a direct client write.
-- ============================================================

grant select on public.sensor_list to anon, authenticated;
grant insert, update on public.sensor_list to authenticated;


-- ============================================================
-- 5. UPDATED_AT AUTOMATICALLY REFRESHES
-- ============================================================
-- Reuses public.set_updated_at() from 0002_monitoring_data.sql rather
-- than defining a second copy of the same trigger function.
-- ============================================================

drop trigger if exists trg_sensor_list_updated_at
    on public.sensor_list;

create trigger trg_sensor_list_updated_at
before update on public.sensor_list
for each row
execute function public.set_updated_at();


-- ============================================================
-- 6. VERIFICATION
-- ============================================================

select
    column_name,
    data_type,
    is_nullable,
    column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'sensor_list'
order by ordinal_position;

-- Current sensor state, newest reading first:
--
-- select sensor_id, greenhouse_id, status, lux, last_reading_at
-- from public.sensor_list
-- order by last_reading_at desc;


-- ============================================================
-- END OF SENSOR LIST
-- ============================================================
