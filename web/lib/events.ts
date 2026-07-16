"use client";

// Event-driven data layer: launch history (TokenCreated) and holders (ERC-20
// Transfer logs) fetched via the wagmi public client. v2 has no Trade or
// Graduated events — price/liquidity come from the Uniswap pool (see lib/pool).
// All fetchers degrade gracefully — RPCs that cap log ranges yield
// `unavailable: true` instead of throwing.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address } from "viem";
import { parseAbiItem } from "viem";
import { usePublicClient, useWatchContractEvent } from "wagmi";
import { potatoPadAbi, potatoTokenAbi } from "@/lib/abi";
import { PAD_START_BLOCK, ZERO_ADDRESS, padDeployments } from "@/lib/config";
import { usePad } from "@/lib/hooks";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

// Live RPCs cap eth_getLogs block ranges (Alchemy on Robinhood = 10k blocks), so
// scan forward from the pad's deploy block in sub-cap windows and concatenate.
const LOG_CHUNK = 9_000n;
// Run this many window fetches at once: cuts wall-clock on wide (legacy-pad) scans
// without a burst big enough to trip the RPC compute-unit limit.
const SCAN_CONCURRENCY = 4;

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

// ---------------------------------------------------------------------------
// localStorage cache for the launch feed (bigint-safe). The historical scan is
// expensive; persisting it means a refresh paints instantly from cache and
// revalidates in the background instead of re-scanning cold every time.
// ---------------------------------------------------------------------------

const LAUNCH_CACHE_PREFIX = "potatopad:launch:v2:";

// JSON can't hold bigint; tag them as {__b} so token names/symbols that happen to
// look numeric are never mistaken for one.
function launchReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? { __b: value.toString() } : value;
}
function launchReviver(_key: string, value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { __b?: unknown }).__b === "string" &&
    Object.keys(value as object).length === 1
  ) {
    return BigInt((value as { __b: string }).__b);
  }
  return value;
}

interface CachedLaunch {
  data: LaunchActivity;
  updatedAt: number;
}

