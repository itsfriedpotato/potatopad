# PotatoPad Community Feedback Board — v1 Spec

A place where token holders post detailed feedback and upvote each other, with a
weekly reward pot for the best ideas. Inspired by the Minecraft Feedback site, but
built to resist the one attack that matters on a permissionless chain: **Sybil**
(one person, many wallets).

Status: design locked, ready to build. Thresholds marked `TUNE` are final knobs to
confirm before launch, not blockers.

---

## 1. Design decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Vote model | **1 eligible wallet = 1 vote** (egalitarian) | Feels like real community voting. Vote counts don't move money, so Sybil on counts is low-stakes. |
| Eligibility asset | **Any PotatoPad token that clears a liquidity floor** | Open and inclusive, but junk / self-made pools can't qualify (see §3). |
| Eligibility threshold | Hold **≥ $50** (time-weighted) for **≥ 1 day** | The user's rule. Time-weighting stops flash-buy-then-vote. |
| Post rate limit | **1 post per wallet per 3 days** | Anti-spam / anti-flood. |
| Votes | **Upvote-only**, 1 per wallet per post | No downvote brigading to bury rivals. |
| Edits | Author may propose an edit; it goes live **only after admin approval** | Kills the "post nice, farm votes, then edit into spam/scam" bait-and-switch. |
| Rewards | **Curated** weekly from the top-voted shortlist; pot = a **fixed operator-set amount** (default $50/week) | Padding votes only shortlists you, never pays. The operator controls the weekly budget directly. |
| Admin | `0xd3358b1F39A6a71911c6e33717D185F99d43e80d` (the owner/treasury address) | Approves edits, moderates, marks "Adopted", picks reward winners. |
| Auth | **Sign-In-With-Ethereum** (EIP-4361), gasless | Prove wallet control per action, no on-chain tx, no gas. |
| Database | **Supabase** (hosted Postgres) | New dependency; everything else in PotatoPad is stateless. |

---

## 2. The anti-abuse model (why this is safe)

The core insight: **votes only rank feedback (low stakes); the reward pot is the only
thing worth attacking.** So we defend the money, not the vote counts.

1. **Rewards are curated, not paid by vote count.** Admin picks weekly winners from the
   top-voted shortlist (e.g. top 10). Farming votes gets you *shortlisted*, never paid.
   This defuses reward-Sybil at any pot size, and is why v1 needs **no** proof-of-personhood,
   World ID, or heavy cluster-detection.
2. **Eligibility costs real, un-fakeable capital.** $50 of a *liquid* token, held a day,
   priced against a real pool (§3). A Sybil needs genuine capital per wallet that moves
   with the market. No free value.
3. **Rate limits + dedup.** 1 post / wallet / 3 days, 1 upvote / wallet / post, upvote-only.
4. **Edits are moderated.** A highly-upvoted post can't be silently rewritten.
5. **Light monitoring.** Flag and discount obvious rings (wallets funded from one source,
   created the same hour, voting in lockstep). Detect, don't over-build prevention.

The math we're accepting: without real identity you can't have *both* "small holders
count as much as whales" *and* "immune to wallet-splitting." We chose egalitarian votes
and moved the Sybil defense onto the money (curation) and the eligibility cost.

---

## 3. Eligibility

A wallet may post or vote iff **all** of:

1. **Holds ≥ $50 now** across **qualifying** PotatoPad tokens (sum of `balanceOf × poolPriceUSD`).
2. **Held ≥ $50 at a snapshot ≥ 24h ago** (the "for at least a day" rule; time-weighted so
   a flash buy right before acting does not count).
3. Wallet is **not banned** by admin.

### Qualifying tokens (closes the "any token" hole)

The attack on "any token": mint a token, spike its thin pool price with a tiny buy so a
near-worthless bag reads as "$50". (LPs are locked forever on PotatoPad, so the attack is
*price manipulation*, not liquidity manufacture.)

A token **qualifies** only if its pool clears an automatic, permissionless floor:

- Pool WETH liquidity **≥ $L** (`TUNE`, default **$3,000**)
- Distinct holders **≥ H** (`TUNE`, default **25**)
- Token age **≥ D days** (`TUNE`, default **2**)

This is a *self-computing allowlist*: no manual gatekeeping, junk pools just don't count.
On a token with genuine depth and holders, you cannot fake a $50 bag without spending
roughly $50 of real capital. All three inputs already exist in the app: pool reserves/price
(`web/lib/pool.ts`), holder counts (the `/api/holders` indexer), and launch block/age
(`TokenCreated`).

### Computation

