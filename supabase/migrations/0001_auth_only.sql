-- LPMAS — Supabase migration (AUTH ONLY)
-- ------------------------------------------------------------------
-- Supabase is scoped strictly to user accounts here. Sensor readings,
-- phases, and incidents live on the Raspberry Pi's local SQLite database
-- (see /pi-server) — they are intentionally NOT mirrored here, to avoid
-- depending on internet connectivity for core monitoring to function.
-- ------------------------------------------------------------------

create type user_role as enum ('admin', 'manager', 'technician');

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role user_role not null default 'technician',
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "Users can view their own profile"
  on profiles for select
  using (auth.uid() = id);

create policy "Admins can view all profiles"
  on profiles for select
  using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin')
  );

create policy "Users can update their own profile"
  on profiles for update
  using (auth.uid() = id);

-- Automatically create a profile row when a new user signs up
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, new.raw_user_meta_data->>'full_name', 'technician');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
