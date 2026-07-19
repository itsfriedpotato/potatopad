# SPEC: Creator profiles (v2 — profiles only)

**Status:** Implementation aligned with maintainer feedback (RedBullish, 2026-07-17/19)  
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
| `/creator/[address]` | Planter: summary + paginated coins + share + OG. Non-planter: short “not a planter” state (no zero-metric chrome). Invalid: error. Unavailable feed: honest outage. |
| Header | **My profile** only when connected **and** feed shows ≥1 plant for that wallet |
| TokenCard | Sibling planter link (no nested anchors) |
| TokenHeaderCard | Sibling “View profile” (does not wrap AddressChip) |

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
- [x] My profile gated on planter status
- [x] TokenCard / TokenHeaderCard profile entry points without nested AddressChip
- [x] Nullable prices (failed ≠ 0 ETH) on Discover + profile cards
- [x] padStats tests; tsc; build
