"use client";

// Event-driven data layer: launch history (TokenCreated) and holders (ERC-20
// Transfer logs) fetched via the wagmi public client. v2 has no Trade or
// Graduated events — price/liquidity come from the Uniswap pool (see lib/pool).
// All fetchers degrade gracefully — RPCs that cap log ranges yield
// `unavailable: true` instead of throwing.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address, PublicClient } from "viem";
import { parseAbiItem } from "viem";
import { usePublicClient, useWatchContractEvent } from "wagmi";
import { potatoPadAbi, potatoTokenAbi } from "@/lib/abi";
import { PAD_START_BLOCK, ZERO_ADDRESS } from "@/lib/config";
import { usePad } from "@/lib/hooks";

const tokenCreatedEvent = parseAbiItem(
  "event TokenCreated(address indexed token, address indexed creator, string name, string symbol, address pool, string imageURI, string website, string twitter, string telegram)",
);
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

// Live RPCs cap eth_getLogs block ranges (Alchemy on Robinhood = 10k blocks), so
// scan forward from the pad's deploy block in sub-cap windows and concatenate.
const LOG_CHUNK = 9_000n;

async function collectLogs<T>(
  fromBlock: bigint,
  toBlock: bigint,
  fetchRange: (from: bigint, to: bigint) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK + 1n) {
    const end = start + LOG_CHUNK <= toBlock ? start + LOG_CHUNK : toBlock;
    out.push(...(await fetchRange(start, end)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block timestamps (module-level cache; block timestamps never change)
// ---------------------------------------------------------------------------

const timestampCache = new Map<string, number>();

async function fetchBlockTimestamps(
  client: PublicClient,
  chainId: number,
  blockNumbers: bigint[],
): Promise<Map<bigint, number>> {
  const out = new Map<bigint, number>();
  const missing: bigint[] = [];
  const seen = new Set<string>();

  for (const bn of blockNumbers) {
    const key = bn.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const cached = timestampCache.get(`${chainId}:${key}`);
    if (cached !== undefined) out.set(bn, cached);
    else missing.push(bn);
  }

  const CHUNK = 20;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const blocks = await Promise.all(
      missing.slice(i, i + CHUNK).map((n) => client.getBlock({ blockNumber: n })),
    );
    for (const block of blocks) {
      const ts = Number(block.timestamp);
      timestampCache.set(`${chainId}:${block.number.toString()}`, ts);
      out.set(block.number, ts);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Launch activity: TokenCreated (ticker, card ages, symbols, pool addresses)
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
}

interface LaunchActivity {
  creations: CreationEvent[];
  unavailable: boolean;
}

const EMPTY_LAUNCH: LaunchActivity = { creations: [], unavailable: false };

export function useLaunchActivity() {
  const { pad, chainId, isDeployed } = usePad();
  const client = usePublicClient();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["launch-activity", chainId, pad], [chainId, pad]);

  const query = useQuery<LaunchActivity>({
    queryKey,
    enabled: isDeployed && !!client,
    staleTime: 15_000,
    queryFn: async () => {
      if (!client) return EMPTY_LAUNCH;
      try {
        const latest = await client.getBlockNumber();
        const startBlock = PAD_START_BLOCK[chainId] ?? 0n;
        const createdLogs = await collectLogs(startBlock, latest, (from, to) =>
          client.getLogs({ address: pad, event: tokenCreatedEvent, fromBlock: from, toBlock: to }),
        );
        const ts = await fetchBlockTimestamps(
          client,
          chainId,
          createdLogs.map((l) => l.blockNumber),
        );
        const creations: CreationEvent[] = createdLogs.map((l) => ({
          token: l.args.token as Address,
          creator: l.args.creator as Address,
          name: l.args.name ?? "",
          symbol: l.args.symbol ?? "",
          pool: (l.args.pool as Address) ?? ZERO_ADDRESS,
          imageURI: l.args.imageURI ?? "",
          website: l.args.website ?? "",
          twitter: l.args.twitter ?? "",
          telegram: l.args.telegram ?? "",
          timestamp: ts.get(l.blockNumber) ?? 0,
          blockNumber: l.blockNumber,
        }));
        return { creations, unavailable: false };
      } catch {
        // RPC capped the range / log queries unsupported — degrade gracefully.
        return { ...EMPTY_LAUNCH, unavailable: true };
      }
    },
  });

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
        const startBlock = PAD_START_BLOCK[chainId] ?? 0n;
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
