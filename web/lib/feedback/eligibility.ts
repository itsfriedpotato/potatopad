// SERVER ONLY. Eligibility engine:
//   - which PotatoPad tokens QUALIFY (real WETH liquidity + age floor, so a thin
//     self-made pool can't fake a $50 bag via price manipulation),
//   - a wallet's current $ value across qualifying tokens,
//   - the time-weighted "held >= $50 for >= 24h" check (from holdings_snapshots),
//   - the 1-post-per-3-days cooldown.
import { createPublicClient, http, erc20Abi, parseAbiItem, type Address } from "viem";
import { robinhoodChain, WETH_ADDRESSES, ZERO_ADDRESS } from "@/lib/config";
import { priceWethPerToken, tokenIsToken0, uniswapV3PoolAbi } from "@/lib/pool";
import { loadFeed } from "@/lib/tokenFeed";
import { requireSupabase } from "@/lib/supabase";
import {
  ADMIN_ADDRESS,
  HOLD_MS,
  MIN_USD,
  POST_COOLDOWN_MS,
  type EligibilityInfo,
} from "./types";

const WETH = WETH_ADDRESSES[robinhoodChain.id] as Address;

// Floor (TUNE): a token counts toward eligibility only if its pool holds real WETH
// depth and it is not brand new. This is the "any token, made safe" mechanism.
const MIN_LIQUIDITY_USD = 3_000;
const MIN_AGE_MS = 2 * 24 * 60 * 60 * 1000;

// A qualifying token must also show real distribution: at least this many distinct
// on-chain holders. Counted from ERC20 Transfer logs like /api/holders, so the
// figure includes infrastructure holders such as the locked LP pool, not only
// humans. It is a coarse anti-Sybil floor (TUNE).
const MIN_HOLDERS = 25;

// Holder-scan bounds. The count is computed only for the handful of tokens that
// already clear liquidity+age, and only from each token's OWN creation block
// forward, so the work stays small. These cap the worst case so an old token, or a
// token with an unknown creation block, can never trigger a runaway getLogs sweep.
const HOLDER_LOG_CHUNK = 9_000n; // Alchemy on Robinhood caps eth_getLogs at 10k blocks.
const HOLDER_SCAN_CONCURRENCY = 4; // windows fetched at once, per token.
// Max windows scanned for one token. ~300 * 9k blocks covers the whole current
// token history with headroom; past it (a much older token as the chain grows) we
// treat holders as unknown and fall back to liquidity+age. Grow this as the chain ages.
const MAX_HOLDER_WINDOWS = 300;
// Safety budget on how many tokens get a holder scan per refresh. The liquidity+age
// prefilter already makes this a small set; any excess falls back to liquidity+age.
const MAX_HOLDER_TOKENS = 12;

// Local testing only: skip the 24h wait before snapshots accrue. NEVER set in prod.
const DEV_BYPASS = process.env.FEEDBACK_DEV_BYPASS === "1";

const client = createPublicClient({
  chain: robinhoodChain,
  transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"),
});

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
type TransferLog = { args: { from?: Address; to?: Address; value?: bigint } };

export function isAdmin(address: string): boolean {
  return address.toLowerCase() === ADMIN_ADDRESS;
}

interface QToken {
  address: Address;
  symbol: string;
  pool: Address;
  priceUsd: number;
  liquidityUsd: number;
  createdAt: number;
  /** Distinct on-chain holders, or null when it could not be determined (RPC
   *  failure, or a scan range too large to trust). null means "unknown" and never
   *  hard-blocks: the token falls back to the liquidity+age verdict. */
  holders: number | null;
  qualifies: boolean;
}

// A token after the cheap liquidity+age pass, before the holder floor is applied.
interface PrelimToken {
  address: Address;
  symbol: string;
  pool: Address;
  priceUsd: number;
  liquidityUsd: number;
  createdAt: number;
  createdBlock: bigint;
  passesLiqAge: boolean;
}

