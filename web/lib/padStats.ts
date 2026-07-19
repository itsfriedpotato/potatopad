/**
 * Pure helpers for creator-profile existence metrics from the TokenCreated feed.
 * No volume, no pad-wide aggregates (deferred to indexer).
 */

export type FeedState = "fresh" | "stale" | "unavailable";

export type CreationLike = {
  token: string;
  creator: string;
  timestamp: number; // unix seconds
  marketCapEth?: number | null;
};

/** Creations planted by `creator` (case-insensitive address match). */
export function creationsByCreator<T extends CreationLike>(
  creations: T[],
  creator: string,
): T[] {
  const key = creator.toLowerCase();
  return creations.filter((c) => c.creator.toLowerCase() === key);
}

/** True when this address has planted at least one coin in the feed. */
export function isPlanter(creations: CreationLike[], address: string): boolean {
  return creationsByCreator(creations, address).length > 0;
}

export function firstPlantTimestamp(creations: CreationLike[]): number | null {
  if (creations.length === 0) return null;
  let min = creations[0].timestamp;
  for (const c of creations) {
    if (c.timestamp > 0 && (min === 0 || c.timestamp < min)) min = c.timestamp;
  }
  return min > 0 ? min : null;
}

export function latestPlantTimestamp(creations: CreationLike[]): number | null {
  if (creations.length === 0) return null;
  let max = 0;
  for (const c of creations) {
    if (c.timestamp > max) max = c.timestamp;
  }
  return max > 0 ? max : null;
}

/**
 * Highest non-null marketCapEth among the provided rows (page-scoped hero).
 * Returns null when nothing is priced.
 */
export function topCoinByMarketCap<T extends { marketCapEth?: number | null }>(
  rows: T[],
): T | null {
  let best: T | null = null;
  for (const r of rows) {
    const m = r.marketCapEth;
    if (m == null || !Number.isFinite(m) || m <= 0) continue;
    if (!best || (best.marketCapEth ?? 0) < m) best = r;
  }
  return best;
}
