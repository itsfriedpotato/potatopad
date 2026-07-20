import { createPublicClient, http } from "viem";
import { robinhoodChain } from "@/lib/config";

/** Analytics / profile pricing is pinned to Robinhood regardless of wallet chain. */
export const ANALYTICS_CHAIN_ID = robinhoodChain.id; // 4663

/**
 * Browser-safe public client for Robinhood read RPCs (slot0, etc.).
 * Uses the public RPC — never embed private Alchemy/Chainstack keys client-side.
 */
export const robinhoodPublicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http("https://rpc.mainnet.chain.robinhood.com", { timeout: 12_000 }),
});
