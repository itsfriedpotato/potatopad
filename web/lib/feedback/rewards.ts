// SERVER ONLY. The weekly reward pot is 10% of the protocol (treasury) fees earned
// during the current ISO week, summed on-chain from TreasuryPaid(WETH) events across
// every pad's fee locker. This mirrors contracts/scripts/treasury-sent.ts (pad ->
// locker() -> scan TreasuryPaid for WETH in chunked getLogs), ported from ethers to a
// viem publicClient and windowed to just this week's blocks. Also exposes the open
// reward round from Supabase for the sidebar.
import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  parseAbiItem,
  type Address,
} from "viem";
import { padDeployments, robinhoodChain, WETH_ADDRESSES, ZERO_ADDRESS } from "@/lib/config";
import { requireSupabase } from "@/lib/supabase";

/** Pot policy: the reward pot is this percent of the week's treasury fees (TUNE). */
export const REWARD_POLICY_PCT = 10;

const WETH_LC = (WETH_ADDRESSES[robinhoodChain.id] as Address).toLowerCase();

const LOG_CHUNK = 9_000n; // Alchemy on Robinhood caps eth_getLogs at 10k blocks.
const SCAN_CONCURRENCY = 4; // windows fetched at once — fast without a CU spike.
const FEES_TTL_MS = 30 * 60_000; // 30 min: fees only grow, a slightly stale pot is fine.

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"),
});

// Minimal pad ABI: just locker(), the address that receives + emits fee events.
const padAbi = [
  { inputs: [], name: "locker", outputs: [{ type: "address", name: "" }], stateMutability: "view", type: "function" },
] as const;

const treasuryPaidEvent = parseAbiItem("event TreasuryPaid(address indexed asset, uint256 amount)");

interface TreasuryPaidLog {
  args: { asset?: `0x${string}`; amount?: bigint };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retry a flaky RPC call a few times with linear backoff, mirroring treasury-sent.ts
// (4 attempts, 300ms * attempt). Throws the last error if every attempt fails.
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let a = 0; a < attempts; a++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (a < attempts - 1) await sleep(300 * (a + 1));
    }
  }
  throw lastErr;
}

// -------------------------------------------------------------------- ISO week
export interface IsoWeek {
  /** Monday 00:00:00.000 UTC of the current ISO week. */
  weekStart: Date;
  /** Sunday 23:59:59.999 UTC of the current ISO week. */
  weekEnd: Date;
}

/** The current ISO week (weeks start Monday, UTC). */
export function currentIsoWeek(now: Date = new Date()): IsoWeek {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (midnight.getUTCDay() + 6) % 7; // Mon->0 ... Sun->6
  const weekStart = new Date(midnight);
  weekStart.setUTCDate(midnight.getUTCDate() - daysSinceMonday);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 7); // next Monday 00:00
  weekEnd.setUTCMilliseconds(weekEnd.getUTCMilliseconds() - 1); // -> Sunday 23:59:59.999
  return { weekStart, weekEnd };
}

