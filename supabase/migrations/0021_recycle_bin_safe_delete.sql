-- Standalone recycle-bin repair; no Pi or notification protocol changes.
-- Keep safeupdate enabled while explicitly targeting all recycle-bin entries.
create or replace function public.empty_greenhouse_recycle_bin()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_role text;
    v_count integer;
begin
    select p.role::text into v_role from public.profiles p where p.id = auth.uid();
    if v_role is null or v_role not in ('admin', 'manager') then
        raise exception 'Not authorized to manage the recycle bin';
    end if;

    delete from public.greenhouse_recycle_bin where id is not null;
    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

revoke all on function public.empty_greenhouse_recycle_bin() from public, anon;
grant execute on function public.empty_greenhouse_recycle_bin() to authenticated;
