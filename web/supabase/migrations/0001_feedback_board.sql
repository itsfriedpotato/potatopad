-- PotatoPad Community Feedback Board — v1 schema
-- Run this in the Supabase SQL editor (Dashboard -> SQL -> New query -> paste -> Run).
-- All tables have RLS enabled with NO policies, so ONLY the server's service_role key
-- (which bypasses RLS) can read/write. The browser never touches Supabase directly.

-- ------------------------------------------------------------------ profiles
create table if not exists profiles (
  address        text primary key,               -- lowercased 0x...
  first_seen_at  timestamptz not null default now(),
  last_post_at   timestamptz,                     -- drives the 1-post-per-3-days limit
  is_banned      boolean not null default false,
  banned_reason  text
);

-- --------------------------------------------------------------------- posts
create table if not exists posts (
  id           uuid primary key default gen_random_uuid(),
  author       text not null references profiles(address),
  category     text not null,
  title        text not null,
  body         text not null,
  status       text not null default 'published', -- published | hidden | adopted
  vote_count   integer not null default 0,
  signature    text not null,                     -- author SIWE proof of the original
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists posts_status_votes_idx on posts (status, vote_count desc);
create index if not exists posts_status_created_idx on posts (status, created_at desc);
create index if not exists posts_category_idx on posts (category, status, vote_count desc);

-- --------------------------------------------------------------------- votes
-- One upvote per wallet per post (PK enforces it). Upvote-only: a row = an upvote.
create table if not exists votes (
  post_id    uuid not null references posts(id) on delete cascade,
  voter      text not null references profiles(address),
  created_at timestamptz not null default now(),
  signature  text not null,
  primary key (post_id, voter)
);
create index if not exists votes_voter_idx on votes (voter);

-- ---------------------------------------------------------------- post_edits
-- Author-proposed edits, pending admin approval. On approve, content replaces the post.
create table if not exists post_edits (
  id             uuid primary key default gen_random_uuid(),
  post_id        uuid not null references posts(id) on delete cascade,
  proposed_title text not null,
  proposed_body  text not null,
  status         text not null default 'pending', -- pending | approved | rejected
  author_sig     text not null,
  created_at     timestamptz not null default now(),
  reviewed_by    text,
  reviewed_at    timestamptz
);
create index if not exists post_edits_status_idx on post_edits (status, created_at);

-- -------------------------------------------------------- holdings_snapshots
-- Time-weighted eligibility: "held >= $50 for >= 24h" is checked against these.
create table if not exists holdings_snapshots (
  address        text not null,
  ts             timestamptz not null default now(),
  qualifying_usd numeric not null,
  primary key (address, ts)
);
create index if not exists holdings_snapshots_addr_ts_idx on holdings_snapshots (address, ts desc);

-- --------------------------------------------------------- qualifying_tokens
-- Which PotatoPad tokens clear the liquidity floor (refreshed by cron).
create table if not exists qualifying_tokens (
  address       text primary key,
  symbol        text,
  liquidity_usd numeric,
  holders       integer,
  first_block   bigint,
  qualifies     boolean not null default false,
  updated_at    timestamptz not null default now()
);

-- ------------------------------------------------------------- reward_rounds
create table if not exists reward_rounds (
  id         uuid primary key default gen_random_uuid(),
  week_start date not null,
  week_end   date not null,
  pot_eth    numeric,
  status     text not null default 'open',        -- open | finalized | paid
  created_at timestamptz not null default now()
);
-- At most one round per ISO week: hard-stops the duplicate-open-round race.
create unique index if not exists reward_rounds_week_start_uidx on reward_rounds (week_start);

create table if not exists reward_winners (
  round_id    uuid not null references reward_rounds(id) on delete cascade,
  post_id     uuid not null references posts(id),
  rank        integer not null,
  amount_eth  numeric not null,
  paid_tx     text,
  selected_by text not null,
  primary key (round_id, post_id)
);

-- ------------------------------------------------------------- admin_actions
create table if not exists admin_actions (
  id         uuid primary key default gen_random_uuid(),
  actor      text not null,
  action     text not null,
  target     text,
  signature  text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------- feedback_nonces
-- Single-use SIWE nonces (anti-replay). Cleaned up opportunistically.
create table if not exists feedback_nonces (
  nonce      text primary key,
  address    text not null,
  created_at timestamptz not null default now(),
  used       boolean not null default false
);
create index if not exists feedback_nonces_created_idx on feedback_nonces (created_at);

-- ------------------------------------------------------- atomic vote helpers
-- Insert-or-noop a vote and keep posts.vote_count exact, in one transaction.
create or replace function cast_vote(p_post_id uuid, p_voter text, p_sig text)
returns integer language plpgsql as $$
declare v_count integer;
begin
  insert into votes(post_id, voter, signature) values (p_post_id, p_voter, p_sig)
  on conflict (post_id, voter) do nothing;
  if found then
    update posts set vote_count = vote_count + 1 where id = p_post_id returning vote_count into v_count;
  else
    select vote_count into v_count from posts where id = p_post_id;
  end if;
  return v_count;
end; $$;

create or replace function remove_vote(p_post_id uuid, p_voter text)
returns integer language plpgsql as $$
declare v_count integer;
begin
  delete from votes where post_id = p_post_id and voter = p_voter;
  if found then
    update posts set vote_count = greatest(vote_count - 1, 0) where id = p_post_id returning vote_count into v_count;
  else
    select vote_count into v_count from posts where id = p_post_id;
  end if;
  return v_count;
end; $$;

-- Apply a pending edit to its post, atomically.
create or replace function approve_edit(p_edit_id uuid, p_admin text)
returns void language plpgsql as $$
declare e record;
begin
  select * into e from post_edits where id = p_edit_id and status = 'pending';
  if not found then raise exception 'edit not pending'; end if;
  update posts set title = e.proposed_title, body = e.proposed_body, updated_at = now() where id = e.post_id;
  update post_edits set status = 'approved', reviewed_by = p_admin, reviewed_at = now() where id = p_edit_id;
end; $$;

-- --------------------------------------------------------- lock down (RLS on)
-- No policies => anon/public get nothing; only the server's service_role (which
-- bypasses RLS) can read/write. Defense in depth if the anon key ever leaks.
alter table profiles          enable row level security;
alter table posts             enable row level security;
alter table votes             enable row level security;
alter table post_edits        enable row level security;
alter table holdings_snapshots enable row level security;
alter table qualifying_tokens enable row level security;
alter table reward_rounds     enable row level security;
alter table reward_winners    enable row level security;
alter table admin_actions     enable row level security;
alter table feedback_nonces   enable row level security;
