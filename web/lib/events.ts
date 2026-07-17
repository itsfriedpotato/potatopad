"use client";

// Event-driven data layer: launch history (TokenCreated) and holders (ERC-20
// Transfer logs) fetched via the wagmi public client. v2 has no Trade or
// Graduated events — price/liquidity come from the Uniswap pool (see lib/pool).
// All fetchers degrade gracefully — RPCs that cap log ranges yield
// `unavailable: true` instead of throwing.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address } from "viem";
import { useWatchContractEvent } from "wagmi";
import { potatoPadAbi, potatoTokenAbi } from "@/lib/abi";
import { padDeployments } from "@/lib/config";
import { usePad } from "@/lib/hooks";

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

/**
 * Balances per address, sorted descending. The Transfer-log scan now runs
 * server-side (cached) at /api/holders, so no visitor pays the per-token getLogs
 * cost — the browser just fetches a small JSON payload.
 */
export function useTokenHolders(token: Address | undefined) {
  const { chainId, isDeployed } = usePad();
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ["token-holders", chainId, token ?? "none"],
    [chainId, token],
  );

  const query = useQuery<HoldersData>({
    queryKey,
    enabled: isDeployed && !!token,
    staleTime: 10_000,
    queryFn: async () => {
      if (!token) return EMPTY_HOLDERS;
      try {
        const res = await fetch(`/api/holders?token=${token}`);
        if (!res.ok) return { ...EMPTY_HOLDERS, unavailable: true };
        const json = (await res.json()) as {
          holders: Array<{ address: Address; balance: string }>;
          total: string;
          unavailable: boolean;
        };
        // JSON has no bigint; balances arrive as decimal strings.
        const holders: Holder[] = (json.holders ?? []).map((h) => ({
          address: h.address,
          balance: BigInt(h.balance),
        }));
        const total = BigInt(json.total ?? "0");
        return { holders, total, unavailable: !!json.unavailable };
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