/** A Date as a UTC calendar day (YYYY-MM-DD) for the reward_rounds date columns. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// -------------------------------------------------------------- block windowing
// Smallest block whose timestamp is >= targetSec, by binary search over block
// timestamps. Orbit block times are irregular, so estimating from an average is
// unreliable — the search is exact. Bounded by [lo, hi].
async function blockAtOrAfter(targetSec: bigint, lo: bigint, hi: bigint): Promise<bigint> {
  let l = lo;
  let h = hi;
  while (l < h) {
    const mid = (l + h) / 2n;
    const block = await withRetry(() => client.getBlock({ blockNumber: mid }));
    if (block.timestamp < targetSec) l = mid + 1n;
    else h = mid;
  }
  return l;
}

function buildRanges(fromBlock: bigint, toBlock: bigint): [bigint, bigint][] {
  const ranges: [bigint, bigint][] = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK + 1n) {
    const end = start + LOG_CHUNK <= toBlock ? start + LOG_CHUNK : toBlock;
    ranges.push([start, end]);
  }
  return ranges;
}

// ------------------------------------------------------------- weekly fee scan
let feesCache: { weekStartMs: number; weiTotal: bigint; expiresAt: number } | null = null;

async function weeklyFeesWei(): Promise<bigint> {
  const { weekStart } = currentIsoWeek();
  const weekStartMs = weekStart.getTime();
  const now = Date.now();
  // Cache is valid only WITHIN the same ISO week — a week rollover must invalidate.
  if (feesCache && feesCache.weekStartMs === weekStartMs && feesCache.expiresAt > now) {
    return feesCache.weiTotal;
  }

  const latest = await withRetry(() => client.getBlockNumber());
  const deployments = padDeployments(robinhoodChain.id);
  const earliest = deployments.length
    ? deployments.reduce((m, p) => (p.startBlock < m ? p.startBlock : m), deployments[0].startBlock)
    : 0n;

  const targetSec = BigInt(Math.floor(weekStartMs / 1000));
  const fromBlock = await blockAtOrAfter(targetSec, earliest, latest);

  // Resolve each pad's fee locker. A failed read means we can't be sure we covered
  // that pad, so mark the scan degraded (and skip caching an undercount below).
  let degraded = false;
  const lockerReads = await Promise.all(
    deployments.map(async (p) => {
      try {
        return (await withRetry(() =>
          client.readContract({ address: p.address, abi: padAbi, functionName: "locker" }),
        )) as Address;
      } catch {
        degraded = true;
        return null;
      }
    }),
  );
  const lockers = Array.from(
    new Set(
      lockerReads
        .filter((l): l is Address => l !== null && l.toLowerCase() !== ZERO_ADDRESS.toLowerCase())
        .map((l) => l.toLowerCase()),
    ),
  ).map((l) => getAddress(l));

  const ranges = buildRanges(fromBlock, latest);
  let totalWei = 0n;
  for (const locker of lockers) {
    for (let i = 0; i < ranges.length; i += SCAN_CONCURRENCY) {
      const batch = ranges.slice(i, i + SCAN_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async ([from, to]) => {
          try {
            const logs = (await withRetry(() =>
              client.getLogs({ address: locker, event: treasuryPaidEvent, fromBlock: from, toBlock: to }),
            )) as unknown as TreasuryPaidLog[];
            return { logs, ok: true };
          } catch {
            // Gave up on this window after retries — sum what we can, flag degraded.
            return { logs: [] as TreasuryPaidLog[], ok: false };
          }
        }),
      );
      for (const r of results) {
        if (!r.ok) degraded = true;
        for (const log of r.logs) {
          const { asset, amount } = log.args;
          if (amount === undefined || !asset) continue;
          if (asset.toLowerCase() === WETH_LC) totalWei += amount;
        }
      }
    }
  }

  // Only cache a COMPLETE scan; a gappy one undercounts and would stick for the TTL.
  if (!degraded) feesCache = { weekStartMs, weiTotal: totalWei, expiresAt: now + FEES_TTL_MS };
  return totalWei;
}

/** This ISO week's treasury (protocol) fees in ETH, summed from TreasuryPaid(WETH). */
export async function weeklyFeesEth(): Promise<number> {
  const wei = await weeklyFeesWei();
  return Number(formatEther(wei));
}

/** The reward pot for this ISO week: REWARD_POLICY_PCT of the weekly fees, in ETH. */
export async function potForWeekEth(): Promise<number> {
  const wei = await weeklyFeesWei();
  // Integer-wei math first, then format — no floating-point drift on the split.
  const potWei = (wei * BigInt(REWARD_POLICY_PCT)) / 100n;
  return Number(formatEther(potWei));
}

// ----------------------------------------------------------------- open round
export interface RewardRound {
  id: string;
  week_start: string;
  week_end: string;
  pot_eth: number | null;
  status: string;
  created_at: string;
}

/** The currently-open reward round, or null if none is open. */
export async function currentRound(): Promise<RewardRound | null> {
  const db = requireSupabase();
  const { data } = await db
    .from("reward_rounds")
    .select("id, week_start, week_end, pot_eth, status, created_at")
    .eq("status", "open")
    .order("week_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as RewardRound | null) ?? null;
}
