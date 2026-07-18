# PotatoPad

An open-source, direct-to-Uniswap-V3 token launchpad. Every launch mints its entire supply as permanently locked, single-sided Uniswap V3 liquidity — so the token is live and tradable from the first block, with no bonding curve and no graduation step. Built to be read, forked, and shipped by people who want to understand exactly how a launchpad works, end to end.

**Live demo: [potato.fm](https://potato.fm/)**

> Demo software. Unaudited. Not production-ready. Not financial advice. This exists to showcase how a direct-to-Uniswap launchpad works. Read every line before it touches real money.

This README is written to be vibecoded: if you can run a few terminal commands and edit an env file, you can run the whole thing locally, deploy it to a testnet, and host the website. Every step is spelled out below.

## Table of contents

1. [What you get](#what-you-get)
2. [How it works](#how-it-works)
3. [Repo layout](#repo-layout)
4. [What you need](#what-you-need)
5. [Run it locally (the full loop)](#run-it-locally-the-full-loop)
6. [Deploy the contracts to a testnet](#deploy-the-contracts-to-a-testnet)
7. [Host the website](#host-the-website)
8. [Configuration](#configuration)
9. [Known limitations](#known-limitations)
10. [License and attribution](#license-and-attribution)

## What you get

- **Smart contracts** (Solidity 0.8.24, Hardhat): a factory that mints single-sided Uniswap V3 liquidity, a permanent fee locker, and a minimal fixed-supply ERC-20. No owner, no mint function, no pause switch, no blacklist.
- **A website** (Next.js App Router, wagmi v2, viem, RainbowKit): a Discover feed, a "Plant a Coin" launch form, and per-token pages with price / market cap, holders, a trade widget, and fee collection. A few small server routes keep infrastructure fast and keys hidden: `/api/rpc` (RPC-key proxy with a write-method denylist, rate limit, and multi-key failover), `/api/tokens` (server-side cached launch feed), and `/api/upload` (image → IPFS via Pinata).
- **Scripts**: a narrated end-to-end demo, a deploy script (local, Base Sepolia, and Robinhood Chain), and a seeder that fills a local chain with sample tokens.
- **Tests**: 23 Hardhat tests that run against the real Uniswap V3 contracts (factory, position manager, router) deployed from the official `@uniswap/*` npm artifacts. No mocks.

## How it works

A launch is a single atomic transaction — no curve, no graduation, no waiting.

1. **Launch.** Anyone calls `createToken(name, symbol, meta, salt)`. It deploys a fixed-supply ERC-20 (1,000,000,000 tokens) with no owner, no mint, no pause, no blacklist — nothing a rug could hide in (the only transfer-time logic is a time-boxed anti-snipe max-wallet cap that becomes a complete no-op after the launch window). `meta` carries the token's image + socials; it's emitted in the `TokenCreated` event and indexed off-chain, so nothing extra is stored on-chain.

2. **Single-sided liquidity.** The pad creates and initializes the token's Uniswap V3 pool (the 1% fee tier) at the open price, then mints the **entire supply as single-sided liquidity — token only, zero ETH** — across a fixed price range: it opens around a **3 ETH fully-diluted valuation** and the range tops out around **525 ETH FDV**. That position's NFT is minted straight into the immutable `PotatoFeeLocker`, which has no transfer and no withdraw path, so the principal is **locked forever (unruggable)**.

3. **Price walks up as people buy.** From the first block the token is live and tradable on Uniswap. As buyers bring WETH, the price walks up through the range and the launch supply sells out of the locked LP — the pad never runs a curve, the open market does the pricing. Attach ETH to `createToken` and it runs an atomic creator "dev-buy" on the fresh pool in the same transaction.

4. **Fees for life.** Every swap pays the pool's 1% fee to the locked position. Anyone can call `locker.collect(tokenId)` to harvest the accrued fees; they split 50/50 — the treasury's half is auto-forwarded on `collect`, and the creator claims their half with `locker.claim()`.

**Why the token address is random.** The token is deployed with `CREATE2` off a caller-supplied **random** salt, so the address is unpredictable until the transaction is public. That stops a griefer from pre-creating and mis-initializing the token's Uniswap pool to break the single-sided mint. If a candidate address is somehow already taken, the pad walks to the next one and self-heals — no launch can be permanently bricked.

**Anti-snipe.** For a short window after launch (a fixed number of blocks) no non-exempt wallet may end a transfer holding more than 2% of supply, throttling bots from vacuuming the opening liquidity. After the window it becomes a complete no-op, so normal trading is never affected.

**Who funds the liquidity?** Nobody up front — the creator only pays gas. The whole supply *is* the liquidity, seeded single-sided, and buyers' WETH is what walks the price up. That's the entire trick behind a "zero-capital" launch.

## Repo layout

```
potatopad/
  contracts/                          Hardhat project (Solidity 0.8.24)
    contracts/PotatoPad.sol           launchpad: token deploy + single-sided LP mint + dev-buy
    contracts/PotatoFeeLocker.sol     permanent LP lock + 50/50 fee splitter
    contracts/PotatoToken.sol         minimal fixed-supply ERC-20 (+ time-boxed anti-snipe)
    contracts/libraries/TickMath.sol  Uniswap tick math, ported to 0.8.24
    contracts/interfaces/             minimal Uniswap V3 interfaces
    test/potatopad.test.ts            32 tests vs real Uniswap V3 bytecode
    scripts/demo.ts                   narrated launch showcase
    scripts/deploy.ts                 local / Base Sepolia / Robinhood deployment
    scripts/seed-demo.ts              fill a local chain for the frontend
  web/                                Next.js + wagmi v2 + RainbowKit
    app/api/rpc/                      server-side RPC-key proxy (denylist + multi-key failover)
    app/api/tokens/                   server-side cached launch feed
    app/api/upload/                   Pinata → IPFS image upload
  README.md                           this file
  LICENSE                             MIT with an attribution requirement
```

New to the codebase? **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** walks the
full contract flow (`createToken` → CREATE2 salt → pool init → single-sided mint
→ locker) and the frontend data layer (the cached `/api/tokens` feed, multi-pad
reads, and the `/api/rpc` proxy).

## What you need

To run locally:

- **Node.js 20 or 22** and npm. That is genuinely all you need for the local loop; a local blockchain (anvil-style) ships with Hardhat.

To deploy to a public testnet and host the site, additionally:

- **A browser wallet** (MetaMask, Rabby, etc.) with a throwaway account.
- **Some testnet ETH.** For Base Sepolia, get it from a faucet (search "Base Sepolia faucet"). A fraction of an ETH is plenty.
- **A deployer private key** (export the throwaway account's key). Never use a key that holds real funds.
- **An RPC URL** for your target chain. The public `https://sepolia.base.org` works; a dedicated one from Alchemy/Infura is more reliable.
- **Optional: a WalletConnect Project ID** (free from cloud.walletconnect.com) if you want mobile/WalletConnect wallets. Browser-extension wallets work without it.

## Run it locally (the full loop)

This gets you the contracts, the demo, and the website running against a local chain with sample tokens, no testnet or faucet needed.

**1. Contracts: install, test, and watch the demo.**

```bash
cd contracts
npm install
npx hardhat test                    # 32 tests, all green
npx hardhat run scripts/demo.ts     # the whole story, narrated in your terminal
```

**2. Start a local chain and seed it with sample tokens.**

Open a terminal and start the node (leave it running):

```bash
cd contracts
npx hardhat node
```

In a second terminal, seed it:

```bash
cd contracts
npx hardhat run scripts/seed-demo.ts --network localhost
```

The seeder prints two lines to copy, the PotatoPad and WETH addresses, that look like:

```
NEXT_PUBLIC_PAD_ADDRESS_LOCALHOST=0x...
NEXT_PUBLIC_WETH_ADDRESS_LOCALHOST=0x...
```

**3. Run the website.**

```bash
cd web
npm install
```

Create `web/.env.local` and paste the two lines the seeder printed:

```
NEXT_PUBLIC_PAD_ADDRESS_LOCALHOST=0x...
NEXT_PUBLIC_WETH_ADDRESS_LOCALHOST=0x...
```

Then:

```bash
npm run dev
```

Open http://localhost:3000. To trade in the UI, add the local network to your wallet (RPC `http://127.0.0.1:8545`, chain id `31337`) and import one of the private keys Hardhat printed when you ran `npx hardhat node`.

## Deploy the contracts to a testnet

Base Sepolia is wired up out of the box (it uses the canonical Uniswap V3 addresses there).

```bash
cd contracts
```

Create `contracts/.env` (see `.env.example`):

```
DEPLOYER_PRIVATE_KEY=0xyour_throwaway_key
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
# optional:
# TREASURY=0x...            # where fees go (defaults to the address below)
# START_FDV_ETH=3           # launch/open fully-diluted valuation, in ETH
# TOP_FDV_ETH=530           # range-ceiling FDV, in ETH
# ANTI_SNIPE_BLOCKS=1200    # length of the 2% max-wallet window, in blocks
```

Deploy:

```bash
npx hardhat run scripts/deploy.ts --network baseSepolia
```

It deploys the pad and its `PotatoFeeLocker`, prints both addresses, and writes `deployments.baseSepolia.json`. The `PotatoPad` constructor takes `(treasury, startFdvWei, topFdvWei, antiSnipeBlocks, factory, positionManager, weth, owner, initialBannedWords)`; the deploy script fills in the Uniswap addresses per network, the FDV/anti-snipe values from the env above, the `owner` (blacklist admin + fee-redirect authority — defaults to the treasury), and the seed blacklist. Note `owner == address(0)` reverts (`InvalidConfig`), so both trailing args are mandatory.

To target a different chain, follow the end-to-end guide in **[docs/ADDING_A_CHAIN.md](docs/ADDING_A_CHAIN.md)**: it's three small edits (a `hardhat.config.ts` network entry, a `CANONICAL` entry in `scripts/deploy.ts`, and one entry in the frontend's `CHAINS` config). **Robinhood Chain mainnet (chainId 4663)** is already wired this way, and is where the live demo runs.

## Host the website

The website is a standard Next.js app, so any host that runs Next works (Vercel, Railway, Netlify, Cloudflare Pages, or a plain Node server via `npm run build && npm run start`).

**What you need:** the repo pushed to GitHub, a host account, and the PotatoPad address from your deploy.

**Steps:**

1. Push this repo to GitHub.
2. In your host, import the repo and set the **Root Directory** to `web` (the Next app lives in `web/`, not the repo root).
3. Add environment variables:
   - `NEXT_PUBLIC_PAD_ADDRESS_<CHAIN>` = the pad address you deployed (e.g. `NEXT_PUBLIC_PAD_ADDRESS_ROBINHOOD`)
   - `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` = your WalletConnect id (optional; without it, only browser-extension wallets work)
   - **Server-only** (never shipped to the browser; used by the `/api` routes):
     - `ROBINHOOD_RPC_URL` = your RPC endpoint. The `/api/rpc` proxy forwards to this so the key stays hidden; add `ROBINHOOD_RPC_URL_2` (and `_3`) for round-robin + 429 failover across keys.
     - `PINATA_JWT` = a Pinata JWT, if you want the "Plant a Coin" image upload (`/api/upload`) to work.
4. Deploy. The host builds with `npm run build` and gives you a URL.

That is it. There is **no database and no indexer to run**: the Discover feed is served by the `/api/tokens` route, which scans launch events once server-side and caches the result for all visitors; everything else is read live from the chain over RPC.

Notes:
- To point the site at mainnet or another chain, add one entry to the `CHAINS` array in `web/lib/config.ts` and set the matching env var — see **[docs/ADDING_A_CHAIN.md](docs/ADDING_A_CHAIN.md)**. Earlier pads for a chain can be listed under that entry's `legacyPads` so their tokens keep showing after you redeploy.
- **You must keep the "Made by proofofpotato.com" footer credit** (see the license section).

## Configuration

| Setting | Default | Where |
|---|---|---|
| Uniswap fee tier | 1% (`POOL_FEE = 10000`) | `PotatoPad.sol` |
| Fee split | 50% creator / 50% treasury | `PotatoPad.sol`, `PotatoFeeLocker.sol` |
| Treasury | `0xd3358b1F39A6a71911c6e33717D185F99d43e80d` | constructor arg (`scripts/deploy.ts`) |
| Total supply | 1,000,000,000 | `PotatoPad.sol` |
| Launch (open) FDV | ~3 ETH | constructor arg (`START_FDV_ETH`) |
| Range-ceiling FDV | ~530 ETH | constructor arg (`TOP_FDV_ETH`) |
| Liquidity | entire supply, single-sided (token only) | `PotatoPad.sol` |
| Anti-snipe | 2% max wallet for `ANTI_SNIPE_BLOCKS` blocks | `PotatoToken.sol` |

The launch supply is seeded single-sided across a tick-aligned range, so the aligned open/top FDVs land within a percent or two of the `START_FDV_ETH` / `TOP_FDV_ETH` targets (the pad exposes the exact values as `actualStartFdv()` / `actualTopFdv()`). Because the token holds no ETH at launch, the opening price is deterministic and there is no curve to front-run.

## Known limitations

These are intentional scope cuts for an MVP, documented so you know what to harden before production.

- **Read the price from the pool.** There is no curve; a token's price and market cap come from its Uniswap V3 pool, not the pad.
- **Feed staleness.** The Discover feed is cached ~45s server-side (`/api/tokens`), so a brand-new launch appears within that window rather than instantly.
- **No full indexer.** The frontend reads chain state over RPC plus the cached feed route. That is great for a demo and for self-hosting with near-zero backend, but at scale you would add an indexer (for example Ponder) over the `TokenCreated` event and serve token pages from it too.
- **Anti-snipe is blunt.** The 2% max-wallet window throttles the most obvious sniping; it is not full MEV protection.
- **Owner can redirect creator fees.** The pad owner can call `redirectFees(tokenId, to)` to reassign a token's FUTURE creator-fee share to any address — a manual, off-chain-judgement power (e.g. an abandoned dev). It cannot touch the locked principal, the treasury cut, or already-accrued balances, and renouncing the owner to `address(0)` freezes it.
- **Griefing is bounded, not eliminated.** A determined attacker can force a specific launch attempt to revert (the creator retries with a fresh random salt and lands on a clean address), but cannot permanently brick the launchpad.

## Charts

Once a token's Uniswap pool is indexed on a [GeckoTerminal](https://api.geckoterminal.com/docs/index.html)-supported network (Base, Ethereum, Arbitrum, Optimism, Robinhood Chain, and more), the token page embeds the GeckoTerminal pool chart for real DEX candles. Testnets and local chains are not indexed by GeckoTerminal (`base-sepolia` returns 404), so they fall back to live pool stats. Network slugs live in `web/lib/config.ts` (`GECKOTERMINAL_NETWORKS`).

## Terms

The site ships a `/terms` page with the full disclaimers below. In short: this is permissionless, unaudited, educational software; tokens are third-party creations; nothing here is an endorsement or financial advice; and you use it entirely at your own risk.

**No endorsement.** Potato Pad is permissionless software: anyone can create a token here without our review or approval. The tokens listed on this site are created and promoted by third parties. We do not endorse, recommend, vet, audit, or vouch for any token, its creator, or its community. Appearing on this site means nothing beyond the fact that someone paid gas to deploy it.

**Not financial advice.** Nothing on this site is investment, financial, legal, or tax advice. These tokens are extremely volatile and most go to zero. Never trade more than you can afford to lose entirely, and do your own research.

**Unaudited software, no warranty.** The Potato Pad smart contracts and this interface are an open-source demonstration. They are provided "as is", without warranty of any kind, and have not undergone a professional security audit. Bugs may exist that cause partial or total loss of funds. Use entirely at your own risk. Launch liquidity positions are locked permanently and irreversibly by design — nobody (including us) can withdraw them.

**Your responsibility.** You are solely responsible for complying with the laws of your jurisdiction, including any restrictions on trading digital assets. Do not use this site where doing so would be unlawful. You are responsible for the security of your own wallet and keys.

This project is provided for **educational purposes**. You are responsible for how you use it; the authors accept no responsibility for any unlawful or wrongful use.

## License and attribution

MIT with an attribution requirement. See [LICENSE](./LICENSE).

Made by [proofofpotato.com](https://proofofpotato.com). Any public deployment, fork, or derivative that has a user-facing interface must keep a visible "Made by proofofpotato.com" credit in its site footer and retain this attribution in its README. That credit may not be removed, hidden, or obscured. Beyond that, fork away. And if you ship a launchpad from this, get an audit first: this code has had adversarial review but no professional audit.
