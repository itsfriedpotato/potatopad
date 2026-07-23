import { NextResponse } from "next/server";
import { createPublicClient, parseAbiItem, type Address } from "viem";
import { robinhoodServerTransport } from "@/lib/serverRpc";
import { allPadDeployments, robinhoodChain, ZERO_ADDRESS } from "@/lib/config";

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

// Rate limit the SCAN path only (cache hits are free): an attacker looping
// arbitrary token addresses would otherwise force an unbounded full-history
// eth_getLogs scan per address against the shared RPC key.
const RL_WINDOW_MS = 60_000;
const RL_MAX_PER_IP = 30;
const RL_MAX_GLOBAL = Number(process.env.HOLDERS_MAX_GLOBAL_PER_WINDOW) || 120;
const ipHits = new Map<string, number[]>();
let globalHits: number[] = [];

function scanRateLimited(ip: string): boolean {
  const now = Date.now();
  globalHits = globalHits.filter((t) => now - t < RL_WINDOW_MS);
  globalHits.push(now);
  if (globalHits.length > RL_MAX_GLOBAL) return true; // unspoofable global ceiling
  const recent = (ipHits.get(ip) ?? []).filter((t) => now - t < RL_WINDOW_MS);
  recent.push(now);
  ipHits.set(ip, recent);
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) if (v.every((t) => now - t >= RL_WINDOW_MS)) ipHits.delete(k);
  }
  return recent.length > RL_MAX_PER_IP;
}

const client = createPublicClient({
  chain: robinhoodChain,
  transport: robinhoodServerTransport(),
});

/**
 * Incremental per-token indexer state. The first request for a token pays for
 * one full-history scan; every refresh after that scans ONLY the blocks mined
 * since `lastScanned` (usually a single getLogs chunk) and applies the deltas
 * to the running balance map. Before this, every 45s cache expiry re-scanned
 * the token's whole history from the earliest pad block (600+ getLogs calls
 * for a busy token) and N concurrent visitors triggered N such scans — which
 * is what crash-looped the server during the first CHIP pump.
 */
type TokenState = {
  balances: Map<string, bigint>;
  lastScanned: bigint;
  payload: HoldersPayload;
  freshUntil: number;
};
const state = new Map<string, TokenState>();
// One scan per token at a time — concurrent requests share the same promise.
const scanning = new Map<string, Promise<HoldersPayload>>();

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

function earliestPadBlock(): bigint {
  // Scan from the EARLIEST pad's deploy block so a legacy token's full Transfer
  // history is covered, not truncated at the newest pad's block.
  const deployments = allPadDeployments(robinhoodChain.id); // include the curve pad block
  return deployments.length
    ? deployments.reduce((m, p) => (p.startBlock < m ? p.startBlock : m), deployments[0].startBlock)
    : 0n;
}

function buildPayload(balances: Map<string, bigint>): HoldersPayload {
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

/** Scan new blocks since the token's last refresh (full history on first call). */
async function refresh(key: string, token: Address): Promise<HoldersPayload> {
  const inflight = scanning.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    const latest = await client.getBlockNumber();
    const prev = state.get(key);
    const fromBlock = prev ? prev.lastScanned + 1n : earliestPadBlock();
    const balances = prev ? prev.balances : new Map<string, bigint>();

    if (fromBlock <= latest) {
      const logs = (await collectLogs(fromBlock, latest, (from, to) =>
        client.getLogs({ address: token, event: transferEvent, fromBlock: from, toBlock: to }),
      )) as unknown as TransferLog[];

      for (const log of logs) {
        const { from, to, value } = log.args;
        if (value === undefined || value === 0n) continue;
        if (from && from !== ZERO_ADDRESS) {
          const next = (balances.get(from) ?? 0n) - value;
          if (next === 0n) balances.delete(from);
          else balances.set(from, next);
        }
        if (to && to !== ZERO_ADDRESS) {
          balances.set(to, (balances.get(to) ?? 0n) + value);
        }
      }
    }

    const payload = buildPayload(balances);
    state.set(key, { balances, lastScanned: latest, payload, freshUntil: Date.now() + CACHE_TTL_MS });
    if (state.size > MAX_CACHED_TOKENS) {
      const oldest = state.keys().next().value;
      if (oldest !== undefined) state.delete(oldest);
    }
    return payload;
  })();

  scanning.set(key, p);
  void p.finally(() => {
    if (scanning.get(key) === p) scanning.delete(key);
  });
  return p;
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  if (!token || !ADDRESS_RE.test(token)) {
    return NextResponse.json({ error: "invalid or missing token address" }, { status: 400 });
  }
  const key = token.toLowerCase();
  const now = Date.now();

  const st = state.get(key);
  if (st && st.freshUntil > now) {
    return NextResponse.json(st.payload, { headers: CACHE_HEADERS });
  }

  // Stale state: answer INSTANTLY from it and refresh in the background. The
  // incremental refresh is one small getLogs, and the inflight map guarantees
  // at most one runs per token no matter how many viewers are polling.
  if (st) {
    void refresh(key, token as Address).catch(() => {});
    return NextResponse.json(st.payload, { headers: CACHE_HEADERS });
  }

  // No state at all → this is the one expensive path (full-history first scan).
  // Gate it so arbitrary token addresses can't force unbounded scans.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (scanRateLimited(ip)) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  try {
    const payload = await refresh(key, token as Address);
    return NextResponse.json(payload, { headers: CACHE_HEADERS });
  } catch {
    // Scan failed (RPC hiccup) — an empty-but-unavailable list, always HTTP 200
    // so the UI degrades softly.
    const empty: HoldersPayload = { holders: [], total: "0", unavailable: true };
    return NextResponse.json(empty, { headers: CACHE_HEADERS });
  }
}
