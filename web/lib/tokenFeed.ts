import { createPublicClient, parseAbiItem, type Address } from "viem";
import { allPadDeployments, robinhoodChain, ZERO_ADDRESS, type PadKind } from "@/lib/config";
import { robinhoodServerTransport } from "@/lib/serverRpc";

/**
 * Server-side, cached Discover feed — the single source the `/api/tokens` route,
 * the token page's `generateMetadata`, and its `opengraph-image` all read from.
 *
 * The `TokenCreated` log scan across all pads runs ONCE here and is cached in
 * memory for a short TTL, so every consumer shares one scan instead of each
 * hammering the RPC. A poor-man's indexer.
 */

// The Discover feed is chain-pinned (robinhoodChain below). Robinhood's pads are
// V3 and emit `address pool`. A V4-chain feed would decode `bytes32 poolId` instead
// (the pad's V4 TokenCreated) — see the note in loadFeed's chain wiring.
const tokenCreatedEvent = parseAbiItem(
  "event TokenCreated(address indexed token, address indexed creator, string name, string symbol, address pool, string imageURI, string website, string twitter, string telegram)",
);

const LOG_CHUNK = 9_000n; // Alchemy on Robinhood caps eth_getLogs at 10k blocks.
const SCAN_CONCURRENCY = 6; // windows fetched at once — fast without a CU spike.
const CACHE_TTL_MS = 90_000;
const CHUNK_RETRIES = 3; // a window survives transient RPC blips instead of aborting the scan.
// If more than this fraction of a pad's windows never succeed, the scan is too
// incomplete to trust — flag `unavailable` so the client retries (vs. caching a
// half-empty feed or, worse, flashing "nothing planted").
const MAX_FAILED_FRACTION = 0.25;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  /** 24h USD volume from GeckoTerminal (0 if unindexed) — drives "Recent buys". */
  volume24Usd: number;
  /** Which pad kind launched it: "curve" (bonding curve) or "direct" (legacy). */
  kind: PadKind;
}
export type FeedState = "fresh" | "stale" | "unavailable";

export interface FeedPayload {
  chainId: number;
  /** unix ms — stamped on every loadFeed return (incl. cache hits). */
  servedAt: number;
  /** unix ms — last successful scan; 0 if never. */
  scanCompletedAt: number;
  state: FeedState;
  creations: CreationDTO[];
  /** @deprecated prefer `state`; true iff state === "unavailable" */
  unavailable: boolean;
}

const client = createPublicClient({
  chain: robinhoodChain,
  transport: robinhoodServerTransport(),
});

/** In-process content cache (not the full response — servedAt is always re-stamped). */
let cache: {
  creations: CreationDTO[];
  scanCompletedAt: number;
  state: Exclude<FeedState, "unavailable">;
  expiresAt: number;
} | null = null;

/** Short cooldown after a cold unavailable so /api/tokens can't force full rescans. */
const UNAVAILABLE_COOLDOWN_MS = 15_000;
let unavailableUntil = 0;

function stamp(
  creations: CreationDTO[],
  state: FeedState,
  scanCompletedAt: number,
): FeedPayload {
  return {
    chainId: robinhoodChain.id,
    servedAt: Date.now(),
    scanCompletedAt,
    state,
    creations,
    unavailable: state === "unavailable",
  };
}

/** One window, with retries. Returns null only after every attempt fails. */
async function fetchCreatedLogs(
  pad: Address,
  from: bigint,
  to: bigint,
): Promise<CreatedLog[] | null> {
  for (let attempt = 0; attempt < CHUNK_RETRIES; attempt++) {
    try {
      const logs = await client.getLogs({
        address: pad,
        event: tokenCreatedEvent,
        fromBlock: from,
        toBlock: to,
      });
      return logs as unknown as CreatedLog[];
    } catch {
      if (attempt < CHUNK_RETRIES - 1) await sleep(200 * (attempt + 1));
    }
  }
  return null;
}

type PadTag = { log: CreatedLog; pad: Address };

