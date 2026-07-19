"use client";

// Event-driven data layer: launch history (TokenCreated) and holders (ERC-20
// Transfer logs). v2 has no Trade or Graduated events — price/liquidity come
// from the Uniswap pool (see lib/pool). All fetchers degrade gracefully.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address } from "viem";
import { isHiddenToken } from "@/lib/config";
import { usePad } from "@/lib/hooks";
import type { FeedState } from "@/lib/tokenFeed";
import { ANALYTICS_CHAIN_ID } from "@/lib/robinhoodPublicClient";

// ---------------------------------------------------------------------------
// localStorage cache for the launch feed (bigint-safe).
// ---------------------------------------------------------------------------

const LAUNCH_CACHE_PREFIX = "potatopad:launch:v3:";
/** Age a seeded fresh payload into "stale" after this (2 × server ~90s TTL). */
const CLIENT_FRESH_MAX_MS = 180_000;

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
  /** 24h USD volume (from the server feed); 0 if unindexed. */
  volume24Usd: number;
}

export interface LaunchActivity {
  creations: CreationEvent[];
  state: FeedState;
  chainId: number;
  servedAt: number;
  scanCompletedAt: number;
  /** @deprecated prefer state === "unavailable" */
  unavailable: boolean;
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
    // Discard legacy shapes without honesty fields.
    if (
      typeof parsed.data.servedAt !== "number" ||
      typeof parsed.data.scanCompletedAt !== "number" ||
      !parsed.data.state
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function writeLaunchCache(key: string, data: LaunchActivity) {
  if (typeof window === "undefined") return;
  // Persist only trustworthy fresh scans (incl. genuine empty).
  if (data.state !== "fresh") return;
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({ data, updatedAt: Date.now() } satisfies CachedLaunch, launchReplacer),
    );
  } catch {
    // quota / disabled storage — caching is best-effort.
  }
}

/** Re-evaluate aged seeds so UI never treats a day-old snapshot as fresh. */
function presentAged(data: LaunchActivity): LaunchActivity {
  if (data.state === "fresh" && Date.now() - data.servedAt > CLIENT_FRESH_MAX_MS) {
    return { ...data, state: "stale", unavailable: false };
  }
  return data;
}

const EMPTY_LAUNCH: LaunchActivity = {
  creations: [],
  state: "unavailable",
  chainId: ANALYTICS_CHAIN_ID,
  servedAt: 0,
  scanCompletedAt: 0,
  unavailable: true,
};

/**
 * PotatoPad launch feed — always Robinhood (4663) server scan, independent of
 * the connected wallet chain. Discover, ticker, and creator profiles share this.
 */
export function useLaunchActivity() {
  const queryKey = useMemo(() => ["launch-activity", ANALYTICS_CHAIN_ID] as const, []);
  const cacheKey = LAUNCH_CACHE_PREFIX + ANALYTICS_CHAIN_ID;

  const query = useQuery<LaunchActivity>({
    queryKey,
    enabled: true,
    staleTime: 60_000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchInterval: (q) => (q.state.data?.state === "unavailable" ? 10_000 : 60_000),
    // Prefer a warm local snapshot over a blank unavailable frame while revalidating.
    placeholderData: () => {
      const cached = readLaunchCache(cacheKey);
      return cached ? presentAged(cached.data) : undefined;
    },
    queryFn: async ({ client }) => {
      // `placeholderData` is observer-only — not in the query cache. Fall back to
      // localStorage so a cold mount + failed fetch still preserves a warm snapshot.
      const previous =
        client.getQueryData<LaunchActivity>(queryKey) ??
        (() => {
          const cached = readLaunchCache(cacheKey);
          return cached ? presentAged(cached.data) : undefined;
        })();

      const asStale = (base: LaunchActivity, servedAt?: number): LaunchActivity => ({
        ...base,
        state: "stale",
        unavailable: false,
        servedAt: servedAt ?? Date.now(),
      });

      try {
        const res = await fetch("/api/tokens", { cache: "no-store" });
        if (!res.ok) {
          if (previous && previous.creations.length > 0) return asStale(previous);
          return {
            ...EMPTY_LAUNCH,
            state: "unavailable" as const,
            unavailable: true,
            servedAt: Date.now(),
          };
        }
        const json = (await res.json()) as {
          creations: Array<Omit<CreationEvent, "blockNumber"> & { blockNumber: string }>;
          unavailable?: boolean;
          state?: FeedState;
          chainId?: number;
          servedAt?: number;
          scanCompletedAt?: number;
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
          volume24Usd: c.volume24Usd ?? 0,
        }));
        const state: FeedState =
          json.state ?? (json.unavailable ? "unavailable" : "fresh");
        // Server unavailable with empty list: prefer warm previous/localStorage as stale.
        if (state === "unavailable" && creations.length === 0 && previous?.creations.length) {
          return asStale(previous, json.servedAt);
        }
        const result: LaunchActivity = {
          creations,
          state,
          chainId: json.chainId ?? ANALYTICS_CHAIN_ID,
          servedAt: json.servedAt ?? Date.now(),
          scanCompletedAt: json.scanCompletedAt ?? 0,
          unavailable: state === "unavailable",
        };
        writeLaunchCache(cacheKey, result);
        return result;
      } catch {
        if (previous && previous.creations.length > 0) return asStale(previous);
        return {
          ...EMPTY_LAUNCH,
          state: "unavailable" as const,
          unavailable: true,
          servedAt: Date.now(),
        };
      }
    },
  });

  const raw = query.data ?? EMPTY_LAUNCH;
  const data = presentAged(raw);
  // creationByToken keeps the FULL set so a hidden token's own page/trade still
  // resolves by direct link; only the browse LISTS below drop hidden tokens.
  const creationByToken = useMemo(() => {
    const map = new Map<string, CreationEvent>();
    for (const c of data.creations) map.set(c.token.toLowerCase(), c);
    return map;
  }, [data.creations]);
  const creations = useMemo(
    () => data.creations.filter((c) => !isHiddenToken(c.token)),
    [data.creations],
  );

  return {
    creations,
    /** Unfiltered map (includes hidden tokens) for direct token-page lookups. */
    creationByToken,
    /** Unfiltered creations for planter checks (header "My profile"). */
    allCreations: data.creations,
    state: data.state,
    chainId: data.chainId,
    servedAt: data.servedAt,
    scanCompletedAt: data.scanCompletedAt,
    unavailable: data.state === "unavailable",
    isLoading: query.isLoading,
    isFetching: query.isFetching,
  };
}

// ---------------------------------------------------------------------------
// Holders, derived client-side from server /api/holders
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
 * Balances per address, sorted descending. The Transfer-log scan runs
 * server-side (cached) at /api/holders.
 */
export function useTokenHolders(token: Address | undefined) {
  const { chainId, isDeployed } = usePad();
  const queryKey = useMemo(
    () => ["token-holders", chainId, token ?? "none"],
    [chainId, token],
  );

  const query = useQuery<HoldersData>({
    queryKey,
    enabled: isDeployed && !!token,
    staleTime: 30_000,
    refetchInterval: 60_000,
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

  const data = query.data ?? EMPTY_HOLDERS;
  return {
    holders: data.holders,
    total: data.total,
    unavailable: data.unavailable,
    isLoading: query.isLoading,
  };
}
