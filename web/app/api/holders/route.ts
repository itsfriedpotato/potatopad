import { NextResponse } from "next/server";
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { padDeployments, robinhoodChain, ZERO_ADDRESS } from "@/lib/config";

/**
 * Server-side, cached holder list for a single token.
 *
 * The legacy path scanned ERC-20 Transfer logs in every visitor's browser
 * (`useTokenHolders`), which is slow and multiplies RPC load per viewer. This
 * mirrors {@link ../tokens/route.ts}: the Transfer scan runs ONCE here per token
 * and the derived balances are cached in memory for a short TTL, so every viewer
 * of the same token gets a small JSON payload instantly. A poor-man's indexer,
 * scoped per token.
 */

export const runtime = "nodejs";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const LOG_CHUNK = 9_000n; // Alchemy on Robinhood caps eth_getLogs at 10k blocks.
const SCAN_CONCURRENCY = 4; // windows fetched at once — fast without a CU spike.
const CACHE_TTL_MS = 45_000;
// Bound the per-token cache so a long tail of one-off token lookups can't grow
// memory without limit; evict the oldest entry once we exceed this.
const MAX_CACHED_TOKENS = 500;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** balance as a decimal string — JSON has no bigint; the client converts back. */
interface HolderDTO {
  address: Address;
  balance: string;
}
interface HoldersPayload {
  holders: HolderDTO[];
  /** sum of all positive balances — equals circulating total supply */
  total: string;
  unavailable: boolean;
}

const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
};

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"),
});

// Prefer a Ponder indexer when configured; fall back to the live log scan below
// if unset or unreachable, so prod keeps working even if the indexer is down.
const INDEXER_URL = process.env.INDEXER_URL?.replace(/\/+$/, "");

async function fromIndexer(token: string): Promise<HoldersPayload | null> {
  if (!INDEXER_URL) return null;
  try {
    const res = await fetch(`${INDEXER_URL}/holders?token=${token}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Partial<HoldersPayload>;
    if (!json || !Array.isArray(json.holders)) return null;
    return {
      holders: json.holders as HolderDTO[],
      total: json.total ?? "0",
      unavailable: false,
    };
  } catch {
    return null;
  }
}

const cache = new Map<string, { payload: HoldersPayload; expiresAt: number }>();

async function collectLogs<T>(
  fromBlock: bigint,
  toBlock: bigint,
  fetchRange: (from: bigint, to: bigint) => Promise<T[]>,
): Promise<T[]> {
  const ranges: [bigint, bigint][] = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK + 1n) {
    const end = start + LOG_CHUNK <= toBlock ? start + LOG_CHUNK : toBlock;
    ranges.push([start, end]);
  }
  const out: T[] = [];
  for (let i = 0; i < ranges.length; i += SCAN_CONCURRENCY) {
    const batch = ranges.slice(i, i + SCAN_CONCURRENCY);
    const results = await Promise.all(batch.map(([from, to]) => fetchRange(from, to)));
    for (const r of results) out.push(...r);
  }
  return out;
}

type TransferLog = { args: { from?: Address; to?: Address; value?: bigint } };

async function scan(token: Address): Promise<HoldersPayload> {
  const latest = await client.getBlockNumber();
  // Scan from the EARLIEST pad's deploy block so a legacy token's full Transfer
  // history is covered, not truncated at the newest pad's block.
  const deployments = padDeployments(robinhoodChain.id);
  const startBlock = deployments.length
    ? deployments.reduce(
        (m, p) => (p.startBlock < m ? p.startBlock : m),
        deployments[0].startBlock,
      )
    : 0n;

  const logs = (await collectLogs(startBlock, latest, (from, to) =>
    client.getLogs({ address: token, event: transferEvent, fromBlock: from, toBlock: to }),
  )) as unknown as TransferLog[];

  const balances = new Map<string, bigint>();
  for (const log of logs) {
    const { from, to, value } = log.args;
    if (value === undefined || value === 0n) continue;
    if (from && from !== ZERO_ADDRESS) {
      balances.set(from, (balances.get(from) ?? 0n) - value);
    }
    if (to && to !== ZERO_ADDRESS) {
      balances.set(to, (balances.get(to) ?? 0n) + value);
    }
  }

  const positive = Array.from(balances.entries())
    .filter(([, balance]) => balance > 0n)
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));

  const total = positive.reduce((sum, [, balance]) => sum + balance, 0n);
  return {
    holders: positive.map(([address, balance]) => ({
      address: address as Address,
      balance: balance.toString(),
    })),
    total: total.toString(),
    unavailable: false,
  };
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  if (!token || !ADDRESS_RE.test(token)) {
    return NextResponse.json({ error: "invalid or missing token address" }, { status: 400 });
  }
  const key = token.toLowerCase();
  const now = Date.now();

  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    return NextResponse.json(hit.payload, { headers: CACHE_HEADERS });
  }

  try {
    const payload = (await fromIndexer(token)) ?? (await scan(token as Address));
    cache.set(key, { payload, expiresAt: now + CACHE_TTL_MS });
    if (cache.size > MAX_CACHED_TOKENS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return NextResponse.json(payload, { headers: CACHE_HEADERS });
  } catch {
    // Scan failed (RPC hiccup). Serve the last good payload for this token if we
    // have one, else an empty-but-unavailable list — always HTTP 200 so the UI
    // degrades softly.
    if (hit) return NextResponse.json(hit.payload, { headers: CACHE_HEADERS });
    const empty: HoldersPayload = { holders: [], total: "0", unavailable: true };
    return NextResponse.json(empty, { headers: CACHE_HEADERS });
  }
}
