// Robinhood RPC with ordered failover: the PRIMARY upstream first (Chainstack),
// then the fallbacks (Alchemy), then the public RPC as a last resort. Reads the
// server-only env upstreams in order.
//
// Neutral module on purpose (NO "use client"): server modules import it for a
// failover viem transport, and the /api/rpc proxy imports the upstream list. Keys
// live only in these server env vars, so the browser never sees them (it talks to
// the same-origin /api/rpc proxy instead).
import { fallback, http, type Transport } from "viem";

const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

/** Ordered upstreams: ROBINHOOD_RPC_URL (primary), then _2, _3. Public RPC if none. */
export function robinhoodUpstreams(): string[] {
  const list = [
    process.env.ROBINHOOD_RPC_URL,
    process.env.ROBINHOOD_RPC_URL_2,
    process.env.ROBINHOOD_RPC_URL_3,
  ].filter((u): u is string => !!u && u.length > 0);
  return list.length > 0 ? list : [PUBLIC_RPC];
}

/** viem transport that tries the primary first and fails over to the rest on error.
 *  `rank: false` keeps the declared order (primary first) rather than reordering by
 *  latency, so Chainstack stays primary and Alchemy is only hit on failure. */
export function robinhoodServerTransport(): Transport {
  return fallback(
    robinhoodUpstreams().map((u) => http(u, { timeout: 12_000 })),
    { rank: false },
  );
}
