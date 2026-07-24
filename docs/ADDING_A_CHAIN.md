# Adding a chain

> **Uniswap V4 port.** New chains use a **Uniswap V4 deployment** (the singleton
> `PoolManager`, plus StateView / Universal Router / Permit2 / V4 Quoter for the
> frontend). The deploy scripts take the `PoolManager` + WETH per network
> (canonical for Base/Base Sepolia; `POOL_MANAGER` / `WETH` env vars elsewhere —
> see developers.uniswap.org/contracts/v4/deployments). In `web/lib/config.ts`,
> tag the chain entry with `uniswapVersion: "v4"` and set `stateView`,
> `universalRouter`, `permit2`, `poolManager`, and `quoter`. Legacy chains keep
> `uniswapVersion: "v3"` (Robinhood) and their SwapRouter02/QuoterV2 addresses, so
> existing V3 tokens keep displaying and trading — the frontend routes by this tag.

PotatoPad runs on any EVM chain that has a **Uniswap deployment** and a
**canonical WETH**. Adding one is three small, independent edits: deploy the
contract, tell the deploy script where Uniswap lives, and tell the frontend about
the new chain.

Robinhood Chain mainnet (chainId `4663`) is already wired end-to-end and is the
best worked example to copy.

## What you need first

- The chain's **RPC URL** and **chainId**.
- Its **Uniswap V3 factory** and **NonfungiblePositionManager** addresses. These
  are on [Uniswap's deployments page](https://docs.uniswap.org/contracts/v3/reference/deployments/)
  for canonical chains, or triangulate them on-chain: a live pool's `factory()`
  and the NPM's `factory()` / `WETH9()` should be self-consistent, and
  `factory.feeAmountTickSpacing(10000)` must be non-zero (the 1% tier PotatoPad
  launches into must exist).
- Its **canonical WETH** address (verify it equals a live WETH pool's `token0`).
- Optionally, the Uniswap **SwapRouter02** and **QuoterV2** for in-app trading,
  and the chain's **GeckoTerminal** network slug for the embedded price chart.

## 1. Contracts — deploy the pad

Two edits under `contracts/`, both keyed by the Hardhat **network name**:

**`contracts/hardhat.config.ts`** — add a network entry:

```ts
myChain: {
  url: process.env.MYCHAIN_RPC_URL || "https://rpc.mychain.example",
  chainId: 1234,
  accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
},
```

**`contracts/scripts/deploy.ts`** — add the Uniswap addresses to `CANONICAL`
under the same network name:

```ts
myChain: {
  factory: "0x…",   // UniswapV3Factory
  npm:     "0x…",   // NonfungiblePositionManager
  weth:    "0x…",   // canonical WETH
},
```

Then deploy (see the [README](../README.md#deploy-the-contracts-to-a-testnet)
for the FDV / treasury env vars):

```bash
cd contracts
npx hardhat run scripts/deploy.ts --network myChain
```

It prints the `PotatoPad` and `PotatoFeeLocker` addresses and writes
`deployments.myChain.json`. Note the pad address and its **deploy block** — the
frontend needs both.

## 2. Frontend — register the chain

The frontend has a **single source of truth**: the `CHAINS` array in
[`web/lib/config.ts`](../web/lib/config.ts). Every per-chain lookup map
(`PAD_ADDRESSES`, `WETH_ADDRESSES`, `SWAP_ROUTER_ADDRESSES`, `QUOTER_ADDRESSES`,
`PAD_START_BLOCK`, `LEGACY_PADS`, `SUPPORTED_CHAINS`, and the Uniswap /
GeckoTerminal slug maps) is **derived** from it, so you add exactly one entry:

```ts
{
  chain: myChain,                                   // a viem/wagmi Chain (see below)
  padAddress: process.env.NEXT_PUBLIC_PAD_ADDRESS_MYCHAIN,
  weth: "0x…",
  swapRouter: "0x…",        // optional — omit to disable in-app trading
  quoter: "0x…",            // optional — omit to disable in-app quotes
  padStartBlock: 1234567n,  // the pad's deploy block (log-scan start)
  legacyPads: [],           // optional — earlier pads whose tokens still show
  uniswapSlug: "mychain",   // optional — the "Trade on Uniswap" link slug
  geckoTerminalNetwork: "mychain", // optional — only if GT indexes this chain
},
```

If the chain isn't in `wagmi/chains`, define it with viem's `defineChain` first
(the `robinhoodChain` export at the top of `config.ts` is the template) and pass
it as `chain`. Otherwise import it from `wagmi/chains`.

That is the only frontend edit. `wagmi.ts` builds its chain/transport list from
these exports, so no separate wagmi change is needed.

## 3. Environment

Set the pad address env var you referenced above, matching the
`NEXT_PUBLIC_PAD_ADDRESS_<CHAIN>` convention:

```bash
NEXT_PUBLIC_PAD_ADDRESS_MYCHAIN=0x…   # the pad from step 1
```

For a chain whose RPC key must stay server-side, add a matching `/api/rpc`
proxy env (`MYCHAIN_RPC_URL`) — see the [README hosting section](../README.md#host-the-website).

## Checklist

- [ ] `contracts/hardhat.config.ts` — network entry added
- [ ] `contracts/scripts/deploy.ts` — `CANONICAL[myChain]` added
- [ ] Pad deployed; address + deploy block recorded
- [ ] `web/lib/config.ts` — one `CHAINS` entry added
- [ ] `NEXT_PUBLIC_PAD_ADDRESS_<CHAIN>` set in the frontend env
- [ ] `npx tsc --noEmit` and `npm run build` clean in `web/`

## Why the split

The contract edits (`hardhat.config.ts`, `deploy.ts`) run under Node/Hardhat and
are keyed by Hardhat network name; the frontend edit runs in the browser bundle
and is keyed by chainId. They live in separate build graphs, so they can't share
one module — but each side is now a single, obvious edit site.
