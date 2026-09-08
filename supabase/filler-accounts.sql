create table if not exists public.filler_accounts (
  player_tag varchar(15) primary key,
  player_name varchar(50),
  clan_tag varchar(15),
  town_hall int,
  war_weight int,
  owner varchar(50) not null
);

create table if not exists public.family_clans (
  clan_tag varchar(15) primary key,
  clan_name varchar(50) not null,
  is_active boolean default true,
  added_date date default current_date
);

alter table public.family_clans
  add column if not exists is_active boolean default true;
alter table public.family_clans
  add column if not exists added_date date default current_date;

alter table public.filler_accounts enable row level security;
alter table public.family_clans enable row level security;

grant select, insert, update, delete on table public.filler_accounts to authenticated;
grant select on table public.family_clans to authenticated;

drop policy if exists "Allowed users can read filler accounts" on public.filler_accounts;
drop policy if exists "Allowed users can add filler accounts" on public.filler_accounts;
drop policy if exists "Allowed users can delete filler accounts" on public.filler_accounts;
drop policy if exists "Allowed users can update filler accounts" on public.filler_accounts;
drop policy if exists "Allowed users can read active family clans" on public.family_clans;
drop policy if exists "Allowed users can read family clans" on public.family_clans;

create policy "Allowed users can read filler accounts" on public.filler_accounts
  for select to authenticated using (public.get_my_allowed_role() is not null);
create policy "Allowed users can add filler accounts" on public.filler_accounts
  for insert to authenticated with check (public.get_my_allowed_role() is not null);
create policy "Allowed users can delete filler accounts" on public.filler_accounts
  for delete to authenticated using (public.get_my_allowed_role() is not null);
create policy "Allowed users can update filler accounts" on public.filler_accounts
  for update to authenticated
  using (public.get_my_allowed_role() is not null)
  with check (public.get_my_allowed_role() is not null);
create policy "Allowed users can read family clans" on public.family_clans
  for select to authenticated using (public.get_my_allowed_role() is not null);