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

There are two launch entry points, sharing one internal `_launch`:

| Entry point | Creator half of WETH fees |
|---|---|
| `createToken(name, symbol, meta, salt)` | all to the creator |
| `createRewardToken(…, creatorFeeBps)` | split creator / **token holders** |

Everything else — locked LP, treasury cut, anti-snipe, ownerless token — is
identical. See [Holder-rewards launches](#holder-rewards-launches) below.

### 1. CREATE2 salt loop — a griefer-proof token address

The token is deployed with **CREATE2** off `keccak256(msg.sender, salt)`, not plain
`CREATE`. Why: a plain-`CREATE` address is a pure function of the pad's nonce, so
anyone can predict the next token address and pre-`initialize` its Uniswap pool at
a hostile price — which would make our single-sided mint revert, and (because a
revert rolls the nonce back) brick *every* future launch at that address forever.

> **The CREATE2 deployer is `PotatoTokenFactory`, not the pad.** To `CREATE2` a
> token, the deployer must carry that token's whole creation bytecode in its own
> runtime code; carrying two token types pushed the pad past the 24 KB EIP-170
> limit, so the bytecode lives in a small factory the pad calls. The griefing
> argument is unchanged, just re-anchored — addresses derive from the factory,
> the salt is still the caller's random value, and `deploy` is pad-only. Anything
> predicting a launch address off-chain must use `pad.tokenFactory()` as the
> deployer.

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

### 5. Holder-rewards launches

`createRewardToken` deploys a **`PotatoRewardToken`** instead: the same token,
plus an accrual accumulator that pays the token's own holders a share of the
fees, in ETH. The creator picks their cut at launch (`creatorFeeBps`, 0–50% of
total WETH fees) and holders get the rest of the creator half. The treasury's
50% and the token-side burn are untouched, and the split is immutable.

Three properties are worth understanding, because they drive the whole design:

**Pull, not push.** Paying every holder inside `_transfer` is unbounded gas — you
cannot loop the holder set. (Tokens advertising "auto-payouts" run a gas-budgeted
queue: every trade costs hundreds of thousands of extra gas, payouts follow queue
order rather than fairness, and the tail stops getting paid as holders grow.)
Instead a monotonic `rewardPerShareX128` accumulator plus a per-account
`rewardDebtX128` makes accrual **O(1) per transfer** at any holder count, and
exact rather than approximate. Holders pull with `claim()`, paid as native ETH.

**Accounting is decoupled from custody.** Fees physically sit in the locked
position until someone calls `collect()`. The obvious design credits holders when
that money *arrives* — but then fees are attributed to whoever holds **after** the
harvest, not to whoever held while the volume traded. Hold through a week of
trading, sell an hour before a collect, and you get nothing.

So the token doesn't wait for custody. Uniswap moves `feeGrowthGlobal` on **every
swap**, and it is readable at any instant, so `_accrue()` derives the position's
`feeGrowthInside` on each transfer and credits the delta immediately:

```
feeGrowthInside = feeGrowthGlobal − feeGrowthBelow − feeGrowthAbove
earned          = positionLiquidity × Δ feeGrowthInside / 2¹²⁸
```

A `collect()` becomes a pure **funding** operation — it moves ETH that holders
were already credited for. `claim()` calls it itself when the contract is short,
so nobody has to crank anything. Two consequences: attribution is exact (you earn
for swaps that happen while you hold, and keep it when you sell), and there is no
distribution *event* left to front-run, so buying just before a collect gains
nothing. An earlier design streamed each harvest over 24h purely to defend that
attack; with no lump sum, the defence became unnecessary.

Reading pool state inside `_update` is safe mid-swap: Uniswap writes `slot0` and
`feeGrowthGlobal` **before** it transfers tokens, and those getters carry no
reentrancy lock — so a buy is credited with its own fee, in the transaction that
generated it.

**Measured against circulating supply.** `eligibleSupply` is total supply minus
the locked LP pool, the pad, the locker, the position manager, and the burn
address — maintained incrementally on transfer, never by iterating holders. So
the ~entire supply parked in the locked position never dilutes real holders. If
`eligibleSupply` is ever zero the fee checkpoint is deliberately *not* advanced,
banking that growth for the next holder rather than crediting nobody.

Because credit is derived from pool fee growth rather than from arriving WETH,
donating WETH to the token does **not** mint rewards — it only over-funds the
contract. Integer division can leave cumulative credit a few wei ahead of
cumulative funding, so `claim()` caps each payout at the funded balance and
leaves the remainder claimable rather than reverting.

> Code: `contracts/contracts/PotatoRewardToken.sol`,
> `PotatoFeeLocker._distribute` / `_payHolders`.
> Tested in `contracts/test/potatoreward.test.ts` (continuous accrual with no
> harvest, payout to a holder who sold before any collect, snipe resistance,
> all three split settings, solvency).

### 6. Optional atomic dev-buy

If ETH is attached to `createToken`, the pad wraps it to WETH and swaps into the
fresh pool in the same tx, delivering tokens to the creator (capped by the
anti-snipe max-wallet during the opening window).

Contracts at a glance:

| File | Role |
|---|---|
| `contracts/contracts/PotatoPad.sol` | launchpad: token deploy + pool init + single-sided mint + dev-buy |
| `contracts/contracts/PotatoTokenFactory.sol` | CREATE2 deployer for launch tokens (holds their creation bytecode) |
| `contracts/contracts/PotatoFeeLocker.sol` | permanent LP lock + fee splitter (auto-pay treasury, pull for creator, push to holders) |
| `contracts/contracts/PotatoToken.sol` | minimal fixed-supply ERC-20 + time-boxed anti-snipe max-wallet |
| `contracts/contracts/PotatoRewardToken.sol` | the above + O(1) holder fee accrual, credited live from pool fee growth |
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
