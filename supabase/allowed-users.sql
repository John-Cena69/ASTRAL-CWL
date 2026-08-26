create table if not exists public.allowed_user_ids (
  discord_user_id text primary key,
  role text not null,
  created_at timestamptz not null default now()
);

alter table public.allowed_user_ids enable row level security;

drop policy if exists "Users can check their own allowlist entry" on public.allowed_user_ids;

create or replace function public.get_my_allowed_role()
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select allowed.role
  from public.allowed_user_ids as allowed
  join auth.users as account on account.id = auth.uid()
  left join auth.identities as identity
    on identity.user_id = account.id and identity.provider = 'discord'
  where allowed.discord_user_id = coalesce(
    account.raw_user_meta_data ->> 'provider_id',
    account.raw_user_meta_data ->> 'sub',
    identity.identity_data ->> 'provider_id',
    identity.identity_data ->> 'sub'
  )
  limit 1;
$$;

revoke execute on function public.get_my_allowed_role() from public;
grant execute on function public.get_my_allowed_role() to authenticated;

-- Example:
-- insert into public.allowed_user_ids (discord_user_id, role)
-- values ('123456789012345678', 'viewer');