import { defineChain, type Address, type Chain } from "viem";
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
  contracts: {
    // Canonical Multicall3, verified live on Robinhood via eth_getCode. Lets
    // wagmi/viem batch the Discover slot0 fan-out (~39 pool reads per visitor)
    // into ONE eth_call (multicall3.aggregate3) instead of 39, which is the
    // single biggest cut to burst RPC volume — bigger than adding nodes.
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as Address;

function envAddress(value: string | undefined): Address {
  return value && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? (value as Address)
    : ZERO_ADDRESS;
}

/**
 * Like {envAddress} but yields `undefined` rather than the zero address, for
 * OPTIONAL config where "unset" must stay distinguishable from "set to zero" —
 * an unset `swapRouter` disables in-app trading, whereas a zero address would
 * be treated as a real contract and every swap would revert.
 */
function envAddressOpt(value: string | undefined): Address | undefined {
  const a = envAddress(value);
  return a === ZERO_ADDRESS ? undefined : a;
}

/** Whether a pad is the bonding-curve launcher or the direct-to-Uniswap one. */
export type PadKind = "curve" | "direct";

/** A single pad deployment: its address, the block to scan logs from, and kind. */
export interface PadDeployment {
  address: Address;
  startBlock: bigint;
  /** Optional last block to index. Legacy pads are capped at the repoint block so
   *  their EXISTING tokens still render, but post-repoint launches on a superseded
   *  (blacklist-less) pad don't surface. Omit = scan to latest. */
  endBlock?: bigint;
  /** Defaults to "direct" when omitted (e.g. legacy pad literals). */
  kind?: PadKind;
}

/**
 * Everything the frontend needs to know about ONE chain, in one place. Adding a
 * chain means adding a single entry to {CHAINS} below — every per-chain lookup
 * map exported from this file is DERIVED from these entries, so there is exactly
 * one edit site. See docs/ADDING_A_CHAIN.md for the end-to-end process.
 */
export interface ChainConfig {
  /** The viem/wagmi chain object (id, RPC, explorer). */
  chain: Chain;
  /**
   * The read-only DIRECT-to-Uniswap PotatoPad address (legacy launch mode), from
   * a public env var. New launches no longer use it, but its tokens still resolve
   * and trade. Zero/undefined = not deployed.
   */
  padAddress?: string;
  /**
   * The PRIMARY (write) bonding-curve launcher — PotatoCurvePad — from a public
   * env var. All new launches go here. Zero/undefined = not deployed.
   */
  curvePadAddress?: string;
  /** Block to start scanning the curve pad's event logs from (its deploy block). */
  curvePadStartBlock?: bigint;
  /** Canonical WETH the single-sided LP pairs against (locker pays fees in WETH). */
  weth: Address;
  /** Uniswap SwapRouter02 for in-app buy/sell. Omit to disable the in-app router. */
  swapRouter?: Address;
  /** Uniswap QuoterV2 for accurate buy/sell estimates. Omit to disable in-app quotes. */
  quoter?: Address;
  /** Block to start scanning pad event logs from (the pad's deploy block). */
  padStartBlock: bigint;
  /** Read-only pads from EARLIER deploys that still custody launched tokens. */
  legacyPads?: PadDeployment[];
  /** Uniswap interface chain slug, for the "Trade on Uniswap" link. */
  uniswapSlug?: string;
  /** GeckoTerminal network slug, for the embedded pool chart (only GT-indexed chains). */
  geckoTerminalNetwork?: string;
}

/**
 * SINGLE SOURCE OF TRUTH for supported chains. To add a chain, append one entry
 * here (and deploy the pad + wire contracts/ — see docs/ADDING_A_CHAIN.md). The
 * derived maps below need no edits.
 */
export const CHAINS: ChainConfig[] = [
  {
    chain: robinhoodChain,
    padAddress: process.env.NEXT_PUBLIC_PAD_ADDRESS_ROBINHOOD,
    curvePadAddress: process.env.NEXT_PUBLIC_CURVE_PAD_ADDRESS_ROBINHOOD,
    curvePadStartBlock: 13_369_100n, // PotatoCurvePad 0x12fcf1… ($2.5k/$44k, lock-at-launch, post-merge) deploy block 13369169
    // Verified on-chain (a live Uniswap pool's token0) and in Robinhood's docs.
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    // Only Robinhood is wired for in-app trading (router + quoter present).
    swapRouter: "0xcaf681a66d020601342297493863e78c959e5cb2",
    quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
    padStartBlock: 14_072_000n, // deploy block of the holder-rewards pad 0x88eB…A338
    legacyPads: [
      // Superseded pads, CAPPED at the block their successor took over: existing
      // tokens still render, but launches after the repoint do not surface. No
      // token is lost — every pre-repoint launch is below the cap. (The cap on
      // 0x6722 has a small buffer past 13_221_549 to cover the deploy→repoint
      // window, so a token launched during it still shows.)
      // v5 pad 0xe26e…9001 — the 2%/redirect/owner pad, superseded by the holder-rewards pad.
      { address: "0xe26e17B552A3f0361b0546443FFe58F7cF509001", startBlock: 13_221_549n, endBlock: 14_073_506n },
      // v4 pad 0x6722…63E8 — the burn+blacklist pad, superseded by the redirect pad.
      { address: "0x67225AC6ba037aA220F68e5aAA2b49Be4B0863E8", startBlock: 12_757_281n, endBlock: 13_230_000n },
      // v3 pad 0x12A0…D91F — held all launches before the burn+blacklist upgrade.
      { address: "0x12A075A946c790F05a23d2DcEa70B207DB23D91F", startBlock: 11_555_000n, endBlock: 12_757_281n },
      // v2 pad (pre-CREATE2 fix) — still holds CHIP + anything launched on it.
      { address: "0xc12723c251dABcBe10c4F44060A6AE6b5E96a79d", startBlock: 11_481_181n, endBlock: 12_757_281n },
    ],
    uniswapSlug: "robinhood",
    geckoTerminalNetwork: "robinhood",
  },
  {
    chain: baseSepolia,
    padAddress: process.env.NEXT_PUBLIC_PAD_ADDRESS_BASE_SEPOLIA,
    curvePadAddress: process.env.NEXT_PUBLIC_CURVE_PAD_ADDRESS_BASE_SEPOLIA,
    curvePadStartBlock: 0n,
    weth: "0x4200000000000000000000000000000000000006",
    padStartBlock: 0n,
    uniswapSlug: "base_sepolia",
    // NB: base-sepolia is NOT indexed by GeckoTerminal (404s), so no chart network.
  },
  {
    chain: hardhat,
    padAddress: process.env.NEXT_PUBLIC_PAD_ADDRESS_LOCALHOST,
    curvePadAddress: process.env.NEXT_PUBLIC_CURVE_PAD_ADDRESS_LOCALHOST,
    curvePadStartBlock: 0n, // fresh local chain scans from genesis
    weth: envAddress(process.env.NEXT_PUBLIC_WETH_ADDRESS_LOCALHOST),
    padStartBlock: 0n, // fresh local chain scans from genesis
    // A local chain has no canonical Uniswap deployment, so the router and
    // quoter are whatever `scripts/local-playground.ts` just deployed. Unset
    // means no in-app trading, exactly as on any other unwired chain.
    swapRouter: envAddressOpt(process.env.NEXT_PUBLIC_SWAP_ROUTER_LOCALHOST),
    quoter: envAddressOpt(process.env.NEXT_PUBLIC_QUOTER_LOCALHOST),
  },
];

/** Look up a chain's config by id (undefined for unsupported chains). */
function configFor(chainId: number): ChainConfig | undefined {
  return CHAINS.find((c) => c.chain.id === chainId);
}

/** Build a `Record<chainId, T>` from each chain's config in one place. */
function byChain<T>(pick: (c: ChainConfig) => T): Record<number, T> {
  return Object.fromEntries(CHAINS.map((c) => [c.chain.id, pick(c)]));
}

/** Read-only DIRECT-to-Uniswap PotatoPad address per chain (zero = not deployed). */
export const PAD_ADDRESSES: Record<number, Address> = byChain((c) => envAddress(c.padAddress));

/** PRIMARY (write) bonding-curve PotatoCurvePad address per chain (zero = not deployed). */
export const CURVE_PAD_ADDRESSES: Record<number, Address> = byChain((c) => envAddress(c.curvePadAddress));

/** Canonical WETH per chain (single-sided LP pairs token/WETH; locker pays fees in WETH). */
export const WETH_ADDRESSES: Record<number, Address> = byChain((c) => c.weth);

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
export const SWAP_ROUTER_ADDRESSES: Record<number, Address | undefined> = byChain((c) => c.swapRouter);

/**
 * Uniswap QuoterV2 per chain, for accurate buy/sell output estimates that
 * account for the single-sided pool's price impact. Optional — a missing quote
 * disables the in-app trade button (the Uniswap link still works).
 */
export const QUOTER_ADDRESSES: Record<number, Address | undefined> = byChain((c) => c.quoter);

/**
 * Block to start scanning pad event logs from, per chain. Live RPCs cap
 * eth_getLogs ranges (Alchemy on Robinhood = 10k blocks), so we scan from the
 * pad's deploy block forward in chunks rather than from genesis. 0 = genesis
 * (fine for a fresh local chain). UPDATE the live value when you redeploy the pad.
 */
export const PAD_START_BLOCK: Record<number, bigint> = byChain((c) => c.padStartBlock);

/** Block to start scanning the curve pad's logs from, per chain. */
export const CURVE_PAD_START_BLOCK: Record<number, bigint> = byChain((c) => c.curvePadStartBlock ?? 0n);

/**
 * Read-only pads from EARLIER deploys that still custody launched tokens. The
 * primary (write) pad lives in {PAD_ADDRESSES} via env; these are historical,
 * hard-coded address constants so their tokens keep showing after a repoint.
 */
export const LEGACY_PADS: Record<number, PadDeployment[]> = byChain((c) => c.legacyPads ?? []);

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

/**
 * Tokens hidden from the browse LISTS (Discover feed + ticker strip) — e.g. a
 * PotatoPad launch that duplicates a curated Ancient runner, so it should surface
 * only under Ancients. Hidden from lists ONLY: the token's own page and in-app
 * trade still resolve by direct link. Compared lowercase.
 */
const HIDDEN_TOKENS = new Set<string>([
  "0x6b1855cca09b826dd9b2b6025ef4f7447de549a5", // duplicates an Ancient entry
]);

export function isHiddenToken(address: string): boolean {
  return HIDDEN_TOKENS.has(address.toLowerCase());
}

/** The chain's bonding-curve pad as a scannable deployment, or undefined if unset. */
export function curvePadDeployment(chainId: number): PadDeployment | undefined {
  const address = CURVE_PAD_ADDRESSES[chainId] ?? ZERO_ADDRESS;
  if (address === ZERO_ADDRESS) return undefined;
  return { address, startBlock: CURVE_PAD_START_BLOCK[chainId] ?? 0n, kind: "curve" };
}

/**
 * Every pad to READ for a chain, KIND-TAGGED: the curve pad FIRST (primary going
 * forward, so it wins token-resolution precedence), then the direct pad(s). Used
 * by the launch-feed scan, the holders scan's earliest block, and token
 * resolution. Deduped by address, zero-stripped.
 */
export function allPadDeployments(chainId: number): PadDeployment[] {
  const curve = curvePadDeployment(chainId);
  const directs: PadDeployment[] = padDeployments(chainId).map((p) => ({ ...p, kind: "direct" }));
  const all: PadDeployment[] = curve ? [curve, ...directs] : directs;
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

/** True if the chain can launch (curve pad set) OR has any legacy/direct token to show. */
export function isChainDeployed(chainId: number): boolean {
  return (CURVE_PAD_ADDRESSES[chainId] ?? ZERO_ADDRESS) !== ZERO_ADDRESS
    || padDeployments(chainId).length > 0;
}

export const SUPPORTED_CHAINS = CHAINS.map((c) => c.chain);

export function chainName(chainId: number): string {
  return configFor(chainId)?.chain.name ?? `chain ${chainId}`;
}

/** Block-explorer base URL for a chain, if it has one (local Hardhat does not). */
export function explorerBaseUrl(chainId: number): string | undefined {
  return configFor(chainId)?.chain.blockExplorers?.default?.url;
}

export function txUrl(chainId: number, hash: string): string | undefined {
  const base = explorerBaseUrl(chainId);
  return base ? `${base}/tx/${hash}` : undefined;
}

export function addressUrl(chainId: number, address: string): string | undefined {
  const base = explorerBaseUrl(chainId);
  return base ? `${base}/address/${address}` : undefined;
}

/**
 * Uniswap interface chain slugs, for the "Trade on Uniswap" link. Derived from
 * {CHAINS}, plus a few extra live networks a token could be bridged/traded on.
 */
const UNISWAP_CHAIN_SLUGS: Record<number, string> = {
  8453: "base", // base mainnet — not a launch chain, but a valid Uniswap target
  ...byChain((c) => c.uniswapSlug),
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
 * Derived from {CHAINS}, plus common L1/L2s a bridged token could chart on.
 * Full slug list: GET api.geckoterminal.com/api/v2/networks
 */
export const GECKOTERMINAL_NETWORKS: Record<number, string> = {
  1: "eth",
  10: "optimism",
  8453: "base",
  42161: "arbitrum",
  ...byChain((c) => c.geckoTerminalNetwork),
};

export function geckoTerminalPoolUrl(chainId: number, pool: string): string | undefined {
  const network = GECKOTERMINAL_NETWORKS[chainId];
  return network
    ? `https://www.geckoterminal.com/${network}/pools/${pool}?embed=1&info=0&swaps=0&light_chart=0&chart_type=market_cap&resolution=1m&bg_color=000000`
    : undefined;
}

export const PROOF_OF_POTATO_URL = "https://proofofpotato.com";

/** Canonical public origin. Also the website a coin gets when its creator leaves
 *  the field blank, so explorers reading the launch metadata link somewhere real
 *  instead of showing nothing. */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://potato.fm";
