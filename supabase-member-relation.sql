create extension if not exists pgcrypto;

create table if not exists public.forbes_members (
  member_id text primary key,
  game_nickname text not null default '',
  game_id text null,
  discord_user_id text null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint forbes_members_game_id_format check (game_id is null or game_id ~ '^[0-9]{1,10}$'),
  constraint forbes_members_discord_id_format check (discord_user_id is null or discord_user_id ~ '^[0-9]{15,25}$')
);

create unique index if not exists forbes_members_discord_user_id_uq
  on public.forbes_members(discord_user_id)
  where discord_user_id is not null;

create unique index if not exists forbes_members_game_id_uq
  on public.forbes_members(game_id)
  where game_id is not null;

alter table public.forbes_members enable row level security;

-- Website clients never query this table directly. Only the Backend service
-- role may read/write the hidden Discord relation.
revoke all on table public.forbes_members from anon, authenticated;
grant all on table public.forbes_members to service_role;
