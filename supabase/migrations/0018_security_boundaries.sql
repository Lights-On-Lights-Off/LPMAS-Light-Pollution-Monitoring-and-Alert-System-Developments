-- A scoped gateway reads one consistent configuration snapshot. It never exposes
-- SMS credentials, account records, or arbitrary database queries to the Pi.
create function public.pi_configuration() returns jsonb
language sql stable security definer set search_path=public as $$
select jsonb_build_object(
    'greenhouses', coalesce((select jsonb_agg(jsonb_build_object(
        'id',id,'name',name,'phase_start',phase_start,'phase_end',phase_end,
        'window_start',window_start,'window_end',window_end,'is_active',is_active,'updated_at',updated_at
    )) from public.greenhouses where is_active),'[]'::jsonb),
    'greenhouse_sensors', coalesce((select jsonb_agg(jsonb_build_object('greenhouse_id',s.greenhouse_id,'sensor_id',s.sensor_id))
        from public.greenhouse_sensors s join public.greenhouses g on g.id=s.greenhouse_id where g.is_active),'[]'::jsonb),
    'sensor_list', coalesce((select jsonb_agg(jsonb_build_object('sensor_id',sensor_id)) from public.sensor_list),'[]'::jsonb),
    'dark_phase_days',coalesce((select value::integer from public.system_settings where key='dark_phase_duration_days'),60)
);
$$;
revoke execute on function public.pi_configuration() from public,anon,authenticated;
grant execute on function public.pi_configuration() to service_role;

-- Anonymous visitors need recent monitoring context, not the complete archive.
drop policy "Public monitor reads aggregate history" on public.sensor_minute_aggregates;
create policy "Public monitor reads aggregate history" on public.sensor_minute_aggregates
    for select to anon using (bucket_start >= now()-interval '24 hours');
drop policy "Public monitor reads incident history" on public.monitoring_incidents;
create policy "Public monitor reads incident history" on public.monitoring_incidents
    for select to anon using (status in ('open','acknowledged') or opened_at >= now()-interval '24 hours');
