# PotatoPad

An open-source, pump.fun-style bonding-curve launchpad that graduates tokens into permanently locked Uniswap V3 liquidity. Built to be read, forked, and shipped by people who want to understand exactly how a launchpad works, end to end.

**Live demo: [potato.fm](https://potato.fm/)**

**Official $CHIP contract (Robinhood Chain):** `0x1e4d3243a287EDb687A4cBf2A1223dA54E8c835f` — this is the **only** official token address. Any other address circulating (e.g. `0xee218888246d9e7db71d2afbfb02fcc952b1623d`) is **not** the official contract. Always verify here before you trade.

> Demo software. Unaudited. Not production-ready. Not financial advice. This exists to showcase how curve-launchpad mechanics work. Read every line before it touches real money.

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

- **Smart contracts** (Solidity 0.8.24, Hardhat): a factory, a bonding curve, an automatic Uniswap V3 graduation, and a permanent fee locker. No owner, no mint function, no pause switch, no blacklist.
- **A website** (Next.js 14, wagmi v2, viem, RainbowKit): a Discover feed, a "Plant a Coin" launch form, and per-token pages with a live price chart, trades, holders, a trade widget, and fee claiming. All data is read live over RPC, no separate indexer required.
- **Scripts**: a narrated end-to-end demo, a deploy script (local and Base Sepolia), and a seeder that fills a local chain with tokens at every lifecycle stage.
- **Tests**: 24 Hardhat tests that run against the real Uniswap V3 contracts (factory, position manager, router) deployed from the official `@uniswap/*` npm artifacts. No mocks.

## How it works

A token moves through four stages.

1. **Launch.** Anyone calls `createToken(name, symbol, minTokensOut)` and a fixed-supply ERC-20 (1,000,000,000 tokens) is deployed. The entire supply is held by the launchpad contract. The token has no owner, no mint, no pause, no transfer hooks, nothing a rug could hide in. If you attach ETH to the call, it runs as a creator "dev-buy" in the same transaction. The token's Uniswap V3 pool is also pre-created and initialized at the exact price it will graduate at.

2. **Curve phase.** 800,000,000 tokens are sold on a virtual constant-product bonding curve (the pump.fun shape: virtual reserves of 1 ETH and 1.073B tokens, scaled to the graduation target). Buyers send ETH to `buy()`, price walks up the curve, and the contract just accumulates the ETH. Sellers call `sell()` and get ETH back down the curve. Every trade pays a 1% fee (see the next section).

3. **Graduation.** The moment the curve has collected its ETH target OR sold out the 800M, the triggering buy graduates the token atomically, in the same transaction:
   - it deposits all the ETH the curve collected, plus the 200,000,000 reserved tokens, as full-range liquidity in the token's Uniswap V3 pool on the 1% fee tier,
   - it mints that liquidity position as an NFT straight into the fee locker, which has no withdrawal path, so the liquidity is locked forever (unruggable),
   - it burns any unsold curve tokens, refunds the buyer's excess ETH, and closes the curve (`buy`/`sell` now revert).

4. **Fees for life.** After graduation, people trade the token directly on Uniswap V3. Every swap pays the pool's 1% fee to the locked position. Anyone can call `locker.collect(tokenId)` to harvest those accrued fees, which are split 50/50 between the creator and the treasury and claimed with `locker.claim()`.

**Who funds the liquidity?** Nobody up front. The creator only pays gas. The buyers' ETH accumulates on the curve, and at graduation that pot becomes the locked liquidity. That is the entire trick behind a "zero-capital" fair launch.

## Repo layout

```
potatopad/
  contracts/                       Hardhat project (Solidity 0.8.24)
    contracts/PotatoPad.sol        factory + bonding curve + graduation
    contracts/PotatoFeeLocker.sol  permanent LP lock + fee splitter
    contracts/PotatoToken.sol      minimal fixed-supply ERC-20
    contracts/interfaces/          minimal Uniswap V3 interfaces
    test/potatopad.test.ts         24 tests vs real Uniswap V3 bytecode
    scripts/demo.ts                narrated full-lifecycle showcase
    scripts/deploy.ts              local / Base Sepolia deployment
    scripts/seed-demo.ts           fill a local chain for the frontend
  web/                             Next.js 14 + wagmi v2 + RainbowKit
  README.md                        this file
  LICENSE                          MIT with an attribution requirement
```

## What you need

To run locally:

- **Node.js 20 or 22** and npm. That is genuinely all you need for the local loop; a local blockchain (anvil-style) ships with Hardhat.

To deploy to a public testnet and host the site, additionally:

- **A browser wallet** (MetaMask, Rabbit, etc.) with a throwaway account.
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
npx hardhat test                    # 24 tests, all green
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
# TREASURY=0x...            # where fees go (defaults to the address above)
# GRADUATION_ETH=0.05       # ETH to graduate a curve (small = cheap to demo)
```

Deploy:

```bash
npx hardhat run scripts/deploy.ts --network baseSepolia
```

It prints the PotatoPad address and writes `deployments.baseSepolia.json`. The default testnet graduation target is `0.05 ETH` so you can actually reach graduation without spending much.

To target a different chain, add its Uniswap V3 factory, NonfungiblePositionManager, and WETH addresses to the `CANONICAL` map in `scripts/deploy.ts` and add a network entry in `hardhat.config.ts`. Robinhood Chain (the chain pons uses) works the same way once you plug in its addresses.

## Host the website

The website is a standard Next.js 14 app, so any host that runs Next works. The simplest is **Vercel**.

**What you need:** the repo pushed to GitHub, a (free) Vercel account, and the PotatoPad address from your testnet deploy.

**Steps:**

1. Push this repo to GitHub.
2. In Vercel, "Add New Project" and import the repo.
3. Set the **Root Directory** to `web` (important: the Next app lives in `web/`, not the repo root).
4. Add environment variables (Project Settings, Environment Variables):
   - `NEXT_PUBLIC_PAD_ADDRESS_BASE_SEPOLIA` = the address you deployed
   - `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` = your WalletConnect id (optional; without it, only browser-extension wallets work)
5. Deploy. Vercel builds with `npm run build` and gives you a URL.

That is it. The site reads everything it shows directly from the chain over RPC, so there is no database, no backend, and no indexer to run or pay for.

Notes:
- The build is self-contained and needs no secret keys. All the env vars are public (`NEXT_PUBLIC_*`).
- To point the site at mainnet or another chain later, add that chain and its pad address to `web/lib/config.ts` and set the matching env var.
- Any other Next host (Netlify, Cloudflare Pages, a plain Node server via `npm run build && npm run start`) works too; just set the same env vars and the `web` root.
- **You must keep the "Made by proofofpotato.com" footer credit** (see the license section).

## Configuration

| Setting | Default | Where |
|---|---|---|
| Trade fee | 1% (`TRADE_FEE_BPS = 100`) | `PotatoPad.sol` |
| Fee split | 50% creator / 50% treasury | `PotatoPad.sol`, `PotatoFeeLocker.sol` |
| Treasury | `0xd3358b1F39A6a71911c6e33717D185F99d43e80d` | constructor arg (`scripts/deploy.ts`) |
| Total supply | 1,000,000,000 | `PotatoPad.sol` |
| Curve / LP split | 800M on the curve / 200M reserved for the LP | `PotatoPad.sol` |
| Graduation target | 4 ETH (0.05 on testnet) | constructor arg |
| Virtual reserves | `graduationEth / 4` ETH, 1.073B tokens | constructor arg |
| Uniswap fee tier | 1% (`POOL_FEE = 10000`), full range | `PotatoPad.sol` |

With the default ratios the 800M supply cap binds first, at about 2.93 ETH collected, and the pool's initial price is derived from exactly that deterministic outcome. This is why the graduation price is knowable at deploy time and cannot be front-run.

## Known limitations

These are intentional scope cuts for an MVP, documented so you know what to harden before production.

- **Extreme foreign liquidity at graduation.** The brick is fixed, but a griefer who locks an economically irrational amount of real liquidity could still hold the price slightly off target at graduation, causing a bounded value leak (the LP mints at a nearby price rather than the exact target). Production fix: swap-to-target with a TWAP guard, or a dedicated graduation pool.
- **`currentPrice()` is the curve price.** After graduation, read the price from the Uniswap pool, not the pad.
- **No indexer.** The frontend reads chain state and event logs directly over RPC. That is great for a demo and for self-hosting with zero backend, but at scale you would put an indexer (for example Ponder) in front of the `TokenCreated` / `Trade` / `Graduated` events.
- **Frontend is demo-grade.** No anti-snipe, no social login, no comments backend.

## How the graduation math works

The curve is `x * y = k` over virtual reserves. Buys add ETH to `x` and remove tokens from `y`; the contract just banks the real ETH. With a virtual 1 ETH and 1.073B tokens and an 800M curve allocation, selling out collects about 2.93 ETH, and the LP is seeded with that 2.93 ETH plus 200M tokens, which lands within roughly 2% of the final curve price, so there is no price cliff at graduation. Buys that would overshoot either cap are clamped and the surplus is refunded, which is what makes the final LP amounts, and therefore the pool's starting price, deterministic at deploy time.

## Charts

Curve-phase tokens are charted from on-chain `Trade` events (no indexer needed). Once a token graduates on a [GeckoTerminal](https://api.geckoterminal.com/docs/index.html)-indexed network (Base, Ethereum, Arbitrum, Optimism, Robinhood Chain, and more), the token page switches to the GeckoTerminal pool embed for real DEX candles. Testnets and local chains are not indexed by GeckoTerminal (`base-sepolia` returns 404), so they keep the event-built chart. Network slugs live in `web/lib/config.ts` (`GECKOTERMINAL_NETWORKS`).

## Terms

The site ships a `/terms` page with the full disclaimers below. In short: this is permissionless, unaudited, educational software; tokens are third-party creations; nothing here is an endorsement or financial advice; and you use it entirely at your own risk.

**No endorsement.** Potato Pad is permissionless software: anyone can create a token here without our review or approval. The tokens listed on this site are created and promoted by third parties. We do not endorse, recommend, vet, audit, or vouch for any token, its creator, or its community. Appearing on this site means nothing beyond the fact that someone paid gas to deploy it.

**Not financial advice.** Nothing on this site is investment, financial, legal, or tax advice. Bonding-curve tokens are extremely volatile and most go to zero. Never trade more than you can afford to lose entirely, and do your own research.

**Unaudited software, no warranty.** The Potato Pad smart contracts and this interface are an open-source demonstration. They are provided "as is", without warranty of any kind, and have not undergone a professional security audit. Bugs may exist that cause partial or total loss of funds. Use entirely at your own risk. Graduated liquidity positions are locked permanently and irreversibly by design — nobody (including us) can withdraw them.

**Your responsibility.** You are solely responsible for complying with the laws of your jurisdiction, including any restrictions on trading digital assets. Do not use this site where doing so would be unlawful. You are responsible for the security of your own wallet and keys.

This project is provided for **educational purposes**. You are responsible for how you use it; the authors accept no responsibility for any unlawful or wrongful use.

## License and attribution

MIT with an attribution requirement. See [LICENSE](./LICENSE).

Made by [proofofpotato.com](https://proofofpotato.com). Any public deployment, fork, or derivative that has a user-facing interface must keep a visible "Made by proofofpotato.com" credit in its site footer and retain this attribution in its README. That credit may not be removed, hidden, or obscured. Beyond that, fork away. And if you ship a launchpad from this, get an audit first: this code has had adversarial review but no professional audit.