/**
 * Scan one pad's [start, end] block range for TokenCreated logs. Individual
 * windows that keep failing are tolerated (counted, not thrown) so one bad RPC
 * response can't sink the whole feed — the crux of the "stuck on skeletons" bug.
 */
async function scanPadRange(
  pad: Address,
  start: bigint,
  end: bigint,
): Promise<{ tagged: PadTag[]; failed: number; total: number }> {
  const windows: { from: bigint; to: bigint }[] = [];
  for (let s = start; s <= end; s += LOG_CHUNK + 1n) {
    const e = s + LOG_CHUNK <= end ? s + LOG_CHUNK : end;
    windows.push({ from: s, to: e });
  }
  const tagged: PadTag[] = [];
  let failed = 0;
  for (let i = 0; i < windows.length; i += SCAN_CONCURRENCY) {
    const batch = windows.slice(i, i + SCAN_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (w) => {
        const logs = await fetchCreatedLogs(pad, w.from, w.to);
        return logs === null ? null : logs.map((log) => ({ log, pad }));
      }),
    );
    for (const r of results) {
      if (r === null) failed++;
      else tagged.push(...r);
    }
  }
  return { tagged, failed, total: windows.length };
}

/** Best-effort per-token 24h USD volume from GeckoTerminal (0 if unindexed). */
async function fetchVolumes(addresses: Address[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (addresses.length === 0) return out;
  const key = process.env.COINGECKO_API_KEY;
  const base = key
    ? "https://pro-api.coingecko.com/api/v3/onchain/networks/robinhood"
    : "https://api.geckoterminal.com/api/v2/networks/robinhood";
  const headers: Record<string, string> = key
    ? { "x-cg-pro-api-key": key, accept: "application/json" }
    : { accept: "application/json" };
  // Multi-token endpoint takes up to 30 addresses per call.
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30);
    try {
      const res = await fetch(`${base}/tokens/multi/${chunk.join(",")}`, {
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(6000), // a slow GT call must not stall the feed
      });
      if (!res.ok) continue;
      const j = (await res.json()) as {
        data?: { attributes?: { address?: string; volume_usd?: { h24?: string } } }[];
      };
      for (const t of j.data ?? []) {
        const addr = (t.attributes?.address ?? "").toLowerCase();
        if (addr) out.set(addr, Number(t.attributes?.volume_usd?.h24) || 0);
      }
    } catch {
      // best-effort — a volume miss just means that token sorts as cold
    }
  }
  return out;
}

// Legacy pads are capped at their repoint endBlock — immutable history. Scanned
// once and kept for the process lifetime; only the active pad is re-scanned.
let legacyTagged: PadTag[] | null = null;

