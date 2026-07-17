# Architecture

A map of the codebase for new contributors. PotatoPad has two halves that meet
only at an address + an event: **contracts** that launch tokens into Uniswap V3,
and a **Next.js frontend** that reads chain state (there is no database).

```
contracts/  Solidity: launch a token as locked single-sided Uniswap V3 liquidity
web/        Next.js: read the chain (cached feed + RPC proxy), no DB, no indexer
```

## Contract flow

The whole launch is one atomic transaction: `PotatoPad.createToken(name, symbol, meta, salt)`.

### 1. CREATE2 salt loop — a griefer-proof token address

The token is deployed with **CREATE2** off `keccak256(msg.sender, salt)`, not plain
`CREATE`. Why: a plain-`CREATE` address is a pure function of the pad's nonce, so
anyone can predict the next token address and pre-`initialize` its Uniswap pool at
a hostile price — which would make our single-sided mint revert, and (because a
revert rolls the nonce back) brick *every* future launch at that address forever.

CREATE2 off a **random** salt makes the address unpredictable until the tx is
public, so the pool can't be pre-poisoned. If a candidate address is somehow
already taken (has a pool or code), the loop walks to the next candidate
(`seed, seed+1, …`) up to `MAX_SALT_TRIES`. If *all* candidates are taken it
reverts `LaunchGriefed` and the caller simply retries with a fresh salt — a brand
new candidate set no attacker could have pre-poisoned. No permanent brick.

> Code: `PotatoPad.createToken` (the salt loop + `_computeTokenAddress`).
> Tested in `contracts/test/potatopad.test.ts` ("skips a griefer's pre-initialized
> pool" and the exhaustion/recovery cases).

### 2. Pool creation + initialization

The pad creates the token/WETH Uniswap V3 pool at the **1% fee tier** and
`initialize`s it at the exact tick-boundary sqrt price for the opening FDV
(~3 ETH). Sitting precisely on the launch tick is what lets the next step consume
**zero WETH**.

### 3. Single-sided mint

The pad mints the **entire supply as single-sided liquidity — token only, no ETH**
— across a fixed range (open FDV → ceiling FDV ~530 ETH), via the
NonfungiblePositionManager. It asserts zero WETH was used (`NotSingleSided`) and
that ~all supply was deployed (`SeedFailed`). Buyers' WETH is what later walks the
price up through the range; nobody funds liquidity up front.

### 4. Locker — fees for life, principal locked

The LP position NFT is minted **straight into the immutable `PotatoFeeLocker`**,
which has no transfer and no withdraw path, so the principal is locked forever.
Each swap pays the pool's 1% fee to that position. Fees flow out in two steps:

- `locker.collect(tokenId)` — permissionless; harvests accrued fees into the
  locker, **auto-pays the treasury its 50%**, and sets aside the creator's 50%.
- `locker.claim(token)` — creator-only; withdraws their set-aside share.

Fees accrue on **both** sides (WETH and the token), tracked as
`claimable[asset][account]`.

### 5. Optional atomic dev-buy

If ETH is attached to `createToken`, the pad wraps it to WETH and swaps into the
fresh pool in the same tx, delivering tokens to the creator (capped by the
anti-snipe max-wallet during the opening window).

Contracts at a glance:

| File | Role |
|---|---|
| `contracts/contracts/PotatoPad.sol` | launchpad: token deploy + pool init + single-sided mint + dev-buy |
| `contracts/contracts/PotatoFeeLocker.sol` | permanent LP lock + 50/50 fee splitter (auto-pay treasury, pull for creator) |
| `contracts/contracts/PotatoToken.sol` | minimal fixed-supply ERC-20 + time-boxed anti-snipe max-wallet |
| `contracts/contracts/libraries/TickMath.sol` | Uniswap tick math, ported to 0.8.24 |

## Frontend data layer

There is **no database and no indexer**. The frontend reads everything from the
chain, with two server routes that make that fast and keep keys hidden.

### `/api/tokens` — cached Discover feed (poor-man's indexer)

Instead of every visitor's browser scanning `TokenCreated` logs, the scan runs
**once server-side** and is cached in memory for a short TTL (~45s). It walks each
pad's logs in bounded-concurrency block chunks (Alchemy caps `eth_getLogs` at 10k
blocks on Robinhood), attaches block timestamps, dedupes by token address, and
returns a small JSON payload all visitors share. RPC load drops from "per user per
load" to "once per TTL for the whole site".

> Code: `web/app/api/tokens/route.ts`.

### Multi-pad reads

A chain can have more than one pad: the **primary (write) pad** (from env) plus
**legacy pads** from earlier deploys that still custody launched tokens.
`padDeployments(chainId)` returns the full read set (primary first, then legacy,
deduped, zero-address stripped), each with the block to start scanning from. The
feed route, `useLaunchActivity` (Discover), and `useTokenPad` (token page — resolves
which pad launched a given token) all read across this set, so tokens keep showing
after a repoint.

> Code: `web/lib/config.ts` (`padDeployments`, `LEGACY_PADS`), `web/lib/events.ts`,
> `web/lib/hooks.ts`. See also [ADDING_A_CHAIN.md](./ADDING_A_CHAIN.md).

### `/api/rpc` — key-hiding RPC proxy

The browser talks to same-origin `/api/rpc`, which forwards to the Alchemy
endpoint(s) in server-only env vars — the keys never ship to the client. Guards:
a **method denylist** (blocks tx-relay / subscription methods; all reads pass), a
coarse **per-IP rate limit**, and **round-robin + 429/5xx failover** across
multiple keys (`ROBINHOOD_RPC_URL`, `_2`, `_3`). Wallet *writes* go through the
user's own wallet RPC, never this proxy.

> Code: `web/app/api/rpc/route.ts`. Image uploads (`/api/upload`) proxy to Pinata/IPFS.

### Client read/write hooks

- Reads: wagmi/viem `useReadContract(s)` over `/api/rpc`; `usePool*` for pool
  price/FDV/fees, `useAccruedFees` for uncollected pool fees.
- Writes: `useTx` (`web/lib/hooks.ts`) wraps `useWriteContract` +
  `useWaitForTransactionReceipt` and invalidates queries on confirmation. Used by
  `HarvestCard` (collect/claim), `TradeWidget` (buy/sell), and the create form.

## Where to start reading

1. `contracts/contracts/PotatoPad.sol` → `createToken` (the whole launch).
2. `contracts/test/potatopad.test.ts` → runs against real Uniswap V3 bytecode.
3. `web/app/api/tokens/route.ts` → how the feed is served without a DB.
4. `web/lib/config.ts` → chains, pads, and derived config.