- A cron (every ~3–6h) refreshes `qualifying_tokens` (which tokens clear the floor) and
  writes `holdings_snapshots` rows `(address, ts, qualifying_usd)` for wallets that hold
  qualifying tokens and/or have interacted with the board.
- `GET /api/feedback/eligibility?address=` returns
  `{ eligible, qualifyingUsd, heldSince, canPostAt }` to drive the UI (button states,
  "come back in Xh", "hold $50 to participate").

---

## 4. Auth (SIWE, gasless)

Every mutating action is a signed message, verified server-side. No gas, no tx.

Message payload (EIP-4361 style) binds: `domain`, `address`, `action`
(`post|vote|unvote|edit|admin:*`), a **content hash** (title+body, or post id), a
server-issued **nonce**, and an **issuedAt** timestamp.

Server flow:
1. `GET /api/feedback/nonce` issues a short-lived nonce (stored, single-use).
2. Client signs the message with the wallet.
3. Server verifies with viem `verifyMessage` / `recoverMessageAddress`, checks the nonce is
   unused and fresh (anti-replay), then authorizes.
4. **Admin** actions additionally require the recovered address to equal
   `0xd3358b1F39A6a71911c6e33717D185F99d43e80d`.

All writes go through our Next.js API using the Supabase **service-role** key (server-only).
Clients never write to Supabase directly. Public reads can be direct (RLS read-only) or via
the API.

---

## 5. Data model (Supabase / Postgres)

```sql
-- Wallet profiles (one per interacting wallet)
create table profiles (
  address        text primary key,              -- lowercased 0x...
  first_seen_at  timestamptz not null default now(),
  last_post_at   timestamptz,                    -- drives the 3-day post limit
  is_banned      boolean not null default false,
  banned_reason  text
);

-- Feedback posts (body = current PUBLISHED content)
create table posts (
  id           uuid primary key default gen_random_uuid(),
  author       text not null references profiles(address),
  category     text not null,                    -- see §7
  title        text not null,
  body         text not null,
  status       text not null default 'published',-- published | hidden | adopted
  vote_count   integer not null default 0,       -- denormalized cache of votes
  signature    text not null,                    -- author SIWE proof of original
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on posts (status, vote_count desc);
create index on posts (status, created_at desc);
create index on posts (category, status, vote_count desc);

-- One upvote per wallet per post (PK enforces it). Upvote-only: a row = an upvote.
create table votes (
  post_id    uuid not null references posts(id) on delete cascade,
  voter      text not null references profiles(address),
  created_at timestamptz not null default now(),
  signature  text not null,
  primary key (post_id, voter)
);

-- Author-proposed edits, pending admin approval. On approve, content replaces the post.
create table post_edits (
  id             uuid primary key default gen_random_uuid(),
  post_id        uuid not null references posts(id) on delete cascade,
  proposed_title text not null,
  proposed_body  text not null,
  status         text not null default 'pending', -- pending | approved | rejected
  author_sig     text not null,
  created_at     timestamptz not null default now(),
  reviewed_by    text,                            -- admin address
  reviewed_at    timestamptz
);
create index on post_edits (status, created_at);

-- Time-weighted eligibility snapshots
create table holdings_snapshots (
  address        text not null,
  ts             timestamptz not null default now(),
  qualifying_usd numeric not null,
  primary key (address, ts)
);
create index on holdings_snapshots (address, ts desc);

-- Which tokens currently clear the liquidity floor (refreshed by cron)
create table qualifying_tokens (
  address       text primary key,
  liquidity_usd numeric,
  holders       integer,
  first_block   bigint,
  qualifies     boolean not null default false,
  updated_at    timestamptz not null default now()
);

-- Weekly reward rounds (pot = the fixed operator-set weekly amount, in USD)
create table reward_rounds (
  id         uuid primary key default gen_random_uuid(),
  week_start date not null,
  week_end   date not null,
  pot_eth    numeric,                             -- the week's fixed pot (USD); legacy column name
  status     text not null default 'open',        -- open | finalized | paid
  created_at timestamptz not null default now()
);

create table reward_winners (
  round_id    uuid not null references reward_rounds(id) on delete cascade,
  post_id     uuid not null references posts(id),
  rank        integer not null,
  amount_eth  numeric not null,
  paid_tx     text,                               -- payout tx hash (manual/multisig)
  selected_by text not null,                      -- admin address
  primary key (round_id, post_id)
);

-- Admin audit log (moderation, approvals, adoptions, reward picks)
create table admin_actions (
  id        uuid primary key default gen_random_uuid(),
  actor     text not null,
  action    text not null,
  target    text,
  signature text not null,
  created_at timestamptz not null default now()
);
```

