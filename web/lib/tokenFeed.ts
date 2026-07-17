import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { padDeployments, robinhoodChain, ZERO_ADDRESS } from "@/lib/config";

/**
 * Server-side, cached Discover feed — the single source the `/api/tokens` route,
 * the token page's `generateMetadata`, and its `opengraph-image` all read from.
 *
 * The `TokenCreated` log scan across all pads runs ONCE here and is cached in
 * memory for a short TTL, so every consumer shares one scan instead of each
 * hammering the RPC. A poor-man's indexer.
 */

const tokenCreatedEvent = parseAbiItem(
  "event TokenCreated(address indexed token, address indexed creator, string name, string symbol, address pool, string imageURI, string website, string twitter, string telegram)",
);

const LOG_CHUNK = 9_000n; // Alchemy on Robinhood caps eth_getLogs at 10k blocks.
const SCAN_CONCURRENCY = 4; // windows fetched at once — fast without a CU spike.
const CACHE_TTL_MS = 45_000;

interface TokenCreatedArgs {
  token: Address;
  creator: Address;
  name: string;
  symbol: string;
  pool: Address;
  imageURI: string;
  website: string;
  twitter: string;
  telegram: string;
}
type CreatedLog = { blockNumber: bigint | null; args: Partial<TokenCreatedArgs> };

export interface CreationDTO {
  token: Address;
  creator: Address;
  name: string;
  symbol: string;
  pool: Address;
  imageURI: string;
  website: string;
  twitter: string;
  telegram: string;
  timestamp: number;
  /** decimal string — JSON has no bigint; the client converts back. */
  blockNumber: string;
  pad: Address;
}
export interface FeedPayload {
  creations: CreationDTO[];
  unavailable: boolean;
}

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"),
});

let cache: { payload: FeedPayload; expiresAt: number } | null = null;

async function fetchCreatedLogs(pad: Address, from: bigint, to: bigint): Promise<CreatedLog[]> {
  const logs = await client.getLogs({
    address: pad,
    event: tokenCreatedEvent,
    fromBlock: from,
    toBlock: to,
  });
  return logs as unknown as CreatedLog[];
}

async function scan(): Promise<FeedPayload> {
  const pads = padDeployments(robinhoodChain.id);
  if (pads.length === 0) return { creations: [], unavailable: false };

  const latest = await client.getBlockNumber();

  // Flatten every (pad, block-window) into one chunk list, then fetch with
  // bounded concurrency.
  const chunks: { pad: Address; from: bigint; to: bigint }[] = [];
  for (const p of pads) {
    for (let s = p.startBlock; s <= latest; s += LOG_CHUNK + 1n) {
      const e = s + LOG_CHUNK <= latest ? s + LOG_CHUNK : latest;
      chunks.push({ pad: p.address, from: s, to: e });
    }
  }

  const tagged: { log: CreatedLog; pad: Address }[] = [];
  for (let i = 0; i < chunks.length; i += SCAN_CONCURRENCY) {
    const batch = chunks.slice(i, i + SCAN_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (c) => {
        const logs = await fetchCreatedLogs(c.pad, c.from, c.to);
        return logs.map((log) => ({ log, pad: c.pad }));
      }),
    );
    for (const r of results) tagged.push(...r);
  }

  // Timestamps for the matched blocks (dedupe + batch).
  const blockNums = [
    ...new Set(tagged.map((t) => t.log.blockNumber).filter((b): b is bigint => b !== null)),
  ];
  const tsByBlock = new Map<bigint, number>();
  const TS_CHUNK = 20;
  for (let i = 0; i < blockNums.length; i += TS_CHUNK) {
    const blocks = await Promise.all(
      blockNums.slice(i, i + TS_CHUNK).map((n) => client.getBlock({ blockNumber: n })),
    );
    for (const b of blocks) tsByBlock.set(b.number, Number(b.timestamp));
  }

  // A token belongs to exactly one pad; dedupe by token address.
  const byToken = new Map<string, CreationDTO>();
  for (const { log, pad } of tagged) {
    const token = log.args.token;
    if (!token) continue;
    const key = token.toLowerCase();
    if (byToken.has(key)) continue;
    const bn = log.blockNumber;
    byToken.set(key, {
      token,
      creator: log.args.creator ?? ZERO_ADDRESS,
      name: log.args.name ?? "",
      symbol: log.args.symbol ?? "",
      pool: log.args.pool ?? ZERO_ADDRESS,
      imageURI: log.args.imageURI ?? "",
      website: log.args.website ?? "",
      twitter: log.args.twitter ?? "",
      telegram: log.args.telegram ?? "",
      timestamp: bn !== null ? (tsByBlock.get(bn) ?? 0) : 0,
      blockNumber: bn !== null ? bn.toString() : "0",
      pad,
    });
  }
  return { creations: [...byToken.values()], unavailable: false };
}

/**
 * Cached feed getter. Returns the last good payload on a scan failure (soft
 * degrade) so callers never throw; `unavailable` flags a cold-cache RPC miss.
 */
export async function loadFeed(): Promise<FeedPayload> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.payload;
  try {
    const payload = await scan();
    cache = { payload, expiresAt: now + CACHE_TTL_MS };
    return payload;
  } catch {
    if (cache) return cache.payload;
    return { creations: [], unavailable: true };
  }
}

/** One token's creation record (name/symbol/image/pool), by address, from the cached feed. */
export async function getCreation(address: string): Promise<CreationDTO | undefined> {
  const { creations } = await loadFeed();
  const key = address.toLowerCase();
  return creations.find((c) => c.token.toLowerCase() === key);
}
