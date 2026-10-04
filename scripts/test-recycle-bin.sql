\set ON_ERROR_STOP on
-- Exercise the hosted deletion guard, role checks, and returned deletion count.
load 'safeupdate';
set safeupdate.enabled = on;
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','trash-manager@example.invalid','{}'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','trash-admin@example.invalid','{}');
update public.profiles set role='manager' where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
update public.profiles set role='admin' where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
insert into public.greenhouses(id,name,phase_start,phase_end,window_start,window_end)
values('trash-active','Active greenhouse',current_date,current_date+2,'23:00','05:00');
insert into public.greenhouse_recycle_bin(greenhouse_id,name,config)
values('trash-G1','Deleted one','{}'),('trash-G2','Deleted two','{}');
do $$
begin
    begin
        -- Reproduce the original function's error with the guard enabled.
        delete from public.greenhouse_recycle_bin;
        raise exception 'Deletion guard did not reject the original query';
    exception when sqlstate '21000' then
        if SQLERRM not like '%WHERE clause%' then raise; end if;
    end;
end;
$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
do $$
begin
    if public.empty_greenhouse_recycle_bin() <> 2 then raise exception 'Manager deletion count incorrect'; end if;
    if public.empty_greenhouse_recycle_bin() <> 0 then raise exception 'Empty trash is not idempotent'; end if;
    if exists(select 1 from public.greenhouse_recycle_bin) then raise exception 'Trash was not emptied'; end if;
    if not exists(select 1 from public.greenhouses where id='trash-active') then raise exception 'Active greenhouse was deleted'; end if;
end;
$$;
reset role;
insert into public.greenhouse_recycle_bin(greenhouse_id,name,config) values('trash-G3','Deleted three','{}');
set local role authenticated;
select set_config('request.jwt.claim.sub','cccccccc-cccc-4ccc-8ccc-cccccccccccc',true);
do $$
begin
    begin
        perform public.empty_greenhouse_recycle_bin();
        raise exception 'Unapproved user emptied trash';
    exception when raise_exception then
        if SQLERRM <> 'Not authorized to manage the recycle bin' then raise; end if;
    end;
end;
$$;
select set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
do $$
begin
    if public.empty_greenhouse_recycle_bin() <> 1 then raise exception 'Admin deletion count incorrect'; end if;
    if has_function_privilege('anon','public.empty_greenhouse_recycle_bin()','execute') then raise exception 'Anonymous trash access granted'; end if;
end;
$$;
rollback;
\echo 'Recycle bin: guarded deletion, manager/admin authorization, exact counts, and active greenhouse preservation passed.'
