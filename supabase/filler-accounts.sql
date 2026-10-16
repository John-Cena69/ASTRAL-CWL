create table if not exists public.filler_accounts (
  player_tag varchar(15) primary key,
  player_name varchar(50),
  clan_tag varchar(15),
  clan_name varchar(50),
  town_hall int,
  war_weight int,
  owner varchar(50) not null
);

alter table public.filler_accounts
  add column if not exists clan_name varchar(50);

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

create table if not exists public.family_wars (
  id uuid default gen_random_uuid() primary key,
  clan_tag varchar(15) references public.family_clans(clan_tag),
  clan_badge_url text,
  opponent_name varchar(50),
  opponent_tag varchar(15),
  state varchar(20),
  prep_start_time bigint,
  end_time bigint,
  stars int,
  attacks_used int,
  opponent_stars int,
  opponent_attacks_used int,
  our_points int,
  opponent_points int,
  sync_used varchar(10),
  war_result varchar(20),
  unique(clan_tag, prep_start_time)
);

alter table public.family_wars
  add column if not exists opponent_stars int;
alter table public.family_wars
  add column if not exists opponent_attacks_used int;

alter table public.family_wars enable row level security;
grant select, insert, update, delete on table public.family_wars to authenticated;

drop policy if exists "Allowed users can manage family wars" on public.family_wars;
create policy "Allowed users can manage family wars" on public.family_wars
  for all to authenticated
  using (public.get_my_allowed_role() is not null)
  with check (public.get_my_allowed_role() is not null);

create table if not exists public.bot_settings (
  setting_key varchar(50) primary key,
  setting_value varchar(255)
);

insert into public.bot_settings (setting_key, setting_value)
values ('fwa_sync_state', 'Low')
on conflict (setting_key) do nothing;

alter table public.bot_settings enable row level security;
grant select, insert, update, delete on table public.bot_settings to authenticated;

drop policy if exists "Allowed users can read bot settings" on public.bot_settings;
drop policy if exists "Allowed users can update bot settings" on public.bot_settings;
create policy "Allowed users can read bot settings" on public.bot_settings
  for select to authenticated using (public.get_my_allowed_role() is not null);
create policy "Allowed users can update bot settings" on public.bot_settings
  for update to authenticated
  using (public.get_my_allowed_role() is not null)
  with check (public.get_my_allowed_role() is not null);