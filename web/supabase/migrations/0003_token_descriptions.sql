-- Off-chain token descriptions.
--
-- The on-chain launch metadata (imageURI, website, twitter, telegram) has no
-- description slot and the pad is immutable, so a creator-authored description
-- lives here, keyed by the token address. Writes are gated in the API by a
-- wallet signature that must recover to the token's on-chain creator, so this
-- table only ever holds creator-authored text (RLS stays off; the service-role
-- key is server-only, same as profiles/feedback).

create table if not exists token_descriptions (
  token_address text primary key,
  creator_address text not null,
  description text not null default '',
  updated_at timestamptz not null default now()
);

-- Look up "who authored this" quickly (creator profile pages, moderation).
create index if not exists token_descriptions_creator_idx
  on token_descriptions (creator_address);