// --- ETH/USD (cached 5 min) ---
let priceCache: { usd: number; expiresAt: number } | null = null;
async function ethUsd(): Promise<number> {
  if (priceCache && priceCache.expiresAt > Date.now()) return priceCache.usd;
  // Use the CoinGecko PRO endpoint + API key when configured (the free endpoint is
  // rate-limited from cloud IPs like Railway, which would return 0 and zero out every
  // token's USD value). Mirrors lib/tokenFeed.ts.
  const key = process.env.COINGECKO_API_KEY;
  const url = key
    ? "https://pro-api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
    : "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd";
  const headers: Record<string, string> = key
    ? { "x-cg-pro-api-key": key, accept: "application/json" }
    : { accept: "application/json" };
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
    const j = (await r.json()) as { ethereum?: { usd?: number } };
    const usd = j.ethereum?.usd ?? 0;
    if (usd > 0) priceCache = { usd, expiresAt: Date.now() + 5 * 60_000 };
    return usd || priceCache?.usd || 0;
  } catch {
    return priceCache?.usd ?? 0;
  }
}

/** Diagnostic: expose the engine's internal state for one address (dev / triage). */
export async function debugScan(address: string) {
  const price = await ethUsd();
  const feed = await loadFeed().catch((e) => ({ creations: [], err: String(e) }));
  const creations = feed.creations;
  let firstRead: unknown = "no creations";
  const c0 = creations[0];
  if (c0?.pool) {
    try {
      const [slot0, wethBal] = await Promise.all([
        client.readContract({ address: c0.pool as Address, abi: uniswapV3PoolAbi, functionName: "slot0" }),
        client.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [c0.pool as Address] }),
      ]);
      firstRead = { pool: c0.pool, sqrt: String((slot0 as readonly unknown[])[0]), wethInPool: String(wethBal) };
    } catch (e) {
      firstRead = { readError: String(e).slice(0, 300) };
    }
  }
  const q = await getQualifyingTokens();
  const usd = await getWalletUsd(address);
  return {
    ethUsd: price,
    coingeckoKey: !!process.env.COINGECKO_API_KEY,
    creations: creations.length,
    firstRead,
    qualifyingTotal: q.length,
    qualifyingTrue: q.filter((t) => t.qualifies).length,
    walletUsd: usd,
    sample: q
      .slice(0, 4)
      .map((t) => ({ symbol: t.symbol, priceUsd: t.priceUsd, liquidityUsd: t.liquidityUsd, holders: t.holders, qualifies: t.qualifies })),
  };
}

// --- qualifying tokens (cached 10 min) ---
let qCache: { tokens: QToken[]; expiresAt: number } | null = null;
let qInFlight: Promise<QToken[]> | null = null;
const Q_TTL_MS = 10 * 60_000;

export async function getQualifyingTokens(): Promise<QToken[]> {
  if (qCache && qCache.expiresAt > Date.now()) return qCache.tokens;
  // Coalesce concurrent cold-cache callers onto ONE scan (mirrors loadFeed). The
  // holder scan widens the cold window to seconds, so without this every eligibility
  // request landing in that window would fire its own full sweep at the shared RPC.
  if (qInFlight) return qInFlight;
  qInFlight = (async () => {
    try {
      return await scanQualifyingTokens();
    } finally {
      qInFlight = null;
    }
  })();
  return qInFlight;
}

