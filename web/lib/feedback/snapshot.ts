// SERVER ONLY. The scheduled snapshot job behind POST /api/feedback/cron.
//   1. Refreshes qualifying_tokens (which PotatoPad tokens clear the liquidity floor).
//   2. Writes one holdings_snapshots row per known wallet, so the "held >= $50 for
//      >= 24h" history accrues even for holders who never open the board (ordinary
//      eligibility checks only snapshot wallets that actively check).
//   3. Prunes stale nonces and old snapshots so the tables do not grow unbounded.
// Kept out of the route handler so the route stays a thin auth wrapper.
import { requireSupabase } from "@/lib/supabase";
import { getQualifyingTokens, getWalletUsd } from "./eligibility";

// Bound cost: at most this many wallets get a fresh on-chain valuation per run.
const MAX_WALLETS_PER_RUN = 500;
// Fetch profiles a page at a time; capped at the per-run limit so we never
// over-fetch rows we would only discard.
const PAGE = MAX_WALLETS_PER_RUN;
// Wallets valued concurrently. Each getWalletUsd fans out one balanceOf read per
// qualifying token, so keep this modest to avoid hammering the RPC.
const WALLET_BATCH = 10;

const NONCE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SnapshotResult {
  ok: boolean;
  tokens: number; // qualifying-token rows refreshed this run
  wallets: number; // wallets snapshotted this run
}

/**
 * Run the eligibility snapshot job. Best-effort throughout: every phase is guarded
 * so a failure in one (RPC hiccup, transient Supabase error) still lets the others
 * make progress. Never throws.
 */
export async function runSnapshot(): Promise<SnapshotResult> {
  let tokens = 0;
  let wallets = 0;

  // 1. Refresh the qualifying-token set. getQualifyingTokens() persists the result
  //    to qualifying_tokens (best-effort) and warms the 10-min cache that every
  //    per-wallet getWalletUsd() below then reuses, so this must run first.
  try {
    tokens = (await getQualifyingTokens()).length;
  } catch {
    /* keep going so snapshots still accrue against the last cached token set */
  }

  // 2. Snapshot each known wallet's current qualifying-token value.
  try {
    const addresses = await loadWalletAddresses();
    for (let i = 0; i < addresses.length; i += WALLET_BATCH) {
      const slice = addresses.slice(i, i + WALLET_BATCH);
      const rows = await Promise.all(
        slice.map(async (address) => {
          try {
            const usd = await getWalletUsd(address);
            return { address, qualifying_usd: usd };
          } catch {
            return null; // skip a wallet whose reads failed this run
          }
        }),
      );
      const valid = rows.filter(
        (r): r is { address: string; qualifying_usd: number } => r !== null,
      );
      if (valid.length) {
        const db = requireSupabase();
        const { error } = await db.from("holdings_snapshots").insert(valid);
        if (!error) wallets += valid.length;
      }
    }
  } catch {
    /* best-effort */
  }

  // 3. Cleanup (best-effort): burn stale nonces and prune ancient snapshots. Each
  //    delete carries a filter so it can never wipe a whole table.
  try {
    const db = requireSupabase();
    const nonceCutoff = new Date(Date.now() - NONCE_MAX_AGE_MS).toISOString();
    await db.from("feedback_nonces").delete().lt("created_at", nonceCutoff);
  } catch {
    /* best-effort */
  }
  try {
    const db = requireSupabase();
    const snapCutoff = new Date(Date.now() - SNAPSHOT_MAX_AGE_MS).toISOString();
    await db.from("holdings_snapshots").delete().lt("ts", snapCutoff);
  } catch {
    /* best-effort */
  }

  return { ok: true, tokens, wallets };
}

/** Page through profiles (ordered by address) up to the per-run cap. */
async function loadWalletAddresses(): Promise<string[]> {
  const db = requireSupabase();
  const addresses: string[] = [];
  for (let from = 0; addresses.length < MAX_WALLETS_PER_RUN; from += PAGE) {
    const { data, error } = await db
      .from("profiles")
      .select("address")
      .order("address", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data) {
      addresses.push(row.address as string);
      if (addresses.length >= MAX_WALLETS_PER_RUN) break;
    }
    if (data.length < PAGE) break; // last page
  }
  return addresses;
}
