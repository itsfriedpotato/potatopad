# Potato Pad — web frontend

Next.js 14 (app router) frontend for the PotatoPad bonding-curve launchpad
("plant a coin" → grows on the curve → "harvested" to Uniswap V3).
Stack: React 18, TypeScript, Tailwind CSS v3, wagmi v2 + viem v2, RainbowKit v2,
TanStack Query v5, lucide-react icons.

> Open-source MVP — **unaudited, demo only**.

## Setup

```bash
cd web
npm install
cp .env.example .env.local   # then fill in addresses
npm run dev                  # http://localhost:3000
```

## Environment variables

All variables are optional — the app renders a friendly "not deployed on this
chain" state when a pad address is missing.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_PAD_ADDRESS_BASE_SEPOLIA` | PotatoPad contract address on Base Sepolia |
| `NEXT_PUBLIC_PAD_ADDRESS_LOCALHOST` | PotatoPad contract address on a local Hardhat node (chain id 31337) |
| `NEXT_PUBLIC_WETH_ADDRESS_LOCALHOST` | WETH address on the local Hardhat node (used for locker fee claims). Base Sepolia WETH is hardcoded to `0x4200000000000000000000000000000000000006`. |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect Cloud project id. Falls back to a demo placeholder so builds never require a real one; injected/browser wallets work regardless. |

## Local development against Hardhat

1. In `contracts/`: start a node (`npx hardhat node`) and deploy PotatoPad + a
   WETH9; note the addresses.
2. Put them in `web/.env.local` as `NEXT_PUBLIC_PAD_ADDRESS_LOCALHOST` and
   `NEXT_PUBLIC_WETH_ADDRESS_LOCALHOST`.
3. `npm run dev`, connect a wallet pointed at `http://127.0.0.1:8545`
   (chain id 31337), and switch the app to the Hardhat chain via the chain
   picker in the header.

## Scripts

- `npm run dev` — dev server
- `npm run build` — production build (acceptance test)
- `npm run start` — serve the production build

## Event-driven data (client-side, no indexer)

Several UI features are derived directly from on-chain logs fetched with
`publicClient.getLogs(..., fromBlock: 'earliest')` (see `lib/events.ts`):

- **Ticker strip** (above the header): most recent `TokenCreated`
  ("FRESHLY PLANTED") and `Graduated` ("HARVESTED") events.
- **Token ages / "Fresh" sort** on Discover: `TokenCreated` block timestamps.
- **Price chart**: OHLC candles bucketed from `Trade` events
  (price = `ethAmount / tokenAmount` per trade; bucket = time range / 30,
  min 60s). Rendered as a hand-rolled SVG — no chart library.
- **Trades tab**: latest ~25 `Trade` events, newest first.
- **Holders tab**: balances computed from the token's ERC20 `Transfer` logs
  (top 8, with "Bonding Curve 🥔" / "Uniswap V3 Pool" / "Creator" labels).
- **Stats card**: holders count and 24h volume (sum of `Trade.ethAmount`
  in the last 24h).

All of these refresh live via `useWatchContractEvent`. Log scans from
`earliest` are fine at Hardhat / Base Sepolia demo scale; every fetch is
wrapped in try/catch and the UI degrades to a "history unavailable" state on
RPCs that cap log ranges. Block timestamps are fetched per unique block and
memoized in-process.

## Notes

- ABIs live in `lib/abi.ts`, extracted verbatim from the compiled Hardhat
  artifacts in `contracts/artifacts/contracts/`. Re-extract after changing the
  contracts.
- No external fonts/CDNs/images are used (system font stack only; icons are the
  bundled `lucide-react` package; token avatars are deterministic gradients
  derived from the token address), so the app builds and runs in
  network-restricted environments.
- Slippage for buys/sells is fixed at 1% (`minTokensOut`/`minEthOut` = quote × 0.99),
  shown in the trade widget as "Slippage ~1%".
- The header search box filters the Discover list client-side by name/symbol.