async function scanQualifyingTokens(): Promise<QToken[]> {
  const [{ creations }, price] = await Promise.all([loadFeed(), ethUsd()]);
  const now = Date.now();

  // Phase 1: cheap liquidity + age check for every token (two reads each).
  const prelim = (
    await Promise.all(
      creations.map(async (c): Promise<PrelimToken | null> => {
        if (!c.pool) return null;
        try {
          const [slot0, wethBal] = await Promise.all([
            client.readContract({ address: c.pool as Address, abi: uniswapV3PoolAbi, functionName: "slot0" }),
            client.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [c.pool as Address] }),
          ]);
          const sqrtP = (slot0 as readonly unknown[])[0] as bigint;
          const priceWeth = priceWethPerToken(sqrtP, tokenIsToken0(c.token, WETH));
          const priceUsd = priceWeth * price;
          const liquidityUsd = (Number(wethBal) / 1e18) * price;
          const createdAt = c.timestamp * 1000;
          let createdBlock = 0n;
          try {
            createdBlock = BigInt(c.blockNumber);
          } catch {
            /* unknown block -> the holder scan bails to "unknown" and we fall back */
          }
          const passesLiqAge =
            priceUsd > 0 && liquidityUsd >= MIN_LIQUIDITY_USD && now - createdAt >= MIN_AGE_MS;
          return {
            address: c.token as Address,
            symbol: c.symbol,
            pool: c.pool as Address,
            priceUsd,
            liquidityUsd,
            createdAt,
            createdBlock,
            passesLiqAge,
          };
        } catch {
          return null;
        }
      }),
    )
  ).filter((t): t is PrelimToken => t !== null);

  // Phase 2: holder floor, only for the (small) set that already clears liq+age.
  // Scanned one token at a time (windows concurrent within a token) to stay gentle
  // on the shared RPC key. Tokens beyond the budget stay holders-unknown.
  const latestBlock = await client.getBlockNumber().catch(() => null);
  const passers = prelim.filter((t) => t.passesLiqAge).slice(0, MAX_HOLDER_TOKENS);
  const holdersByToken = new Map<string, number | null>();
  if (latestBlock !== null) {
    for (const t of passers) {
      holdersByToken.set(t.address.toLowerCase(), await countHolders(t.address, t.createdBlock, latestBlock));
    }
  }

  const tokens: QToken[] = prelim.map((t) => {
    // Unknown holders (RPC failure, oversized scan, or not scanned) must not hard-
    // block: fall back to the liquidity+age verdict for that token.
    const holders = t.passesLiqAge ? (holdersByToken.get(t.address.toLowerCase()) ?? null) : null;
    const qualifies = t.passesLiqAge && (holders === null || holders >= MIN_HOLDERS);
    return {
      address: t.address,
      symbol: t.symbol,
      pool: t.pool,
      priceUsd: t.priceUsd,
      liquidityUsd: t.liquidityUsd,
      createdAt: t.createdAt,
      holders,
      qualifies,
    };
  });

  qCache = { tokens, expiresAt: Date.now() + Q_TTL_MS };
  void persistQualifying(tokens);
  return tokens;
}

/**
 * Distinct current holders of `token`, counted from ERC20 Transfer logs the same
 * way /api/holders does: accumulate transfer value deltas into a balance map and
 * count the addresses left with a positive balance (the locked-LP pool included).
 * Scans only [createdBlock, latestBlock], chunked and hard-capped. Returns null
 * when the count cannot be trusted, an unknown or oversized range, or an RPC
 * failure, so the caller can fall back instead of hard-blocking.
 */
async function countHolders(
  token: Address,
  createdBlock: bigint,
  latestBlock: bigint,
): Promise<number | null> {
  if (createdBlock <= 0n || createdBlock > latestBlock) return null;

  const windows: [bigint, bigint][] = [];
  for (let s = createdBlock; s <= latestBlock; s += HOLDER_LOG_CHUNK + 1n) {
    const e = s + HOLDER_LOG_CHUNK <= latestBlock ? s + HOLDER_LOG_CHUNK : latestBlock;
    windows.push([s, e]);
    if (windows.length > MAX_HOLDER_WINDOWS) return null; // range too large to trust -> unknown
  }

  const balances = new Map<string, bigint>();
  try {
    for (let i = 0; i < windows.length; i += HOLDER_SCAN_CONCURRENCY) {
      const batch = windows.slice(i, i + HOLDER_SCAN_CONCURRENCY);
      const results = await Promise.all(
        batch.map(([from, to]) =>
          client.getLogs({ address: token, event: transferEvent, fromBlock: from, toBlock: to }),
        ),
      );
      for (const logs of results) {
        for (const log of logs as unknown as TransferLog[]) {
          const { from, to, value } = log.args;
          if (value === undefined || value === 0n) continue;
          if (from && from !== ZERO_ADDRESS) balances.set(from, (balances.get(from) ?? 0n) - value);
          if (to && to !== ZERO_ADDRESS) balances.set(to, (balances.get(to) ?? 0n) + value);
        }
      }
    }
  } catch {
    return null; // RPC failure -> unknown, never hard-block
  }

  let count = 0;
  for (const balance of balances.values()) if (balance > 0n) count++;
  return count;
}

