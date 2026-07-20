-- Personal profiles.
--
-- Extends the existing feedback `profiles` row with a claimable display identity.
-- Auto-generated names are DERIVED at read time (see web/lib/profile/name.ts) and
-- deliberately never stored, so these columns stay null until a wallet actually
-- claims a custom identity. That keeps first-view reads write-free and stops
-- derived names from racing claimed ones for uniqueness.

alter table profiles add column if not exists username        text;
alter table profiles add column if not exists bio             text;
alter table profiles add column if not exists avatar_url      text;
-- When the username was last CHANGED (null = never claimed, so the first set is
-- free). Drives the 24h change cooldown, enforced server-side.
alter table profiles add column if not exists username_set_at timestamptz;

-- Case-insensitive uniqueness for CLAIMED names only. Partial index, so the many
-- rows still on a derived name (username is null) never collide with each other.
-- A duplicate raises 23505, which the API turns into a clean 409 "username taken".
create unique index if not exists profiles_username_lower_key
  on profiles (lower(username))
  where username is not null;
