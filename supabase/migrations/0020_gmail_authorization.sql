-- Gmail refresh tokens are encrypted by Vault, never stored in system_settings.
create extension if not exists supabase_vault with schema vault;
create schema if not exists lpmas_private;
revoke all on schema lpmas_private from public,anon,authenticated,service_role;
create table lpmas_private.gmail_authorization (
    singleton boolean primary key default true check(singleton),
    admin_user_id uuid not null references auth.users(id),
    sender_email text not null,
    refresh_secret_id uuid not null,
    updated_at timestamptz not null default now()
);
revoke all on lpmas_private.gmail_authorization from public,anon,authenticated,service_role;

create function public.set_gmail_authorization(p_admin_user_id uuid,p_sender_email text,p_refresh_token text) returns void
language plpgsql security definer set search_path=public as $$
declare secret_id uuid;
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
    if not exists(select 1 from auth.users u join public.profiles p on p.id=u.id
      where u.id=p_admin_user_id and p.role::text='admin' and u.email_confirmed_at is not null and lower(u.email)=lower(p_sender_email)) then
      raise exception 'Verified administrator sender required';
    end if;
    if length(p_refresh_token) < 20 or length(p_refresh_token) > 8192 then raise exception 'Invalid authorization'; end if;
    -- Serialize authorization replacement, including an initially empty table.
    perform pg_advisory_xact_lock(190020);
    select refresh_secret_id into secret_id from lpmas_private.gmail_authorization where singleton=true;
    if secret_id is null then
      select vault.create_secret(p_refresh_token,'lpmas_gmail_refresh_token') into secret_id;
    else
      perform vault.update_secret(secret_id,p_refresh_token);
    end if;
    insert into lpmas_private.gmail_authorization(singleton,admin_user_id,sender_email,refresh_secret_id)
    values(true,p_admin_user_id,lower(p_sender_email),secret_id)
    on conflict(singleton) do update set admin_user_id=excluded.admin_user_id,sender_email=excluded.sender_email,refresh_secret_id=excluded.refresh_secret_id,updated_at=now();
end;
$$;
create function public.get_gmail_authorization() returns jsonb
language plpgsql security definer set search_path=public as $$
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
    return (select jsonb_build_object('sender_email',a.sender_email,'refresh_token',s.decrypted_secret)
      from lpmas_private.gmail_authorization a join vault.decrypted_secrets s on s.id=a.refresh_secret_id
      join auth.users u on u.id=a.admin_user_id join public.profiles p on p.id=u.id
      where p.role::text='admin' and u.email_confirmed_at is not null and lower(u.email)=a.sender_email);
end;
$$;
revoke all on function public.set_gmail_authorization(uuid,text,text),public.get_gmail_authorization() from public,anon,authenticated;
grant execute on function public.set_gmail_authorization(uuid,text,text),public.get_gmail_authorization() to service_role;

create function public.get_gmail_authorization_status() returns jsonb
language plpgsql security definer set search_path=public as $$
begin
    if auth.role() is distinct from 'service_role' then raise exception 'Backend only'; end if;
    return (select jsonb_build_object('sender_email',a.sender_email,'authorized_at',a.updated_at)
      from lpmas_private.gmail_authorization a join auth.users u on u.id=a.admin_user_id
      join public.profiles p on p.id=u.id where p.role::text='admin'
      and u.email_confirmed_at is not null and lower(u.email)=a.sender_email);
end;
$$;
revoke all on function public.get_gmail_authorization_status() from public,anon,authenticated;
grant execute on function public.get_gmail_authorization_status() to service_role;
