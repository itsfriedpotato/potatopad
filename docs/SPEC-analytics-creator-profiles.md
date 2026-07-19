# SPEC: Creator profiles (v2 — profiles only)

**Status:** Implementation aligned with maintainer feedback (RedBullish, 2026-07-17/19) + owner bar (think through impacts / journeys before final)  
**Repo:** `itsfriedpotato/potatopad`  
**Scope:** Frontend creator profiles + feed honesty fields. No pad stats strip. No new contracts. No volume.

## Maintainer decisions (locked)

1. **Planter-scoped first.** Full profile chrome only for wallets that have planted ≥1 coin. Header **My profile** only when the connected wallet is a planter.
2. **No Discover pad stats strip** in this PR — pad-wide aggregates wait on indexer-backed data.
3. **Existence metrics only** from the `TokenCreated` feed (coins planted, first/latest plant, page-scoped top coin). No volume.
4. **Data source:** `/api/tokens` feed; re-point later when private indexer lands (#29).

## Surfaces

| Surface | Behavior |
|---------|----------|
| `/creator/[address]` | Planter: summary + paginated coins + share + OG. Non-planter: short “not a planter” state (no zero-metric chrome). Self-empty: indexing-honest copy (never “you never launched” while feed may lag). Invalid: error. Unavailable feed: honest outage. |
| Header | **My profile** only when connected **and** feed shows ≥1 plant for that wallet |
| TokenCard | Sibling **by 0x…** link (no nested anchors); token remains primary action |
| TokenHeaderCard | Sibling “View planter” (does not wrap AddressChip) |

## User journeys (must not break)

| Who | Path | Expected |
|-----|------|----------|
| Browser on Discover | Tap coin → token; tap **by 0x…** → planter profile | No nested links; token nav still primary |
| Token page visitor | **View planter** | Lands on planter list (or honest empty) |
| Connected planter | **My profile** in header | Only after feed knows they planted |
| Connected non-planter | Header | No My profile (no fake empty profile chrome) |
| Just planted | Create → token → View planter | Must **not** say “never launched” while feed lags |
| Shared `/creator/0x` | Cold open | Invalid / unavailable / non-planter / planter — distinct |

## Product impacts called out

- Discover cards gain a secondary row (`by 0x…`) — slightly denser; primary action remains the token.
- Feed TTL (~90s server) means brand-new plants lag on profiles; create invalidates client query; self-empty copy is lag-honest.
- “Top coin” is page-scoped when paginated — copy says so.
- No pad stats strip (owner has `/analytics`); no volume on profile surfaces.
- Plant list is **newest first** (scan order is not chronological).

## Feed honesty (required)

`FeedPayload`: `chainId`, `servedAt`, `scanCompletedAt`, `state` (`fresh` \| `stale` \| `unavailable`), `creations`.

- Stamp fresh `servedAt` on every `loadFeed` return (incl. cache hits).
- Client cache `potatopad:launch:v3:` — write only `fresh`; age → present as `stale`.
- `/api/tokens`: `Cache-Control: private, no-store`.
- Feed fetch pinned to Robinhood (server already scans 4663 only).

## Non-goals

- Discover pad stats strip / Robinhood-wide aggregates
- True swap volume
- Creator-wide combined FDV
- Bonding curves / buyback / voting
- Replacing owner `/analytics` page

## Done when

- [x] Planter profile lists only that creator’s plants; progressive page pricing
- [x] Non-planter and unavailable states are distinct and non-deceptive
- [x] Self-empty ≠ “not a planter” (indexing honesty)
- [x] My profile gated on planter status
- [x] TokenCard / TokenHeaderCard profile entry points without nested AddressChip
- [x] Nullable prices (failed ≠ 0 ETH) on Discover + profile cards
- [x] Newest-first plant list; first plant uses calendar date
- [x] padStats tests; tsc; build