async function persistQualifying(tokens: QToken[]) {
  try {
    const db = requireSupabase();
    await db.from("qualifying_tokens").upsert(
      tokens.map((t) => ({
        address: t.address.toLowerCase(),
        symbol: t.symbol,
        liquidity_usd: t.liquidityUsd,
        holders: t.holders,
        qualifies: t.qualifies,
        updated_at: new Date().toISOString(),
      })),
    );
  } catch {
    /* best-effort */
  }
}

/** Current $ value of a wallet's holdings across qualifying tokens. */
export async function getWalletUsd(address: string): Promise<number> {
  const qtokens = (await getQualifyingTokens()).filter((t) => t.qualifies);
  let usd = 0;
  await Promise.all(
    qtokens.map(async (t) => {
      try {
        const bal = (await client.readContract({
          address: t.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address as Address],
        })) as bigint;
        usd += (Number(bal) / 1e18) * t.priceUsd;
      } catch {
        /* skip a bad read */
      }
    }),
  );
  return usd;
}

// Record a snapshot at most ~once/hour per address, so 24h history accrues from
// ordinary eligibility checks (the cron supplements this).
async function maybeSnapshot(address: string, usd: number) {
  try {
    const db = requireSupabase();
    const { data } = await db
      .from("holdings_snapshots")
      .select("ts")
      .eq("address", address)
      .order("ts", { ascending: false })
      .limit(1);
    const lastTs = data?.[0]?.ts ? new Date(data[0].ts as string).getTime() : 0;
    if (Date.now() - lastTs > 60 * 60 * 1000) {
      await db.from("holdings_snapshots").insert({ address, qualifying_usd: usd });
    }
  } catch {
    /* best-effort */
  }
}

export async function getEligibility(addressRaw: string): Promise<EligibilityInfo> {
  const address = addressRaw.toLowerCase();
  const db = requireSupabase();
  const admin = isAdmin(address);

  // Bans override holdings: a restricted wallet can neither post nor vote. The
  // admin is exempt (it moderates the board and is never banned).
  if (!admin) {
    const { data: banned } = await db
      .from("profiles")
      .select("is_banned")
      .eq("address", address)
      .maybeSingle();
    if (banned?.is_banned) {
      return {
        eligible: false,
        qualifyingUsd: 0,
        heldEnough: false,
        heldLongEnough: false,
        canPost: false,
        canPostAt: null,
        reason: "account restricted",
      };
    }
  }

  const usd = await getWalletUsd(address);
  const heldEnough = usd >= MIN_USD || DEV_BYPASS || admin;

  await maybeSnapshot(address, usd);

  let heldLongEnough = heldEnough;
  if (!DEV_BYPASS && !admin) {
    const cutoff = new Date(Date.now() - HOLD_MS).toISOString();
    const { data: old } = await db
      .from("holdings_snapshots")
      .select("ts")
      .eq("address", address)
      .lte("ts", cutoff)
      .gte("qualifying_usd", MIN_USD)
      .limit(1);
    heldLongEnough = heldEnough && !!old && old.length > 0;
  }

  const { data: profile } = await db
    .from("profiles")
    .select("last_post_at")
    .eq("address", address)
    .maybeSingle();
  const lastPost = profile?.last_post_at ? new Date(profile.last_post_at as string).getTime() : 0;
  const canPostAtMs = lastPost + POST_COOLDOWN_MS;
  const cooldownOk = Date.now() >= canPostAtMs;

  const eligible = heldEnough && heldLongEnough;
  return {
    eligible,
    qualifyingUsd: Math.round(usd * 100) / 100,
    heldEnough,
    heldLongEnough,
    canPost: eligible && cooldownOk,
    canPostAt: cooldownOk ? null : new Date(canPostAtMs).toISOString(),
    reason: !heldEnough
      ? "Hold at least $50 of a listed token"
      : !heldLongEnough
        ? "Hold it for at least 24 hours"
        : undefined,
  };
}
