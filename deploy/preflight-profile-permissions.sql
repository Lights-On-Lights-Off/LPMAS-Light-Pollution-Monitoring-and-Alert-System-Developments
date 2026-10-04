-- Compatible pre-cutover hardening; migration 0016 repeats these grants.
-- Apply only to the confirmed LPMAS database after saving a schema backup.
begin;
revoke update on public.profiles from authenticated;
grant update(full_name) on public.profiles to authenticated;
do $$
begin
  if has_column_privilege('authenticated','public.profiles','role','update') then
    raise exception 'Authenticated users retain role-update access';
  end if;
  if not has_column_privilege('authenticated','public.profiles','full_name','update') then
    raise exception 'Own-profile name edits lost access';
  end if;
end;
$$;
commit;
select has_column_privilege('authenticated','public.profiles','role','update') as users_can_change_role,
       has_column_privilege('authenticated','public.profiles','full_name','update') as users_can_edit_name;
