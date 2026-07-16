import { defineChain, type Address } from "viem";
import { baseSepolia, hardhat } from "wagmi/chains";

/**
 * Robinhood Chain mainnet (Arbitrum Orbit L2, chainId 4663). Not in wagmi/chains
 * yet, so defined here. Uses the PUBLIC RPC for client reads — never embed a
 * private Alchemy key in the browser bundle.
 */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Robinscan", url: "https://robinhoodchain.blockscout.com" },
  },
});

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as Address;

function envAddress(value: string | undefined): Address {
  return value && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? (value as Address)
    : ZERO_ADDRESS;
}

/** PotatoPad contract address per chain (zero address = not deployed). */
export const PAD_ADDRESSES: Record<number, Address> = {
  [baseSepolia.id]: envAddress(process.env.NEXT_PUBLIC_PAD_ADDRESS_BASE_SEPOLIA),
  [hardhat.id]: envAddress(process.env.NEXT_PUBLIC_PAD_ADDRESS_LOCALHOST),
  [robinhoodChain.id]: envAddress(process.env.NEXT_PUBLIC_PAD_ADDRESS_ROBINHOOD),
};

/** Canonical WETH per chain (single-sided LP pairs token/WETH; locker pays fees in WETH). */
export const WETH_ADDRESSES: Record<number, Address> = {
  [baseSepolia.id]: "0x4200000000000000000000000000000000000006",
  [hardhat.id]: envAddress(process.env.NEXT_PUBLIC_WETH_ADDRESS_LOCALHOST),
  // Verified on-chain (a live Uniswap pool's token0) and in Robinhood's docs.
  [robinhoodChain.id]: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
};

/**
 * Uniswap V3 1% fee tier — the tier every PotatoPad pool is launched into.
 * Buys/sells and quotes must target this exact tier.
 */
export const POOL_FEE_TIER = 10_000;

/**
 * Uniswap SwapRouter02 per chain, for in-app buy/sell. Only Robinhood is wired
 * for in-app trading; other chains are `undefined`, which disables the router
 * path and falls back to the "Trade on Uniswap" link.
 */
export const SWAP_ROUTER_ADDRESSES: Record<number, Address | undefined> = {
  [robinhoodChain.id]: "0xcaf681a66d020601342297493863e78c959e5cb2",
};

/**
 * Uniswap QuoterV2 per chain, for accurate buy/sell output estimates that
 * account for the single-sided pool's price impact. Optional — a missing quote
 * disables the in-app trade button (the Uniswap link still works).
 */
export const QUOTER_ADDRESSES: Record<number, Address | undefined> = {
  [robinhoodChain.id]: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
};

/**
 * Block to start scanning pad event logs from, per chain. Live RPCs cap
 * eth_getLogs ranges (Alchemy on Robinhood = 10k blocks), so we scan from the
 * pad's deploy block forward in chunks rather than from genesis. 0 = genesis
 * (fine for a fresh local chain). UPDATE the live value when you redeploy the pad.
 */
export const PAD_START_BLOCK: Record<number, bigint> = {
  [robinhoodChain.id]: 11_555_000n, // deploy block of the CREATE2 pad 0x12A0…D91F
  [baseSepolia.id]: 0n,
  [hardhat.id]: 0n,
};

/** A single PotatoPad deployment: its address and the block to scan logs from. */
export interface PadDeployment {
  address: Address;
  startBlock: bigint;
}

/**
 * Read-only pads from EARLIER deploys that still custody launched tokens. The
 * primary (write) pad lives in {PAD_ADDRESSES} via env; these are historical,
 * hard-coded address constants so their tokens keep showing after a repoint.
 */
export const LEGACY_PADS: Record<number, PadDeployment[]> = {
  [robinhoodChain.id]: [
    // v2 pad (pre-CREATE2 fix). Still holds CHIP + anything launched on it.
    { address: "0xc12723c251dABcBe10c4F44060A6AE6b5E96a79d", startBlock: 11_481_181n },
  ],
};

/**
 * Every pad to READ for a chain when discovering / resolving tokens: the primary
 * (write) pad first, then legacy pads. Deduped by address and stripped of the
 * zero address, so if the primary env pad still equals a legacy one we never
 * double-scan.
 */
export function padDeployments(chainId: number): PadDeployment[] {
  const all: PadDeployment[] = [
    { address: PAD_ADDRESSES[chainId] ?? ZERO_ADDRESS, startBlock: PAD_START_BLOCK[chainId] ?? 0n },
    ...(LEGACY_PADS[chainId] ?? []),
  ];
  const seen = new Set<string>();
  const out: PadDeployment[] = [];
  for (const p of all) {
    const key = p.address.toLowerCase();
    if (p.address === ZERO_ADDRESS || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export const SUPPORTED_CHAINS = [robinhoodChain, baseSepolia, hardhat] as const;

export function chainName(chainId: number): string {
  const chain = SUPPORTED_CHAINS.find((c) => c.id === chainId);
  return chain?.name ?? `chain ${chainId}`;
}

/** Block-explorer base URL for a chain, if it has one (local Hardhat does not). */
export function explorerBaseUrl(chainId: number): string | undefined {
  const chain = SUPPORTED_CHAINS.find((c) => c.id === chainId);
  return chain && "blockExplorers" in chain
    ? chain.blockExplorers?.default?.url
    : undefined;
}

export function txUrl(chainId: number, hash: string): string | undefined {
  const base = explorerBaseUrl(chainId);
  return base ? `${base}/tx/${hash}` : undefined;
}

export function addressUrl(chainId: number, address: string): string | undefined {
  const base = explorerBaseUrl(chainId);
  return base ? `${base}/address/${address}` : undefined;
}

/** Uniswap interface chain slugs, for the "Trade on Uniswap" link. */
const UNISWAP_CHAIN_SLUGS: Record<number, string> = {
  4663: "robinhood",
  8453: "base",
  84532: "base_sepolia",
};

export function uniswapSwapUrl(token: string, chainId?: number): string {
  const slug = (chainId !== undefined && UNISWAP_CHAIN_SLUGS[chainId]) || "robinhood";
  return `https://app.uniswap.org/swap?outputCurrency=${token}&chain=${slug}`;
}

/**
 * GeckoTerminal network slugs by chain id, for the embedded pool chart. Every
 * v2 token is live on Uniswap V3 from launch, so its pool is charted directly.
 * Only live, GT-indexed networks belong here — testnets and local chains 404
 * (verified: `base-sepolia` is not indexed) and fall back to a placeholder.
 * Full slug list: GET api.geckoterminal.com/api/v2/networks
 */
export const GECKOTERMINAL_NETWORKS: Record<number, string> = {
  1: "eth",
  10: "optimism",
  8453: "base",
  42161: "arbitrum",
  4663: "robinhood",
};

export function geckoTerminalPoolUrl(chainId: number, pool: string): string | undefined {
  const network = GECKOTERMINAL_NETWORKS[chainId];
  return network
    ? `https://www.geckoterminal.com/${network}/pools/${pool}?embed=1&info=0&swaps=0&light_chart=0`
    : undefined;
}

export const PROOF_OF_POTATO_URL = "https://proofofpotato.com";
