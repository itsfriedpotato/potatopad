// Robinhood RPC upstreams in two tiers:
//   - PRIMARY POOL (ROBINHOOD_RPC_URL, _2, _3): the Chainstack nodes, ~250 req/s
//     each. These are LOAD-BALANCED (round-robined by the /api/rpc proxy, shuffled
//     by the server transport) so traffic spreads across all of them and no single
//     node hits its per-node rate limit while the others sit idle.
//   - FALLBACKS (ROBINHOOD_RPC_FALLBACK_URL, _2): Alchemy free tier, only hit after
//     the whole primary pool is exhausted. Then the public RPC as the last resort.
//
// Neutral module on purpose (NO "use client"): server modules import it for a
// failover viem transport, and the /api/rpc proxy imports the tier lists. Keys live
// only in these server env vars, so the browser never sees them (it talks to the
// same-origin /api/rpc proxy instead).
import { fallback, http, type Transport } from "viem";

export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

/** Primary pool: the Chainstack nodes, load-balanced. ROBINHOOD_RPC_URL, _2..._7. */
export function robinhoodPrimaryPool(): string[] {
  return [
    process.env.ROBINHOOD_RPC_URL,
    process.env.ROBINHOOD_RPC_URL_2,
    process.env.ROBINHOOD_RPC_URL_3,
    process.env.ROBINHOOD_RPC_URL_4,
    process.env.ROBINHOOD_RPC_URL_5,
    process.env.ROBINHOOD_RPC_URL_6,
    process.env.ROBINHOOD_RPC_URL_7,
  ].filter((u): u is string => !!u && u.length > 0);
}

/** Fallback upstreams, tried only after the whole primary pool: Alchemy free tier. */
export function robinhoodFallbacks(): string[] {
  return [
    process.env.ROBINHOOD_RPC_FALLBACK_URL,
    process.env.ROBINHOOD_RPC_FALLBACK_URL_2,
  ].filter((u): u is string => !!u && u.length > 0);
}

/** Full ordered failover chain (pool + fallbacks + public), de-duped. Public RPC
 *  is always the final safety net so reads never hard-fail while any node lives. */
export function robinhoodUpstreams(): string[] {
  return [...new Set([...robinhoodPrimaryPool(), ...robinhoodFallbacks(), PUBLIC_RPC])];
}

/** Fisher-Yates shuffle (non-crypto): just spreads server-side load across the pool. */
function shuffled(a: string[]): string[] {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** viem transport for server reads. A RANDOM primary node leads (so server-side
 *  load spreads across the pool too), then the rest of the pool, then the fallbacks
 *  and public RPC. `rank: false` keeps this order rather than reordering by latency. */
export function robinhoodServerTransport(): Transport {
  const urls = [...new Set([...shuffled(robinhoodPrimaryPool()), ...robinhoodFallbacks(), PUBLIC_RPC])];
  return fallback(
    urls.map((u) => http(u, { timeout: 12_000 })),
    { rank: false },
  );
}