function readLaunchCache(key: string): CachedLaunch | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw, launchReviver) as CachedLaunch;
    if (!parsed?.data || !Array.isArray(parsed.data.creations)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeLaunchCache(key: string, data: LaunchActivity) {
  if (typeof window === "undefined") return;
  try {
    // Never cache an empty/failed scan — it would mask a real result on refresh.
    if (data.unavailable || data.creations.length === 0) return;
    window.localStorage.setItem(
      key,
      JSON.stringify({ data, updatedAt: Date.now() } satisfies CachedLaunch, launchReplacer),
    );
  } catch {
    // quota / disabled storage — caching is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Launch activity: TokenCreated, served pre-scanned + cached by /api/tokens
// ---------------------------------------------------------------------------

export interface CreationEvent {
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
  blockNumber: bigint;
  /** The pad (primary or legacy) that launched this token. */
  pad: Address;
}

interface LaunchActivity {
  creations: CreationEvent[];
  unavailable: boolean;
}

const EMPTY_LAUNCH: LaunchActivity = { creations: [], unavailable: false };

export function useLaunchActivity() {
  const { pad, chainId, isDeployed } = usePad();
  const queryClient = useQueryClient();
  const pads = useMemo(() => padDeployments(chainId), [chainId]);
  const queryKey = useMemo(
    () => ["launch-activity", chainId, pads.map((p) => p.address).join(",")],
    [chainId, pads],
  );
  const cacheKey = LAUNCH_CACHE_PREFIX + chainId + ":" + pads.map((p) => p.address).join(",");

  const query = useQuery<LaunchActivity>({
    queryKey,
    enabled: isDeployed && pads.length > 0,
    // Cached refreshes paint instantly (initialData) and revalidate in the
    // background; the scan itself now runs server-side (cached) at /api/tokens,
    // so no visitor pays the multi-pad getLogs cost anymore.
    staleTime: 60_000,
    gcTime: 24 * 60 * 60 * 1000,
    initialData: () => readLaunchCache(cacheKey)?.data,
    initialDataUpdatedAt: () => readLaunchCache(cacheKey)?.updatedAt,
    queryFn: async () => {
      try {
        const res = await fetch("/api/tokens");
        if (!res.ok) return { ...EMPTY_LAUNCH, unavailable: true };
        const json = (await res.json()) as {
          creations: Array<Omit<CreationEvent, "blockNumber"> & { blockNumber: string }>;
          unavailable: boolean;
        };
        const creations: CreationEvent[] = (json.creations ?? []).map((c) => ({
          token: c.token,
          creator: c.creator,
          name: c.name,
          symbol: c.symbol,
          pool: c.pool,
          imageURI: c.imageURI,
          website: c.website,
          twitter: c.twitter,
          telegram: c.telegram,
          timestamp: c.timestamp,
          blockNumber: BigInt(c.blockNumber),
          pad: c.pad,
        }));
        const result: LaunchActivity = { creations, unavailable: !!json.unavailable };
        writeLaunchCache(cacheKey, result);
        return result;
      } catch {
        return { ...EMPTY_LAUNCH, unavailable: true };
      }
    },
  });

  // Live updates: watch the primary (write) pad; legacy pads are historical.
  useWatchContractEvent({
    address: pad,
    abi: potatoPadAbi,
    eventName: "TokenCreated",
    enabled: isDeployed,
    onLogs: () => queryClient.invalidateQueries({ queryKey }),
  });

  const data = query.data ?? EMPTY_LAUNCH;
  const creationByToken = useMemo(() => {
    const map = new Map<string, CreationEvent>();
    for (const c of data.creations) map.set(c.token.toLowerCase(), c);
    return map;
  }, [data.creations]);

  return {
    creations: data.creations,
    creationByToken,
    unavailable: data.unavailable,
    isLoading: query.isLoading,
  };
}

// ---------------------------------------------------------------------------
// Holders, derived client-side from ERC20 Transfer logs (MVP approach)
// ---------------------------------------------------------------------------

export interface Holder {
  address: Address;
  balance: bigint;
}

interface HoldersData {
  holders: Holder[];
  /** sum of all positive balances — equals circulating total supply */
  total: bigint;
  unavailable: boolean;
}

const EMPTY_HOLDERS: HoldersData = { holders: [], total: 0n, unavailable: false };

/** Balances per address from Transfer logs, sorted descending. */
export function useTokenHolders(token: Address | undefined) {
  const { chainId, isDeployed } = usePad();
  const client = usePublicClient();
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ["token-holders", chainId, token ?? "none"],
    [chainId, token],
  );

  const query = useQuery<HoldersData>({
    queryKey,
    enabled: isDeployed && !!client && !!token,
    staleTime: 10_000,
    queryFn: async () => {
      if (!client || !token) return EMPTY_HOLDERS;
      try {
        const latest = await client.getBlockNumber();
        // Scan from the EARLIEST pad's deploy block so a legacy token's full
        // Transfer history is covered, not truncated at the newest pad's block.
        const deployments = padDeployments(chainId);
        const startBlock = deployments.length
          ? deployments.reduce((m, p) => (p.startBlock < m ? p.startBlock : m), deployments[0].startBlock)
          : (PAD_START_BLOCK[chainId] ?? 0n);
        const logs = await collectLogs(startBlock, latest, (from, to) =>
          client.getLogs({ address: token, event: transferEvent, fromBlock: from, toBlock: to }),
        );
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
        const holders: Holder[] = Array.from(balances.entries())
          .filter(([, balance]) => balance > 0n)
          .map(([address, balance]) => ({ address: address as Address, balance }))
          .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
        const total = holders.reduce((sum, h) => sum + h.balance, 0n);
        return { holders, total, unavailable: false };
      } catch {
        return { ...EMPTY_HOLDERS, unavailable: true };
      }
    },
  });

  useWatchContractEvent({
    address: token,
    abi: potatoTokenAbi,
    eventName: "Transfer",
    enabled: isDeployed && !!token,
    onLogs: () => queryClient.invalidateQueries({ queryKey }),
  });

  const data = query.data ?? EMPTY_HOLDERS;
  return {
    holders: data.holders,
    total: data.total,
    unavailable: data.unavailable,
    isLoading: query.isLoading,
  };
}