---

## 6. API (Next.js route handlers)

Public:
- `GET  /api/feedback` — list posts. Query: `category`, `sort` (top|new|adopted), `cursor`.
- `GET  /api/feedback/[id]` — one post + its votes/edit status.
- `GET  /api/feedback/nonce?address=` — issue a SIWE nonce.
- `GET  /api/feedback/eligibility?address=` — `{ eligible, qualifyingUsd, heldSince, canPostAt }`.

Signed (eligibility + SIWE verified server-side):
- `POST   /api/feedback` — create post. Checks eligibility + `last_post_at ≥ 3 days ago`,
  inserts post, sets `profiles.last_post_at = now()`.
- `POST   /api/feedback/[id]/vote` — upvote (unique per wallet). `DELETE` to remove.
- `POST   /api/feedback/[id]/edit` — author proposes an edit → `post_edits(pending)`.

Admin (SIWE recovered == admin address):
- `GET  /api/admin/edits?status=pending`
- `POST /api/admin/edits/[id]/approve` — apply edit to the post, mark approved.
- `POST /api/admin/edits/[id]/reject`
- `POST /api/admin/feedback/[id]/hide` | `/adopt`
- `POST /api/admin/profiles/[address]/ban`
- `POST /api/admin/rewards/[round]/finalize` — set winners + amounts, mark finalized.

Every signed/admin write: verify nonce (single-use, fresh) → verify signature → authorize →
act → (admin) append `admin_actions`.

---

## 7. Board UX

- Layout modeled on the reference: category columns, each item showing **vote count + title**,
  a big "New / Top / Adopted" toggle, and a detail view for the full body + discussion.
- **Categories** (`TUNE`, default): `Launchpad`, `Fees & Rewards`, `Trading & UI`,
  `Tokens & Discovery`, `Other`.
- Connected-wallet states: not eligible → "Hold $50 of a listed token for a day to
  participate"; eligible but rate-limited → "You can post again in Xh"; eligible → full access.
- Uses the existing terminal-black + neon design system already shipped.

---

## 8. Rewards

- **Pot** = a **fixed amount the operator commits each week** (`REWARD_POT_USD`, default **$50**),
  funded and paid out manually. It is intentionally NOT a share of protocol fees (that was rejected
  as too large a payout to run on autopilot).
- **Selection**: at week end, admin reviews the **top-voted shortlist** (top 10) and picks
  winners with amounts. Curated, not automatic.
- **Payout (v1)**: manual/multisig transfer from a rewards wallet; record `paid_tx`.
  (v2 option: a claim contract so winners self-claim.)
- Winning posts get an **Adopted / Rewarded** badge and move to the Adopted tab.

---

## 9. Integration & reuse

Almost everything reuses existing infra; the only new piece is Supabase:

- **Eligibility value**: `web/lib/pool.ts` (pool price) + `/api/holders` (holder counts) +
  `TokenCreated` (age). No new indexer.
- **Fees for the pot**: `contracts/scripts/treasury-sent.ts` logic (TreasuryPaid sums).
- **Signatures**: viem `verifyMessage` (already a dependency).
- **New**: Supabase project + `@supabase/supabase-js`, env `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY` (server-only, never shipped to the browser),
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` (read-only, RLS-guarded).
- **Cron**: a scheduled route (Railway cron or Vercel cron) for `holdings_snapshots` +
  `qualifying_tokens` refresh, and weekly round rollover.

---

## 10. Build phases

1. **Foundation** — Supabase schema, SIWE nonce/verify, eligibility endpoint, `qualifying_tokens`
   + `holdings_snapshots` cron.
2. **Core board** — create post (3-day limit) + upvote + list/detail API + board UI (New/Top).
3. **Moderation** — author edit → admin approval flow + admin panel (approve/reject/hide/adopt/ban).
4. **Rewards** — weekly rounds, curated selection, payout recording, Adopted tab.
5. **Hardening** — cluster monitoring + discounting, rate-limit polish, abuse dashboard.

---

## 11. Thresholds to confirm before launch (`TUNE`)

- Liquidity floor **$L = $3,000**, holders **H = 25**, age **D = 2 days**.
- Eligibility **$50**, hold window **24h**.
- Post limit **1 / 3 days** (locked by request).
- Reward pot: fixed **$50/week** (`REWARD_POT_USD`); shortlist size **10**.
- Categories list.
- Payout: manual/multisig (v1) vs claim contract (v2).
