-- ============================================================
-- LPMAS - REMOVE TECHNICIAN ROLE
-- Migration 0003
-- ============================================================
--
-- FINAL AUTHENTICATED ROLES:
--
--   admin
--   manager
--
-- PUBLIC MONITORING:
--
--   /monitor
--
-- The old "technician" role is no longer part of the
-- authenticated application architecture.
--
-- IMPORTANT:
-- This migration intentionally stops if existing profiles
-- still use the technician role.
--
-- We do NOT automatically convert technician accounts to
-- manager accounts because that could grant unintended
-- privileges to an existing account.
-- ============================================================


-- ============================================================
-- 1. SAFETY CHECK
-- ============================================================
--
-- Before removing the enum value, make sure there are no
-- existing profiles still assigned to technician.
--
-- If this raises an error, inspect the affected accounts
-- first instead of automatically promoting them.
-- ============================================================

do $$
declare
    technician_count integer;
begin
    select count(*)
    into technician_count
    from public.profiles
    where role::text = 'technician';

    if technician_count > 0 then
        raise exception
            'Cannot remove technician role: % profile(s) still use technician. Review and migrate those accounts to admin or manager first.',
            technician_count;
    end if;
end
$$;


-- ============================================================
-- 2. CREATE THE FINAL ROLE ENUM
-- ============================================================

create type public.user_role_v2 as enum (
    'admin',
    'manager'
);


-- ============================================================
-- 3. CHANGE PROFILES.ROLE TO THE NEW ENUM
-- ============================================================

alter table public.profiles
    alter column role drop default;


alter table public.profiles
    alter column role type public.user_role_v2
    using role::text::public.user_role_v2;


-- ============================================================
-- 4. RESTORE A SAFE DEFAULT
-- ============================================================
--
-- New authenticated accounts should not become technician
-- accounts because that role no longer exists.
--
-- The Admin API explicitly assigns the intended role when
-- inviting a user.
--
-- Manager is used as the database default only as a fallback
-- for profile creation. Admin-created users should always
-- receive their explicit role from the application.
-- ============================================================

alter table public.profiles
    alter column role set default 'manager'::public.user_role_v2;


-- ============================================================
-- 5. REMOVE THE OLD ENUM
-- ============================================================

drop type public.user_role;


-- ============================================================
-- 6. RENAME THE FINAL ENUM
-- ============================================================

alter type public.user_role_v2
    rename to user_role;


-- ============================================================
-- 7. UPDATE THE NEW-USER PROFILE TRIGGER
-- ============================================================
--
-- The old trigger created every new profile as:
--
--     technician
--
-- That is no longer valid.
--
-- New profiles now default to manager.
--
-- The Admin API will subsequently set the explicitly
-- requested role when an administrator invites a user.
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.profiles (
        id,
        full_name,
        role
    )
    values (
        new.id,
        new.raw_user_meta_data->>'full_name',
        'manager'
    )
    on conflict (id) do nothing;

    return new;
end;
$$;


-- ============================================================
-- 8. RECREATE THE AUTH USER TRIGGER SAFELY
-- ============================================================

drop trigger if exists on_auth_user_created
    on auth.users;


create trigger on_auth_user_created
    after insert on auth.users
    for each row
    execute function public.handle_new_user();


-- ============================================================
-- 9. VERIFY THE RESULT
-- ============================================================

select
    t.typname as enum_name,
    e.enumlabel as role
from pg_type t
join pg_enum e
    on t.oid = e.enumtypid
where t.typname = 'user_role'
order by e.enumsortorder;


select
    role,
    count(*) as profile_count
from public.profiles
group by role
order by role;