-- ============================================================
-- LPMAS - EMPTY RECYCLE BIN
--
-- greenhouse_recycle_bin previously supported SELECT and INSERT only
-- (storage/listing only, by design in 0006_greenhouse_config.sql).
-- This adds a security-definer RPC to permanently clear it, matching
-- the same role-check pattern as upsert_greenhouse()/delete_greenhouse().
-- Direct client DELETEs remain blocked by the existing RLS policy.
-- ============================================================

grant delete on public.greenhouse_recycle_bin to authenticated;

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

    select count(*) into v_count from public.greenhouse_recycle_bin;
    delete from public.greenhouse_recycle_bin;

    return v_count;
end;
$$;

grant execute on function public.empty_greenhouse_recycle_bin() to authenticated;
