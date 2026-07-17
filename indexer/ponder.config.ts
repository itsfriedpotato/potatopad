import { createConfig, factory } from "ponder";
import { http, parseAbiItem } from "viem";
import { Erc20Abi } from "./abis/Erc20Abi";
import { PotatoPadAbi } from "./abis/PotatoPadAbi";

/**
 * PotatoPad indexer. Ingests every pad's `TokenCreated` and each launched
 * token's ERC-20 `Transfer` into Postgres, then serves the Discover feed and
 * per-token holder lists from src/api — replacing the live eth_getLogs scans the
 * web app did per visitor (see web/app/api/tokens + web/app/api/holders).
 */

// Robinhood Chain mainnet (Arbitrum Orbit L2). Public RPC works but a dedicated
// key (Alchemy) is strongly recommended for backfill throughput.
const CHAIN_ID = Number(process.env.PONDER_CHAIN_ID ?? 4663);

// Pads to index: primary (write) pad + legacy pads that still custody tokens.
// Mirrors web/lib/config.ts PAD_ADDRESSES + LEGACY_PADS. Override via env.
const PADS = (
  process.env.PONDER_PAD_ADDRESSES?.split(",").map((s) => s.trim()) ?? [
    "0x12A075A946c790F05a23d2DcEa70B207DB23D91F", // CREATE2 pad
    "0xc12723c251dABcBe10c4F44060A6AE6b5E96a79d", // v2 legacy pad (holds CHIP)
  ]
).filter(Boolean) as `0x${string}`[];

// Earliest pad deploy block — matches PAD_START_BLOCK / LEGACY_PADS in the web
// config. Scanning both pads from the earliest is harmless (no events before a
// pad's own deploy) and keeps a single start block.
const START_BLOCK = Number(process.env.PONDER_START_BLOCK ?? 11_481_181);

const tokenCreatedEvent = parseAbiItem(
  "event TokenCreated(address indexed token, address indexed creator, string name, string symbol, address pool, string imageURI, string website, string twitter, string telegram)",
);

export default createConfig({
  chains: {
    robinhood: {
      id: CHAIN_ID,
      rpc: http(process.env.PONDER_RPC_URL_4663 || "https://rpc.mainnet.chain.robinhood.com"),
    },
  },
  contracts: {
    // The pads themselves — source of the Discover feed.
    PotatoPad: {
      abi: PotatoPadAbi,
      chain: "robinhood",
      address: PADS,
      startBlock: START_BLOCK,
    },
    // Every token any pad created, discovered via the TokenCreated log. Ponder
    // merges child addresses across all factory addresses.
    PotatoToken: {
      abi: Erc20Abi,
      chain: "robinhood",
      address: factory({
        address: PADS,
        event: tokenCreatedEvent,
        parameter: "token",
        startBlock: START_BLOCK,
      }),
      startBlock: START_BLOCK,
    },
  },
});