async function scan(): Promise<FeedPayload> {
  // Kind-tagged: the curve pad AND the direct pads, so a token resolves to the
  // right launcher and the feed can tell the UI which stage to render.
  const pads = allPadDeployments(robinhoodChain.id);
  // No pads configured for this chain is a VALID empty result, not an outage.
  if (pads.length === 0) return stamp([], "fresh", Date.now());

  const latest = await client.getBlockNumber();
  // The active (write) pad has no endBlock; legacy pads carry the repoint block.
  const legacyPads = pads.filter((p) => p.endBlock !== undefined);
  const activePads = pads.filter((p) => p.endBlock === undefined);

  let unavailable = false;

  // Legacy history: scan once, reuse forever. Lock the cache in only if it came
  // back near-complete, otherwise use this round's result but retry next time.
  let legacyRound: PadTag[];
  if (legacyTagged !== null) {
    legacyRound = legacyTagged;
  } else {
    const acc: PadTag[] = [];
    let failed = 0;
    let total = 0;
    for (const p of legacyPads) {
      const upTo = p.endBlock! < latest ? p.endBlock! : latest;
      const r = await scanPadRange(p.address, p.startBlock, upTo);
      acc.push(...r.tagged);
      failed += r.failed;
      total += r.total;
    }
    legacyRound = acc;
    if (total === 0 || failed / total <= 0.1) legacyTagged = acc;
    else unavailable = true; // gappy legacy scan — don't lock it in; retry next round
  }

  // Active pad(s): always fresh.
  const activeRound: PadTag[] = [];
  {
    let failed = 0;
    let total = 0;
    for (const p of activePads) {
      const r = await scanPadRange(p.address, p.startBlock, latest);
      activeRound.push(...r.tagged);
      failed += r.failed;
      total += r.total;
    }
    if (total > 0 && failed / total > MAX_FAILED_FRACTION) unavailable = true;
  }

  const tagged = [...legacyRound, ...activeRound];

  // Timestamps for the matched blocks (dedupe + batch; a block miss just yields 0).
  const blockNums = [
    ...new Set(tagged.map((t) => t.log.blockNumber).filter((b): b is bigint => b !== null)),
  ];
  const tsByBlock = new Map<bigint, number>();
  const TS_CHUNK = 20;
  for (let i = 0; i < blockNums.length; i += TS_CHUNK) {
    const blocks = await Promise.all(
      blockNums.slice(i, i + TS_CHUNK).map((n) => client.getBlock({ blockNumber: n }).catch(() => null)),
    );
    for (const b of blocks) if (b) tsByBlock.set(b.number, Number(b.timestamp));
  }

  // A token belongs to exactly one pad; dedupe by token address.
  const kindByPad = new Map(pads.map((p) => [p.address.toLowerCase(), p.kind ?? "direct"] as const));
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
      volume24Usd: 0,
      kind: kindByPad.get(pad.toLowerCase()) ?? "direct",
    });
  }
  // Enrich with 24h volume (best-effort) so the client can offer a "Recent buys" sort.
  const creations = [...byToken.values()];
  try {
    const vols = await fetchVolumes(creations.map((c) => c.token));
    for (const c of creations) c.volume24Usd = vols.get(c.token.toLowerCase()) ?? 0;
  } catch {
    /* leave volumes at 0 */
  }
  // A partial scan (some window failed) surfaces as "unavailable" so the client
  // shows a warm cache rather than treating a truncated list as complete.
  return stamp(creations, unavailable ? "unavailable" : "fresh", Date.now());
}

let inFlight: Promise<FeedPayload> | null = null;

/**
 * Cached feed getter. Always stamps a fresh `servedAt` (incl. cache hits).
 * Soft-degrades to stale/unavailable without throwing. Concurrent cold-cache
 * callers share ONE scan (in-flight coalescing).
 */
export async function loadFeed(): Promise<FeedPayload> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return stamp(cache.creations, cache.state, cache.scanCompletedAt);
  }
  // Cold failure backoff: avoid hammering RPC with full multi-pad scans.
  if (!cache && now < unavailableUntil) {
    return stamp([], "unavailable", 0);
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const result = await scan();
      // Gappy scans: soft-degrade. Prefer warm cache as "stale" over a partial list.
      if (result.unavailable) {
        if (cache) return stamp(cache.creations, "stale", cache.scanCompletedAt);
        unavailableUntil = Date.now() + UNAVAILABLE_COOLDOWN_MS;
        return stamp([], "unavailable", 0);
      }
      const scanCompletedAt = Date.now();
      unavailableUntil = 0;
      cache = {
        creations: result.creations,
        scanCompletedAt,
        state: "fresh",
        expiresAt: scanCompletedAt + CACHE_TTL_MS,
      };
      return stamp(result.creations, "fresh", scanCompletedAt);
    } catch {
      if (cache) return stamp(cache.creations, "stale", cache.scanCompletedAt);
      unavailableUntil = Date.now() + UNAVAILABLE_COOLDOWN_MS;
      return stamp([], "unavailable", 0);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** One token's creation record (name/symbol/image/pool), by address, from the cached feed. */
export async function getCreation(address: string): Promise<CreationDTO | undefined> {
  const { creations } = await loadFeed();
  const key = address.toLowerCase();
  return creations.find((c) => c.token.toLowerCase() === key);
}
